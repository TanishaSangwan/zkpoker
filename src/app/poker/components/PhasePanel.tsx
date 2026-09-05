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
import type { TableState } from '../useTableState';
import { asU256, decodeError, executeAndWait, pgCall, erc20ApproveCall, STREET_NAMES } from '../contract';
import type { SeatIdentity } from '@/lib/identity';
import { jointKey as sumKeys, prove as schnorrProve, initProver as initSchnorr } from '@/lib/schnorr';
import { deckToU256, proveShuffle } from '@/lib/shuffle';
import { useProvingEnvironment } from '../useProvingEnvironment';
import { INITIAL_DECK_COMMITMENT, initialDeck, type Ciphertext } from '@/lib/deck';
import { findDeckPublishedTx, readPublishedDeck } from '@/lib/publishedDeck';
import { chunkCount, openDeckArgs, proveOpenChunk } from '@/lib/deckOpen';
import { cardToName } from '@/lib/grumpkin';

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
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const { env, ready: envReady } = useProvingEnvironment();
  const mySeat = yourSeat === null ? null : table.seats[yourSeat];

  async function run(label: string, fn: () => Promise<string | void>) {
    if (!account || !provider) { setError('Connect a wallet first.'); return; }
    setBusy({ label }); setError(null); setNote(null);
    try {
      const out = await fn();
      if (typeof out === 'string') setNote(out);
      refresh();
    } catch (e) {
      setError(decodeError(e));
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
        deckIn = p.deck;
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
      const result = await proveShuffle({
        deckIn,
        jointKey: table.jointKey,
        commitmentIn: expected,
        onProgress: (stage) =>
          setBusy({
            label: 'Shuffling',
            detail:
              stage === 'proving'
                ? `generating the proof (~${env.multithreaded ? 5 : 10} s, ${env.threads} thread${env.threads === 1 ? '' : 's'})`
                : stage,
          }),
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
          <span className={styles.fieldHint}>
            Generates a Grumpkin key in this browser and proves you know its secret. Mandatory —
            without the proof, the last seat to register could own the joint key alone.
          </span>
        </div>
      ) : null}

      {table.phase === 'keys' && !table.shuffleStarted ? (
        <>
          <p className={styles.fieldHint}>
            registered:{' '}
            {table.seats.filter((s) => s.occupied).map((s) => (
              <span key={s.seat} className={s.keyRegistered ? styles.chip : styles.chipMuted}>
                seat {s.seat} {s.keyRegistered ? '✓' : '…'}{' '}
              </span>
            ))}
          </p>
          {isDealer(table, account) ? (
            <div className={styles.actionsRow}>
              <button
                className={uni.btn}
                disabled={!!busy || table.seats.some((s) => s.occupied && !s.keyRegistered) || table.seated.length < 2}
                onClick={beginShuffle}
              >
                Begin shuffle
              </button>
              <span className={styles.fieldHint}>
                Freezes the participant list and pins the joint key. Every seated player must have
                registered first — the contract refuses otherwise.
              </span>
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
              <button className={uni.btn} disabled={!!busy} onClick={doShuffle}>
                Shuffle &amp; prove
              </button>
              <span className={styles.fieldHint}>
                ~{env.multithreaded ? 5 : 10} s of proving in this tab. The permutation never leaves
                this browser — that is the whole point.
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
              <span className={styles.fieldHint}>
                Only if the deck seat {table.publishedDeckSeat} published does not open the
                commitment the chain is on. Ends the hand and forfeits <strong>nobody</strong> — the
                contract cannot check the claim, and nothing has been bet yet, so every seat
                reclaims exactly what it put in. Do this <em>before</em> your clock expires:
                afterwards you forfeit.
              </span>
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
              <span className={styles.fieldHint}>
                Voids the hand and forfeits seat {table.shuffleOrder[table.shuffleTurn]}&apos;s stake to
                everyone else. Callable by anyone — the stalling player will not report themselves.
              </span>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── betting ─────────────────────────────────────────────────── */}
      {table.phase === 'betting' && yourSeat !== null ? (
        <>
          <div className={styles.stateGrid}>
            <Item label="street" value={STREET_NAMES[table.street] ?? String(table.street)} />
            <Item label="to call" value={(mySeat?.toCall ?? 0n).toString()} />
            <Item label="your street total" value={(mySeat?.streetContributed ?? 0n).toString()} />
            <Item label="clock" value={myTurn ? clock : table.roundComplete ? 'round complete' : `seat ${table.actionTurn}`} />
          </div>
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
                placeholder={(mySeat?.toCall ?? 0n) > 0n ? `more than ${mySeat!.toCall}` : 'amount'}
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)} style={{ maxWidth: 160 }} />
              <button className={styles.chipBtn} disabled={!!busy || !betAmount}
                onClick={() => run('Betting', () => send('bet', { table_id: table.tableId, seat: String(yourSeat), amount: betAmount }))}>
                {(mySeat?.toCall ?? 0n) > 0n ? 'Raise' : 'Bet'}
              </button>
              <button className={styles.chipBtn} disabled={!!busy}
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
              <span className={styles.fieldHint}>
                Folds the seat and play continues — a missing bet costs nothing to supply, so this is
                the one stall that is recoverable. Their chips stay in the pot.
              </span>
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
            <span className={styles.fieldHint}>
              Anyone may advance a completed round — it takes no input beyond the table and its
              precondition is checked on-chain, so no dealer has to be online for the hand to
              continue.
            </span>
          </div>
        </>
      ) : null}

      {/* ── terminal states ─────────────────────────────────────────── */}
      {table.phase === 'voided' || table.phase === 'settled' ? (
        <div className={styles.actionsRow}>
          <span className={styles.fieldHint}>
            {table.phase === 'voided'
              ? 'Hand voided. Every seat can reclaim what it put in; the party that stalled has forfeited theirs.'
              : 'Settled.'}
          </span>
          {yourSeat !== null ? (
            <button className={uni.btn} disabled={!!busy}
              onClick={() => run('Reclaiming', () => send('reclaim_stalled_bet', { table_id: table.tableId, seat: String(yourSeat) }))}>
              Reclaim
            </button>
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
            <button className={uni.btn} disabled={!!busy} onClick={openChunk}>
              Open chunk {table.deckOpenChunk + 1} of {chunks}
            </button>
            <span className={styles.fieldHint}>
              Binds the in-play ciphertexts to the deck the chain committed to. The contract cannot
              check that itself — the commitment is a Poseidon2 hash over BN254 and Cairo&apos;s
              Poseidon is over the STARK field — so this proof is what stops a fabricated deck.
              Needs no secret, so anyone at the table can do it. The circuit opens 5 slots at a
              time, and the last chunk repeats the final position to fill up.
            </span>
          </div>
        </>
      ) : null}

      {busy ? (
        <div className={`${uni.receipt} ${uni.receiptPending}`}>
          <div className={uni.receiptHead}>
            <span className={uni.receiptIcon}>⋯</span>
            <span>{busy.label}{busy.detail ? ` — ${busy.detail}` : ''}</span>
          </div>
        </div>
      ) : null}
      {note ? (
        <div className={`${uni.receipt} ${uni.receiptOk}`}>
          <div className={uni.receiptHead}><span className={uni.receiptIcon}>✓</span><span>Done</span></div>
          <pre className={uni.receiptNote}>{note}</pre>
        </div>
      ) : null}
      {error ? (
        <div className={`${uni.receipt} ${uni.receiptError}`}>
          <div className={uni.receiptHead}><span className={uni.receiptIcon}>!</span><span>Failed</span></div>
          <pre className={uni.receiptNote}>{error}</pre>
        </div>
      ) : null}
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
    case 'showdown': return 'Players reopen their dealing-time commitments. Mucking forfeits rather than blocks.';
    case 'voided': return 'A party stalled. The hand is over and their stake is forfeit.';
    default: return '';
  }
}

export { cardToName };
