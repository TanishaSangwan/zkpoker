// End-to-end against the LOCALLY DEPLOYED stack, with real proofs throughout.
//
// Everything else in this repo tests one layer at a time: unit tests against
// mock verifiers, verifier tests against checked-in fixtures, the browser
// check against the client's own modules. This is the only thing that runs
// PokerGame -> VerifierAdapter -> the real Garaga verifiers on a real chain,
// which is exactly the seam round 8's finding I hid in -- the deck could not
// be opened at all against the real verifier while a mock said it could.
//
//   starknet-devnet --seed 0 --host 127.0.0.1 --port 5050 &
//   ./scripts/deploy_local.sh
//   node scripts/smoke_local.mjs
//
// Covers: key registration with real Schnorr PoKs, the joint key summed and
// checked on-chain, the full shuffle chain with real Honk proofs, and the deck
// opened in chunks with real Honk proofs. Buy-in is 0 -- escrow and betting
// are covered by 204 unit tests, and the point here is the cryptography.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Account, CallData, Contract, RpcProvider } from 'starknet';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.RPC ?? 'http://127.0.0.1:5050';
const ACCOUNTS = process.env.ACCOUNTS_FILE ?? `${process.env.HOME}/.starknet_accounts/starknet_open_zeppelin_accounts.json`;

const fail = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok    ${m}`);
const step = (m) => console.log(`\n== ${m}`);

// The client modules, bundled from source -- the same code the browser runs.
const outdir = join(root, 'node_modules/.cache/zkpoker');
const entry = join(outdir, 'smoke-entry.ts');
const { mkdirSync, writeFileSync } = await import('node:fs');
mkdirSync(outdir, { recursive: true });
writeFileSync(entry, `
export * as grumpkin from ${JSON.stringify(join(root, 'src/lib/grumpkin.ts'))};
export * as schnorr from ${JSON.stringify(join(root, 'src/lib/schnorr.ts'))};
export * as deck from ${JSON.stringify(join(root, 'src/lib/deck.ts'))};
export * as felt from ${JSON.stringify(join(root, 'src/lib/felt.ts'))};
export * as deckOpen from ${JSON.stringify(join(root, 'src/lib/deckOpen.ts'))};
`);
const bundle = join(outdir, 'smoke.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  outfile: bundle, external: ['garaga', 'starknet', '@aztec/bb.js', '@noir-lang/noir_js'], logLevel: 'warning' });
const { grumpkin, schnorr, deck, felt, deckOpen } = await import(pathToFileURL(bundle).href);
await schnorr.initProver();

const env = readFileSync(join(root, '.env.local'), 'utf8');
const readEnv = (k) => (env.match(new RegExp(`^${k}=(.*)$`, 'm')) ?? [])[1]?.trim();
const GAME = readEnv('NEXT_PUBLIC_POKERGAME_DEVNET');
const TOKEN = readEnv('NEXT_PUBLIC_DEVNET_TOKEN');
if (!GAME || GAME === '0x0') fail('NEXT_PUBLIC_POKERGAME_DEVNET is not set -- run scripts/deploy_local.sh');

const provider = new RpcProvider({ nodeUrl: RPC });
const accts = JSON.parse(readFileSync(ACCOUNTS, 'utf8'));
const net = Object.values(accts).find((n) => n.devnet0);
// starknet.js v10 takes an options object, not positional args -- the
// positional form silently gives `address === undefined` and dies inside the
// constructor.
const acct = (name) => new Account({ provider, address: net[name].address, signer: net[name].private_key });
const dealer = acct('devnet0');
const players = [acct('devnet0'), acct('devnet1')];

const abi = JSON.parse(
  readFileSync(join(root, 'cairo/target/dev/zkpoker_PokerGame.contract_class.json'), 'utf8'),
).abi;
const cd = new CallData(abi);
const view = new Contract({ abi, address: GAME, providerOrAccount: provider });

const call = (entrypoint, args) => ({ contractAddress: GAME, entrypoint, calldata: cd.compile(entrypoint, args) });
async function send(account, entrypoint, args) {
  const { transaction_hash } = await account.execute([call(entrypoint, args)]);
  const r = await provider.waitForTransaction(transaction_hash, { retries: 200, retryInterval: 500 });
  const status = r.execution_status ?? r.finality_status;
  if (status && String(status).includes('REVERTED')) fail(`${entrypoint} reverted: ${r.revert_reason}`);
  return transaction_hash;
}

// A fresh id per run by default: devnet keeps state between runs and
// create_table refuses to reuse one. TABLE_ID overrides it, which is how a
// named table gets left behind for the UI to open.
const TABLE = process.env.TABLE_ID
  ? '0x' + Buffer.from(process.env.TABLE_ID).toString('hex')
  : '0x' + Buffer.from(`SM${Date.now() % 100000}`).toString('hex');
console.log(`table id: ${TABLE}${process.env.TABLE_ID ? ` (${process.env.TABLE_ID})` : ''}`);
const SEATS = 2;
const hex = (v) => '0x' + v.toString(16);
const u256 = (v) => { const [low, high] = felt.u256Parts(v); return { low, high }; };

step('table + seats');
await send(dealer, 'create_table', { table_id: TABLE, token: TOKEN, buy_in: 0, max_seats: SEATS });
ok(`table created, ${SEATS} seats, buy-in 0`);
for (let s = 0; s < SEATS; s++) {
  await send(players[s], 'join_table', { table_id: TABLE, seat: String(s), hole_card_note_id: String(100 + s) });
}
ok('both seats joined');

step('key registration -- real Schnorr proofs, verified on-chain');
const keys = [];
for (let s = 0; s < SEATS; s++) {
  const key = schnorr.generateKey();
  const proof = schnorr.prove(key.secret);
  await send(players[s], 'register_shuffle_key', {
    table_id: TABLE, seat: String(s),
    pk_x: u256(proof.pk.x), pk_y: u256(proof.pk.y),
    key_proof: proof.calldata.map(hex),
  });
  keys.push(key);
  ok(`seat ${s} registered (Schnorr PoK accepted by the deployed verifier)`);
}

step('begin_shuffle -- the joint key is summed and checked on-chain');
const Y = schnorr.jointKey(keys.map((k) => k.pk));
await send(dealer, 'begin_shuffle', { table_id: TABLE, joint_pk_x: u256(Y.x), joint_pk_y: u256(Y.y) });
ok(`joint key accepted: SUM(pk_i) verified on Grumpkin by VerifierAdapter`);

const orderLen = Number(await view.get_shuffle_order_len(TABLE));
if (orderLen !== SEATS) fail(`shuffle order is ${orderLen}, expected ${SEATS}`);
ok(`chain length ${orderLen}`);

step('the shuffle chain -- real Honk proofs, one per seat');
// shuffle.ts touches browser globals in its environment probe, so it is
// bundled separately rather than through the shared entry. Always rebuilt --
// an earlier version of this script imported a cached bundle and spent two
// runs testing stale code.
const e2 = join(outdir, 'shuffle-entry.ts');
writeFileSync(e2, `export { proveShuffle } from ${JSON.stringify(join(root, 'src/lib/shuffle.ts'))};`);
await build({ entryPoints: [e2], bundle: true, format: 'esm', platform: 'node',
  outfile: join(outdir, 'shuffle.mjs'),
  external: ['garaga', '@aztec/bb.js', '@noir-lang/noir_js'], logLevel: 'warning' });
const { proveShuffle } = await import(
  pathToFileURL(join(outdir, 'shuffle.mjs')).href + `?v=${Date.now()}`);

const shuffleCircuit = JSON.parse(readFileSync(
  join(root, 'circuits/shuffle_verifier/example_proof/beta16_build/target/shuffle.json'), 'utf8'));
const openCircuit = JSON.parse(readFileSync(
  join(root, 'circuits/deck_open_verifier/example_proof/beta16_build/target/deck_open.json'), 'utf8'));

let current = deck.initialDeck();
for (let turn = 0; turn < SEATS; turn++) {
  const seat = Number(await view.get_shuffle_seat_at(TABLE, turn));
  const head = await view.get_shuffle_commitment(TABLE);
  const headBig = typeof head === 'bigint' ? head : (BigInt(head.high) << 128n) | BigInt(head.low);
  const t0 = Date.now();
  const r = await proveShuffle({ deckIn: current, jointKey: Y, commitmentIn: headBig, circuitJson: shuffleCircuit, wasmPath: null });
  await send(players[seat], 'submit_shuffle', {
    table_id: TABLE,
    new_commitment: u256(r.commitmentOut),
    deck: deck.deckToFields(r.deckOut).map((f) => u256(f)),
    proof: r.calldata.map(hex),
  });
  current = r.deckOut;
  ok(`position ${turn} (seat ${seat}): proof accepted on-chain in ${Date.now() - t0} ms, ` +
     `${r.calldata.length} felts`);
}
if (!(await view.get_shuffle_complete(TABLE))) fail('shuffle chain did not complete');
ok('shuffle chain complete');

step('open_deck -- real Honk proofs, chunked');
const finalHash = await deck.commitment(current);
const chunks = deckOpen.chunkCount(SEATS);
for (let chunk = 0; chunk < chunks; chunk++) {
  const t0 = Date.now();
  const r = await deckOpen.proveOpenChunk({ deck: current, deckHash: finalHash, maxSeats: SEATS, chunk, circuitJson: openCircuit, wasmPath: null });
  const args = deckOpen.openDeckArgs(TABLE, r);
  await send(dealer, 'open_deck', {
    table_id: TABLE, chunk, ciphertexts: args.ciphertexts, proof: r.calldata.map(hex),
  });
  ok(`chunk ${chunk} (positions ${r.positions.join(',')}): accepted in ${Date.now() - t0} ms`);
}
if (!(await view.get_deck_opened(TABLE))) fail('deck did not finish opening');
ok('deck opened');

step('what the contract now holds');
for (const pos of [0, 1, 2 * SEATS]) {
  const raw = await view.get_opened_ciphertext(TABLE, pos);
  const vals = (Array.isArray(raw) ? raw : [raw[0], raw[1], raw[2], raw[3]])
    .map((v) => (typeof v === 'bigint' ? v : (BigInt(v.high) << 128n) | BigInt(v.low)));
  const expected = deck.deckToFields(current).slice(4 * pos, 4 * pos + 4);
  const same = vals.every((v, i) => v === expected[i]);
  if (!same) fail(`position ${pos} stored a ciphertext that is not the final deck's`);
  ok(`position ${pos}: stored ciphertext matches the final deck`);
}

console.log('\nSmoke test passed: real Schnorr, real joint-key check, real shuffle chain, real deck opening.');
