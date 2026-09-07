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
import Why from './Why';
import type { TableState } from '../useTableState';
import { asU256, decodeError, executeAndWait, pgCall, pokerGameReader, readU256 } from '../contract';
import type { SeatIdentity } from '@/lib/identity';
import { fromWire, type Point, cardToName } from '@/lib/grumpkin';
import { randomFelt } from '@/lib/felt';
import * as dealing from '@/lib/dealing';
import { initProver as initDleqProver } from '@/lib/dleq';
import {
  cardFromShare, commitHoleSharesArgs, loadHoleOpening, revealCommunityArgs,
  revealHoleArgs, saveHoleOpening,
} from '@/lib/reveal';
import { BroadcastTransport, type Transport } from '@/lib/shares';
import { RelayStatus, RelayTransport, relayOverride, relayUrl, setRelayOverride } from '@/lib/relayTransport';
import { communityPosition, seatHolePositions } from '@/lib/deck';
import { useActivityLog } from '../activityLog';

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
  const pushLog = useActivityLog((s) => s.push);
  // ONE stream per tab, not two.
  //
  // There used to be a second, replay-disabled connection for the aggregate
  // rounds. It was redundant and actively harmful: round messages are marked
  // ephemeral, so the relay never stores them and never replays them -- the
  // ordinary stream is already live-only for exactly the messages that needed
  // it to be.
  //
  // Harmful because browsers cap concurrent connections per origin at about
  // six over HTTP/1.1, and SSE streams are long-lived. Four tabs times two
  // streams is eight: past the cap, some streams silently never connected and
  // the POSTs queued behind them. Clients sent their commitments and received
  // nothing, so every reveal stalled in the committing round with no error --
  // and it only appeared at three or more players.
  const transport = useRef<Transport | null>(null);

  // A relay when one is configured, BroadcastChannel otherwise. The fallback
  // only spans tabs of this browser, which demonstrates a table and cannot
  // host a game between two people -- so the relay is what makes the share
  // exchange real. Either way every hole share is encrypted to its recipient
  // before it leaves, so the transport is never trusted.
  const [transportKind, setTransportKind] = useState<'relay' | 'local'>('local');
  // Read in an effect, not here: localStorage does not exist on the server,
  // and seeding state from it during render is a hydration mismatch.
  const [relayInput, setRelayInput] = useState('');
  const [relayRev, setRelayRev] = useState(0);
  const [activeRelay, setActiveRelay] = useState<string | null>(null);
  const [relayStatus, setRelayStatus] = useState<RelayStatus>('connecting');
  useEffect(() => { setRelayInput(relayOverride() ?? ''); }, []);
  useEffect(() => {
    const url = relayUrl();
    setRelayStatus('connecting');
    const t: Transport & { close: () => void } = url
      ? new RelayTransport(table.tableId, url, { onStatus: setRelayStatus })
      : new BroadcastTransport(table.tableId);
    transport.current = t;
    setTransportKind(url ? 'relay' : 'local');
    setActiveRelay(url);
    // `served` is per TABLE, not per tab. Without this it survives a table
    // change, and deck positions are small integers that collide immediately:
    // a tab that served seat 0's holes (positions 0 and 1) on one table then
    // skips them on the next, silently, because the ref still says "done".
    //
    // Found by play. Two seats, two tabs, TABLE_2 then TABLE_3: the seat whose
    // tab had already served positions 0 and 1 served nothing on the new
    // table, so its opponent could never combine a share, never commit, and
    // never see a card -- while the other seat, which owed positions 2 and 3,
    // worked perfectly. Exactly one seat's cards appear, which reads like a
    // protocol asymmetry and is not one.
    served.current = new Set();
    // `joined` too, for the same reason and it is worse: it tracks which
    // aggregate ROUNDS this tab has joined, keyed by deck position, and the
    // community positions are the same small integers on every table
    // (2*max_seats .. +4). Carrying them across meant a tab that revealed the
    // board on one table silently refused to join the board rounds on the
    // next -- the flop simply never appeared, with nothing logged, because
    // `joined.current.has(pos)` returned early before any work started.
    joined.current = new Set();
    return () => { t.close(); };
    // relayRev: changing the relay must tear the old connection down and
    // reconnect, not wait for a reload. It also clears `served`, which is
    // correct -- a new relay has heard none of what the old one carried.
  }, [table.tableId, relayRev]);

  // Wake the DLEQ prover as soon as there is a deck, not when the clock is
  // running.
  //
  // initDleqProver loads garaga's wasm for the MSM hints. It is idempotent and
  // cheap afterwards, but the FIRST call is not, and every showdown path used
  // to pay it inside a ten-second deadline -- so a tab's first reveal was its
  // slowest, which is exactly the one that ran out of time. The clock is far
  // more forgiving now, but paying this during dealing still costs nothing:
  // there is no clock there.
  useEffect(() => {
    if (!table.deckOpened) return;
    void initDleqProver().catch(() => {
      // Reported by the first action that actually needs it; a warm-up that
      // fails must not put an error on screen by itself.
    });
  }, [table.deckOpened]);

  const keys = useMemo(() => {
    const m = new Map<number, Point>();
    for (const s of table.seats) if (s.occupied && s.keyRegistered && s.pk) m.set(s.seat, s.pk);
    return m;
  }, [table.seats]);

  // A run can be abandoned from the UI.
  //
  // `busy` disables every button in this panel, and the gathers inside a
  // reveal wait up to two minutes each for shares that may never arrive. So
  // one unanswered seat left the whole panel dead for minutes DURING a
  // showdown clock, with no way back but reloading the tab -- which is what
  // happened on TABLE_4, where "Show my hand" was greyed out and nothing said
  // why. The work itself cannot be cancelled (a promise in flight keeps
  // running), but the UI must not be held hostage by it: abandoning clears
  // the lock and lets the seat try again, and a late result from the
  // abandoned run is ignored rather than allowed to overwrite state.
  const runId = useRef(0);
  const abandon = () => {
    runId.current += 1;
    setBusy(null);
    pushLog('error', 'Abandoned', 'Anything already sent to the chain still stands — re-read the table before retrying.');
  };

  async function run(label: string, fn: () => Promise<string | void>) {
    const id = ++runId.current;
    const mine = () => runId.current === id;
    setBusy(label);
    try {
      // Every action here ends in a DLEQ somewhere -- sending a share,
      // aggregating, answering an accusation -- and building one needs
      // garaga's wasm loaded for the MSM hints. Doing it here rather than in
      // an effect means it cannot lose a race with the first click, which is
      // exactly how this failed: 'dleq: call initProver() first' on the very
      // first share button. Idempotent, so the cost is one check per action.
      await initDleqProver();
      const out = await fn();
      if (!mine()) return; // abandoned; its result is no longer this panel's
      // The result goes to the shared activity log (see activityLog.ts)
      // instead of rendering inline here -- only the pending indicator
      // stays next to the button that was clicked.
      pushLog('ok', label, typeof out === 'string' ? out : undefined);
      refresh();
    } catch (e) {
      if (!mine()) return;
      pushLog('error', label, decodeError(e));
    } finally {
      if (mine()) setBusy(null);
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
        } catch (err) {
          // One bad envelope must not abort the gather. The relay replays
          // history to every new subscriber, so a client legitimately sees
          // messages from earlier attempts and from seats it cannot decrypt
          // for -- rejecting on the first of those meant a single stale frame
          // killed a reveal that had every share it needed. A share that does
          // not verify is dropped and named; the wait continues, and the
          // timeout is what reports a seat that genuinely never sent one.
          say(`ignored a bad share for position ${position} from seat ${e.from}: ` +
              `${String((err as Error)?.message ?? err).slice(0, 90)}`);
        }
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
        // A felt252, NOT a curve scalar. See felt.ts's randomFelt: a Grumpkin
        // scalar does not fit in a felt252, and the mismatch only surfaces at
        // showdown, where the blinding is finally sent to the chain.
        const blinding = randomFelt();
        // Committed BEFORE betting. That ordering is the point: a commitment
        // made after the board is known would let a player pick a friendlier
        // share set, and the shares are what determine the card.
        await send('commit_hole_shares', commitHoleSharesArgs({
          tableId: table.tableId, seat: yourSeat!, slot, share: D!, blinding,
        }));
        saveHoleOpening(
          { chainId: p.chainId, contract, tableId: table.tableId, hand: table.handNumber, seat: yourSeat!, slot },
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
        transport: transport.current!, tableId: table.tableId, position, h: c1,
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
  //
  // Everything a reveal needs for ONE card, ready to send. Built during this
  // seat's showdown turn and not before: the aggregate challenge is taken over
  // D = SUM(d_i), c2 is already on-chain, so anyone holding D reads this card
  // -- which is why the co-signers only join once it is this seat's turn to
  // show (see the auto-join gate), and why building it earlier would hand the
  // table a hand nobody had agreed to expose.
  const prepareReveal = async (slot: number) => {
    const stored = loadHoleOpening({
      chainId: p.chainId, contract, tableId: table.tableId,
      hand: table.handNumber, seat: yourSeat!, slot,
    });
    if (!stored) {
      throw new Error(
        `No stored opening for slot ${slot}. It was written at dealing time and is needed to ` +
          `show — and a seat that cannot show forfeits its claim on the pot when the clock runs out.`,
      );
    }
    const position = seatHolePositions(yourSeat!)[slot];
    const { c1 } = await openedAt(position);
    const shares = await gatherShares(position, c1, true);
    // The co-signers need D, which includes THIS seat's share. Held back all
    // hand precisely so nobody could read this card; released now because
    // showing it is exactly what is about to happen.
    //
    // Announced for the whole aggregate, not just once before it: the other
    // seats only start gathering when they SEE this seat's first nonce
    // commitment, so the share has to still be arriving after that point.
    const agg = await announceOpenShare(position, () => dealing.runAggregate({
      transport: transport.current!, tableId: table.tableId, position, h: c1,
      jointKey: table.jointKey!, keys, shares, mySeat: yourSeat!, mySecret: identity!.secret,
      onProgress: (phase, outstanding) =>
        setBusy(`slot ${slot}: ${phase} — waiting on ${outstanding.join(', ') || '—'}`),
    }));
    return revealHoleArgs({
      tableId: table.tableId, seat: yourSeat!, slot,
      share: agg.share, blinding: stored.blinding, card: stored.card, proof: agg.proof,
    });
  };

  /**
   * Show every card this seat still owes, in ONE transaction.
   *
   * Both halves of that matter. The old shape built one card's aggregate, sent
   * it, then built the other's and sent that: two relay round-trips and two
   * transactions in series. Against the ten-second-per-seat clock this failed
   * outright -- every seat at the table showed its first card and was mucked
   * before the second, so a hand where everyone did the right thing ended with
   * nobody able to win it. That clock is gone, and this shape is still the
   * right one: the two aggregates are independent, so they run concurrently,
   * and the reveals go as a single multicall -- one signature, one
   * confirmation, and half as many round trips against a public chain.
   */
  const showHoleCards = (slots: number[]) =>
    run('Showing my hand', async () => {
      setBusy(`running the aggregate${slots.length === 1 ? '' : 's'}`);
      // allSettled, not all: one slot whose aggregate never completes used to
      // take the other down with it, so a hand with one gatherable card
      // showed nothing at all and the seat forfeited a pot it could have
      // won. Show what can be shown, say what could not.
      const settled = await Promise.allSettled(slots.map(prepareReveal));
      const ready = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = settled.flatMap((r, i) =>
        r.status === 'rejected' ? [`slot ${slots[i]}: ${String(r.reason?.message ?? r.reason).slice(0, 90)}`] : []);
      if (!ready.length) throw new Error(failed.join(' · ') || 'no aggregate completed');
      const { txHash } = await executeAndWait(
        account!, provider!,
        ready.map((a) => pgCall(contract, 'reveal_hole_card', a as any)),
      );
      const note = failed.length ? `\nstill missing — ${failed.join(' · ')}` : '';
      return `showed ${ready.length} card${ready.length === 1 ? '' : 's'} — ${txHash}${note}`;
    });

  // ── automatic share service ────────────────────────────────────────────
  //
  // None of this needs a human. Sending a share and taking part in the
  // aggregate rounds are mechanical: there is no decision to make, no
  // information to weigh, and getting them wrong only stalls the table. The
  // buttons below exist because making each step visible was useful while
  // proving the protocol worked; leaving them as the only way to play would
  // mean two people clicking in lockstep for every card, which is not a game.
  //
  // What stays manual is what actually involves a choice: bet / check / fold.
  // Showing is no longer one of them -- every contender shows -- but the toggle
  // stays, because a client that sends transactions on its own should always be
  // stoppable.
  //
  // ── The one rule that makes this safe ─────────────────────────────────
  //
  // A client serves shares for positions it OWES someone -- other seats' hole
  // positions, and the community positions. It must NEVER serve its own share
  // for its OWN hole positions, and never join an aggregate over them.
  //
  // That is not tidiness. Reading seat S's card needs a share from every party
  // for position 2S; the opponents' shares are supposed to be handed over,
  // and S's own is the piece that keeps the card private. A client that served
  // it on request would hand out the last missing piece and expose its own
  // hand. So "answer anything asked" is exactly the wrong default, and the
  // scoping below is the security property, not a convenience.
  const served = useRef<Set<number>>(new Set());
  const joined = useRef<Set<number>>(new Set());

  // The per-position latches are per HAND, not just per table.
  //
  // `served` and `joined` are keyed by deck position, and the positions repeat
  // every hand -- seat s's cards are always at 2s and 2s+1, the board is
  // always the five after the holes. They are cleared on a table change
  // already; without clearing them on a HAND change too, the second hand at a
  // table serves nobody and joins nothing, because every position reads as
  // already done. Exactly the bug that made a new table silently refuse to
  // deal, one scope in.
  const handLatch = useRef<number | null>(null);
  useEffect(() => {
    if (handLatch.current === table.handNumber) return;
    handLatch.current = table.handNumber;
    served.current = new Set();
    joined.current = new Set();
  }, [table.handNumber]);

  // The auto-join effect must subscribe ONCE. Anything it needs that changes
  // on every poll -- the seat keys, the community array, the callbacks that
  // close over them -- goes in a ref instead of the dependency array, or the
  // effect tears down and re-subscribes every few seconds and drops messages
  // in the gap.
  const latest = useRef({ keys, table, identity, openedAt, gatherShares, refresh, send });
  latest.current = { keys, table, identity, openedAt, gatherShares, refresh, send };
  const [autoServe, setAutoServe] = useState(true);
  const [autoShow, setAutoShow] = useState(true);
  // Automatic-coordination status (share serving, reveals, blind posting)
  // used to accumulate as a local <pre> block that only ever grew. It goes
  // to the shared activity log now, same as everything else -- see
  // activityLog.ts.
  const say = useCallback((m: string) => pushLog('info', m), [pushLog]);

  /**
   * The street a community card belongs to. Mirrors the contract's own gate.
   *
   *   street 1 flop -> indices 0,1,2 · street 2 turn -> 3 · street 3 river -> 4
   */
  const streetFor = (index: number) => (index <= 2 ? 1 : index === 3 ? 2 : 3);

  /**
   * Positions this seat owes a share for, and who to send each to.
   *
   * Community shares are withheld until the street that deals the card.
   * Handing them over early lets the whole board be revealed before a single
   * bet -- the contract now refuses such a reveal, but a client that gives the
   * shares away anyway is still handing over material it did not need to, and
   * "the chain will stop them" is a poor reason to leak. Hole shares are owed
   * from the moment the deck opens: that is what dealing IS.
   */
  const owed = useMemo(() => {
    if (yourSeat === null) return [];
    const out: { pos: number; to: number | null }[] = [];
    for (const s of table.seats) {
      if (!s.occupied || s.seat === yourSeat) continue;
      for (const pos of seatHolePositions(s.seat)) out.push({ pos, to: s.seat });
    }
    for (let k = 0; k < 5; k++) {
      if (table.street < streetFor(k)) continue;
      out.push({ pos: communityPosition(k, table.maxSeats), to: null });
    }
    return out;
  }, [table.seats, table.maxSeats, yourSeat, table.street]);

  // Serve every share owed, once each, as soon as the deck is open.
  useEffect(() => {
    if (!autoServe || !table.deckOpened || yourSeat === null || !identity || !provider) return;
    let cancelled = false;
    (async () => {
      await initDleqProver();
      for (const { pos, to } of owed) {
        if (cancelled || served.current.has(pos)) continue;
        try {
          const { c1 } = await openedAt(pos);
          const msg = dealing.shareFor(identity.secret, c1);
          if (to === null) {
            // Community: public by design, so broadcast rather than sealed.
            await transport.current!.publish({
              tableId: table.tableId, position: pos, from: yourSeat, kind: 'share', to: null,
              body: {
                d: { x: msg.d.x.toString(), y: msg.d.y.toString() },
                s: msg.s.toString(), e: msg.e.toString(),
              },
            });
          } else {
            await dealing.sendHoleShare({
              transport: transport.current!, tableId: table.tableId, position: pos,
              from: yourSeat, to, recipientPk: keys.get(to)!, msg,
            });
          }
          served.current.add(pos);
          say(`served share for position ${pos}${to === null ? ' (board)' : ` (seat ${to})`}`);
        } catch {
          // Usually "not opened yet". Retried on the next poll rather than
          // treated as a failure -- positions open in chunks.
        }
      }
    })();
    return () => { cancelled = true; };
  }, [autoServe, table.deckOpened, table.deckOpenChunk, yourSeat, identity, provider, owed, keys, openedAt, say, table.tableId]);

  /**
   * Publish this seat's share for `pos` IN THE CLEAR.
   *
   * Only ever called for a hole position at showdown, and that restriction is
   * the security property, not a detail.
   *
   * The aggregate challenge is taken over D = SUM(d_i), so every co-signer
   * must know D to produce its s_i -- and c2 is already on-chain, so anyone
   * who knows D for a hole position computes c2 - D and reads that card. That
   * is why hole shares are sealed to their owner during dealing and why
   * src/lib/dealing.ts builds the hole aggregate at showdown rather than at
   * dealing time (docs/PROTOCOL.md §9.5).
   *
   * At showdown the card is being turned face up anyway, so D stops being a
   * secret and the co-signers can finally have it. Publishing it is what makes
   * a hand finish. Publishing it one moment earlier would hand the table
   * somebody's hole cards.
   */
  const publishOpenShare = useCallback(async (pos: number) => {
    const { c1 } = await openedAt(pos);
    const msg = dealing.shareFor(identity!.secret, c1);
    await transport.current!.publish({
      tableId: table.tableId, position: pos, from: yourSeat!, kind: 'share', to: null,
      body: {
        d: { x: msg.d.x.toString(), y: msg.d.y.toString() },
        s: msg.s.toString(), e: msg.e.toString(),
      },
    });
  }, [openedAt, identity, yourSeat, table.tableId]);

  /**
   * Publish this seat's open share for `pos` and KEEP publishing it until
   * `fn` finishes.
   *
   * Sending it once is not enough, and that is not a transport quirk to work
   * around -- it is the shape of the problem. Clients arrive at a position at
   * different moments: a reload, a slow gather, a retry after a timeout. A
   * share sent before a peer was listening is simply gone, so that peer waits
   * for something that was genuinely sent, while the sender considers the job
   * done. Both sides then wait forever, which is exactly how a showdown with
   * every card in place still could not finish.
   *
   * The nonce commitments in src/lib/dealing.ts are re-announced for the same
   * reason. This is the same rule applied to the one message that was still
   * being sent once.
   *
   * Re-publishing is free of consequence: receivers key shares by seat, so a
   * repeat overwrites itself, and each carries its own DLEQ.
   */
  const announceOpenShare = useCallback(async <T,>(pos: number, fn: () => Promise<T>): Promise<T> => {
    await publishOpenShare(pos);
    say(`published my share for position ${pos} -- seat ${Math.floor(pos / 2)} is showing`);
    const timer = setInterval(() => { void publishOpenShare(pos).catch(() => {}); }, 2500);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
    }
  }, [publishOpenShare, say]);

  /**
   * Run the aggregate for one position: gather shares, do the three rounds,
   * and submit if it is a community card.
   *
   * Shared by BOTH paths -- joining an aggregate someone else started, and
   * starting one because a card is due. They have to be the same code and
   * share the same `joined` guard, or a client that does both ends up running
   * two sessions for one position and answering its own rounds twice.
   */
  // ── did somebody else already do it? ─────────────────────────────────
  // Both of these are read straight from the contract when a submission
  // fails. The alternative -- trusting `table`, which is refreshed by a poll
  // running at twelve seconds on a public chain -- reports a lost race as an
  // error for as long as the poll is behind, which is exactly the window in
  // which races are lost.
  const blindsAreIn = useCallback(async (): Promise<boolean> => {
    try {
      const c = pokerGameReader(contract, provider!);
      return !!Number(await c.get_blinds_posted(latest.current.table.tableId));
    } catch {
      return false;
    }
  }, [contract, provider]);

  const runFor = useCallback(async (pos: number) => {
    const L = latest.current;
    await initDleqProver();
    const { c1, c2 } = await L.openedAt(pos);
    // Joining a showdown reveal of somebody else's hole card: the co-signers
    // need D, so every share for that position has to be in the clear. This
    // seat's is one of them.
    const joiningAHoleReveal = pos < 2 * L.table.maxSeats && Math.floor(pos / 2) !== yourSeat;

    const gatherThenAggregate = async () => {
      const shares = await L.gatherShares(pos, c1, false);
      // Report the ROUND, not just "working".
      //
      // Without this the UI kept showing the last message gatherShares set --
      // "waiting on seat —", meaning it had every share it needed -- for the
      // entire three-round aggregate, so a table that was mid-protocol looked
      // identical to one stuck collecting shares. The phase and who is
      // outstanding is the whole diagnostic for an n-of-n round.
      setBusy(`position ${pos}: shares in, starting the aggregate`);
      return dealing.runAggregate({
        transport: transport.current!, tableId: L.table.tableId, position: pos, h: c1,
        jointKey: L.table.jointKey!, keys: L.keys, shares,
        mySeat: yourSeat!, mySecret: L.identity!.secret,
        onProgress: (phase, outstanding) => {
          const who = outstanding.length ? `waiting on seat ${outstanding.join(', ')}` : 'all in';
          setBusy(`position ${pos}: ${phase} round — ${who}`);
          say(`pos ${pos} ${phase}: ${who}`);
        },
      });
    };

    // Announced across the WHOLE run, not just this seat's own gather. The
    // other co-signers reach their gather at different moments -- one is
    // already aggregating while another is still collecting -- so stopping
    // the moment this seat has what it needs strands whoever is behind it.
    const agg = joiningAHoleReveal
      ? await announceOpenShare(pos, gatherThenAggregate)
      : await gatherThenAggregate();
    setBusy(null);
    const communityBase = 2 * L.table.maxSeats;
    const card = cardFromShare({ c1, c2 }, agg.share);
    if (card === null) return;

    if (pos < communityBase) return; // a hole card: participation only
    const index = pos - communityBase;
    if (L.table.community[index]?.revealed) return;
    try {
      await L.send('reveal_community_card', revealCommunityArgs({
        tableId: L.table.tableId, index, share: agg.share, card, proof: agg.proof,
      }));
      say(`revealed board ${index}`);
      L.refresh();
    } catch {
      // Someone else submitted first. That is the point of both sides trying.
    }
  }, [yourSeat, say, announceOpenShare]);

  // Join an aggregate the moment someone starts one, so a reveal is one click
  // for whoever wants the card and nothing at all for everyone else.
  const deckIsOpen = table.deckOpened;
  const mySecretHex = identity ? identity.secret.toString(16) : null;
  useEffect(() => {
    if (!autoServe || !deckIsOpen || yourSeat === null || !mySecretHex) return;
    const myHoles = seatHolePositions(yourSeat);
    const stop = transport.current!.subscribe((e) => {
      if (e.kind !== 'nonce-commit' || e.from === yourSeat) return;
      const pos = e.position;
      if (joined.current.has(pos)) return;
      // Never over my own hole positions -- see the rule above. Showing is a
      // decision, and the share that keeps the card private is mine.
      if (myHoles.includes(pos)) return;
      const T = latest.current.table;
      if (pos < 2 * T.maxSeats) {
        // Somebody else's HOLE card, which now means publishing a share that
        // lets the whole table read it. Three conditions, all of them load
        // bearing, and none of them merely tidy:
        //
        //   * the showdown has actually started -- before that a hole card is
        //     nobody's business and this share is the thing protecting it;
        //   * the request came from the card's OWNER, not a third party. Any
        //     seat could otherwise nonce-commit on a rival's hole position and
        //     have the rest of the table hand over the pieces of their hand;
        //   * the owner is still entitled to show: not folded, and not already
        //     forfeited on the showdown clock.
        //
        // There is no third condition about whose TURN it is, because there is
        // no turn order any more -- every contender shows, so nothing is
        // protected by making them queue.
        //
        // Together: this seat helps expose a hole card only when its owner
        // asks, at showdown, while they may still show it.
        const owner = Math.floor(pos / 2);
        if (!T.showdownStarted || T.settled) return;
        if (e.from !== owner) return;
        if (T.seats[owner]?.forfeited || T.seats[owner]?.folded) return;
      }
      // And never help open a board card before its street. Same reasoning as
      // `owed`: the contract refuses the reveal, but there is no reason to
      // contribute to it in the first place.
      const communityIndex = pos - 2 * latest.current.table.maxSeats;
      // Indices 0..4 are the board. Nothing sits past them -- the in-play
      // block ends at 2*max_seats + 5 now that the button is not dealt.
      if (communityIndex >= 0 && communityIndex < 5
          && latest.current.table.street < streetFor(communityIndex)) return;
      joined.current.add(pos);
      void runFor(pos).catch((err) => {
        joined.current.delete(pos); // let a fresh run be joined
        say(`aggregate for position ${pos} failed: ${String(err?.message ?? err).slice(0, 110)}`);
      });
    });
    return stop;
  }, [autoServe, deckIsOpen, yourSeat, mySecretHex, say]);


  // Start a reveal for any board card that is DUE and still face down.
  //
  // A community reveal needs a decryption share from every player, so the
  // keeper structurally cannot do it -- it holds no key share. Somebody's
  // client has to begin, and until now that was a human clicking "Reveal
  // board N" for a card with no decision attached to it.
  //
  // Both clients try. Whoever gets there first proposes the run (the lowest
  // seat names it, see runAggregate) and the other joins; whoever finishes
  // first submits and the other's transaction is refused as already revealed,
  // which is the correct outcome rather than an error.
  //
  // The street check is not just tidiness: it mirrors the contract's own gate,
  // and without it this loop would try to turn the whole board over the moment
  // the deck opened -- which is exactly the bug that made the last hand
  // unplayable.
  useEffect(() => {
    if (!autoServe || !deckIsOpen || yourSeat === null || !mySecretHex) return;
    if (!table.jointKey) return;
    for (let index = 0; index < 5; index++) {
      if (table.community[index]?.revealed) continue;
      if (table.street < streetFor(index)) continue;
      const pos = communityPosition(index, table.maxSeats);
      if (joined.current.has(pos)) continue;
      joined.current.add(pos);
      say(`board ${index} is due -- starting the reveal`);
      void runFor(pos).catch((err) => {
        joined.current.delete(pos);
        say(`reveal for board ${index} failed: ${String(err?.message ?? err).slice(0, 110)}`);
      });
    }
  }, [autoServe, deckIsOpen, yourSeat, mySecretHex, table.street, table.community, table.jointKey, table.maxSeats, runFor, say]);

  // ── draw for the button, then post the blinds ─────────────────────────
  //
  // Neither of these is a decision, so neither should be a button.
  // Posting is permissionless and takes no arguments, so any client can do it
  // and it does not matter which. Latched per hand rather than forever: the
  // button rotates and the blinds are posted again next hand -- and on a table
  // with a blind ladder they are posted at a different price each level.
  // Keyed by TABLE AND hand, not hand alone.
  //
  // Hand numbers restart at 0 on every table, so a tab that posted the blinds
  // for hand 0 here would skip them on the next table it opened -- the same
  // shape of bug as `served` and `joined`, which both cached by a value that
  // repeats across tables. Keying by both makes it self-defending rather than
  // dependent on someone remembering to clear it.
  const postedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!autoServe || yourSeat === null || !account || !provider) return;
    if (!table.buttonSet || table.blindsPosted || table.settled || table.voided) return;
    if (table.bigBlind === 0n) return; // a table with no structure
    // NOT until the deck is open, even though the contract would allow it.
    //
    // post_blinds needs only button_set and street 0, and button_set is
    // written by begin_shuffle -- so this used to fire the instant the shuffle
    // opened, putting real money on the table before a single card existed.
    // Then the 600s shuffle clock ran with the pot funded, and a shuffle that
    // did not land in time cost the small blind: exactly what happened on
    // TABLE_2, where 30 STRK sat on a table that was never dealt and the
    // stalled seat forfeited 10 of it.
    //
    // Waiting costs nothing. The blinds are still fixed before any card is
    // READABLE -- the deck opens as ciphertexts and needs every seat's share
    // to reveal anything -- so the property that matters (stakes not tuned to
    // a deal) holds either way. It also matches phaseOf, which already puts
    // 'posting' after 'opening'; the client was contradicting its own model.
    if (!table.deckOpened) return;
    const handKey = `${table.tableId}:${table.handNumber}`;
    if (postedFor.current === handKey) return;
    postedFor.current = handKey;
    say('posting the blinds');
    void (async () => {
      try {
        await send('post_blinds', { table_id: table.tableId });
        refresh();
      } catch (e) {
        // Almost always "someone else already posted", which is fine -- and
        // confirmed against the chain rather than the poll, which lags. Any
        // other failure -- a player with no allowance, most likely -- has to
        // be visible or the table just sits there.
        if (await blindsAreIn()) return;
        postedFor.current = null;
        say(`post_blinds: ${decodeError(e).slice(0, 110)}`);
      }
    })();
  }, [autoServe, yourSeat, account, provider, table.buttonSet, table.blindsPosted,
      table.deckOpened, table.settled, table.voided, table.bigBlind, table.handNumber,
      table.tableId, say]);

  // ── deal your own cards without being asked ───────────────────────────
  //
  // No decision here either: you collect a share from every party, verify each
  // against its sender's registered key, combine them, and commit. You cannot
  // play the hand without doing it, and the commitment has to be posted before
  // betting -- that ordering is what stops a player shopping for a friendlier
  // share set after seeing the board.
  //
  // Retried rather than latched: the first attempt can legitimately fail
  // because another seat has not served its share yet, and giving up would
  // strand the player at a table they could still join.
  const dealing2 = useRef(false);
  useEffect(() => {
    if (!autoServe || !deckIsOpen || yourSeat === null || !mySecretHex) return;
    if (dealing2.current) return;
    const me = table.seats[yourSeat];
    if (!me || (me.holeCommitted[0] && me.holeCommitted[1])) return;
    dealing2.current = true;
    say('dealing my hole cards');
    void dealMyHoleCards().finally(() => {
      // Cleared, not held: a failure here usually means somebody has not sent
      // their share yet, and the next poll should try again.
      dealing2.current = false;
    });
  }, [autoServe, deckIsOpen, yourSeat, mySecretHex, table.seats, say]);

  // ── show at showdown, unless told not to ──────────────────────────────
  //
  // Two different things happen at showdown and only one of them is a
  // decision.
  //
  // Helping SOMEONE ELSE show is mechanical: their card needs a share from
  // every party, so a client that sits out is not being cautious, it is
  // stopping a hand from resolving. The auto-join above already covers that --
  // it skips only this seat's OWN hole positions.
  //
  // Showing YOUR hand is now the rule rather than a choice: every contender
  // shows, and the only way not to is to let the showdown clock run out, which
  // forfeits. The toggle stays because a client that fires transactions on its
  // own should always be stoppable -- but leaving it off costs the pot rather
  // than protecting a losing hand from view.
  //
  // Folded and already-forfeited seats are skipped: they have nothing to show
  // and the contract would reject it.
  // Why the automatic show is NOT running, when it is a contender's turn to
  // show and nothing is happening. Same reasoning as shuffleBlocker: an
  // effect that returns early looks exactly like one that never fired, and
  // during a showdown the clock is running while you guess.
  const showdownBlocker = (() => {
    if (!table.showdownStarted || table.settled) return null;
    if (yourSeat === null) return 'you are not seated at this table';
    const me = table.seats[yourSeat];
    if (!me) return null;
    if (me.folded) return 'you folded — nothing to show';
    if (me.forfeited) return 'you forfeited on the clock — the contract will refuse a reveal';
    if (me.holeRevealed[0] && me.holeRevealed[1]) return null;
    if (!autoShow) return 'automatic showing is switched off — use "Show my hand"';
    if (!mySecretHex) return 'no seat key in this browser — reconnect the account that registered';
    if (!account) return 'no wallet or local account is connected';
    if (busy) return `waiting on ${busy}`;
    return null;
  })();

  const showing = useRef(false);
  useEffect(() => {
    if (!autoShow || yourSeat === null || !mySecretHex) return;
    if (!table.showdownStarted || table.settled) return;
    const me = table.seats[yourSeat];
    if (!me || me.folded || me.forfeited || showing.current) return;
    const pending = [0, 1].filter((slot) => !me.holeRevealed[slot]);
    if (pending.length === 0) return;
    showing.current = true;
    void showHoleCards(pending).finally(() => { showing.current = false; });
  }, [autoShow, yourSeat, mySecretHex, table.showdownStarted, table.settled, table.seats]);

  // Close the showdown once its clock has run out.
  //
  // Not showing in time forfeits: there is nothing to reconstruct and nobody
  // to punish beyond the pot that seat gives up. One call closes the whole
  // showdown, because there is one deadline for the table rather than one per
  // seat. Callable by anyone, so any client can unstick a showdown somebody
  // walked away from -- the same reasoning as every other timeout here.
  const clearing = useRef(false);
  useEffect(() => {
    if (!table.showdownStarted || table.settled || !table.showdownDeadline) return;
    if (!account || !provider || clearing.current) return;
    const msLeft = table.showdownDeadline * 1000 - Date.now();
    if (msLeft > 0) return;
    clearing.current = true;
    void (async () => {
      try {
        await send('claim_showdown_timeout', { table_id: table.tableId });
        refresh();
      } catch {
        // Someone else got there first, or the seat showed just in time.
      } finally {
        clearing.current = false;
      }
    })();
  }, [table.showdownStarted, table.showdownDeadline, table.settled, account, provider]);

  // ── accusations ────────────────────────────────────────────────────────
  const [accSeat, setAccSeat] = useState('0');
  const [accPos, setAccPos] = useState('0');

  if (!table.deckOpened) return null;

  const mySeatState = yourSeat === null ? null : table.seats[yourSeat];

  return (
    <details className={styles.section}>
      <summary className={`${styles.sectionHead} ${styles.sectionHeadToggle}`}>
        <div className={styles.sectionTitle}>Dealing &amp; reveals</div>
        <div className={styles.sectionHint}>
          Every card needs a share from every seat. Nobody can read your hole cards — decrypting one
          needs your own share, and pooling everything else leaves them one short.
        </div>
      </summary>

      {/* Which transport is carrying shares. Prominent because it decides
          whether a game between two people is possible at all, and because
          the failure is silent: with BroadcastChannel the buttons work, the
          messages go nowhere a second client can hear, and both sides sit
          waiting for shares that were genuinely sent. */}
      <div className={transportKind === 'relay' && relayStatus === 'open' ? styles.bannerOk : styles.caution}>
        {transportKind === 'relay' && relayStatus !== 'open' ? (
          <>
            {/* A relay that is DOWN must not read the same as one that is
                working. Reconnection is automatic and backs off, but silently
                retrying while the chip still says "shares reach other clients"
                recreates the exact failure this chip exists to warn about:
                the buttons respond, nothing arrives, and both players wait. */}
            <strong>Relay {relayStatus === 'retrying' ? 'unreachable' : 'connecting'}.</strong>{' '}
            {relayStatus === 'retrying'
              ? 'Retrying with backoff. Shares are not moving while this says so — check the relay is up and that everyone is pointed at the same url.'
              : 'Opening the stream.'}
          </>
        ) : transportKind === 'relay' ? (
          <>
            <strong>Relay:</strong> shares reach other clients, each encrypted to its recipient&apos;s
            registered key. The relay cannot read them.
          </>
        ) : (
          <>
            <strong>No relay.</strong> Shares are going over BroadcastChannel, which only reaches
            other <em>tabs of this browser</em> — another player&apos;s client will never receive
            them, and both sides will wait forever. Run <code>node scripts/relay.mjs</code>, or
            point this browser at one below.
          </>
        )}
      </div>

      {/* Set at run time, not baked in. NEXT_PUBLIC_RELAY_URL is inlined when
          the app is BUILT, so a deployed build could otherwise only ever talk
          to the relay that existed at compile time -- and players on separate
          devices need to agree on one now, without a redeploy. Everyone at a
          table must enter the SAME url. */}
      <div className={styles.actionsRow}>
        <label className={styles.fieldHint} style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
          Relay
          <input
            className={styles.input}
            style={{ flex: 1, minWidth: 220 }}
            placeholder={activeRelay ?? 'https://your-relay.example — blank uses this build\u2019s default'}
            value={relayInput}
            onChange={(e) => setRelayInput(e.target.value)}
          />
        </label>
        <button
          className={uni.btn}
          onClick={() => {
            setRelayOverride(relayInput || null);
            setRelayRev((n) => n + 1);
            say(relayInput ? `relay set to ${relayInput}` : 'relay reset to this build\u2019s default');
          }}>
          Use this relay
        </button>
        <span className={styles.fieldHint}>
          Every player at the table must point at the same one. It is trusted with nothing —
          shares are sealed to the recipient&apos;s registered key and carry a proof the recipient
          checks — so any of you can host it.
        </span>
      </div>

      {yourSeat !== null ? (
        <>
          <div className={styles.actionsRow}>
            <button className={uni.btn} disabled={!!busy} onClick={dealMyHoleCards}>
              Deal my hole cards
            </button>
            <Why>
              Happening automatically — this button is only a retry. Collects a share from every
              seat, verifies each against that seat&apos;s registered key, and commits to the
              combination <em>before</em> betting, which is what stops anyone shopping for a
              friendlier share set after seeing the board.
            </Why>
          </div>

          {/* Serving shares is automatic. It is left switchable because the
              manual buttons are the only way to see a single step in
              isolation, which is what every coordination bug in this layer
              was found with. */}
          <div className={styles.actionsRow}>
            <label className={styles.fieldHint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={autoServe} onChange={(e) => setAutoServe(e.target.checked)} />
              Serve shares and join reveals automatically
            </label>
            <span className={styles.chip}>
              {served.current.size}/{owed.length} shares served
            </span>
            <span className={styles.chip}>
              parties: {[...keys.keys()].sort((a, b) => a - b).join(', ') || 'none'}
            </span>
            {/* Both auto-effects return early without a joint key, silently.
                An n-of-n aggregate then stalls with no error anywhere. */}
            <span className={table.jointKey ? styles.chipOwner : styles.caution}>
              joint key: {table.jointKey ? 'yes' : 'MISSING'}
            </span>
            <span className={styles.chip}>street {table.street}</span>
          </div>

          {!autoServe ? (
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
                <button key={`c${i}`} className={styles.chipBtn}
                  disabled={!!busy || table.street < streetFor(i)}
                  title={table.street < streetFor(i) ? `not due until street ${streetFor(i)}` : undefined}
                  onClick={() => contribute(communityPosition(i, table.maxSeats), null)}>
                  share → board {i}
                </button>
              ))}
            </div>
          ) : null}

          <div className={styles.actionsRow}>
            {table.community.map((c, i) =>
              c.revealed ? null : (
                <button key={i} className={styles.chipBtn}
                  disabled={!!busy || table.street < streetFor(i)}
                  title={table.street < streetFor(i)
                    ? `board ${i} is not dealt until street ${streetFor(i)}`
                    : undefined}
                  onClick={() => revealCommunity(i)}>
                  Reveal board {i}
                </button>
              ),
            )}
          </div>

          {table.showdownStarted ? (
            <div className={styles.stateGrid}>
              <Item label="clock" value={<ShowdownClock deadline={table.showdownDeadline} />} />
              <Item label="showing"
                value={table.seats.filter((s) => s.occupied && !s.folded)
                  .map((s) => `${s.seat}${s.forfeited
                    ? ' (forfeit)'
                    : s.holeRevealed[0] && s.holeRevealed[1] ? ' ✓' : ' …'}`)
                  .join('  ')} />
            </div>
          ) : null}

          {table.street >= 4 || table.settled ? (
            <div className={styles.actionsRow}>
              <label className={styles.fieldHint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={autoShow} onChange={(e) => setAutoShow(e.target.checked)} />
                Show my hand automatically at showdown
              </label>
              {/* One button for the hand, not one per card: both reveals go in
                  a single transaction, which is also one fewer round trip
                  against the showdown clock. */}
              {(() => {
                // Only a seat that MAY show gets the button.
                //
                // It used to appear for any seat with unrevealed slots, which
                // includes one that folded -- and a folded seat has nothing to
                // show, so pressing it started an aggregate no other client
                // would ever join (the responder refuses a request whose owner
                // has folded). That seat then sat in a two-minute-per-card
                // wait with `busy` disabling its whole panel, publishing
                // shares for its own dead cards, while the contenders needed
                // it to be answering THEIR rounds instead. That is what
                // stalled TABLE_4's showdown.
                const canShow = mySeatState && !mySeatState.folded && !mySeatState.forfeited;
                const owed = [0, 1].filter((slot) => !mySeatState?.holeRevealed[slot]);
                return canShow && owed.length ? (
                  <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={!!busy} onClick={() => showHoleCards(owed)}>
                    Show my hand{owed.length === 1 ? ` (slot ${owed[0]})` : ''}
                  </button>
                ) : null;
              })()}
              <button className={uni.btn} disabled={!!busy}
                onClick={() => run('Settling', () => send('settle_from_reveals', { table_id: table.tableId }))}>
                Settle
              </button>
              <Why>
                Settling takes no input beyond the table — every card comes from storage a reveal
                proof bound — so anyone may call it and nobody can steer it, and it is refused until
                the showdown is actually over. There is no muck: every contender shows, and a seat
                that does not show before the clock runs out forfeits its claim on the pot.
                Helping others show is automatic, since their card needs a share from every seat and
                sitting out only stops the hand resolving.
              </Why>
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

      {/* Result goes to the shared activity log -- see the `pushLog` calls
          in `run()` above. Only the in-flight indicator stays here. */}
      {busy ? <div className={`${uni.receipt} ${uni.receiptPending}`}>
        <div className={uni.receiptHead}>
          <span className={uni.receiptIcon}>⋯</span><span>{busy}</span>
          {/* The way out. A gather waits up to two minutes per card for
              shares that may never come, and `busy` disables everything --
              so without this the panel is dead for minutes during a showdown
              clock and the only escape is reloading the tab. */}
          <button className={uni.btn} style={{ marginLeft: 'auto' }} onClick={abandon}>
            Abandon
          </button>
        </div>
      </div> : null}

      {/* Why nothing is happening at showdown, when something should be. */}
      {showdownBlocker ? (
        <div className={styles.caution}>
          <strong>Not showing:</strong> {showdownBlocker}
        </div>
      ) : null}
    </details>
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


/** Seconds left on the showdown clock, ticking locally between polls. */
function ShowdownClock({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  if (!deadline) return <>—</>;
  const left = Math.max(0, Math.ceil((deadline * 1000 - now) / 1000));
  return <>{left === 0 ? 'out of time' : `${left}s`}</>;
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className={styles.stateItem}>
      <div className={styles.stateLabel}>{label}</div>
      <div className={styles.stateValue}>{value}</div>
    </div>
  );
}
