// Turning decryption shares into a revealed card.
//
// Both reveal paths in PokerGame -- community and hole -- end in
// `verify_reveal_at`, which rebuilds the DLEQ statement from ITS OWN storage:
//
//     [joint_pk_x, joint_pk_y, c1_x, c1_y, share_x, share_y]
//
// as u256 low/high pairs, plus (c2_x, c2_y, claimed_card) passed alongside.
// Nothing in that comes from the caller except the share, the claimed card and
// the proof -- the joint key and the ciphertext are read from storage the
// shuffle chain and the opening proof already fixed. So a reveal cannot be
// pointed at a different card or a different key; it can only be right or
// rejected.
//
// The share here is the AGGREGATE over every party (docs/PROTOCOL.md §6.2):
// Y = Σ y_i and D = Σ d_i satisfy log_G(Y) = log_H(D) as a single DLEQ, which
// is what makes a reveal O(1) in players -- 58 felts at any table size. It also
// means a failed reveal proves someone cheated but not who, which is what the
// accusation path is for.

import { Point, add, cardFromPoint, sub } from './grumpkin';
import { poseidonSpan, u256Parts } from './felt';
import type { DleqProof } from './dleq';

export type OpenedCiphertext = { c1: Point; c2: Point };

/**
 * The card a combined share opens, or null if it opens nothing.
 *
 * `null` is not a formality. It means `c2 - D` landed outside the 52-point
 * encoding, which is what a fabricated deck or a wrong share set looks like --
 * and it is far better to find that here than to spend a transaction being
 * told `BAD_REVEAL`.
 */
export function cardFromShare(ct: OpenedCiphertext, combinedShare: Point): number | null {
  return cardFromPoint(sub(ct.c2, combinedShare));
}

/** Arguments for `reveal_community_card(table_id, index, ...)`. */
export function revealCommunityArgs(args: {
  tableId: string;
  index: number;
  share: Point;
  card: number;
  proof: DleqProof;
}) {
  if (args.share === null) throw new Error('reveal: the combined share is the identity');
  const [sxLow, sxHigh] = u256Parts(args.share.x);
  const [syLow, syHigh] = u256Parts(args.share.y);
  return {
    table_id: args.tableId,
    index: args.index,
    share_x: { low: sxLow, high: sxHigh },
    share_y: { low: syLow, high: syHigh },
    claimed_card: args.card,
    proof: args.proof.proof.map((v) => '0x' + v.toString(16)),
  };
}

/**
 * Calldata for `reveal_draw_card`.
 *
 * Identical in shape to a community reveal, and that is the point: the card
 * that decides who posts which blind comes out of the same committed deck,
 * behind the same n-of-n decryption, checked by the same DLEQ. The only
 * difference is which storage slot the contract writes.
 */
export function revealDrawArgs(args: {
  tableId: string;
  seat: number;
  share: Point;
  card: number;
  proof: DleqProof;
}) {
  if (args.share === null) throw new Error('reveal: the combined share is the identity');
  const [sxLow, sxHigh] = u256Parts(args.share.x);
  const [syLow, syHigh] = u256Parts(args.share.y);
  return {
    table_id: args.tableId,
    seat: args.seat,
    share_x: { low: sxLow, high: sxHigh },
    share_y: { low: syLow, high: syHigh },
    claimed_card: args.card,
    proof: args.proof.proof.map((v) => '0x' + v.toString(16)),
  };
}

// ─── hole cards: commit at dealing, open at showdown ────────────────────

/**
 * The commitment `commit_hole_shares` stores, and `reveal_hole_card` reopens.
 *
 * Poseidon over the combined share's four u128 limbs plus a blinding factor,
 * matching the contract's own `poseidon_hash_span` exactly.
 *
 * It is posted during DEALING, before betting. That ordering is the whole
 * point: a commitment made after the board is known would let a player shop
 * for a friendlier share set, and the shares are what determine the card. The
 * contract enforces it by refusing to overwrite a commitment once set.
 */
export function holeCommitment(share: Point, blinding: bigint): bigint {
  if (share === null) throw new Error('reveal: cannot commit to the identity');
  const [sxLow, sxHigh] = u256Parts(share.x);
  const [syLow, syHigh] = u256Parts(share.y);
  return poseidonSpan([sxLow, sxHigh, syLow, syHigh, blinding]);
}

export function commitHoleSharesArgs(args: {
  tableId: string;
  seat: number;
  slot: number;
  share: Point;
  blinding: bigint;
}) {
  return {
    table_id: args.tableId,
    seat: args.seat.toString(),
    slot: args.slot,
    commitment: '0x' + holeCommitment(args.share, args.blinding).toString(16),
  };
}

export function revealHoleArgs(args: {
  tableId: string;
  seat: number;
  slot: number;
  share: Point;
  blinding: bigint;
  card: number;
  proof: DleqProof;
}) {
  if (args.share === null) throw new Error('reveal: the combined share is the identity');
  const [sxLow, sxHigh] = u256Parts(args.share.x);
  const [syLow, syHigh] = u256Parts(args.share.y);
  return {
    table_id: args.tableId,
    seat: args.seat.toString(),
    slot: args.slot,
    share_x: { low: sxLow, high: sxHigh },
    share_y: { low: syLow, high: syHigh },
    blinding: '0x' + args.blinding.toString(16),
    claimed_card: args.card,
    proof: args.proof.proof.map((v) => '0x' + v.toString(16)),
  };
}

// ─── what a player must keep between dealing and showdown ───────────────

/**
 * A hole card's opening, produced at dealing time and republished at showdown.
 *
 * No new proof is generated at showdown -- the DLEQ proofs the OTHER parties
 * produced during dealing are what gets republished, and the proving work
 * happened before anyone had seen a card (§4 phase 4). So this has to survive
 * until the hand ends: lose it and the player simply cannot show, which
 * forfeits the pot rather than merely being inconvenient.
 *
 * Stored per (table, seat, slot) alongside the seat key. Same exposure as
 * src/lib/identity.ts describes, and for the same reason: the alternative is
 * losing a hand to a page reload.
 */
export type HoleOpening = {
  share: { x: bigint; y: bigint };
  blinding: bigint;
  card: number;
  proof: bigint[];
};

const storageKey = (p: { chainId: string; contract: string; tableId: string; seat: number; slot: number }) =>
  ['zkpoker', 'hole', 'v1', p.chainId, p.contract.toLowerCase(), p.tableId, p.seat, p.slot].join(':');

export function saveHoleOpening(
  p: { chainId: string; contract: string; tableId: string; seat: number; slot: number },
  o: HoleOpening,
): void {
  try {
    window.localStorage.setItem(
      storageKey(p),
      JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}n` : v)),
    );
  } catch {
    // Nothing useful to do here, and throwing would abort a deal that is
    // otherwise fine. The UI reports that the opening is unsaved.
  }
}

export function loadHoleOpening(p: {
  chainId: string; contract: string; tableId: string; seat: number; slot: number;
}): HoleOpening | null {
  try {
    const raw = window.localStorage.getItem(storageKey(p));
    if (!raw) return null;
    return JSON.parse(raw, (_, v) =>
      typeof v === 'string' && /^0x[0-9a-f]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as HoleOpening;
  } catch {
    return null;
  }
}

/** Sum of the parties' individual shares -- D in the aggregate DLEQ. */
export function combineShares(shares: Point[]): Point {
  return shares.reduce<Point>((acc, d) => add(acc, d), null);
}
