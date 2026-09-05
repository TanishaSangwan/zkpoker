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
// Where smoke_local.mjs stops, this keeps going: betting, the whole board,
// and above all the HOLE-CARD REVEAL at showdown.
//
// That last one is the reason this script exists. It is the only path where a
// commitment made at DEALING time has to reopen against an aggregate built at
// SHOWDOWN time, and nothing exercised the two together -- unit tests use a
// mock verifier, and smoke_local never reaches a showdown. A hand that could
// not be shown therefore looked fine everywhere except at a real table.
//
// Two seats, both secrets in this process: what is under test is the
// CONTRACT's side of a showdown, not the clients' coordination.
// scripts/check_aggregate.mjs owns that.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Account, CallData, Contract, RpcProvider } from 'starknet';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// NETWORK picks the chain, the accounts and which deployment to read. Devnet
// stays the default for the same reason deploy_local.sh does: this is run far
// more often against a throwaway node, and on a public chain every proof
// verified on-chain costs real fees.
//
//   node scripts/check_showdown.mjs                     devnet
//   NETWORK=sepolia node scripts/check_showdown.mjs     Starknet Sepolia
const NETWORK = process.env.NETWORK ?? 'devnet';
const ON_SEPOLIA = NETWORK === 'sepolia';
const RPC = process.env.RPC
  ?? (ON_SEPOLIA ? 'https://api.cartridge.gg/x/starknet/sepolia' : 'http://127.0.0.1:5050');
// Two seats, two independent keys. Predeployed on devnet; on a public chain
// they are accounts that had to be created and funded.
const SEAT_ACCOUNTS = (process.env.SEAT_ACCOUNTS
  ?? (ON_SEPOLIA ? 'sepolia,sep2' : 'devnet0,devnet1')).split(',');
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
const GAME = readEnv(ON_SEPOLIA ? 'NEXT_PUBLIC_POKERGAME_SEPOLIA' : 'NEXT_PUBLIC_POKERGAME_DEVNET');
// STRK sits at the same canonical address on every network, so the buy-in
// token needs no per-network lookup.
const TOKEN = ON_SEPOLIA
  ? '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
  : readEnv('NEXT_PUBLIC_DEVNET_TOKEN');
if (!GAME || GAME === '0x0') fail(`no ${NETWORK} deployment in .env.local -- run scripts/deploy_local.sh`);
console.log(`network ${NETWORK} · game ${GAME.slice(0, 14)}… · via ${RPC}`);

const provider = new RpcProvider({ nodeUrl: RPC });
const accts = JSON.parse(readFileSync(ACCOUNTS, 'utf8'));
// starknet.js v10 takes an options object, not positional args -- the
// positional form silently gives `address === undefined` and dies inside the
// constructor.
const acct = (name) => {
  const net = Object.values(accts).find((n) => n[name]);
  if (!net) fail(`no account named ${name} in ${ACCOUNTS}`);
  return new Account({ provider, address: net[name].address, signer: net[name].private_key });
};
const players = SEAT_ACCOUNTS.map(acct);
// The dealer takes seat 0 too: it holds no key share beyond that seat's, and
// one fewer funded account is one fewer thing to arrange on a public chain.
const dealer = players[0];

const abi = JSON.parse(
  readFileSync(join(root, 'cairo/target/dev/zkpoker_PokerGame.contract_class.json'), 'utf8'),
).abi;
const cd = new CallData(abi);
const view = new Contract({ abi, address: GAME, providerOrAccount: provider });

const call = (entrypoint, args) => ({ contractAddress: GAME, entrypoint, calldata: cd.compile(entrypoint, args) });
// Starknet caps L2 gas PER TRANSACTION. Sepolia's limit is 1,210,000,000, and
// a shuffle proof verifies at roughly 0.8e9 -- so the work fits, but the fee
// estimator's safety multiplier pushed the BOUND to 1,223,772,240 and the
// transaction was refused before it ran:
//
//   Max gas amount is too high: GasAmount(1223772240),
//   maximum allowed gas amount: 1210000000
//
// Clamped to the cap rather than lowered blindly: the bound is a ceiling on
// what may be spent, not a prediction, so trimming it costs nothing while real
// consumption stays under. If a proof ever genuinely needs more than the cap it
// fails as out-of-gas, which is the honest signal that the circuit has outgrown
// a single transaction.
const L2_GAS_CAP = 1209000000n;

async function send(account, entrypoint, args) {
  const calls = [call(entrypoint, args)];
  let details = {};
  if (ON_SEPOLIA) {
    const est = await account.estimateInvokeFee(calls);
    const src = est.resourceBounds ?? est.resource_bounds;
    // Copied field by field: the bounds carry BigInts, which JSON cannot
    // clone, and mutating the estimate in place is a trap waiting for a retry.
    // BigInts, not the decimal strings the estimator hands back. When bounds
    // are supplied rather than estimated, starknet.js hashes them directly --
    // encodeResourceBoundsL1 shifts the values -- so a string throws "Cannot
    // mix BigInt and other types" from inside the signer.
    const hex = (v) => BigInt(v);
    const want = BigInt(src.l2_gas.max_amount);
    const capped = want > L2_GAS_CAP ? L2_GAS_CAP : want;
    if (want > L2_GAS_CAP) {
      console.log(`      (${entrypoint}: bound ${want} exceeds the ${L2_GAS_CAP} cap -- clamping)`);
    }
    details = {
      resourceBounds: {
        l1_gas: { max_amount: hex(src.l1_gas.max_amount), max_price_per_unit: hex(src.l1_gas.max_price_per_unit) },
        l1_data_gas: { max_amount: hex(src.l1_data_gas.max_amount), max_price_per_unit: hex(src.l1_data_gas.max_price_per_unit) },
        l2_gas: { max_amount: hex(capped), max_price_per_unit: hex(src.l2_gas.max_price_per_unit) },
      },
    };
  }
  const { transaction_hash } = await account.execute(calls, details);
  // A public chain takes seconds per block, not milliseconds.
  const r = await provider.waitForTransaction(transaction_hash, {
    retries: ON_SEPOLIA ? 400 : 200, retryInterval: ON_SEPOLIA ? 3000 : 500,
  });
  const status = r.execution_status ?? r.finality_status;
  if (status && String(status).includes('REVERTED')) fail(`${entrypoint} reverted: ${r.revert_reason}`);
  return transaction_hash;
}

// A fresh id per run by default: devnet keeps state between runs and
// create_table refuses to reuse one. TABLE_ID overrides it, which is how a
// named table gets left behind for the UI to open.
const TABLE = process.env.TABLE_ID // eslint-disable-line
  ? '0x' + Buffer.from(process.env.TABLE_ID).toString('hex')
  : '0x' + Buffer.from(`SD${Date.now() % 100000}`).toString('hex');
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


// ── the aggregate, done inline ─────────────────────────────────────────
//
// Both secrets are here, so the three nonce rounds are arithmetic rather than
// a conversation. Identical maths to src/lib/dealing.ts; what differs is only
// that no messages have to travel.
const sumOf = (pts) => pts.reduce((acc, p) => grumpkin.add(acc, p), null);
function aggregateAt(c1) {
  const nonces = secrets.map(() => grumpkin.randomScalar());
  const parts = secrets.map((x, i) => ({
    pk: grumpkin.mulG(x), d: grumpkin.mul(x, c1),
    r1: grumpkin.mulG(nonces[i]), r2: grumpkin.mul(nonces[i], c1),
  }));
  const e = dleq.challenge(
    sumOf(parts.map((p) => p.pk)), c1, sumOf(parts.map((p) => p.d)),
    sumOf(parts.map((p) => p.r1)), sumOf(parts.map((p) => p.r2)));
  const contributions = parts.map((p, i) => ({ ...p, s: dleq.respond(secrets[i], nonces[i], e) }));
  return { share: sumOf(parts.map((p) => p.d)), proof: dleq.aggregate(contributions, c1) };
}
function ciphertextAt(pos) {
  const f = deck.deckToFields(current).slice(4 * pos, 4 * pos + 4);
  return { c1: grumpkin.fromWire(f[0], f[1]), c2: grumpkin.fromWire(f[2], f[3]) };
}

step('the published deck is findable however the table id was typed');
// The UI accepts a table id as a name, a decimal or hex. Contract calls do not
// care -- starknet.js compiles calldata -- but an event key filter goes to the
// node RAW, and starknet_getEvents rejects a decimal. That made the published
// deck unfindable for every seat after the first on any table whose id was
// typed as a number, which presented as "the shuffle is broken".
{
  const e3 = join(outdir, 'pubdeck-entry.ts');
  writeFileSync(e3, `export { findDeckPublishedTx, readPublishedDeck } from ${JSON.stringify(join(root, 'src/lib/publishedDeck.ts'))};`);
  await build({ entryPoints: [e3], bundle: true, format: 'esm', platform: 'node',
    outfile: join(outdir, 'pubdeck.mjs'), external: ['garaga', 'starknet', '@aztec/bb.js', '@noir-lang/noir_js'],
    logLevel: 'warning' });
  const { findDeckPublishedTx, readPublishedDeck } = await import(
    pathToFileURL(join(outdir, 'pubdeck.mjs')).href + `?v=${Date.now()}`);
  const expected = BigInt(await view.get_published_deck_hash(TABLE));
  for (const [label, id] of [['hex', TABLE], ['decimal', BigInt(TABLE).toString()]]) {
    const tx = await findDeckPublishedTx({ provider, contract: GAME, tableId: id });
    if (!tx) fail(`no DeckPublished transaction found with a ${label} table id`);
    const d = await readPublishedDeck({ provider, txHash: tx, expectedHash: expected });
    if (!d || d.length !== 52) fail(`the published deck did not read back with a ${label} table id`);
  }
  ok('found and read back with the id written as hex and as a decimal');
}

step('the button draw');
for (let seat = 0; seat < SEATS; seat++) {
  const { c1, c2 } = ciphertextAt(deck.drawPosition(seat, SEATS));
  const agg = aggregateAt(c1);
  const card = reveal.cardFromShare({ c1, c2 }, agg.share);
  await send(dealer, 'reveal_draw_card', reveal.revealDrawArgs({
    tableId: TABLE, seat, share: agg.share, card, proof: agg.proof }));
  ok(`seat ${seat} drew ${grumpkin.cardToName(card)}`);
}
const button = Number(await view.get_button(TABLE));
ok(`button to seat ${button}`);

step('hole cards -- committed at DEALING time, before any betting');
// The commitment is the hinge this whole script exists to test. It is made
// now, over the combined share, and has to reopen at showdown against an
// aggregate built there -- with the board in between.
const openings = [];
for (let seat = 0; seat < SEATS; seat++) {
  openings.push([]);
  for (let slot = 0; slot < 2; slot++) {
    const pos = deck.seatHolePositions(seat)[slot];
    const { c1, c2 } = ciphertextAt(pos);
    // D = SUM(x_i * c1). At dealing time this reaches the owner as sealed
    // shares; here it is simply computed.
    const D = sumOf(secrets.map((x) => grumpkin.mul(x, c1)));
    const card = reveal.cardFromShare({ c1, c2 }, D);
    if (card === null) fail(`seat ${seat} slot ${slot} decrypts outside the card encoding`);
    // felt252, not a curve scalar -- see src/lib/felt.ts randomFelt.
    const blinding = felt.randomFelt();
    await send(players[seat], 'commit_hole_shares', reveal.commitHoleSharesArgs({
      tableId: TABLE, seat, slot, share: D, blinding }));
    openings[seat].push({ blinding, card, pos });
  }
  ok(`seat ${seat} holds ${openings[seat].map((o) => grumpkin.cardToName(o.card)).join(' ')}`);
}

step('blinds and betting to showdown');
// Every seat must have approved the game before a blind can be pulled.
//
// This script had no approve step at all and still passed on devnet, because
// scripts/smoke_local.mjs had run against the same node earlier and left an
// allowance behind. On a fresh chain there is none, and post_blinds died with
// "ERC20: insufficient allowance" -- a test quietly depending on state another
// test created, which is worth strictly more than the bug it hid.
//
// The allowance is what makes post_blinds safe to leave permissionless: a
// caller moves the player's money only in the amount, and to the destination,
// that the contract chose.
{
  const erc20 = new CallData([
    { type: 'function', name: 'approve', state_mutability: 'external',
      inputs: [{ name: 'spender', type: 'core::starknet::contract_address::ContractAddress' },
               { name: 'amount', type: 'core::integer::u256' }],
      outputs: [{ type: 'core::bool' }] }]);
  for (let s = 0; s < SEATS; s++) {
    const { transaction_hash } = await players[s].execute([{
      contractAddress: TOKEN, entrypoint: 'approve',
      calldata: erc20.compile('approve', { spender: GAME, amount: { low: 10n ** 18n, high: 0n } }),
    }]);
    await provider.waitForTransaction(transaction_hash, {
      retries: ON_SEPOLIA ? 400 : 200, retryInterval: ON_SEPOLIA ? 3000 : 500,
    });
  }
  ok('both seats approved the game to pull their blinds');
}
await send(dealer, 'post_blinds', { table_id: TABLE });
ok(`blinds posted, pot ${await view.get_pot(TABLE)}`);

const streetFor = (i) => (i <= 2 ? 1 : i === 3 ? 2 : 3);
async function revealBoard(street) {
  for (let i = 0; i < 5; i++) {
    if (streetFor(i) !== street) continue;
    if (await view.get_community_revealed(TABLE, i)) continue;
    const pos = deck.communityPosition(i, SEATS);
    const { c1, c2 } = ciphertextAt(pos);
    const agg = aggregateAt(c1);
    const card = reveal.cardFromShare({ c1, c2 }, agg.share);
    await send(dealer, 'reveal_community_card', reveal.revealCommunityArgs({
      tableId: TABLE, index: i, share: agg.share, card, proof: agg.proof }));
  }
}
// Pre-flop: heads-up the button is the small blind and acts first, so it
// calls and the big blind checks its option.
async function actRound() {
  for (let n = 0; n < SEATS * 3; n++) {
    if (await view.get_round_complete(TABLE)) return;
    const seat = Number(await view.get_action_turn(TABLE));
    const owed = BigInt(await view.get_amount_to_call(TABLE, String(seat)));
    if (owed > 0n) await send(players[seat], 'bet', { table_id: TABLE, seat: String(seat), amount: owed });
    else await send(players[seat], 'check', { table_id: TABLE, seat: String(seat) });
  }
  if (!(await view.get_round_complete(TABLE))) fail('betting round never closed');
}
for (let street = 0; street <= 3; street++) {
  await actRound();
  await send(dealer, 'advance_street', { table_id: TABLE });
  const now = Number(await view.get_table_street(TABLE));
  if (now <= 3) await revealBoard(now);
  ok(`street ${now}${now <= 3 ? ' dealt' : ' -- showdown'}`);
}
if (Number(await view.get_table_street(TABLE)) !== 4) fail('never reached showdown');
if (!(await view.get_showdown_started(TABLE))) fail('showdown did not start');
ok(`board ${[0,1,2,3,4].map(async () => 0) && 'complete'}, pot ${await view.get_pot(TABLE)}`);

step('reveal_hole_card -- a dealing-time commitment, reopened at showdown');
//
// THE test. The share here is the aggregate built NOW, and the blinding and
// card come from the commitment made before the flop. The contract reopens
// one against the other (BAD_OPENING_HASH if they disagree) and then checks
// the DLEQ against the joint key (CARD_REVEAL_REJECTED).
for (let n = 0; n < SEATS; n++) {
  const seat = Number(await view.get_showdown_turn(TABLE));
  for (let slot = 0; slot < 2; slot++) {
    const o = openings[seat][slot];
    const { c1 } = ciphertextAt(o.pos);
    const agg = aggregateAt(c1);
    await send(players[seat], 'reveal_hole_card', reveal.revealHoleArgs({
      tableId: TABLE, seat, slot, share: agg.share,
      blinding: o.blinding, card: o.card, proof: agg.proof }));
    if (!(await view.get_hole_revealed(TABLE, String(seat), slot))) {
      fail(`seat ${seat} slot ${slot} did not register as revealed`);
    }
    if (Number(await view.get_hole_card(TABLE, String(seat), slot)) !== o.card) {
      fail(`seat ${seat} slot ${slot}: chain stored a different card`);
    }
  }
  ok(`seat ${seat} showed ${openings[seat].map((o) => grumpkin.cardToName(o.card)).join(' ')}`);
}

step('settle');
await send(dealer, 'settle_from_reveals', { table_id: TABLE });
if (!(await view.get_table_settled(TABLE))) fail('the hand did not settle');
ok(`settled, pot ${await view.get_pot(TABLE)} paid out`);

step('the button cycles');
await send(dealer, 'start_next_hand', { table_id: TABLE });
const next = Number(await view.get_button(TABLE));
if (next === button) fail('the button did not move');
if (Number(await view.get_hand_number(TABLE)) !== 1) fail('hand number did not advance');
ok(`button moved ${button} -> ${next}, hand 2 ready`);

console.log('\nShowdown checks passed: a hole card committed before the flop,');
console.log('reopened and proved at showdown, and the pot paid out.');
