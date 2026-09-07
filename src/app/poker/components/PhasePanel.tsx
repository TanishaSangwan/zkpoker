'use client';

// What this player can do right now, and nothing else.
//
// The panel is driven by the phase derived from contract state, so it can
// never offer an action the contract would reject for reasons the UI already
// knows about. Where an action IS possible but expensive or slow (a shuffle
// proof is ~5 s of local work), it says so before starting.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInterface, ProviderInterface } from 'starknet';
import styles from '../poker.module.css';
import uni from '../../uni.module.css';
import Why from './Why';
import type { TableState } from '../useTableState';
import { asU256, baseToStrk, fmtAmount, decodeError, executeAndWait, pgCall, erc20ApproveCall, strkToBase, STREET_NAMES, type Phase } from '../contract';
import type { SeatIdentity } from '@/lib/identity';
import { jointKey as sumKeys, prove as schnorrProve, initProver as initSchnorr } from '@/lib/schnorr';
import { deckToU256, precomputeFirstShuffle, proveShuffle, proveShuffleAndOpen, submitFinalShuffleArgs, takePrecomputedFirstShuffle, warmProver } from '@/lib/shuffle';
import { useProvingEnvironment } from '../useProvingEnvironment';
import { INITIAL_DECK_COMMITMENT, commitment, initialDeck, type Ciphertext } from '@/lib/deck';
import { findDeckPublishedTx, readPublishedDeck } from '@/lib/publishedDeck';
import { chunkCount, openDeckArgs, proveOpenChunk } from '@/lib/deckOpen';
import { cardToName } from '@/lib/grumpkin';
import { useActivityLog } from '../activityLog';

export type Busy = { label: string; detail?: string } | null;

type Props = {
  table: TableState;
  yourSeat: number | null;
  identity: SeatIdentity | null;
  account: AccountInterface | undefined;
  provider: ProviderInterface | undefined;
  contract: string;
  /** Deck the local player currently holds for the chain, if any. */
  deck: Ciphertext[] | null;
  setDeck: (d: Ciphertext[] | null) => void;
  refresh: () => void;
};

export default function PhasePanel(p: Props) {
  const { table, yourSeat, identity, account, provider, contract, refresh } = p;
  const [busy, setBusy] = useState<Busy>(null);

  const { env, ready: envReady } = useProvingEnvironment();
  const mySeat = yourSeat === null ? null : table.seats[yourSeat];
  const pushLog = useActivityLog((s) => s.push);

  async function run(label: string, fn: () => Promise<string | void>) {
    if (!account || !provider) { pushLog('error', label, 'Connect a wallet first.'); return; }
    setBusy({ label });
    try {
      const out = await fn();
      // The pending indicator stays inline, right next to the button that
      // was clicked -- this is the RESULT, which is the part worth keeping
      // visible without scrolling back to find it. See activityLog.ts.
      pushLog('ok', label, typeof out === 'string' ? out : undefined);
      refresh();
    } catch (e) {
      pushLog('error', label, decodeError(e));
    } finally {
      setBusy(null);
    }
  }

  const send = async (entrypoint: string, args: Record<string, unknown>) => {
    const { txHash } = await executeAndWait(account!, provider!, [pgCall(contract, entrypoint, args as any)]);
    return `${entrypoint} confirmed — ${txHash}`;
  };

  // ── register key ───────────────────────────────────────────────────────
  const registerKey = () =>
    run('Proving key ownership', async () => {
      if (!identity || yourSeat === null) throw new Error('Take a seat first.');
      await initSchnorr();
      // The Schnorr PoK is the rogue-key defence: without it the last seat to
      // register could pick a share making the joint key theirs alone.
      const proof = schnorrProve(identity.secret);
      return send('register_shuffle_key', {
        table_id: table.tableId,
        seat: yourSeat.toString(),
        pk_x: asU256(proof.pk.x),
        pk_y: asU256(proof.pk.y),
        key_proof: proof.calldata.map((v) => '0x' + v.toString(16)),
      });
    });

  // ── begin shuffle (dealer) ─────────────────────────────────────────────
  const beginShuffle = () =>
    run('Opening the shuffle', async () => {
      // The joint key is summed locally and CHECKED on-chain by the adapter
      // against the registered shares, so a wrong sum here is rejected rather
      // than silently accepted -- but computing it right means the transaction
      // succeeds first time.
      const shares = table.seats.filter((s) => s.occupied && s.keyRegistered && s.pk).map((s) => s.pk!);
      if (shares.length < 2) throw new Error('At least two seats must have registered a key.');
      const Y = sumKeys(shares);
      if (Y === null) throw new Error('The registered shares sum to the identity — refuse to open with a degenerate joint key.');
      return send('begin_shuffle', {
        table_id: table.tableId,
        joint_pk_x: asU256(Y.x),
        joint_pk_y: asU256(Y.y),
      });
    });

  // ── shuffle turn ───────────────────────────────────────────────────────
  const myShufflePosition = table.shuffleOrder.indexOf(yourSeat ?? -1);
  const myShuffleTurn = table.shuffleStarted && !table.shuffleComplete && table.shuffleOrder[table.shuffleTurn] === yourSeat;

  const doShuffle = () =>
    run('Shuffling', async () => {
      if (!table.jointKey) throw new Error('The table has no joint key yet.');
      // Position 0 shuffles the canonical starting deck, which needs no
      // delivery at all -- a_0 depends on nothing and is identical for every
      // table.
      //
      // Every later position reads the previous deck FROM THE CHAIN. It used
      // to arrive off-chain, which meant the previous seat could publish its
      // commitment, satisfy its own deadline, and then send nothing -- and it
      // was this seat that got timed out and forfeited (PROTOCOL.md §9.3).
      // The deck is now part of submit_shuffle's calldata, so there is
      // nothing left to withhold. A locally cached copy is still preferred as
      // a fast path; the chain is the guarantee under it.
      let deckIn: Ciphertext[] | null;
      if (table.shuffleTurn === 0) {
        deckIn = initialDeck();
      } else {
        // The cache is a fast path, and a fast path that is trusted is just a
        // second source of truth. Check it against the commitment this chain
        // is actually on and fall through to the chain if it does not open
        // it -- one Poseidon2 hash, against a witness failure that reports
        // nothing useful and costs a proving run to discover.
        deckIn = p.deck;
        if (deckIn && (await commitment(deckIn)) !== table.commitment) {
          deckIn = null;
        }
        if (!deckIn) {
          setBusy({ label: 'Shuffling', detail: 'reading the published deck from chain' });
          const txHash = await findDeckPublishedTx({ provider: provider!, contract, tableId: table.tableId });
          deckIn = txHash
            ? await readPublishedDeck({ provider: provider!, txHash, expectedHash: table.publishedDeckHash })
            : null;
        }
      }
      if (!deckIn) {
        throw new Error(
          `Seat ${table.publishedDeckSeat} published a deck that could not be read back, or none ` +
            `at all. If it does not open the commitment this chain is now on, you cannot shuffle ` +
            `and nobody can adjudicate it on-chain -- dispute it rather than letting your clock ` +
            `run out, which would forfeit your stake.`,
        );
      }
      const expected = table.shuffleTurn === 0 ? INITIAL_DECK_COMMITMENT : table.commitment;
      setBusy({ label: 'Shuffling', detail: 'permuting and re-randomising 52 cards' });

      // The LAST link opens the deck with the same proof. That is not an
      // option the seat picks: submit_shuffle refuses the final turn and
      // submit_final_shuffle refuses every other one, so the chain has exactly
      // one shape. It costs this seat ~3% more gas than a plain shuffle and
      // saves the table an entire ~587M-gas opening verification.
      const isLast = table.shuffleTurn === table.shuffleOrder.length - 1;
      const progress = (label: string) => (stage: string) =>
        setBusy({
          label,
          detail:
            stage === 'proving'
              ? `generating the proof (~${env.multithreaded ? 5 : 10} s, ${env.threads} thread${env.threads === 1 ? '' : 's'})`
              : stage,
        });

      if (isLast) {
        const result = await proveShuffleAndOpen({
          deckIn,
          jointKey: table.jointKey,
          commitmentIn: expected,
          maxSeats: table.maxSeats,
          onProgress: progress('Shuffling and opening'),
        });
        p.setDeck(result.deckOut);
        const args = submitFinalShuffleArgs(table.tableId, result);
        const txt = await send('submit_final_shuffle', {
          ...args,
          proof: args.proof.map((v) => '0x' + v.toString(16)),
        });
        return (
          `${txt}\nshuffled and opened ${result.positions.length} positions in one proof\n` +
          `witness ${result.timings.witnessMs} ms · proof ${result.timings.proveMs} ms · ` +
          `calldata ${result.timings.calldataMs} ms`
        );
      }

      // Already proved? Position 0's proof does not depend on anything that
      // has happened since, so if the key set is unchanged it is still valid.
      const ready = table.shuffleTurn === 0 ? takePrecomputedFirstShuffle(keyFingerprint) : null;
      const result = ready ?? await proveShuffle({
        deckIn,
        jointKey: table.jointKey,
        commitmentIn: expected,
        onProgress: progress('Shuffling'),
      });
      p.setDeck(result.deckOut);
      const txt = await send('submit_shuffle', {
        table_id: table.tableId,
        new_commitment: asU256(result.commitmentOut),
        // Published as calldata, not merely sent to the next player -- see above.
        deck: deckToU256(result.deckOut),
        proof: result.calldata.map((v) => '0x' + v.toString(16)),
      });
      return `${txt}\nwitness ${result.timings.witnessMs} ms · proof ${result.timings.proveMs} ms · calldata ${result.timings.calldataMs} ms`;
    });

  // ── open the deck ──────────────────────────────────────────────────────
  //
  // One opening per hand, not one per reveal. Opening reveals nothing -- the
  // ciphertexts are already public in the published deck and the card values
  // come only from DLEQ decryption later -- so every in-play position is
  // opened once, straight after the chain, and revealed progressively
  // afterwards (PROTOCOL.md §7.3). It matters because an opening proof costs
  // 772M gas, barely under a shuffle's 811M.
  //
  // Needs no secret, only the final deck, so any party can carry it.
  //
  // Chunk 0 arrived with the last shuffle proof, so this button only appears
  // on tables of EIGHT seats or more -- below that, 2*max_seats + 5 fits the
  // one chunk of 19 that the fused proof already carried, and the deck is
  // fully open the moment the chain closes.
  const chunks = table.maxSeats ? chunkCount(table.maxSeats) : 0;

  const openChunk = () =>
    run('Opening the deck', async () => {
      let deck = p.deck;
      if (!deck) {
        setBusy({ label: 'Opening the deck', detail: 'reading the final deck from chain' });
        const txHash = await findDeckPublishedTx({ provider: provider!, contract, tableId: table.tableId });
        deck = txHash
          ? await readPublishedDeck({ provider: provider!, txHash, expectedHash: table.publishedDeckHash })
          : null;
        if (deck) p.setDeck(deck);
      }
      if (!deck) throw new Error('Could not read the final deck from chain.');

      const chunk = table.deckOpenChunk;
      setBusy({ label: 'Opening the deck', detail: `proving chunk ${chunk + 1} of ${chunks}` });
      const result = await proveOpenChunk({
        deck,
        deckHash: table.commitment,
        maxSeats: table.maxSeats,
        chunk,
        onProgress: (stage) => setBusy({ label: `Opening chunk ${chunk + 1}/${chunks}`, detail: stage }),
      });
      const args = openDeckArgs(table.tableId, result);
      const txt = await send('open_deck', {
        ...args,
        proof: (args.proof as string[]),
      });
      return `${txt}\npositions ${result.positions.join(', ')} · proof ${result.timings.proveMs} ms`;
    });

  const [autoAdvance, setAutoAdvance] = useState(true);

  // ── register the key without being asked ──────────────────────────────
  //
  // You cannot play without registering, and registering is mandatory for a
  // reason that has nothing to do with preference: without the Schnorr proof
  // the last seat to register could choose a share making the joint key theirs
  // alone and read every hole card at the table. So it is not a decision, it
  // is a precondition -- and the key itself is generated locally either way.
  //
  // Guarded on the shuffle not having started, because after that the
  // participant list is frozen and the call would only revert.
  const registering = useRef(false);
  useEffect(() => {
    if (yourSeat === null || !identity || registering.current) return;
    if (table.shuffleStarted || mySeat?.keyRegistered) return;
    if (!account || !provider) return;
    registering.current = true;
    void registerKey().finally(() => { registering.current = false; });
  }, [yourSeat, identity, table.shuffleStarted, mySeat?.keyRegistered, account, provider]);
  const [autoShuffle, setAutoShuffle] = useState(true);

  // ── shuffle on your own turn, without being asked ─────────────────────
  //
  // Shuffling is NOT a dealer job and cannot be automated by one. Each player
  // permutes and re-randomises the deck themselves and proves it, because the
  // permutation is the secret the protocol protects -- handing the witness to
  // anyone else, dealer included, hands them the table (§1, §9.1). The dealer
  // holds no key share and never shuffles.
  //
  // But there is no DECISION in it either. Shuffling honestly is always the
  // right move for you, so waiting for a click buys nothing. This does it on
  // your turn, on your device, with the witness never leaving the browser.
  const shuffling = useRef(false);
  const jointKeyX = table.jointKey ? table.jointKey.x : null;
  // Why the automatic shuffle is not running, when it is your turn and it
  // is not. Silence was the worst part of every bug this table hit today:
  // an effect that returns early is indistinguishable from one that never
  // fired, so "nothing is happening" had to be diagnosed from a relay log
  // rather than read off the screen.
  const shuffleBlocker =
    !myShuffleTurn ? null
    : !autoShuffle ? 'automatic shuffling is switched off'
    : !account ? 'no wallet or devnet account is connected'
    : !provider ? 'no RPC provider'
    : !identity ? 'no seat key in this browser -- register, or reconnect the account that did'
    : !table.jointKey ? 'the table has no joint key yet'
    : null;
  useEffect(() => {
    if (!autoShuffle || !myShuffleTurn || shuffling.current) return;
    if (!account || !provider || !identity || !table.jointKey) return;
    shuffling.current = true;
    void doShuffle().finally(() => { shuffling.current = false; });
    // doShuffle reads the chain head itself, so re-running on a stale turn is
    // rejected on-chain rather than mis-chaining.
    // Depends on the joint key's VALUE, not the object useTableState builds
    // fresh on every poll. With the object in here the effect re-fired every
    // few seconds, so a shuffle that failed for any reason retried forever --
    // which is what "it is looping" looks like from the outside, and it buries
    // the one error that would explain it under an endless stream of repeats.
  }, [autoShuffle, myShuffleTurn, table.shuffleTurn, account, provider, identity, jointKeyX]);

  // ── the dealer, automated ──────────────────────────────────────────────
  //
  // advance_street is permissionless, which is what makes this safe to do
  // from a player's client rather than a privileged bot. The call takes only
  // a table_id, its precondition is computed on-chain, and its effect is
  // fixed -- so whoever sends it chooses nothing, and a client that sends it
  // automatically has taken no authority.
  //
  // That ordering matters. Automating a DEALER-ONLY advance_street would have
  // rebuilt the trusted party in software and left the table stalled whenever
  // that one client was offline (PROTOCOL.md §8.0). Making the call
  // permissionless first turns the automation into a convenience that anyone
  // can provide and nobody has to.
  // Compile the prover while earlier seats are still shuffling.
  //
  // The first proof of a session pays for fetching the circuit, compiling the
  // ~2.4 MB barretenberg wasm and loading the CRS, and all of that used to
  // land inside the shuffle clock on the seat's own turn. Every seat has idle
  // time before its turn that is easily long enough to cover it, so this
  // spends that instead.
  //
  // Started as soon as the table has a shuffle to do -- not when it becomes
  // your turn, which would be too late to be worth anything. The last seat in
  // the order also warms the fused circuit, which is a different one.
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current || yourSeat === null) return;
    if (table.phase !== 'keys' && table.phase !== 'shuffling') return;
    warmed.current = true;
    const last = table.shuffleOrder.length > 0
      && table.shuffleOrder[table.shuffleOrder.length - 1] === yourSeat;
    void warmProver('shuffle');
    if (last) void warmProver('shuffle_open');
  }, [table.phase, yourSeat, table.shuffleOrder]);

  // Prove position 0's shuffle before the shuffle even opens.
  //
  // The first link always shuffles a_0, the canonical deck pinned in the
  // contract, so it can be proved as soon as the joint key is known -- which
  // is as soon as every seated player has registered. For the seat that will
  // play position 0 that turns a ~5s wait on its own clock into no wait at
  // all.
  //
  // Position 0 is the LOWEST OCCUPIED SEAT: begin_shuffle walks the seats in
  // order, so this is knowable before the order is frozen.
  //
  // The fingerprint is the registered key set. A proof is only valid under
  // the joint key it was made for, so if anyone joins, leaves or registers
  // between now and begin_shuffle, the cached proof is discarded rather than
  // spent on a turn.
  const keyFingerprint = table.seats
    .filter((s) => s.occupied && s.keyRegistered && s.pk)
    .map((s) => `${s.seat}:${s.pk!.x.toString(16)}`)
    .join('|');
  const everyoneRegistered = table.seats.filter((s) => s.occupied).length >= 2
    && table.seats.filter((s) => s.occupied).every((s) => s.keyRegistered && s.pk);
  const lowestOccupied = table.seats.find((s) => s.occupied)?.seat ?? null;
  const precomputing = useRef('');
  useEffect(() => {
    if (table.shuffleStarted || !everyoneRegistered || !table.jointKey) return;
    if (yourSeat === null || yourSeat !== lowestOccupied) return;
    if (precomputing.current === keyFingerprint) return;
    precomputing.current = keyFingerprint;
    void precomputeFirstShuffle({ jointKey: table.jointKey, fingerprint: keyFingerprint })
      .catch(() => { precomputing.current = ''; });
  }, [table.shuffleStarted, everyoneRegistered, table.jointKey, yourSeat, lowestOccupied, keyFingerprint]);

  const advancing = useRef(false);
  useEffect(() => {
    if (!autoAdvance || table.phase !== 'betting' || !table.roundComplete) return;
    if (!account || !provider || advancing.current) return;
    advancing.current = true;
    void (async () => {
      try {
        await send('advance_street', { table_id: table.tableId });
        refresh();
      } catch {
        // Someone else advanced it first, which is the whole point of the
        // call being permissionless.
      } finally {
        advancing.current = false;
      }
    })();
  }, [autoAdvance, table.phase, table.roundComplete, table.street, table.tableId, account, provider]);

  // ── the next hand ──────────────────────────────────────────────────────
  //
  // start_next_hand rotates the button one occupied seat, bumps hand_number
  // (which is what walks the blind ladder), and clears the per-hand state.
  // It is permissionless for the same reason advance_street is: it takes only
  // a table id, every precondition is checked on-chain, and its effect is
  // fixed -- so whoever sends it chooses nothing.
  //
  // Occupied, not active, is the rule for the button: blinds are posted
  // before anyone can fold, so a seat that folded last hand still owes one
  // this hand.
  //
  // Keys survive a hand. seat_key_registered and seat_pk are deliberately not
  // reset, so nobody re-registers between hands -- the dealer just calls
  // begin_shuffle again, which puts the chain head back to the canonical deck
  // and leaves the rotated button alone.
  const startingNext = useRef(false);
  const startNextHand = () =>
    run('Starting the next hand', async () => {
      const txt = await send('start_next_hand', { table_id: table.tableId });
      return `${txt}\nbutton moves one occupied seat; hand ${table.handNumber + 1} is ready to shuffle`;
    });

  useEffect(() => {
    if (!autoAdvance || table.phase !== 'settled') return;
    if (!account || !provider || startingNext.current) return;
    startingNext.current = true;
    void (async () => {
      try {
        await send('start_next_hand', { table_id: table.tableId });
        refresh();
      } catch {
        // Someone else started it first, which is the point of the call being
        // permissionless -- and a table that is voided rather than settled
        // refuses it outright, which is also correct.
      } finally {
        startingNext.current = false;
      }
    })();
  }, [autoAdvance, table.phase, table.tableId, table.handNumber, account, provider]);

  // ── betting ────────────────────────────────────────────────────────────
  const [betAmount, setBetAmount] = useState('');
  const myTurn = table.phase === 'betting' && !table.roundComplete && table.actionTurn === yourSeat && !mySeat?.folded;

  const clock = useCountdown(table.actionDeadline);
  const shuffleClock = useCountdown(table.shuffleDeadline);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>{titleFor(table)}</div>
        <div className={styles.sectionHint}>{hintFor(table, yourSeat)}</div>
      </div>

      <PhaseStepper phase={table.phase} />

      {envReady && !env.multithreaded && (table.phase === 'keys' || table.phase === 'shuffling') ? (
        <div className={styles.caution}>
          This page is <strong>not cross-origin isolated</strong>, so bb.js falls back to a single
          thread and every shuffle proof takes roughly twice as long (~9.9 s instead of ~4.8 s).
          Nothing is broken; the deployment is missing the <code>COOP</code>/<code>COEP</code>{' '}
          headers that <code>next.config.js</code> sets.
        </div>
      ) : null}

      {/* ── seating ─────────────────────────────────────────────────── */}
      {table.phase === 'seating' || (yourSeat === null && !table.shuffleStarted) ? (
        <p className={styles.fieldHint}>
          {table.seated.length} of {table.maxSeats} seats taken. A hand needs at least two.
        </p>
      ) : null}

      {/* ── key registration ────────────────────────────────────────── */}
      {yourSeat !== null && !mySeat?.keyRegistered && !table.shuffleStarted ? (
        <div className={styles.actionsRow}>
          <button className={uni.btn} disabled={!!busy} onClick={registerKey}>
            Register key share
          </button>
          <Why>
            Happening automatically — this button is only a retry. Generates a Grumpkin key in this
            browser and proves you know its secret. Mandatory, and not a preference: without the
            proof the last seat to register could choose a share making the joint key theirs alone
            and read every hole card at the table.
          </Why>
        </div>
      ) : null}

      {table.phase === 'keys' && !table.shuffleStarted ? (
        <>
          <p className={styles.fieldHint}>
            registered:{' '}
            {table.seats.filter((s) => s.occupied).map((s) => (
              <span key={s.seat} className={s.keyRegistered ? styles.chipOwner : styles.chipMuted}>
                seat {s.seat} {s.keyRegistered ? '✓' : '…'}{' '}
              </span>
            ))}
          </p>
          {isDealer(table, account) ? (
            <div className={styles.actionsRow}>
              <button
                className={`${uni.btn} ${uni.btnPrimary}`}
                disabled={!!busy || table.seats.some((s) => s.occupied && !s.keyRegistered) || table.seated.length < 2}
                onClick={beginShuffle}
              >
                Begin shuffle
              </button>
              <Why>
                Freezes the participant list and pins the joint key. Every seated player must have
                registered first — the contract refuses otherwise.
              </Why>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── shuffle chain ───────────────────────────────────────────── */}
      {table.phase === 'shuffling' ? (
        <>
          <ChainProgress table={table} yourSeat={yourSeat} />
          {myShuffleTurn ? (
            <div className={styles.actionsRow}>
              <label className={styles.fieldHint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={autoShuffle} onChange={(e) => setAutoShuffle(e.target.checked)} />
                Shuffle automatically on my turn
              </label>
              <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={!!busy} onClick={doShuffle}>
                Shuffle &amp; prove
              </button>
              {shuffleBlocker ? (
                <span className={styles.fieldHint} style={{ color: 'var(--danger)' }}>
                  Not shuffling automatically: {shuffleBlocker}.
                </span>
              ) : null}
              <span className={styles.fieldHint}>
                ~{env.multithreaded ? 5 : 10} s of proving in this tab. There is no decision here —
                shuffling honestly is always right for you — but it has to happen on your machine,
                because the permutation is the secret and handing the witness to anyone else
                (a dealer included) hands them the table.
              </span>
            </div>
          ) : (
            <p className={styles.fieldHint}>
              Waiting for seat {table.shuffleOrder[table.shuffleTurn]} ({shuffleClock}).
            </p>
          )}
          {myShuffleTurn && table.shuffleTurn > 0 && shuffleClock !== 'expired' ? (
            <div className={styles.actionsRow}>
              <button
                className={uni.btn}
                disabled={!!busy}
                onClick={() => run('Disputing the deck', () => send('dispute_deck', { table_id: table.tableId }))}
              >
                Dispute the deck
              </button>
              <Why>
                Only if the deck seat {table.publishedDeckSeat} published does not open the
                commitment the chain is on. Ends the hand and forfeits <strong>nobody</strong> — the
                contract cannot check the claim, and nothing has been bet yet, so every seat
                reclaims exactly what it put in. Do this <em>before</em> your clock expires:
                afterwards you forfeit.
              </Why>
            </div>
          ) : null}
          {shuffleClock === 'expired' ? (
            <div className={styles.actionsRow}>
              <button
                className={uni.btn}
                disabled={!!busy}
                onClick={() => run('Claiming timeout', () => send('claim_shuffle_timeout', { table_id: table.tableId }))}
              >
                Claim shuffle timeout
              </button>
              <Why>
                Voids the hand and forfeits seat {table.shuffleOrder[table.shuffleTurn]}&apos;s stake to
                everyone else. Callable by anyone — the stalling player will not report themselves.
              </Why>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── betting ─────────────────────────────────────────────────── */}
      {table.phase === 'betting' && yourSeat !== null ? (
        <>
          <div className={styles.stateGrid}>
            <Item label="street" value={STREET_NAMES[table.street] ?? String(table.street)} />
            <Item label="to call" value={fmtAmount(mySeat?.toCall ?? 0n)} />
            <Item label="your street total" value={fmtAmount(mySeat?.streetContributed ?? 0n)} />
            <Item label="clock" value={myTurn ? clock : table.roundComplete ? 'round complete' : `seat ${table.actionTurn}`} />
          </div>
          {myTurn ? (
            <div className={styles.turnBanner}>
              <span>Your turn</span>
              <span className={styles.turnBannerClock}>{clock}</span>
            </div>
          ) : null}
          {myTurn ? (
            <div className={styles.actionBar}>
              {/* Check and call are DIFFERENT on-chain actions, and one button
                  labelled "Check / call" that only ever sent `check` was
                  simply wrong: facing a bet, `check` reverts with
                  CANNOT_CHECK_FACING_BET, because checking would mean staying
                  in the hand without matching. So the button follows the
                  amount owed -- `check` when nothing is owed, `bet` for
                  exactly the shortfall when something is. */}
              {(mySeat?.toCall ?? 0n) > 0n ? (
                <button className={styles.chipBtn} disabled={!!busy}
                  onClick={() => run(`Calling ${mySeat!.toCall}`, () => send('bet', {
                    table_id: table.tableId, seat: String(yourSeat),
                    amount: mySeat!.toCall.toString(),
                  }))}>
                  Call {mySeat!.toCall.toString()}
                </button>
              ) : (
                <button className={styles.chipBtn} disabled={!!busy}
                  onClick={() => run('Checking', () => send('check', { table_id: table.tableId, seat: String(yourSeat) }))}>
                  Check
                </button>
              )}
              <input className={styles.input}
                placeholder={(mySeat?.toCall ?? 0n) > 0n ? `more than ${fmtAmount(mySeat!.toCall)}` : 'amount in STRK'}
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)} style={{ maxWidth: 160 }} />
              <button className={`${styles.chipBtn} ${styles.chipBtnPrimary}`} disabled={!!busy || !betAmount}
                onClick={() => run('Betting', () => send('bet', { table_id: table.tableId, seat: String(yourSeat), amount: strkToBase(betAmount).toString() }))}>
                {(mySeat?.toCall ?? 0n) > 0n ? 'Raise' : 'Bet'}
              </button>
              <button className={`${styles.chipBtn} ${styles.chipBtnFold}`} disabled={!!busy}
                onClick={() => run('Folding', () => send('fold', { table_id: table.tableId, seat: String(yourSeat) }))}>
                Fold
              </button>
            </div>
          ) : (
            <p className={styles.fieldHint}>
              {table.roundComplete
                ? 'Round complete — waiting for the dealer to advance the street.'
                : `Waiting for seat ${table.actionTurn}.`}
            </p>
          )}
          {clock === 'expired' && !table.roundComplete ? (
            <div className={styles.actionsRow}>
              <button className={uni.btn} disabled={!!busy}
                onClick={() => run('Folding the clock', () => send('claim_action_timeout', { table_id: table.tableId }))}>
                Fold seat {table.actionTurn} on time
              </button>
              <Why>
                Folds the seat and play continues — a missing bet costs nothing to supply, so this is
                the one stall that is recoverable. Their chips stay in the pot.
              </Why>
            </div>
          ) : null}
          <div className={styles.actionsRow}>
            <label className={styles.fieldHint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={autoAdvance} onChange={(e) => setAutoAdvance(e.target.checked)} />
              Advance the street automatically when the round completes
            </label>
            {table.roundComplete ? (
              <button className={uni.btn} disabled={!!busy}
                onClick={() => run('Advancing', () => send('advance_street', { table_id: table.tableId }))}>
                Advance street
              </button>
            ) : null}
            <Why>
              Anyone may advance a completed round — it takes no input beyond the table and its
              precondition is checked on-chain, so no dealer has to be online for the hand to
              continue.
            </Why>
          </div>
        </>
      ) : null}

      {/* ── terminal states ─────────────────────────────────────────── */}
      {table.phase === 'voided' || table.phase === 'settled' ? (
        <div className={styles.actionsRow}>
          <span className={styles.fieldHint}>
            {table.phase === 'voided'
              ? 'Hand voided. Every seat can reclaim what it put in; the party that stalled has forfeited theirs.'
              : `Hand ${table.handNumber} settled. Winnings are in pending payout until withdrawn.`}
          </span>
          {yourSeat !== null ? (
            <button className={uni.btn} disabled={!!busy}
              onClick={() => run('Reclaiming', () => send('reclaim_stalled_bet', { table_id: table.tableId, seat: String(yourSeat) }))}>
              Reclaim
            </button>
          ) : null}
          {/* A settled hand is not a finished table, and without this the
              browser had no way to say so: start_next_hand existed on-chain
              and in scripts/keeper.mjs, but no client call site, so a table
              simply stopped here. Voided is excluded because the contract
              refuses it -- those seats reclaim individually, and dealing over
              the top would strand whatever had not been reclaimed. */}
          {table.phase === 'settled' ? (
            <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={!!busy} onClick={startNextHand}>
              Start hand {table.handNumber + 1}
            </button>
          ) : null}
          {table.phase === 'settled' ? (
            <span className={styles.fieldHint}>
              Rotates the button one occupied seat and clears the hand. Registered keys survive,
              so nobody registers again — the dealer just runs the shuffle. Permissionless: anyone
              can send it, including a keeper, and it is already automatic above.
            </span>
          ) : null}
        </div>
      ) : null}

      {table.phase === 'opening' ? (
        <>
          <div className={styles.stateGrid}>
            <Item label="chunks done" value={`${table.deckOpenChunk} / ${chunks}`} />
            <Item label="positions" value={`${2 * table.maxSeats} hole + 5 community`} />
            <Item label="chain head" value={`0x${table.commitment.toString(16).slice(0, 10)}…`} />
          </div>
          <div className={styles.actionsRow}>
            <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={!!busy} onClick={openChunk}>
              Open chunk {table.deckOpenChunk + 1} of {chunks}
            </button>
            <Why>
              Binds the in-play ciphertexts to the deck the chain committed to. The contract cannot
              check that itself — the commitment is a Poseidon2 hash over BN254 and Cairo&apos;s
              Poseidon is over the STARK field — so this proof is what stops a fabricated deck.
              Needs no secret, so anyone at the table can do it. The circuit opens 16 slots at a
              time, and the last chunk repeats the final position to fill up.
            </Why>
          </div>
        </>
      ) : null}

      {table.phase === 'posting' ? (
        <>
          <div className={styles.stateGrid}>
            <Item label="blinds" value={`${fmtAmount(table.smallBlind)} / ${fmtAmount(table.bigBlind)}`} />
            <Item label="button" value={`seat ${table.button}`} />
            <Item
              label="level"
              value={table.blindLevelHands > 0
                ? `${table.blindLevel + 1} of 7 · ${table.blindLevelHands} hand${table.blindLevelHands === 1 ? '' : 's'} each`
                : 'fixed'}
            />
          </div>
          <p className={styles.fieldHint}>
            {(
              <>
                Button on seat {table.button}. Posting the small and big blinds from the allowances
                you approved when you sat down. Permissionless and argument-free, so whichever
                client gets there first does it. Betting opens as soon as they are up — until then
                the contract refuses every action with BLINDS_NOT_POSTED, which is why there is
                nothing to press here yet.
              </>
            )}
          </p>
        </>
      ) : null}

      {/* The result (success or failure) goes to the shared activity log
          instead of appearing here -- see the `pushLog` calls in `run()`
          above. Only the in-flight indicator stays inline, next to
          whatever was just clicked. */}
      {busy ? (
        <div className={`${uni.receipt} ${uni.receiptPending}`}>
          <div className={uni.receiptHead}>
            <span className={uni.receiptIcon}>⋯</span>
            <span>{busy.label}{busy.detail ? ` — ${busy.detail}` : ''}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// The hand's progress through the protocol, at a glance. 'voided' and
// 'no-table' are terminal/exception states that don't fit a linear
// progress bar, so the stepper simply doesn't render for them.
const PHASE_STEPS: Phase[] = ['seating', 'keys', 'shuffling', 'opening', 'posting', 'dealing', 'betting', 'showdown', 'settled'];
const PHASE_STEP_LABELS: Record<string, string> = {
  seating: 'Seat', keys: 'Keys', shuffling: 'Shuffle', opening: 'Open',
  posting: 'Blinds', dealing: 'Deal', betting: 'Betting', showdown: 'Showdown', settled: 'Settled',
};

function PhaseStepper({ phase }: { phase: Phase }) {
  const current = PHASE_STEPS.indexOf(phase);
  if (current < 0) return null;
  return (
    <div className={styles.stepper}>
      {PHASE_STEPS.flatMap((key, i) => {
        const dot = (
          <div key={key} className={styles.stepperStep} title={PHASE_STEP_LABELS[key]}>
            <div
              className={`${styles.stepperDot} ${
                i < current ? styles.stepperDotDone : i === current ? styles.stepperDotCurrent : ''
              }`}
            />
            {i === current ? <div className={styles.stepperLabel}>{PHASE_STEP_LABELS[key]}</div> : null}
          </div>
        );
        if (i === PHASE_STEPS.length - 1) return [dot];
        const line = (
          <div key={`${key}-line`} className={`${styles.stepperLine} ${i < current ? styles.stepperLineDone : ''}`} />
        );
        return [dot, line];
      })}
    </div>
  );
}

function ChainProgress({ table, yourSeat }: { table: TableState; yourSeat: number | null }) {
  return (
    <div className={styles.deckGrid} style={{ gridTemplateColumns: `repeat(${Math.max(table.shuffleOrder.length, 1)}, 1fr)` }}>
      {table.shuffleOrder.map((seat, pos) => (
        <div
          key={pos}
          className={`${styles.deckCell} ${seat === yourSeat ? styles.deckCellSelf : ''}`}
          style={pos < table.shuffleTurn ? { opacity: 0.55 } : pos === table.shuffleTurn ? { outline: '2px solid #f5c542' } : undefined}
        >
          <div className={styles.deckPos}>#{pos}</div>
          <div className={styles.deckCard}>seat {seat}</div>
          <div className={styles.deckWho}>{pos < table.shuffleTurn ? 'done' : pos === table.shuffleTurn ? 'now' : 'waiting'}</div>
        </div>
      ))}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stateItem}>
      <div className={styles.stateLabel}>{label}</div>
      <div className={styles.stateValue}>{value}</div>
    </div>
  );
}

/** Local countdown against a chain deadline. Re-renders once a second. */
function useCountdown(deadlineSecs: number): string {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  if (!deadlineSecs) return '—';
  const left = deadlineSecs - now;
  if (left <= 0) return 'expired';
  const m = Math.floor(left / 60);
  return m > 0 ? `${m}m ${left % 60}s` : `${left}s`;
}

const isDealer = (t: TableState, a: AccountInterface | undefined) =>
  !!a && BigInt(t.dealer) === BigInt(a.address);

function titleFor(t: TableState): string {
  return {
    'no-table': 'No such table',
    seating: 'Seating',
    keys: 'Key registration',
    shuffling: 'Shuffle chain',
    opening: 'Opening the deck',
    posting: 'Posting the blinds',
    dealing: 'Dealing',
    betting: 'Betting',
    showdown: 'Showdown',
    settled: 'Settled',
    voided: 'Voided',
  }[t.phase];
}

function hintFor(t: TableState, yourSeat: number | null): string {
  switch (t.phase) {
    case 'seating': return 'Players take seats and escrow their buy-in.';
    case 'keys': return 'Each seat publishes an ElGamal key share with a proof it knows the secret.';
    case 'shuffling': return 'Every seat shuffles in turn. k = n, always — a shorter chain means trusting whoever is in it.';
    case 'opening': return 'One proof binds the in-play ciphertexts to the committed deck.';
    case 'betting': return yourSeat === null ? 'Spectating.' : 'Turn-ordered; a raise reopens the action.';
    case 'showdown': return 'Every contender reopens its dealing-time commitments. Not showing before the clock runs out forfeits.';
    case 'voided': return 'A party stalled. The hand is over and their stake is forfeit.';
    default: return '';
  }
}

export { cardToName };
