'use client';

// Polls PokerGame for everything the table view renders.
//
// Reads go through the contract's VIEWS, not through replayed events. Events
// would work -- ShuffleKeyRegistered carries the key shares, Fold carries the
// folds -- but then core state depends on event indexing, and an RPC that
// paginates, prunes or lags leaves the UI rendering a table that does not
// exist. Events are used only for the activity log, where being approximate is
// harmless.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderInterface } from 'starknet';
import { pokerGameReader, readU256, SHOWDOWN_STREET, type Phase, phaseOf } from './contract';
import { fromWire, type Point } from '@/lib/grumpkin';

export type SeatState = {
  seat: number;
  owner: string;
  occupied: boolean;
  contributed: bigint;
  streetContributed: bigint;
  toCall: bigint;
  folded: boolean;
  keyRegistered: boolean;
  pk: Point;
  holeCommitted: [boolean, boolean];
  holeRevealed: [boolean, boolean];
  holeCards: [number, number];
};

export type TableState = {
  tableId: string;
  exists: boolean;
  dealer: string;
  maxSeats: number;
  pot: bigint;
  street: number;
  settled: boolean;
  voided: boolean;

  shuffleStarted: boolean;
  shuffleComplete: boolean;
  shuffleTurn: number;
  shuffleOrder: number[];
  shuffleDeadline: number;
  commitment: bigint;
  jointKey: Point;

  deckOpened: boolean;
  deckOpenChunk: number;

  /** Starknet-Poseidon of the deck the chain head published; 0 if none yet. */
  publishedDeckHash: bigint;
  publishedDeckSeat: number;

  actionTurn: number;
  actionDeadline: number;
  roundComplete: boolean;

  seats: SeatState[];
  community: { card: number; revealed: boolean }[];

  phase: Phase;
  /** Seats that have taken a seat, in ascending order. */
  seated: number[];
};

const ZERO = '0x0';

export function useTableState(args: {
  address: string;
  provider: ProviderInterface | undefined;
  tableId: string | null;
  /** Poll interval; 0 disables. Kept slow -- nothing here is latency-critical
   *  except the action clock, which is rendered from a local countdown. */
  intervalMs?: number;
}) {
  const { address, provider, tableId, intervalMs = 6000 } = args;
  const [state, setState] = useState<TableState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (!provider || !tableId || address === ZERO || !address) { setState(null); return; }
    if (inflight.current) return; // a slow RPC must not stack up requests
    inflight.current = true;
    setLoading(true);
    try {
      const c = pokerGameReader(address, provider);
      const num = (v: any) => Number(v ?? 0);

      const dealer = await c.get_table_dealer(tableId);
      const exists = BigInt(dealer ?? 0) !== 0n;
      if (!exists) {
        setState({ ...emptyTable(tableId), exists: false, phase: 'no-table' });
        setError(null);
        return;
      }

      const [maxSeats, pot, street, settled, voided] = await Promise.all([
        c.get_table_max_seats(tableId), c.get_pot(tableId), c.get_table_street(tableId),
        c.get_table_settled(tableId), c.get_table_voided(tableId),
      ]);

      const [shuffleStarted, shuffleComplete, shuffleTurn, orderLen, shuffleDeadline, commitment, jointRaw] =
        await Promise.all([
          c.get_shuffle_started(tableId), c.get_shuffle_complete(tableId), c.get_shuffle_turn(tableId),
          c.get_shuffle_order_len(tableId), c.get_shuffle_deadline(tableId),
          c.get_shuffle_commitment(tableId), c.get_joint_pk(tableId),
        ]);

      const [deckOpened, deckOpenChunk, actionTurn, actionDeadline, roundComplete,
             publishedDeckHash, publishedDeckSeat] = await Promise.all([
        c.get_deck_opened(tableId), c.get_deck_open_chunk(tableId), c.get_action_turn(tableId),
        c.get_action_deadline(tableId), c.get_round_complete(tableId),
        c.get_published_deck_hash(tableId), c.get_published_deck_seat(tableId),
      ]);

      const n = num(maxSeats);
      const seats: SeatState[] = await Promise.all(
        Array.from({ length: n }, async (_, seat) => {
          const s = seat.toString();
          const [owner, contributed, folded, keyRegistered, pkRaw] = await Promise.all([
            c.get_seat_owner(tableId, s), c.get_seat_contributed(tableId, s),
            c.get_seat_folded(tableId, s), c.get_seat_key_registered(tableId, s),
            c.get_seat_pk(tableId, s),
          ]);
          const occupied = BigInt(owner ?? 0) !== 0n;
          const [streetContributed, toCall] = occupied
            ? await Promise.all([c.get_street_contributed(tableId, s), c.get_amount_to_call(tableId, s)])
            : [0n, 0n];
          const [hc0, hc1, hr0, hr1, com0, com1] = occupied
            ? await Promise.all([
                c.get_hole_card(tableId, s, 0), c.get_hole_card(tableId, s, 1),
                c.get_hole_revealed(tableId, s, 0), c.get_hole_revealed(tableId, s, 1),
                c.get_hole_commitment(tableId, s, 0), c.get_hole_commitment(tableId, s, 1),
              ])
            : [0, 0, false, false, 0n, 0n];
          return {
            seat, owner: occupied ? toHex(owner) : ZERO, occupied,
            contributed: BigInt(contributed ?? 0),
            streetContributed: BigInt(streetContributed ?? 0),
            toCall: BigInt(toCall ?? 0),
            folded: !!folded, keyRegistered: !!keyRegistered,
            pk: pointOrNull(pkRaw),
            holeCommitted: [BigInt(com0 ?? 0) !== 0n, BigInt(com1 ?? 0) !== 0n],
            holeRevealed: [!!hr0, !!hr1],
            holeCards: [num(hc0), num(hc1)],
          } satisfies SeatState;
        }),
      );

      const community = await Promise.all(
        Array.from({ length: 5 }, async (_, i) => ({
          card: num(await c.get_community_card(tableId, i)),
          revealed: !!(await c.get_community_revealed(tableId, i)),
        })),
      );

      const shuffleOrder = shuffleStarted
        ? await Promise.all(
            Array.from({ length: num(orderLen) }, async (_, p) =>
              Number(await c.get_shuffle_seat_at(tableId, p)),
            ),
          )
        : [];

      const seated = seats.filter((s) => s.occupied).map((s) => s.seat);
      const next: TableState = {
        tableId, exists: true, dealer: toHex(dealer), maxSeats: n,
        pot: BigInt(pot ?? 0), street: num(street), settled: !!settled, voided: !!voided,
        shuffleStarted: !!shuffleStarted, shuffleComplete: !!shuffleComplete,
        shuffleTurn: num(shuffleTurn), shuffleOrder, shuffleDeadline: num(shuffleDeadline),
        commitment: readU256(commitment), jointKey: pointOrNull(jointRaw),
        deckOpened: !!deckOpened, deckOpenChunk: num(deckOpenChunk),
        publishedDeckHash: BigInt(publishedDeckHash ?? 0),
        publishedDeckSeat: Number(publishedDeckSeat ?? 0),
        actionTurn: Number(actionTurn ?? 0), actionDeadline: num(actionDeadline),
        roundComplete: !!roundComplete,
        seats, community, seated,
        phase: 'seating',
      };
      next.phase = phaseOf({
        exists: true, voided: next.voided, settled: next.settled,
        shuffleStarted: next.shuffleStarted, shuffleComplete: next.shuffleComplete,
        deckOpened: next.deckOpened, street: next.street,
        seatedCount: seated.length,
        keysRegistered: seats.filter((s) => s.occupied && s.keyRegistered).length,
      });
      setState(next);
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      inflight.current = false;
      setLoading(false);
    }
  }, [address, provider, tableId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!intervalMs || !tableId) return;
    const id = setInterval(() => { void refresh(); }, intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs, tableId]);

  return { state, error, loading, refresh };
}

const toHex = (v: any) => '0x' + BigInt(v ?? 0).toString(16);

/** Cairo returns (u256, u256); (0, 0) means "not set", not the curve identity. */
function pointOrNull(raw: any): Point {
  try {
    const [x, y] = Array.isArray(raw) ? raw : [raw?.[0], raw?.[1]];
    const px = readU256(x), py = readU256(y);
    if (px === 0n && py === 0n) return null;
    return fromWire(px, py);
  } catch {
    return null;
  }
}

function emptyTable(tableId: string): TableState {
  return {
    tableId, exists: false, dealer: ZERO, maxSeats: 0, pot: 0n, street: 0,
    settled: false, voided: false, shuffleStarted: false, shuffleComplete: false,
    shuffleTurn: 0, shuffleOrder: [], shuffleDeadline: 0, commitment: 0n, jointKey: null,
    deckOpened: false, deckOpenChunk: 0, publishedDeckHash: 0n, publishedDeckSeat: 0,
    actionTurn: 0, actionDeadline: 0,
    roundComplete: false, seats: [], community: [], seated: [], phase: 'no-table',
  };
}

export { SHOWDOWN_STREET };
