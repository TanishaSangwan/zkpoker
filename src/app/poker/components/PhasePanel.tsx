'use client';

// What this player can do right now, and nothing else.
//
// The panel is driven by the phase derived from contract state, so it can
// never offer an action the contract would reject for reasons the UI already
// knows about. Where an action IS possible but expensive or slow (a shuffle
// proof is ~5 s of local work), it says so before starting.

import { useEffect, useMemo, useState } from 'react';
import type { AccountInterface, ProviderInterface } from 'starknet';
import styles from '../poker.module.css';
import uni from '../../uni.module.css';
import type { TableState } from '../useTableState';
import { asU256, decodeError, executeAndWait, pgCall, erc20ApproveCall, STREET_NAMES } from '../contract';
import type { SeatIdentity } from '@/lib/identity';
import { jointKey as sumKeys, prove as schnorrProve, initProver as initSchnorr } from '@/lib/schnorr';
import { proveShuffle } from '@/lib/shuffle';
import { useProvingEnvironment } from '../useProvingEnvironment';
import { INITIAL_DECK_COMMITMENT, initialDeck, type Ciphertext } from '@/lib/deck';
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
      // delivery -- a_0 depends on nothing and is identical for every table.
      const deckIn = table.shuffleTurn === 0 ? initialDeck() : p.deck;
      if (!deckIn) {
        throw new Error(
          `Waiting for the deck from seat ${table.shuffleOrder[table.shuffleTurn - 1]}. ` +
            `The deck is private and travels off-chain, so it has to arrive before you can shuffle.`,
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
        proof: result.calldata.map((v) => '0x' + v.toString(16)),
      });
      return `${txt}\nwitness ${result.timings.witnessMs} ms · proof ${result.timings.proveMs} ms · calldata ${result.timings.calldataMs} ms`;
    });

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
              <button className={styles.chipBtn} disabled={!!busy}
                onClick={() => run('Checking', () => send('check', { table_id: table.tableId, seat: String(yourSeat) }))}>
                Check / call
              </button>
              <input className={styles.input} placeholder="amount" value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)} style={{ maxWidth: 140 }} />
              <button className={styles.chipBtn} disabled={!!busy || !betAmount}
                onClick={() => run('Betting', () => send('bet', { table_id: table.tableId, seat: String(yourSeat), amount: betAmount }))}>
                Bet / raise
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
          {isDealer(table, account) && table.roundComplete ? (
            <div className={styles.actionsRow}>
              <button className={uni.btn} disabled={!!busy}
                onClick={() => run('Advancing', () => send('advance_street', { table_id: table.tableId }))}>
                Advance street
              </button>
            </div>
          ) : null}
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
        <div className={styles.caution}>
          The shuffle chain is complete. Opening the deck needs a{' '}
          <code>circuits/deck_open</code> proof, and the browser build of that circuit is not staged
          yet — <code>scripts/build_client_circuits.mjs</code> only stages the shuffle circuit,
          because the deck-open circuit has no nargo 1.0.0-beta.16 build checked in. Compile it with
          beta.16 and re-run that script to enable this step.
        </div>
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
