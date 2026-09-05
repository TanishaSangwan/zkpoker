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
  useEffect(() => {
    const url = relayUrl();
    const t: Transport & { close: () => void } = url
      ? new RelayTransport(table.tableId, url)
      : new BroadcastTransport(table.tableId);
    transport.current = t;
    setTransportKind(url ? 'relay' : 'local');
    return () => { t.close(); };
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
        transport: transport.current!, tableId: table.tableId, position, h: c1,
        jointKey: table.jointKey, keys, shares, mySeat: yourSeat!, mySecret: identity!.secret,
        onProgress: (phase, outstanding) => setBusy(`${phase} — waiting on ${outstanding.join(', ') || '—'}`),
      });
      return send('reveal_hole_card', revealHoleArgs({
        tableId: table.tableId, seat: yourSeat!, slot,
        share: agg.share, blinding: stored.blinding, card: stored.card, proof: agg.proof,
      }));
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
  // What stays manual is what actually involves a choice: bet / check / fold,
  // and whether to show or muck at showdown.
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
  // The auto-join effect must subscribe ONCE. Anything it needs that changes
  // on every poll -- the seat keys, the community array, the callbacks that
  // close over them -- goes in a ref instead of the dependency array, or the
  // effect tears down and re-subscribes every few seconds and drops messages
  // in the gap.
  const latest = useRef({ keys, table, identity, openedAt, gatherShares, refresh, send });
  latest.current = { keys, table, identity, openedAt, gatherShares, refresh, send };
  const [autoServe, setAutoServe] = useState(true);
  const [autoShow, setAutoShow] = useState(true);
  const [autoLog, setAutoLog] = useState<string[]>([]);
  const say = useCallback((m: string) => setAutoLog((l) => [...l.slice(-6), m]), []);

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
   * Run the aggregate for one position: gather shares, do the three rounds,
   * and submit if it is a community card.
   *
   * Shared by BOTH paths -- joining an aggregate someone else started, and
   * starting one because a card is due. They have to be the same code and
   * share the same `joined` guard, or a client that does both ends up running
   * two sessions for one position and answering its own rounds twice.
   */
  const runFor = useCallback(async (pos: number) => {
    const L = latest.current;
    await initDleqProver();
    const { c1, c2 } = await L.openedAt(pos);
    const shares = await L.gatherShares(pos, c1, false);
    // Report the ROUND, not just "working".
    //
    // Without this the UI kept showing the last message gatherShares set --
    // "waiting on seat —", meaning it had every share it needed -- for the
    // entire three-round aggregate, so a table that was mid-protocol looked
    // identical to one stuck collecting shares. The phase and who is
    // outstanding is the whole diagnostic for an n-of-n round.
    setBusy(`position ${pos}: shares in, starting the aggregate`);
    const agg = await dealing.runAggregate({
      transport: transport.current!, tableId: L.table.tableId, position: pos, h: c1,
      jointKey: L.table.jointKey!, keys: L.keys, shares,
      mySeat: yourSeat!, mySecret: L.identity!.secret,
      onProgress: (phase, outstanding) => {
        const who = outstanding.length ? `waiting on seat ${outstanding.join(', ')}` : 'all in';
        setBusy(`position ${pos}: ${phase} round — ${who}`);
        say(`pos ${pos} ${phase}: ${who}`);
      },
    });
    setBusy(null);
    const community = pos >= 2 * L.table.maxSeats;
    if (!community) return;
    const index = pos - 2 * L.table.maxSeats;
    const card = cardFromShare({ c1, c2 }, agg.share);
    if (card === null || L.table.community[index]?.revealed) return;
    try {
      await L.send('reveal_community_card', revealCommunityArgs({
        tableId: L.table.tableId, index, share: agg.share, card, proof: agg.proof,
      }));
      say(`revealed board ${index}`);
      L.refresh();
    } catch {
      // Someone else submitted first. That is the point of both sides trying.
    }
  }, [yourSeat, say]);

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
      // And never help open a board card before its street. Same reasoning as
      // `owed`: the contract refuses the reveal, but there is no reason to
      // contribute to it in the first place.
      const communityIndex = pos - 2 * latest.current.table.maxSeats;
      if (communityIndex >= 0 && latest.current.table.street < streetFor(communityIndex)) return;
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
  // Showing YOUR hand is a choice. Mucking is legal, the contract pays only
  // hands it verified, and there is no obligation to expose a loser. So this
  // defaults to showing -- which is what almost everyone wants almost always,
  // and what makes a hand actually finish -- but it is a toggle, not a rule.
  //
  // Folded seats are skipped: they have nothing to show and the contract would
  // reject it.
  const showing = useRef(false);
  useEffect(() => {
    if (!autoShow || yourSeat === null || !mySecretHex) return;
    if (table.street !== 4 || table.settled) return;
    const me = table.seats[yourSeat];
    if (!me || me.folded || showing.current) return;
    const pending = [0, 1].filter((slot) => !me.holeRevealed[slot]);
    if (pending.length === 0) return;
    showing.current = true;
    void (async () => {
      for (const slot of pending) {
        try {
          await showHoleCard(slot);
        } catch {
          // Usually the other seats have not joined the aggregate yet. Left
          // for the next poll rather than treated as a refusal to show.
        }
      }
      showing.current = false;
    })();
  }, [autoShow, yourSeat, mySecretHex, table.street, table.settled, table.seats]);

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
              Happening automatically — this button is only a retry. Collects a share from every
              seat, verifies each against that seat&apos;s registered key, and commits to the
              combination <em>before</em> betting, which is what stops anyone shopping for a
              friendlier share set after seeing the board.
            </span>
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
            <span className={table.jointKey ? styles.chip : styles.caution}>
              joint key: {table.jointKey ? 'yes' : 'MISSING'}
            </span>
            <span className={styles.chip}>street {table.street}</span>
          </div>

          {autoLog.length ? (
            <pre className={uni.receiptNote}>{autoLog.join('\n')}</pre>
          ) : null}

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

          {table.street >= 4 || table.settled ? (
            <div className={styles.actionsRow}>
              <label className={styles.fieldHint} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={autoShow} onChange={(e) => setAutoShow(e.target.checked)} />
                Show my hand automatically at showdown
              </label>
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
                forfeits rather than blocks: untick the box above to muck. Helping others show is
                automatic either way, since their card needs a share from every seat and sitting out
                only stops the hand resolving.
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
