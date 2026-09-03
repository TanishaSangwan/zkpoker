// Client-side port of cairo/src/shuffle.cairo's shuffled_deck(seed) — lets
// the "Verify" view recompute a table's deal directly in the browser from a
// revealed seed, the same fairness check scripts/deal_verify.py does from
// the command line (see docs/DESIGN.md "What 'provably fair' means in V1").
//
// NOT assumed equivalent to the Cairo/Python originals — checked against
// cairo/src/shuffle_vector_check.cairo's own pinned seed=42 vector (the
// exact 52-card output that file asserts against an independent Python
// computation) via a throwaway node script before this was trusted, same
// standard the rest of this project holds itself to. It matched exactly.
//
// The single building block this leans on — starknet.js's
// hash.computePoseidonHashOnElements matching Cairo's
// core::poseidon::poseidon_hash_span for a 2-element input — was already
// independently verified in this project's own history (see HANDOFF.md
// §4d, "the two-element case was already confirmed in round 8").

import { hash } from "starknet";

export const DECK_SIZE = 52;

// Mirrors shuffle.cairo's draw_index exactly: h = poseidon([seed, step]),
// r = h mod bound. Not rejection-sampled (small modulo bias) — same
// accepted simplification the Cairo side documents.
function drawIndex(seed: string, step: number, bound: number): number {
  const h = hash.computePoseidonHashOnElements([seed, step.toString()]);
  return Number(BigInt(h) % BigInt(bound));
}

// Mirrors shuffle.cairo's shuffled_deck exactly: Fisher-Yates from idx=51
// down to 1, each swap's index drawn via drawIndex(seed, idx, idx+1).
export function shuffledDeckFromSeed(seedFelt: string): number[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
  for (let idx = DECK_SIZE - 1; idx >= 1; idx--) {
    const j = drawIndex(seedFelt, idx, idx + 1);
    [deck[idx], deck[j]] = [deck[j], deck[idx]];
  }
  return deck;
}

// Mirrors settle_table_by_hand's own convention (lib.cairo): seat N's hole
// cards live at deck positions 2N/2N+1; community card k lives at
// 2*max_seats + k.
export function seatHolePositions(seat: number): [number, number] {
  return [2 * seat, 2 * seat + 1];
}
export function communityPosition(k: number, maxSeats: number): number {
  return 2 * maxSeats + k;
}
