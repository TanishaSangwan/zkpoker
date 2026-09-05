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
// checked on-chain, the full shuffle chain with real Honk proofs, the deck
// opened in chunks with real Honk proofs, and the button DRAWN from that deck
// with a real aggregate Chaum-Pedersen DLEQ per seat. Buy-in is 0 -- escrow
// and betting are covered by unit tests, and the point here is the
// cryptography.
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
export * as dleq from ${JSON.stringify(join(root, 'src/lib/dleq.ts'))};
export * as reveal from ${JSON.stringify(join(root, 'src/lib/reveal.ts'))};
`);
const bundle = join(outdir, 'smoke.mjs');
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node',
  outfile: bundle, external: ['garaga', 'starknet', '@aztec/bb.js', '@noir-lang/noir_js'], logLevel: 'warning' });
const { grumpkin, schnorr, deck, felt, deckOpen, dleq, reveal } = await import(pathToFileURL(bundle).href);
await schnorr.initProver();
await dleq.initProver();

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
// The blind structure. Set before the shuffle -- the stakes are fixed before a
// single card exists, so they cannot be tuned to a deal.
const SMALL = 10n, BIG = 20n;
const hex = (v) => '0x' + v.toString(16);
const u256 = (v) => { const [low, high] = felt.u256Parts(v); return { low, high }; };

step('table + seats');
await send(dealer, 'create_table', { table_id: TABLE, token: TOKEN, buy_in: 0, max_seats: SEATS });
await send(dealer, 'set_blinds', { table_id: TABLE, small_blind: SMALL, big_blind: BIG });
ok(`table created, ${SEATS} seats, buy-in 0, blinds ${SMALL}/${BIG}`);
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
// generateKey() already normalises to even y, so these are the secrets that
// actually match the registered shares -- the negated ones would verify
// nothing.
const secrets = keys.map((k) => k.secret);

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

step('the button draw -- one card per seat, real aggregate DLEQ');
//
// This is the part no mock can stand in for. The card that decides who posts
// which blind is an ordinary deck position, so reading it needs a decryption
// share from EVERY seat, aggregated into one Chaum-Pedersen DLEQ against the
// joint key, and the deployed DleqVerifier has to accept it and agree the
// recovered point really is the claimed card.
//
// Both secrets live in this process, so the three nonce rounds are done
// inline rather than over the relay -- the arithmetic is identical, and what
// is being tested here is the chain's side of it.
const drawn = [];
for (let seat = 0; seat < SEATS; seat++) {
  const t0 = Date.now();
  const pos = deck.drawPosition(seat, SEATS);
  const ctFields = deck.deckToFields(current).slice(4 * pos, 4 * pos + 4);
  const c1 = grumpkin.fromWire(ctFields[0], ctFields[1]);
  const c2 = grumpkin.fromWire(ctFields[2], ctFields[3]);

  // Round 1: each party picks a nonce. Round 2: the points are revealed and
  // the challenge is taken over the SUMS. Round 3: each party responds.
  const nonces = secrets.map(() => grumpkin.randomScalar());
  const parts = secrets.map((x, i) => ({
    pk: grumpkin.mulG(x),
    d: grumpkin.mul(x, c1),
    r1: grumpkin.mulG(nonces[i]),
    r2: grumpkin.mul(nonces[i], c1),
  }));
  const sumOf = (pts) => pts.reduce((acc, p) => grumpkin.add(acc, p), null);
  const e = dleq.challenge(
    sumOf(parts.map((p) => p.pk)), c1, sumOf(parts.map((p) => p.d)),
    sumOf(parts.map((p) => p.r1)), sumOf(parts.map((p) => p.r2)),
  );
  const contributions = parts.map((p, i) => ({ ...p, s: dleq.respond(secrets[i], nonces[i], e) }));
  const proof = dleq.aggregate(contributions, c1);

  const share = sumOf(parts.map((p) => p.d));
  const card = reveal.cardFromShare({ c1, c2 }, share);
  if (card === null) fail(`seat ${seat}'s draw did not decrypt to a card`);

  await send(dealer, 'reveal_draw_card', reveal.revealDrawArgs({
    tableId: TABLE, seat, share, card, proof,
  }));
  const stored = Number(await view.get_draw_card(TABLE, String(seat)));
  if (stored !== card) fail(`seat ${seat}: chain stored card ${stored}, client computed ${card}`);
  drawn.push(card);
  ok(`seat ${seat} drew ${grumpkin.cardToName(card)} at position ${pos} ` +
     `(aggregate DLEQ accepted on-chain in ${Date.now() - t0} ms)`);
}

if (!(await view.get_button_set(TABLE))) fail('every seat drew and no button was set');
const button = Number(await view.get_button(TABLE));
// Rank decides, suit breaks the tie -- the same total order the contract uses.
const best = drawn.reduce((b, c, i) => {
  const r = c % 13, br = drawn[b] % 13;
  return r > br || (r === br && c > drawn[b]) ? i : b;
}, 0);
if (button !== best) {
  fail(`button went to seat ${button}, but seat ${best} drew highest (${drawn.join(', ')})`);
}
ok(`button to seat ${button} -- the highest draw, decided by the deck and nobody else`);

step('post_blinds -- forced bets, from the button');
{
  // Blinds move real tokens, so each seat must have approved the game. That
  // approval is what makes post_blinds safe to leave permissionless: a caller
  // moves the player's money only in the amount and to the destination the
  // contract chose.
  const erc20 = new CallData([
    { type: 'function', name: 'approve', state_mutability: 'external',
      inputs: [{ name: 'spender', type: 'core::starknet::contract_address::ContractAddress' },
               { name: 'amount', type: 'core::integer::u256' }],
      outputs: [{ type: 'core::bool' }] },
  ]);
  for (const p of players) {
    const { transaction_hash } = await p.execute([{
      contractAddress: TOKEN, entrypoint: 'approve',
      calldata: erc20.compile('approve', { spender: GAME, amount: { low: 1000n, high: 0n } }),
    }]);
    await provider.waitForTransaction(transaction_hash, { retries: 200, retryInterval: 500 });
  }
  await send(players[1], 'post_blinds', { table_id: TABLE });
  const sb = Number(await view.get_street_contributed(TABLE, String(button)));
  const other = (button + 1) % SEATS;
  const bb = Number(await view.get_street_contributed(TABLE, String(other)));
  // Heads-up the button posts the SMALL blind. Getting this backwards is the
  // classic hold'em implementation bug.
  if (sb !== Number(SMALL)) fail(`button posted ${sb}, expected the small blind ${SMALL}`);
  if (bb !== Number(BIG)) fail(`seat ${other} posted ${bb}, expected the big blind ${BIG}`);
  if (Number(await view.get_pot(TABLE)) !== Number(SMALL + BIG)) fail('pot does not hold both blinds');
  if (Number(await view.get_action_turn(TABLE)) !== button) {
    fail('heads-up, the small blind acts first pre-flop');
  }
  ok(`seat ${button} posted ${SMALL} (small, on the button), seat ${other} posted ${BIG} (big)`);
  ok(`pot ${await view.get_pot(TABLE)}, action to seat ${button} -- the small blind, heads-up`);
}

console.log('\nSmoke test passed: real Schnorr, real joint-key check, real shuffle chain,');
console.log('real deck opening, a button drawn from the deck with a real aggregate DLEQ,');
console.log('and blinds posted from it.');
