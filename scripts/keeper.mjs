// The automated dealer.
//
// It turns out there is almost nothing to automate, and that is the
// interesting part. This protocol spent its whole design removing the trusted
// dealer, and what remains of the role is two calls:
//
//   begin_shuffle   freezes the participant list and pins the joint key
//                   (which the adapter VERIFIES, so it cannot be faked)
//   advance_street  moves a completed betting round on
//
// Everything else a dealer traditionally does -- shuffling, dealing, deciding
// who won, paying out -- is either done by the players themselves with proofs,
// or by a permissionless entrypoint anyone may call.
//
// ── Why this is a keeper and not an authority ──────────────────────────
//
// `advance_street` is permissionless. That matters more than the automation:
// if it were dealer-only, a keeper would be a LIVENESS DEPENDENCY -- offline
// keeper, stalled table, and no timeout covers it because at that point no
// player owes anything (docs/PROTOCOL.md §8.0). Making the call
// permissionless first means this script is a convenience that anyone can run,
// and any player can do its job instead. Automating a privileged dealer would
// have rebuilt the trusted party in software.
//
// So: run it, don't run it, run three of them. The only thing it can do is
// advance a hand that the contract already agrees is ready to advance.
//
//   node scripts/keeper.mjs <TABLE_ID>
//   ACCOUNT=devnet1 node scripts/keeper.mjs <TABLE_ID>   # any account
//   OPEN_DECK=0 node scripts/keeper.mjs <TABLE_ID>       # skip deck opening
//
// begin_shuffle IS automated, but only once the table is FULL.
//
// The earlier position here was that begin_shuffle is a judgement call and so
// should not be automated at all, because it freezes the participant list and
// starting early locks out players who have not sat down yet. That is right
// while seats are empty -- and it collapses when they are not. With every seat
// occupied and every seat's key registered there is nobody left to wait for,
// so there is no judgement left to make and nothing to be gained by making a
// human click.
//
// BEGIN=0 disables it if you want to hold a full table open anyway.
//
// Shuffling is NOT automated here and cannot be: each PLAYER shuffles with
// their own secret permutation, on their own device, because that permutation
// is the secret the protocol protects. A keeper that shuffled would be a
// keeper you had to trust. Players' clients do it themselves.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Account, CallData, Contract, RpcProvider } from 'starknet';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.RPC ?? 'http://127.0.0.1:5050';
const ACCOUNT = process.env.ACCOUNT ?? 'devnet0';
const POLL_MS = Number(process.env.POLL_MS ?? 4000);
const DO_OPEN = process.env.OPEN_DECK !== '0';
const DO_BEGIN = process.env.BEGIN !== '0';

const tableName = process.argv[2];
if (!tableName) { console.error('usage: node scripts/keeper.mjs <TABLE_ID>'); process.exit(1); }
const TABLE = '0x' + Buffer.from(tableName).toString('hex');

const env = readFileSync(join(root, '.env.local'), 'utf8');
const GAME = (env.match(/^NEXT_PUBLIC_POKERGAME_DEVNET=(.*)$/m) ?? [])[1]?.trim();
if (!GAME || GAME === '0x0') { console.error('no devnet deployment'); process.exit(1); }

const provider = new RpcProvider({ nodeUrl: RPC });
const accts = JSON.parse(readFileSync(`${process.env.HOME}/.starknet_accounts/starknet_open_zeppelin_accounts.json`, 'utf8'));
const net = Object.values(accts).find((n) => n[ACCOUNT]);
const me = new Account({ provider, address: net[ACCOUNT].address, signer: net[ACCOUNT].private_key });

const abi = JSON.parse(readFileSync(join(root, 'cairo/target/dev/zkpoker_PokerGame.contract_class.json'), 'utf8')).abi;
const cd = new CallData(abi);
const view = new Contract({ abi, address: GAME, providerOrAccount: provider });

async function send(entrypoint, args) {
  const { transaction_hash } = await me.execute([
    { contractAddress: GAME, entrypoint, calldata: cd.compile(entrypoint, args) },
  ]);
  const r = await provider.waitForTransaction(transaction_hash, { retries: 200, retryInterval: 500 });
  if (String(r.execution_status ?? '').includes('REVERTED')) throw new Error(`${entrypoint}: ${r.revert_reason}`);
  return transaction_hash;
}

// Deck opening needs a proof but no secret, so any party can carry it -- see
// PROTOCOL.md §7.3. Bundled in because a keeper that advances streets but
// leaves the deck shut is not much of a keeper.
let deckLib = null;
async function loadDeckLib() {
  const outdir = join(root, 'node_modules/.cache/zkpoker');
  const e = join(outdir, 'keeper-entry.ts');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(outdir, { recursive: true });
  writeFileSync(e, `
export * as grumpkin from ${JSON.stringify(join(root, 'src/lib/grumpkin.ts'))};
export * as schnorr from ${JSON.stringify(join(root, 'src/lib/schnorr.ts'))};
export * as deck from ${JSON.stringify(join(root, 'src/lib/deck.ts'))};
export * as deckOpen from ${JSON.stringify(join(root, 'src/lib/deckOpen.ts'))};
export { readPublishedDeck, findDeckPublishedTx } from ${JSON.stringify(join(root, 'src/lib/publishedDeck.ts'))};
`);
  await build({ entryPoints: [e], bundle: true, format: 'esm', platform: 'node',
    outfile: join(outdir, 'keeper.mjs'),
    external: ['garaga', 'starknet', '@aztec/bb.js', '@noir-lang/noir_js'], logLevel: 'error' });
  deckLib = await import(pathToFileURL(join(outdir, 'keeper.mjs')).href + `?v=${Date.now()}`);
  return deckLib;
}

async function openChunk(maxSeats) {
  if (!deckLib) await loadDeckLib();
  const { deck, deckOpen, readPublishedDeck, findDeckPublishedTx } = deckLib;
  const expected = BigInt(await view.get_published_deck_hash(TABLE));
  const tx = await findDeckPublishedTx({ provider, contract: GAME, tableId: TABLE });
  if (!tx) throw new Error('no published deck yet');
  const d = await readPublishedDeck({ provider, txHash: tx, expectedHash: expected });
  if (!d) throw new Error('published deck did not read back');
  const chunk = Number(await view.get_deck_open_chunk(TABLE));
  const circuitJson = JSON.parse(readFileSync(
    join(root, 'circuits/deck_open_verifier/example_proof/beta16_build/target/deck_open.json'), 'utf8'));
  const r = await deckOpen.proveOpenChunk({
    deck: d, deckHash: await deck.commitment(d), maxSeats, chunk, circuitJson, wasmPath: null });
  const args = deckOpen.openDeckArgs(TABLE, r);
  return send('open_deck', {
    table_id: TABLE, chunk, ciphertexts: args.ciphertexts,
    proof: r.calldata.map((v) => '0x' + v.toString(16)),
  });
}

console.log(`keeper on ${tableName} as ${ACCOUNT} (${me.address.slice(0, 10)}…)`);
console.log('advance_street is permissionless, so this holds no authority --');
console.log('any player can do its job, and nothing stalls if it stops.\n');

let lastNote = '';
const note = (m) => { if (m !== lastNote) { console.log(`  ${m}`); lastNote = m; } };

for (;;) {
  try {
    if (BigInt(await view.get_table_dealer(TABLE)) === 0n) { note('waiting for the table to exist'); }
    else if (await view.get_table_voided(TABLE)) { console.log('  table voided -- nothing to keep'); break; }
    else if (await view.get_table_settled(TABLE)) { console.log('  table settled -- done'); break; }
    else {
      const maxSeats = Number(await view.get_table_max_seats(TABLE));
      const started = await view.get_shuffle_started(TABLE);
      const complete = await view.get_shuffle_complete(TABLE);
      const opened = await view.get_deck_opened(TABLE);

      if (!started) {
        // Every seat occupied AND registered -- nobody left to wait for.
        let seated = 0, registered = 0;
        for (let seat = 0; seat < maxSeats; seat++) {
          if (BigInt(await view.get_seat_owner(TABLE, String(seat))) === 0n) continue;
          seated += 1;
          if (await view.get_seat_key_registered(TABLE, String(seat))) registered += 1;
        }
        if (!DO_BEGIN) {
          note(`shuffle not open (BEGIN=0); ${seated}/${maxSeats} seated, ${registered} registered`);
        } else if (seated < maxSeats || registered < seated) {
          note(`waiting for the table to fill: ${seated}/${maxSeats} seated, ${registered} registered`);
        } else if (BigInt(await view.get_table_dealer(TABLE)) !== BigInt(me.address)) {
          // begin_shuffle is still dealer-only on-chain, for the reason in the
          // header: a full table is unambiguous, an empty seat is not.
          note('table is full but this keeper is not the dealer');
        } else {
          // Sum the registered shares and let the adapter check the answer --
          // it verifies Y == SUM(pk_i) on Grumpkin, so a wrong sum is rejected
          // rather than quietly accepted.
          if (!deckLib) await loadDeckLib();
          const { grumpkin, schnorr } = deckLib;
          const shares = [];
          for (let seat = 0; seat < maxSeats; seat++) {
            const raw = await view.get_seat_pk(TABLE, String(seat));
            const [x, y] = (Array.isArray(raw) ? raw : [raw[0], raw[1]]).map(
              (v) => (typeof v === 'bigint' ? v : (BigInt(v.high) << 128n) | BigInt(v.low)),
            );
            if (x === 0n && y === 0n) continue;
            shares.push({ x, y });
          }
          const Y = schnorr.jointKey(shares);
          if (Y === null) throw new Error('registered shares sum to the identity');
          const u256 = (v) => ({ low: v & ((1n << 128n) - 1n), high: v >> 128n });
          console.log(`  table full (${seated}/${maxSeats}) -- opening the shuffle`);
          console.log(`  begin_shuffle ok  ${await send('begin_shuffle', {
            table_id: TABLE, joint_pk_x: u256(Y.x), joint_pk_y: u256(Y.y),
          })}`);
          lastNote = '';
        }
      } else if (!complete) {
        note(`shuffle chain at ${Number(await view.get_shuffle_turn(TABLE))}/${Number(await view.get_shuffle_order_len(TABLE))} -- players are proving`);
      } else if (!opened && DO_OPEN) {
        const chunk = Number(await view.get_deck_open_chunk(TABLE));
        console.log(`  opening deck chunk ${chunk}…`);
        console.log(`  open_deck ok  ${await openChunk(maxSeats)}`);
        lastNote = '';
      } else if (!opened) {
        note('deck not opened (OPEN_DECK=0)');
      } else if (Number(await view.get_table_street(TABLE)) === 4) {
        // Settle once every seat still in the hand has either shown or been
        // given the chance to. settle_from_reveals takes no input beyond the
        // table -- every card comes from storage a reveal proof bound, every
        // payout note from join_table -- so anyone may call it and nobody can
        // steer it, which is exactly why a keeper is allowed to.
        //
        // A seat that declines to show simply does not win; mucking forfeits
        // rather than blocking, so a hand where somebody stays quiet still
        // resolves for everyone else.
        let contenders = 0, shown = 0;
        for (let seat = 0; seat < maxSeats; seat++) {
          if (BigInt(await view.get_seat_owner(TABLE, String(seat))) === 0n) continue;
          if (await view.get_seat_folded(TABLE, String(seat))) continue;
          contenders += 1;
          if (await view.get_hole_revealed(TABLE, String(seat), 0)
              && await view.get_hole_revealed(TABLE, String(seat), 1)) shown += 1;
        }
        if (shown === contenders && contenders > 0) {
          console.log(`  showdown: ${shown}/${contenders} shown -- settling`);
          console.log(`  settle_from_reveals ok  ${await send('settle_from_reveals', { table_id: TABLE })}`);
          lastNote = '';
        } else {
          note(`showdown: ${shown}/${contenders} hands shown`);
        }
      } else if (await view.get_round_complete(TABLE)) {
        const from = Number(await view.get_table_street(TABLE));
        console.log(`  round complete on street ${from} -- advancing`);
        console.log(`  advance_street ok  ${await send('advance_street', { table_id: TABLE })}`);
        lastNote = '';
      } else {
        note(`street ${Number(await view.get_table_street(TABLE))}, waiting on seat ${Number(await view.get_action_turn(TABLE))}`);
      }
    }
  } catch (e) {
    console.error(`  ! ${String(e.message ?? e).slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
