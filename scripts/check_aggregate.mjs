// The three-round aggregate, against the ways real tables actually break it.
//
// Every bug this guards was found by people sitting at a table, not by a unit
// test, and each one looked like "the table is stuck" with no error anywhere:
//
//   1. A stray envelope from a seat that is not a party -- a leftover tab, or
//      anyone at all, since the relay is dumb and open -- threw inside
//      AggregateSession and rejected the whole run. Retry, stray, repeat.
//      Before the filter this was a free denial of service on every reveal at
//      every table.
//   2. A client that joins a position LATE meets parties already past the
//      commit round. They had stopped re-announcing their commitments, so it
//      could never close its own commit round, so it never revealed, so they
//      waited on it forever. All three seats waiting, nobody at fault.
//   3. A reveal arriving before this client has every commitment is normal for
//      a late join, and used to be fatal. It must be PARKED, not accepted
//      (accepting early is the naive-multisignature break) and not rejected.
//
// Run: node scripts/check_aggregate.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'node_modules/.cache/zkpoker');
mkdirSync(outdir, { recursive: true });
const entry = join(outdir, 'agg-entry.ts');
writeFileSync(entry, `
export * as grumpkin from ${JSON.stringify(join(root, 'src/lib/grumpkin.ts'))};
export * as dealing from ${JSON.stringify(join(root, 'src/lib/dealing.ts'))};
export * as dleq from ${JSON.stringify(join(root, 'src/lib/dleq.ts'))};
`);
const bundle = join(outdir, 'agg.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  outfile: bundle, external: ['garaga', 'starknet', '@aztec/bb.js', '@noir-lang/noir_js'],
  logLevel: 'warning' });
const { grumpkin, dealing, dleq } = await import(pathToFileURL(bundle).href);
await dleq.initProver();

const fail = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok    ${m}`);

// A transport that delivers to everyone currently subscribed, and to nobody
// who is not -- exactly like the relay for ephemeral round traffic, which is
// what makes late joining the hard case.
function makeBus() {
  const subs = new Set();
  return {
    injected: [],
    connect() {
      const self = {
        subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
        async publish(env) { for (const fn of [...subs]) fn(env); },
      };
      return self;
    },
    inject(env) { for (const fn of [...subs]) fn(env); },
  };
}

const TABLE = '0x1';
const POSITION = 4;
// H is the ciphertext's c1 -- any curve point will do for the algebra.
const H = grumpkin.mulG(0x9e3779b97f4a7c15n);

async function runTable({ lateSeat = null, stray = false } = {}) {
  const bus = makeBus();
  const secrets = [0x1234n, 0x5678n, 0x9abcn].map((v) => v * 7919n + 13n);
  const keys = new Map(secrets.map((x, i) => [i, grumpkin.mulG(x)]));
  const shares = new Map(secrets.map((x, i) => [i, grumpkin.mul(x, H)]));

  const start = (seat) => dealing.runAggregate({
    transport: bus.connect(), tableId: TABLE, position: POSITION, h: H,
    jointKey: [...keys.values()].reduce((a, p) => grumpkin.add(a, p), null),
    keys, shares, mySeat: seat, mySecret: secrets[seat],
    timeoutMs: 25_000, proposerGraceMs: 1_000,
  });

  const runs = [];
  for (let seat = 0; seat < 3; seat++) if (seat !== lateSeat) runs.push(start(seat));

  if (stray) {
    // A seat number nobody at this table holds. One envelope used to be enough
    // to kill every run.
    await new Promise((r) => setTimeout(r, 300));
    bus.inject({
      tableId: TABLE, position: POSITION, from: 9, kind: 'nonce-commit',
      to: null, body: { commitment: '12345' }, ephemeral: true,
    });
  }

  if (lateSeat !== null) {
    // Long enough for the others to finish committing and start revealing --
    // the exact window the late joiner could never escape.
    await new Promise((r) => setTimeout(r, 3_000));
    runs.push(start(lateSeat));
  }

  const results = await Promise.all(runs);
  // Every party must land on the SAME aggregate, or they did not co-sign one
  // statement.
  const D = results[0].share;
  for (const r of results) {
    if (r.share.x !== D.x || r.share.y !== D.y) fail('parties disagreed on D');
    if (r.proof.proof.length !== results[0].proof.proof.length) fail('proof shapes differ');
  }
  // And it must verify against the joint key, which is the whole point.
  const Y = [...keys.values()].reduce((a, p) => grumpkin.add(a, p), null);
  if (!dleq.verify({ pk: Y, h: H, d: D, s: results[0].proof.s, e: results[0].proof.e })) {
    fail('the aggregate does not verify against the joint key');
  }
  return results;
}

console.log('== the aggregate, three parties');
await runTable();
ok('all three in step: completes and verifies against the joint key');

console.log('\n== a stray envelope from a seat that is not at the table');
await runTable({ stray: true });
ok('ignored -- an outsider cannot stall the run (was: rejected every run, forever)');

console.log('\n== one party joins three seconds late');
await runTable({ lateSeat: 2 });
ok('late joiner catches up and everyone completes (was: all three waiting)');

console.log('\n== both at once');
await runTable({ lateSeat: 1, stray: true });
ok('late join and a stray together still complete');

console.log('\n== a party that opens its commitment with the wrong nonce');
{
  const bus = makeBus();
  const secrets = [11n, 22n, 33n].map((v) => v * 7919n + 13n);
  const keys = new Map(secrets.map((x, i) => [i, grumpkin.mulG(x)]));
  const shares = new Map(secrets.map((x, i) => [i, grumpkin.mul(x, H)]));
  const run = dealing.runAggregate({
    transport: bus.connect(), tableId: TABLE, position: POSITION, h: H,
    jointKey: [...keys.values()].reduce((a, p) => grumpkin.add(a, p), null),
    keys, shares, mySeat: 0, mySecret: secrets[0],
    timeoutMs: 8_000, proposerGraceMs: 500,
  });
  await new Promise((r) => setTimeout(r, 300));
  for (const seat of [1, 2]) {
    bus.inject({ tableId: TABLE, position: POSITION, from: seat, kind: 'nonce-commit',
      to: null, body: { commitment: '999' }, ephemeral: true });
  }
  await new Promise((r) => setTimeout(r, 200));
  // A reveal that does not open the commitment above. Parking must not have
  // turned this into something harmless.
  const bogus = grumpkin.mulG(12345n);
  bus.inject({ tableId: TABLE, position: POSITION, from: 1, kind: 'nonce-reveal',
    to: null, body: { r1: { x: bogus.x.toString(), y: bogus.y.toString() },
                      r2: { x: bogus.x.toString(), y: bogus.y.toString() } }, ephemeral: true });
  let threw = null;
  try { await run; } catch (e) { threw = e; }
  if (!threw) fail('a reveal that does not match its commitment was accepted');
  if (!/does not match its commitment/.test(String(threw.message))) {
    fail(`wrong failure: ${threw.message}`);
  }
  ok('still fatal -- equivocation is not softened by parking');
}

console.log('\nAggregate checks passed.');
