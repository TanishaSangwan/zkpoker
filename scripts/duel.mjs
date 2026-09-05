// Drives ONE seat of a table from the terminal, so a human can take another
// seat in the browser and the two actually play each other.
//
// Deliberately one seat: scripts/smoke_local.mjs drives every seat and can
// therefore see every hand, which makes it a fine integration test and a
// meaningless game. Here the terminal seat's key lives in this file's state
// and the browser seat's key lives in that browser's localStorage, so neither
// side can compute the other's cards -- which is the property the whole
// protocol exists to provide, and the only way to actually exercise it.
//
//   node scripts/duel.mjs create <TABLE_ID>   # create, take seat 0, register
//   node scripts/duel.mjs status <TABLE_ID>
//   node scripts/duel.mjs begin  <TABLE_ID>   # dealer opens the shuffle
//   node scripts/duel.mjs shuffle <TABLE_ID>  # my turn in the chain
//   node scripts/duel.mjs open   <TABLE_ID>   # open the deck, one chunk
//   node scripts/duel.mjs check  <TABLE_ID>   # check/call on my turn
//   node scripts/duel.mjs street <TABLE_ID>   # advance the street (dealer)
//
// State (my seat secret included) lives in .duel-<TABLE_ID>.json, untracked.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { Account, CallData, Contract, RpcProvider } from 'starknet';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.RPC ?? 'http://127.0.0.1:5050';
const MY_SEAT = Number(process.env.MY_SEAT ?? 0);
const MY_ACCOUNT = process.env.MY_ACCOUNT ?? 'devnet0';

const [cmd, tableName] = process.argv.slice(2);
if (!cmd || !tableName) { console.error('usage: node scripts/duel.mjs <cmd> <TABLE_ID>'); process.exit(1); }
const TABLE = '0x' + Buffer.from(tableName).toString('hex');
const statePath = join(root, `.duel-${tableName}.json`);
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

// The client modules, bundled from source -- the same code the browser runs.
const outdir = join(root, 'node_modules/.cache/zkpoker');
const mk = async (name, exports) => {
  const e = join(outdir, `${name}-entry.ts`);
  writeFileSync(e, exports);
  await build({ entryPoints: [e], bundle: true, format: 'esm', platform: 'node',
    outfile: join(outdir, `${name}.mjs`), external: ['garaga', 'starknet', '@aztec/bb.js', '@noir-lang/noir_js'],
    logLevel: 'error' });
  return import(pathToFileURL(join(outdir, `${name}.mjs`)).href + `?v=${Date.now()}`);
};
const lib = await mk('duel', `
export * as grumpkin from ${JSON.stringify(join(root, 'src/lib/grumpkin.ts'))};
export * as schnorr from ${JSON.stringify(join(root, 'src/lib/schnorr.ts'))};
export * as deck from ${JSON.stringify(join(root, 'src/lib/deck.ts'))};
export * as felt from ${JSON.stringify(join(root, 'src/lib/felt.ts'))};
export * as deckOpen from ${JSON.stringify(join(root, 'src/lib/deckOpen.ts'))};
export { proveShuffle } from ${JSON.stringify(join(root, 'src/lib/shuffle.ts'))};
export * as dealing from ${JSON.stringify(join(root, 'src/lib/dealing.ts'))};
export * as reveal from ${JSON.stringify(join(root, 'src/lib/reveal.ts'))};
export * as shares from ${JSON.stringify(join(root, 'src/lib/shares.ts'))};
export { RelayTransport } from ${JSON.stringify(join(root, 'src/lib/relayTransport.ts'))};
export { initProver as dleqInit } from ${JSON.stringify(join(root, 'src/lib/dleq.ts'))};
`);
const { grumpkin, schnorr, deck, felt, deckOpen, proveShuffle, dealing, reveal, shares, RelayTransport, dleqInit } = lib;

const env = readFileSync(join(root, '.env.local'), 'utf8');
const GAME = (env.match(/^NEXT_PUBLIC_POKERGAME_DEVNET=(.*)$/m) ?? [])[1]?.trim();
const TOKEN = (env.match(/^NEXT_PUBLIC_DEVNET_TOKEN=(.*)$/m) ?? [])[1]?.trim();
if (!GAME || GAME === '0x0') { console.error('no devnet deployment -- run npm run deploy:local'); process.exit(1); }

const provider = new RpcProvider({ nodeUrl: RPC });
const accts = JSON.parse(readFileSync(`${process.env.HOME}/.starknet_accounts/starknet_open_zeppelin_accounts.json`, 'utf8'));
const net = Object.values(accts).find((n) => n[MY_ACCOUNT]);
const me = new Account({ provider, address: net[MY_ACCOUNT].address, signer: net[MY_ACCOUNT].private_key });

const abi = JSON.parse(readFileSync(join(root, 'cairo/target/dev/zkpoker_PokerGame.contract_class.json'), 'utf8')).abi;
const cd = new CallData(abi);
const view = new Contract({ abi, address: GAME, providerOrAccount: provider });
const hex = (v) => '0x' + v.toString(16);
const u256 = (v) => { const [low, high] = felt.u256Parts(v); return { low, high }; };
const big = (v) => (typeof v === 'bigint' ? v : (BigInt(v.high) << 128n) | BigInt(v.low));

async function send(entrypoint, args) {
  const { transaction_hash } = await me.execute([
    { contractAddress: GAME, entrypoint, calldata: cd.compile(entrypoint, args) },
  ]);
  const r = await provider.waitForTransaction(transaction_hash, { retries: 200, retryInterval: 500 });
  if (String(r.execution_status ?? '').includes('REVERTED')) throw new Error(`${entrypoint} reverted: ${r.revert_reason}`);
  console.log(`  ${entrypoint} ok  ${transaction_hash}`);
}

async function status() {
  const exists = BigInt(await view.get_table_dealer(TABLE)) !== 0n;
  if (!exists) { console.log(`table ${tableName} does not exist`); return; }
  const maxSeats = Number(await view.get_table_max_seats(TABLE));
  const [started, complete, turn, orderLen, opened, chunk, street, actionTurn, roundDone, voided, settled] =
    await Promise.all([
      view.get_shuffle_started(TABLE), view.get_shuffle_complete(TABLE), view.get_shuffle_turn(TABLE),
      view.get_shuffle_order_len(TABLE), view.get_deck_opened(TABLE), view.get_deck_open_chunk(TABLE),
      view.get_table_street(TABLE), view.get_action_turn(TABLE), view.get_round_complete(TABLE),
      view.get_table_voided(TABLE), view.get_table_settled(TABLE),
    ]);
  console.log(`table ${tableName}  (${TABLE})`);
  console.log(`  max seats     ${maxSeats}`);
  for (let s = 0; s < maxSeats; s++) {
    const owner = await view.get_seat_owner(TABLE, String(s));
    const reg = await view.get_seat_key_registered(TABLE, String(s));
    const occupied = BigInt(owner) !== 0n;
    console.log(`  seat ${s}        ${occupied ? '0x' + BigInt(owner).toString(16).slice(0, 8) + '…' : '(empty)'}` +
                `${occupied ? (reg ? '  key registered' : '  NO KEY YET') : ''}` +
                `${s === MY_SEAT ? '   <- me' : ''}`);
  }
  console.log(`  shuffle       started=${started} complete=${complete} turn=${Number(turn)}/${Number(orderLen)}`);
  if (started && !complete) {
    const seatOnTurn = Number(await view.get_shuffle_seat_at(TABLE, Number(turn)));
    console.log(`                waiting on seat ${seatOnTurn}${seatOnTurn === MY_SEAT ? ' (me)' : ' (you)'}`);
  }
  console.log(`  deck          opened=${opened} chunks=${Number(chunk)}/${deckOpen.chunkCount(maxSeats)}`);
  console.log(`  betting       street=${Number(street)} turn=seat ${Number(actionTurn)} roundComplete=${roundDone}`);
  if (voided) console.log('  VOIDED');
  if (settled) console.log('  SETTLED');
}

async function finalDeck() {
  // Rebuild the chain locally from a_0 plus my own recorded outputs, falling
  // back to the on-chain publication for links I did not produce.
  const { readPublishedDeck, findDeckPublishedTx } = await mk('pubdeck',
    `export { readPublishedDeck, findDeckPublishedTx } from ${JSON.stringify(join(root, 'src/lib/publishedDeck.ts'))};`);
  const expected = BigInt(await view.get_published_deck_hash(TABLE));
  const tx = await findDeckPublishedTx({ provider, contract: GAME, tableId: TABLE });
  if (!tx) throw new Error('nothing published yet');
  const d = await readPublishedDeck({ provider, txHash: tx, expectedHash: expected });
  if (!d) throw new Error('could not read the published deck back');
  return d;
}

switch (cmd) {
  case 'create': {
    await send('create_table', { table_id: TABLE, token: TOKEN, buy_in: 0, max_seats: 2 });
    await send('join_table', { table_id: TABLE, seat: String(MY_SEAT), hole_card_note_id: String(200 + MY_SEAT) });
    const key = schnorr.generateKey();
    await schnorr.initProver();
    const proof = schnorr.prove(key.secret);
    await send('register_shuffle_key', {
      table_id: TABLE, seat: String(MY_SEAT),
      pk_x: u256(proof.pk.x), pk_y: u256(proof.pk.y), key_proof: proof.calldata.map(hex),
    });
    state.secret = hex(key.secret);
    state.pk = { x: hex(proof.pk.x), y: hex(proof.pk.y) };
    save();
    console.log(`\nseat ${MY_SEAT} is mine, key registered. My secret stays in ${statePath}.`);
    await status();
    break;
  }
  case 'status': await status(); break;
  case 'begin': {
    const maxSeats = Number(await view.get_table_max_seats(TABLE));
    const shares = [];
    for (let s = 0; s < maxSeats; s++) {
      if (!(await view.get_seat_key_registered(TABLE, String(s)))) continue;
      const raw = await view.get_seat_pk(TABLE, String(s));
      const [x, y] = (Array.isArray(raw) ? raw : [raw[0], raw[1]]).map(big);
      shares.push({ x, y });
    }
    const Y = schnorr.jointKey(shares);
    if (!Y) throw new Error('the registered shares sum to the identity');
    await send('begin_shuffle', { table_id: TABLE, joint_pk_x: u256(Y.x), joint_pk_y: u256(Y.y) });
    console.log('\nshuffle open. The joint key was summed and checked on-chain.');
    break;
  }
  case 'shuffle': {
    const turn = Number(await view.get_shuffle_turn(TABLE));
    const seat = Number(await view.get_shuffle_seat_at(TABLE, turn));
    if (seat !== MY_SEAT) { console.log(`not my turn -- waiting on seat ${seat}`); break; }
    const raw = await view.get_joint_pk(TABLE);
    const [jx, jy] = (Array.isArray(raw) ? raw : [raw[0], raw[1]]).map(big);
    const Y = grumpkin.fromWire(jx, jy);
    const head = big(await view.get_shuffle_commitment(TABLE));
    const deckIn = turn === 0 ? deck.initialDeck() : await finalDeck();
    const circuitJson = JSON.parse(readFileSync(
      join(root, 'circuits/shuffle_verifier/example_proof/beta16_build/target/shuffle.json'), 'utf8'));
    console.log(`proving my shuffle (position ${turn})…`);
    const t0 = Date.now();
    const r = await proveShuffle({ deckIn, jointKey: Y, commitmentIn: head, circuitJson, wasmPath: null });
    console.log(`  proved in ${Date.now() - t0} ms, ${r.calldata.length} felts`);
    await send('submit_shuffle', {
      table_id: TABLE, new_commitment: u256(r.commitmentOut),
      deck: deck.deckToFields(r.deckOut).map(u256), proof: r.calldata.map(hex),
    });
    console.log('\nmy shuffle is on-chain. The permutation never left this machine.');
    break;
  }
  case 'open': {
    const maxSeats = Number(await view.get_table_max_seats(TABLE));
    const d = await finalDeck();
    const chunk = Number(await view.get_deck_open_chunk(TABLE));
    const circuitJson = JSON.parse(readFileSync(
      join(root, 'circuits/deck_open_verifier/example_proof/beta16_build/target/deck_open.json'), 'utf8'));
    console.log(`proving deck-open chunk ${chunk}…`);
    const r = await deckOpen.proveOpenChunk({
      deck: d, deckHash: await deck.commitment(d), maxSeats, chunk, circuitJson, wasmPath: null });
    const args = deckOpen.openDeckArgs(TABLE, r);
    await send('open_deck', { table_id: TABLE, chunk, ciphertexts: args.ciphertexts, proof: r.calldata.map(hex) });
    console.log(`\nchunk ${chunk} open (positions ${r.positions.join(', ')}).`);
    break;
  }
  // ── dealing ─────────────────────────────────────────────────────────
  //
  // Two jobs, and they are not symmetric. For the OTHER seat's hole
  // positions I owe a share, encrypted to that seat's registered key: I
  // compute it, prove it against my own key, and send it. For MY hole
  // positions I need their share, verify it against their registered key,
  // combine, and commit -- and only then can I see my own cards.
  //
  // The asymmetry is the privacy property. I never learn their share for
  // their own positions, because I never receive it; they never learn mine.
  case 'deal': {
    if (!state.secret) throw new Error('no seat key in state -- run `create` first');
    // From the SAME bundle as dealing/dleq: each esbuild bundle gets its own
    // module instances, so initialising garaga through a second bundle leaves
    // this one's copy unset and shareFor still throws.
    await dleqInit();
    const secret = BigInt(state.secret);
    const relay = process.env.NEXT_PUBLIC_RELAY_URL ?? 'http://127.0.0.1:3100';
    const transport = new RelayTransport(TABLE, relay);

    const maxSeats = Number(await view.get_table_max_seats(TABLE));
    const others = [];
    for (let s2 = 0; s2 < maxSeats; s2++) {
      if (s2 === MY_SEAT) continue;
      if (BigInt(await view.get_seat_owner(TABLE, String(s2))) === 0n) continue;
      const raw = await view.get_seat_pk(TABLE, String(s2));
      const [x, y] = (Array.isArray(raw) ? raw : [raw[0], raw[1]]).map(big);
      others.push({ seat: s2, pk: grumpkin.fromWire(x, y) });
    }

    const openedAt = async (pos) => {
      const raw = await view.get_opened_ciphertext(TABLE, pos);
      const [a, b2, c2x, c2y] = (Array.isArray(raw) ? raw : [raw[0], raw[1], raw[2], raw[3]]).map(big);
      return { c1: grumpkin.fromWire(a, b2), c2: grumpkin.fromWire(c2x, c2y) };
    };

    // 1. Pay what I owe: a share for every other seat's hole positions, and
    //    for the community positions (those are public by design).
    for (const o of others) {
      for (const pos of deck.seatHolePositions(o.seat)) {
        const { c1 } = await openedAt(pos);
        const msg = dealing.shareFor(secret, c1);
        await dealing.sendHoleShare({
          transport, tableId: TABLE, position: pos, from: MY_SEAT, to: o.seat,
          recipientPk: o.pk, msg,
        });
        console.log(`  sent my share for seat ${o.seat} position ${pos} (encrypted to their key)`);
      }
    }

    // 2. Collect what I am owed, and commit. Waits rather than polls: a share
    //    that never arrives is the accusation path's problem, not a retry loop.
    const myPositions = deck.seatHolePositions(MY_SEAT);
    for (const [slot, pos] of myPositions.entries()) {
      const already = await view.get_hole_commitment(TABLE, String(MY_SEAT), slot);
      if (BigInt(already) !== 0n) { console.log(`  slot ${slot}: already committed`); continue; }
      const { c1, c2 } = await openedAt(pos);
      const collected = new Map([[MY_SEAT, grumpkin.mul(secret, c1)]]);
      console.log(`  waiting for shares on my position ${pos}…`);
      await new Promise((resolve, reject) => {
        const stop = transport.subscribe(async (e) => {
          if (e.position !== pos || e.kind !== 'share' || e.from === MY_SEAT) return;
          try {
            const raw = await dealing.openHoleShare(secret, e.body);
            const from = others.find((o) => o.seat === e.from);
            if (!from) return;
            // Verified against THEIR registered key. This is the only check
            // this share will ever get -- nobody else sees it.
            collected.set(e.from, dealing.acceptShare({ from, h: c1, msg: raw }));
            console.log(`    got seat ${e.from}'s share, DLEQ verified`);
            if (collected.size === others.length + 1) { stop(); clearTimeout(t); resolve(); }
          } catch (err) { stop(); clearTimeout(t); reject(err); }
        });
        // Generous by default: the other seat is a person clicking buttons,
        // not a script. A short window here turns "my opponent is reading the
        // screen" into "no share arrived", which is the shape of an accusation
        // and would be a lie. DEAL_WAIT_MS overrides it.
        const waitMs = Number(process.env.DEAL_WAIT_MS ?? 1_800_000);
        const t = setTimeout(
          () => { stop(); reject(new Error(`no share arrived for position ${pos} after ${Math.round(waitMs / 1000)}s`)); },
          waitMs,
        );
      });

      const D = dealing.combineShares([...collected.values()]);
      const card = reveal.cardFromShare({ c1, c2 }, D);
      if (card === null) throw new Error(`position ${pos}: shares decrypt outside the card encoding`);
      const blinding = grumpkin.randomScalar();
      await send('commit_hole_shares', {
        table_id: TABLE, seat: String(MY_SEAT), slot,
        commitment: hex(reveal.holeCommitment(D, blinding)),
      });
      state.hole = state.hole ?? {};
      state.hole[slot] = { share: { x: hex(D.x), y: hex(D.y) }, blinding: hex(blinding), card };
      save();
      console.log(`  slot ${slot}: committed. (card kept in ${statePath}, not printed)`);
    }
    transport.close();
    console.log('\nMy hole cards are dealt and committed. I have not printed them.');
    break;
  }
  case 'myhand': {
    if (!state.hole) { console.log('nothing dealt yet'); break; }
    for (const [slot, h] of Object.entries(state.hole)) {
      console.log(`  slot ${slot}: ${grumpkin.cardToName(h.card)}`);
    }
    break;
  }
  // ── community cards ────────────────────────────────────────────────
  //
  // Unlike a hole card, these shares are PUBLIC by design -- the card is
  // about to be on the board -- so they are broadcast rather than sealed,
  // and the aggregate can be built as soon as they are in.
  //
  // Both seats must be live for this: the aggregate challenge depends on the
  // SUM of every party's nonce point, so it needs three rounds of actual
  // interaction (commit, reveal, respond). A party revealing its nonce last
  // could otherwise grind it against everyone else's -- the classic naive
  // multisignature break -- which is why AggregateSession refuses a reveal
  // before every commitment is in.
  case 'board': {
    const index = Number(process.argv[4] ?? 0);
    if (!state.secret) throw new Error('no seat key in state');
    await dleqInit();
    const secret = BigInt(state.secret);
    const maxSeats = Number(await view.get_table_max_seats(TABLE));
    const pos = deck.communityPosition(index, maxSeats);
    if (await view.get_community_revealed(TABLE, index)) { console.log(`board ${index} already revealed`); break; }

    const relay = process.env.NEXT_PUBLIC_RELAY_URL ?? 'http://127.0.0.1:3100';
    // Two streams on purpose. Share collection wants replay (a missed share is
    // unrecoverable, a duplicate is harmless); the aggregate rounds must not
    // have it (a replayed commitment from an abandoned attempt looks like
    // equivocation and is fatal by design).
    const transport = new RelayTransport(TABLE, relay);
    const liveOnly = new RelayTransport(TABLE, relay, { replay: false });

    const raw = await view.get_opened_ciphertext(TABLE, pos);
    const [c1x, c1y, c2x, c2y] = (Array.isArray(raw) ? raw : [raw[0], raw[1], raw[2], raw[3]]).map(big);
    const c1 = grumpkin.fromWire(c1x, c1y);
    const c2 = grumpkin.fromWire(c2x, c2y);

    const jraw = await view.get_joint_pk(TABLE);
    const [jx, jy] = (Array.isArray(jraw) ? jraw : [jraw[0], jraw[1]]).map(big);
    const Y = grumpkin.fromWire(jx, jy);

    const keys = new Map();
    for (let s2 = 0; s2 < maxSeats; s2++) {
      if (BigInt(await view.get_seat_owner(TABLE, String(s2))) === 0n) continue;
      if (!(await view.get_seat_key_registered(TABLE, String(s2)))) continue;
      const r2 = await view.get_seat_pk(TABLE, String(s2));
      const [x, y] = (Array.isArray(r2) ? r2 : [r2[0], r2[1]]).map(big);
      keys.set(s2, grumpkin.fromWire(x, y));
    }

    // Broadcast mine, then collect everyone's. Public, so no sealing.
    const mine = dealing.shareFor(secret, c1);
    await transport.publish({
      tableId: TABLE, position: pos, from: MY_SEAT, kind: 'share', to: null,
      body: { d: { x: mine.d.x.toString(), y: mine.d.y.toString() }, s: mine.s.toString(), e: mine.e.toString() },
    });
    console.log(`  broadcast my share for board ${index} (position ${pos})`);

    const shares = new Map([[MY_SEAT, grumpkin.mul(secret, c1)]]);
    const waitMs = Number(process.env.DEAL_WAIT_MS ?? 1_800_000);
    await new Promise((resolve, reject) => {
      const stop = transport.subscribe((e) => {
        if (e.position !== pos || e.kind !== 'share' || e.from === MY_SEAT) return;
        try {
          const msg = { d: { x: BigInt(e.body.d.x), y: BigInt(e.body.d.y) }, s: BigInt(e.body.s), e: BigInt(e.body.e) };
          shares.set(e.from, dealing.acceptShare({ from: { seat: e.from, pk: keys.get(e.from) }, h: c1, msg }));
          console.log(`    got seat ${e.from}'s share, DLEQ verified`);
          if (shares.size === keys.size) { stop(); clearTimeout(t); resolve(); }
        } catch (err) { stop(); clearTimeout(t); reject(err); }
      });
      const t = setTimeout(() => { stop(); reject(new Error(`no board share arrived for position ${pos}`)); }, waitMs);
      if (shares.size === keys.size) { stop(); clearTimeout(t); resolve(); }
    });

    console.log('  running the three-round aggregate…');
    const agg = await dealing.runAggregate({
      transport: liveOnly, tableId: TABLE, position: pos, h: c1, jointKey: Y, keys, shares,
      mySeat: MY_SEAT, mySecret: secret,
      onProgress: (phase, outstanding) => console.log(`    ${phase}, waiting on ${outstanding.join(', ') || '-'}`),
    });

    const card = reveal.cardFromShare({ c1, c2 }, agg.share);
    if (card === null) throw new Error('the combined share opens no card in the encoding');
    console.log(`  board ${index} is ${grumpkin.cardToName(card)} -- submitting`);
    try {
      await send('reveal_community_card', reveal.revealCommunityArgs({
        tableId: TABLE, index, share: agg.share, card, proof: agg.proof,
      }));
    } catch (e) {
      // Either side may submit; the loser of the race sees CARD_ALREADY_REVEALED,
      // which is the right outcome and not a failure.
      console.log(`  (submit skipped: ${String(e.message).slice(0, 80)})`);
    }
    transport.close();
    liveOnly.close();
    break;
  }
  // ── showdown ───────────────────────────────────────────────────────
  //
  // The aggregate for a HOLE card is built here, not at dealing time. That is
  // docs/PROTOCOL.md §9.5: an aggregate needs a challenge over D = sum(d_i),
  // every co-signer needs that challenge, and open_deck already published this
  // position's c2 -- so handing D to the co-signers at dealing time would have
  // handed them the card. At showdown it is being revealed anyway.
  //
  // What was committed at dealing time still binds: the share and blinding
  // below have to reopen the commitment already on-chain, so the card was
  // fixed before the board existed. Only the proof is assembled late.
  case 'show': {
    if (!state.hole) throw new Error('nothing dealt -- run `deal` first');
    await dleqInit();
    const secret = BigInt(state.secret);
    const relay = process.env.NEXT_PUBLIC_RELAY_URL ?? 'http://127.0.0.1:3100';
    const transport = new RelayTransport(TABLE, relay);
    const liveOnly = new RelayTransport(TABLE, relay, { replay: false });
    const maxSeats = Number(await view.get_table_max_seats(TABLE));

    const keys = new Map();
    for (let s2 = 0; s2 < maxSeats; s2++) {
      if (BigInt(await view.get_seat_owner(TABLE, String(s2))) === 0n) continue;
      if (!(await view.get_seat_key_registered(TABLE, String(s2)))) continue;
      const r2 = await view.get_seat_pk(TABLE, String(s2));
      const [x, y] = (Array.isArray(r2) ? r2 : [r2[0], r2[1]]).map(big);
      keys.set(s2, grumpkin.fromWire(x, y));
    }
    const jraw = await view.get_joint_pk(TABLE);
    const [jx, jy] = (Array.isArray(jraw) ? jraw : [jraw[0], jraw[1]]).map(big);
    const Y = grumpkin.fromWire(jx, jy);

    for (const [slotStr, stored] of Object.entries(state.hole)) {
      const slot = Number(slotStr);
      if (await view.get_hole_revealed(TABLE, String(MY_SEAT), slot)) { console.log(`  slot ${slot} already shown`); continue; }
      const pos = deck.seatHolePositions(MY_SEAT)[slot];
      const raw = await view.get_opened_ciphertext(TABLE, pos);
      const [c1x, c1y] = (Array.isArray(raw) ? raw : [raw[0], raw[1]]).map(big);
      const c1 = grumpkin.fromWire(c1x, c1y);

      // Showing means the share is no longer secret, so it is broadcast here
      // where at dealing time it was sealed.
      const mineShare = dealing.shareFor(secret, c1);
      await transport.publish({
        tableId: TABLE, position: pos, from: MY_SEAT, kind: 'share', to: null,
        body: { d: { x: mineShare.d.x.toString(), y: mineShare.d.y.toString() }, s: mineShare.s.toString(), e: mineShare.e.toString() },
      });
      console.log(`  slot ${slot}: broadcast my share, gathering the rest…`);

      const shares = new Map([[MY_SEAT, grumpkin.mul(secret, c1)]]);
      const waitMs = Number(process.env.DEAL_WAIT_MS ?? 1_800_000);
      await new Promise((resolve, reject) => {
        const stop = transport.subscribe((e) => {
          if (e.position !== pos || e.kind !== 'share' || e.from === MY_SEAT) return;
          try {
            const msg = { d: { x: BigInt(e.body.d.x), y: BigInt(e.body.d.y) }, s: BigInt(e.body.s), e: BigInt(e.body.e) };
            shares.set(e.from, dealing.acceptShare({ from: { seat: e.from, pk: keys.get(e.from) }, h: c1, msg }));
            console.log(`    got seat ${e.from}'s share, DLEQ verified`);
            if (shares.size === keys.size) { stop(); clearTimeout(t); resolve(); }
          } catch (err) { stop(); clearTimeout(t); reject(err); }
        });
        const t = setTimeout(() => { stop(); reject(new Error(`no share for position ${pos}`)); }, waitMs);
        if (shares.size === keys.size) { stop(); clearTimeout(t); resolve(); }
      });

      const agg = await dealing.runAggregate({
        transport: liveOnly, tableId: TABLE, position: pos, h: c1, jointKey: Y, shares, keys,
        mySeat: MY_SEAT, mySecret: secret,
        onProgress: (phase, out) => console.log(`    ${phase}, waiting on ${out.join(', ') || '-'}`),
      });

      await send('reveal_hole_card', reveal.revealHoleArgs({
        tableId: TABLE, seat: MY_SEAT, slot,
        share: agg.share, blinding: BigInt(stored.blinding), card: stored.card, proof: agg.proof,
      }));
      console.log(`  slot ${slot} shown: ${grumpkin.cardToName(stored.card)}`);
    }
    transport.close(); liveOnly.close();
    break;
  }
  case 'settle': await send('settle_from_reveals', { table_id: TABLE }); break;
  case 'check': await send('check', { table_id: TABLE, seat: String(MY_SEAT) }); break;
  case 'street': await send('advance_street', { table_id: TABLE }); break;
  default: console.error(`unknown command: ${cmd}`); process.exit(1);
}
