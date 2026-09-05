'use client';

// Dealing, reveals, showdown and accusations.
//
// This is where the n-of-n property is paid for. Every card needs a share from
// every party, so most of what this panel does is coordinate people, and most
// of what can go wrong is somebody not answering. That is why the accusation
// controls sit here rather than in a corner: an unanswered share is not an
// error state to retry, it is a thing you name on-chain.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInterface, ProviderInterface } from 'starknet';
import styles from '../poker.module.css';
import uni from '../../uni.module.css';
import type { TableState } from '../useTableState';
import { asU256, decodeError, executeAndWait, pgCall, pokerGameReader, readU256 } from '../contract';
import type { SeatIdentity } from '@/lib/identity';
import { fromWire, type Point, cardToName } from '@/lib/grumpkin';
import { randomScalar } from '@/lib/grumpkin';
import * as dealing from '@/lib/dealing';
import { initProver as initDleqProver } from '@/lib/dleq';
import {
  cardFromShare, commitHoleSharesArgs, loadHoleOpening, revealCommunityArgs,
  revealHoleArgs, saveHoleOpening,
} from '@/lib/reveal';
import { BroadcastTransport, type Transport } from '@/lib/shares';
import { RelayTransport, relayUrl } from '@/lib/relayTransport';
import { communityPosition, seatHolePositions } from '@/lib/deck';

type Props = {
  table: TableState;
  yourSeat: number | null;
  identity: SeatIdentity | null;
  account: AccountInterface | undefined;
  provider: ProviderInterface | undefined;
  contract: string;
  chainId: string;
  refresh: () => void;
};

export default function RevealPanel(p: Props) {
  const { table, yourSeat, identity, account, provider, contract, refresh } = p;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const transport = useRef<Transport | null>(null);
  // A second stream with replay disabled, for the aggregate rounds only. See
  // RelayTransport's constructor note: replay is right for shares and wrong
  // for round-based messages.
  const liveOnly = useRef<Transport | null>(null);

  // A relay when one is configured, BroadcastChannel otherwise. The fallback
  // only spans tabs of this browser, which demonstrates a table and cannot
  // host a game between two people -- so the relay is what makes the share
  // exchange real. Either way every hole share is encrypted to its recipient
  // before it leaves, so the transport is never trusted.
  const [transportKind, setTransportKind] = useState<'relay' | 'local'>('local');
  useEffect(() => {
    const url = relayUrl();
    const t: Transport & { close: () => void } = url
      ? new RelayTransport(table.tableId, url)
      : new BroadcastTransport(table.tableId);
    const live: Transport & { close: () => void } = url
      ? new RelayTransport(table.tableId, url, { replay: false })
      : new BroadcastTransport(table.tableId);
    transport.current = t;
    liveOnly.current = live;
    setTransportKind(url ? 'relay' : 'local');
    return () => { t.close(); live.close(); };
  }, [table.tableId]);

  const keys = useMemo(() => {
    const m = new Map<number, Point>();
    for (const s of table.seats) if (s.occupied && s.keyRegistered && s.pk) m.set(s.seat, s.pk);
    return m;
  }, [table.seats]);

  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(label); setError(null); setNote(null);
    try {
      // Every action here ends in a DLEQ somewhere -- sending a share,
      // aggregating, answering an accusation -- and building one needs
      // garaga's wasm loaded for the MSM hints. Doing it here rather than in
      // an effect means it cannot lose a race with the first click, which is
      // exactly how this failed: 'dleq: call initProver() first' on the very
      // first share button. Idempotent, so the cost is one check per action.
      await initDleqProver();
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

  /** The opened ciphertext at a position, read from the contract's own storage. */
  const openedAt = useCallback(async (position: number) => {
    const c = pokerGameReader(contract, provider!);
    const raw = await c.get_opened_ciphertext(table.tableId, position);
    const [c1x, c1y, c2x, c2y] = (Array.isArray(raw) ? raw : [raw[0], raw[1], raw[2], raw[3]]).map(readU256);
    if (c1x === 0n && c1y === 0n) throw new Error(`position ${position} is not opened yet`);
    return { c1: fromWire(c1x, c1y), c2: fromWire(c2x, c2y) };
  }, [contract, provider, table.tableId]);

  /** Everyone's share for one position, gathered over the transport. */
  const gatherShares = useCallback(async (position: number, h: Point, priv: boolean) => {
    const shares = new Map<number, Point>();
    shares.set(yourSeat!, dealing.mul(identity!.secret, h));
    const outstanding = () => [...keys.keys()].filter((s) => !shares.has(s));

    await new Promise<void>((resolve, reject) => {
      const stop = transport.current!.subscribe(async (e) => {
        if (e.tableId !== table.tableId || e.position !== position || e.kind !== 'share') return;
        if (e.from === yourSeat) return;
        try {
          const msg = priv
            ? await dealing.openHoleShare(identity!.secret, e.body)
            : (e.body as any);
          const from = { seat: e.from, pk: keys.get(e.from)! };
          // Verified as it arrives, client-side. For a hole card this is the
          // only check there will ever be -- nobody else sees these shares.
          shares.set(e.from, dealing.acceptShare({ from, h, msg: normalise(msg) }));
          setBusy(`waiting on seat ${outstanding().join(', ') || '—'}`);
          if (outstanding().length === 0) { stop(); clearTimeout(timer); resolve(); }
        } catch (err) { stop(); clearTimeout(timer); reject(err); }
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`No share from seat ${outstanding().join(', ')} — accuse them below.`));
      }, 120_000);
      if (outstanding().length === 0) { stop(); clearTimeout(timer); resolve(); }
    });
    return shares;
  }, [keys, identity, yourSeat, table.tableId]);

  // ── send my share for a position everyone is waiting on ────────────────
  const contribute = (position: number, to: number | null) =>
    run(`Sending my share for position ${position}`, async () => {
      const { c1 } = await openedAt(position);
      const msg = dealing.shareFor(identity!.secret, c1);
      if (to === null) {
        transport.current!.publish({
          tableId: table.tableId, position, from: yourSeat!, kind: 'share', to: null,
          body: { d: { x: msg.d.x.toString(), y: msg.d.y.toString() }, s: msg.s.toString(), e: msg.e.toString() },
        });
        return `Broadcast a share for position ${position}.`;
      }
      await dealing.sendHoleShare({
        transport: transport.current!, tableId: table.tableId, position,
        from: yourSeat!, to, recipientPk: keys.get(to)!, msg,
      });
      return `Sent an encrypted share for seat ${to}'s position ${position}.`;
    });

  // ── deal: collect my hole shares and commit ────────────────────────────
  const dealMyHoleCards = () =>
    run('Collecting my hole shares', async () => {
      const out: string[] = [];
      for (const slot of [0, 1]) {
        const position = seatHolePositions(yourSeat!)[slot];
        if (table.seats[yourSeat!].holeCommitted[slot]) { out.push(`slot ${slot}: already committed`); continue; }
        const { c1, c2 } = await openedAt(position);
        setBusy(`gathering shares for slot ${slot}`);
        const shares = await gatherShares(position, c1, true);
        const D = dealing.combineShares([...shares.values()]);
        const card = cardFromShare({ c1, c2 }, D);
        if (card === null) {
          throw new Error(
            `slot ${slot}: the shares decrypt to a point outside the 52-card encoding. Either a ` +
              `share is wrong or the deck was fabricated — do not commit to this.`,
          );
        }
        const blinding = randomScalar();
        // Committed BEFORE betting. That ordering is the point: a commitment
        // made after the board is known would let a player pick a friendlier
        // share set, and the shares are what determine the card.
        await send('commit_hole_shares', commitHoleSharesArgs({
          tableId: table.tableId, seat: yourSeat!, slot, share: D!, blinding,
        }));
        saveHoleOpening(
          { chainId: p.chainId, contract, tableId: table.tableId, seat: yourSeat!, slot },
          { share: { x: D!.x, y: D!.y }, blinding, card, proof: [] },
        );
        out.push(`slot ${slot}: ${cardToName(card)}`);
      }
      return out.join('\n');
    });

  // ── community reveal ───────────────────────────────────────────────────
  const revealCommunity = (index: number) =>
    run(`Revealing community card ${index}`, async () => {
      const position = communityPosition(index, table.maxSeats);
      const { c1, c2 } = await openedAt(position);

      // Broadcast MY share before waiting for anyone else's.
      //
      // Without this the button only ever collects, so two clients both sit
      // waiting for a share the other never sent -- a deadlock that looks
      // exactly like the other player being offline. Community shares are
      // public by design (the card is about to be on the board), so this is a
      // plain broadcast, not sealed to anyone.
      setBusy('broadcasting my share');
      const myShare = dealing.shareFor(identity!.secret, c1);
      await transport.current!.publish({
        tableId: table.tableId, position, from: yourSeat!, kind: 'share', to: null,
        body: {
          d: { x: myShare.d.x.toString(), y: myShare.d.y.toString() },
          s: myShare.s.toString(), e: myShare.e.toString(),
        },
      });

      setBusy('gathering shares');
      const shares = await gatherShares(position, c1, false);
      setBusy('running the three-round aggregate');
      const agg = await dealing.runAggregate({
        transport: liveOnly.current!, tableId: table.tableId, position, h: c1,
        jointKey: table.jointKey, keys, shares, mySeat: yourSeat!, mySecret: identity!.secret,
        onProgress: (phase, outstanding) => setBusy(`${phase} — waiting on ${outstanding.join(', ') || '—'}`),
      });
      const card = cardFromShare({ c1, c2 }, agg.share);
      if (card === null) throw new Error('the combined share opens no card in the encoding');
      return send('reveal_community_card', revealCommunityArgs({
        tableId: table.tableId, index, share: agg.share, card, proof: agg.proof,
      }));
    });

  // ── showdown ───────────────────────────────────────────────────────────
  const showHoleCard = (slot: number) =>
    run(`Showing slot ${slot}`, async () => {
      const stored = loadHoleOpening({ chainId: p.chainId, contract, tableId: table.tableId, seat: yourSeat!, slot });
      if (!stored) {
        throw new Error(
          `No stored opening for slot ${slot}. It was written at dealing time and is needed to ` +
            `show — without it you can only muck, which forfeits the pot rather than blocking it.`,
        );
      }
      const position = seatHolePositions(yourSeat!)[slot];
      const { c1 } = await openedAt(position);

      // The aggregate is built HERE, not at dealing time. Building it earlier
      // would mean handing D to the co-signers, and c2 is already public, so
      // that would hand them this card. See src/lib/dealing.ts.
      setBusy('running the three-round aggregate');
      const shares = await gatherShares(position, c1, true);
      const agg = await dealing.runAggregate({
        transport: liveOnly.current!, tableId: table.tableId, position, h: c1,
        jointKey: table.jointKey, keys, shares, mySeat: yourSeat!, mySecret: identity!.secret,
        onProgress: (phase, outstanding) => setBusy(`${phase} — waiting on ${outstanding.join(', ') || '—'}`),
      });
      return send('reveal_hole_card', revealHoleArgs({
        tableId: table.tableId, seat: yourSeat!, slot,
        share: agg.share, blinding: stored.blinding, card: stored.card, proof: agg.proof,
      }));
    });

  // ── accusations ────────────────────────────────────────────────────────
  const [accSeat, setAccSeat] = useState('0');
  const [accPos, setAccPos] = useState('0');

  if (!table.deckOpened) return null;

  const mySeatState = yourSeat === null ? null : table.seats[yourSeat];

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Dealing &amp; reveals</div>
        <div className={styles.sectionHint}>
          Every card needs a share from every seat. Nobody can read your hole cards — decrypting one
          needs your own share, and pooling everything else leaves them one short.
        </div>
      </div>

      {/* Which transport is carrying shares. Prominent because it decides
          whether a game between two people is possible at all, and because
          the failure is silent: with BroadcastChannel the buttons work, the
          messages go nowhere a second client can hear, and both sides sit
          waiting for shares that were genuinely sent. */}
      <div className={transportKind === 'relay' ? styles.chip : styles.caution}>
        {transportKind === 'relay' ? (
          <>
            <strong>Relay:</strong> shares reach other clients, each encrypted to its recipient&apos;s
            registered key. The relay cannot read them.
          </>
        ) : (
          <>
            <strong>No relay.</strong> Shares are going over BroadcastChannel, which only reaches
            other <em>tabs of this browser</em> — another player&apos;s client will never receive
            them, and both sides will wait forever. Start <code>node scripts/relay.mjs</code> and
            reload.
          </>
        )}
      </div>

      {yourSeat !== null ? (
        <>
          <div className={styles.actionsRow}>
            <button className={uni.btn} disabled={!!busy} onClick={dealMyHoleCards}>
              Deal my hole cards
            </button>
            <span className={styles.fieldHint}>
              Collects a share from every seat, verifies each one locally, and commits to the
              combination <em>before</em> betting.
            </span>
          </div>

          <div className={styles.actionsRow}>
            {table.seats.filter((s) => s.occupied && s.seat !== yourSeat).flatMap((s) =>
              seatHolePositions(s.seat).map((pos) => (
                <button key={pos} className={styles.chipBtn} disabled={!!busy}
                  onClick={() => contribute(pos, s.seat)}>
                  share → seat {s.seat} pos {pos}
                </button>
              )),
            )}
            {table.community.map((_, i) => (
              <button key={`c${i}`} className={styles.chipBtn} disabled={!!busy}
                onClick={() => contribute(communityPosition(i, table.maxSeats), null)}>
                share → board {i}
              </button>
            ))}
          </div>

          <div className={styles.actionsRow}>
            {table.community.map((c, i) =>
              c.revealed ? null : (
                <button key={i} className={styles.chipBtn} disabled={!!busy} onClick={() => revealCommunity(i)}>
                  Reveal board {i}
                </button>
              ),
            )}
          </div>

          {table.street >= 4 || table.settled ? (
            <div className={styles.actionsRow}>
              {[0, 1].map((slot) =>
                mySeatState?.holeRevealed[slot] ? null : (
                  <button key={slot} className={uni.btn} disabled={!!busy} onClick={() => showHoleCard(slot)}>
                    Show slot {slot}
                  </button>
                ),
              )}
              <button className={uni.btn} disabled={!!busy}
                onClick={() => run('Settling', () => send('settle_from_reveals', { table_id: table.tableId }))}>
                Settle
              </button>
              <span className={styles.fieldHint}>
                Settling takes no input beyond the table — every card comes from storage a reveal
                proof bound — so anyone may call it and nobody can steer it. Declining to show
                forfeits rather than blocks.
              </span>
            </div>
          ) : null}
        </>
      ) : null}

      {/* ── accusations ─────────────────────────────────────────────── */}
      <div className={styles.sectionHead} style={{ marginTop: 18 }}>
        <div className={styles.sectionTitle}>Withheld shares</div>
        <div className={styles.sectionHint}>
          A share nobody can produce ends the hand however it is handled. What an accusation adds is
          a name and a cost.
        </div>
      </div>
      <div className={styles.grid3}>
        <div className={styles.field}>
          <label className={styles.label}>seat</label>
          <input className={styles.input} value={accSeat} onChange={(e) => setAccSeat(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>deck position</label>
          <input className={styles.input} value={accPos} onChange={(e) => setAccPos(e.target.value)} />
          <div className={styles.fieldHint}>
            Only seat S may accuse over its own hole positions ({yourSeat === null ? '2S, 2S+1' : `${2 * yourSeat}, ${2 * yourSeat + 1}`}).
            Answering publishes a share, and for a hole card that would make it publicly readable —
            so it is S&apos;s decision to make, not anyone else&apos;s.
          </div>
        </div>
      </div>
      <div className={styles.actionsRow}>
        <button className={uni.btn} disabled={!!busy}
          onClick={() => run('Accusing', () => send('accuse_share', {
            table_id: table.tableId, seat: accSeat, position: Number(accPos),
          }))}>
          Accuse
        </button>
        <button className={uni.btn} disabled={!!busy}
          onClick={() => run('Answering', async () => {
            const position = Number(accPos);
            const { c1 } = await openedAt(position);
            // Answering proves against this seat's OWN registered key, not the
            // joint key — that is what makes it name a party rather than merely
            // say "someone cheated".
            const proof = (await import('@/lib/dleq')).prove(identity!.secret, c1);
            return send('answer_accusation', {
              table_id: table.tableId, seat: String(yourSeat), position,
              share_x: asU256(proof.d!.x), share_y: asU256(proof.d!.y),
              proof: proof.proof.map((v) => '0x' + v.toString(16)),
            });
          })}>
          Answer
        </button>
        <button className={uni.btn} disabled={!!busy}
          onClick={() => run('Claiming', () => send('claim_share_timeout', {
            table_id: table.tableId, seat: accSeat, position: Number(accPos),
          }))}>
          Claim timeout
        </button>
      </div>

      {busy ? <div className={`${uni.receipt} ${uni.receiptPending}`}>
        <div className={uni.receiptHead}><span className={uni.receiptIcon}>⋯</span><span>{busy}</span></div>
      </div> : null}
      {note ? <div className={`${uni.receipt} ${uni.receiptOk}`}><pre className={uni.receiptNote}>{note}</pre></div> : null}
      {error ? <div className={`${uni.receipt} ${uni.receiptError}`}><pre className={uni.receiptNote}>{error}</pre></div> : null}
    </div>
  );
}

/** Transport bodies arrive as strings; the crypto wants bigints. */
function normalise(msg: any): dealing.ShareMessage {
  return {
    d: { x: BigInt(msg.d.x), y: BigInt(msg.d.y) },
    s: BigInt(msg.s),
    e: BigInt(msg.e),
  };
}
