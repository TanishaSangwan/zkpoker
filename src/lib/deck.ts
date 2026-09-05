// The deck: ElGamal ciphertexts over Grumpkin, and the witness for one
// player's shuffle step.
//
// Layout matches circuits/shuffle/src/main.nr exactly -- a flat [Field; 208],
// four fields per card, [c1.x, c1.y, c2.x, c2.y]. Any disagreement here shows
// up as an unsatisfiable circuit, not as a wrong answer, which is the good
// failure mode.
//
// The commitment is Poseidon2 over BN254, computed by bb.js. It is NOT
// Starknet's Poseidon and the contract cannot compute it -- that is the whole
// cross-field problem docs/PROTOCOL.md §7 works around. PokerGame only ever
// compares two u256 it was handed.

import { DECK_SIZE, G, N, Point, add, cardPoints, fromWire, mul, mulG, randomScalar, toWire } from './grumpkin';

export type Ciphertext = { c1: Point; c2: Point };

/**
 * a_0: the canonical starting deck, identical for every table.
 *
 * Defined as encryption with r = 0, so it is (identity, M_i) and depends on
 * nothing -- not the joint key, not the players, not the table. That is why
 * PokerGame pins its commitment as a constant instead of accepting one:
 * a dealer who could name it could name a deck with duplicates or missing
 * cards, and shuffles only permute, so the hand would strand at reveal time.
 */
export function initialDeck(): Ciphertext[] {
  return cardPoints().map((m) => ({ c1: null, c2: m }));
}

/** Flatten to the circuit's [Field; 208]. Identity encodes as (0, 0). */
export function deckToFields(deck: Ciphertext[]): bigint[] {
  if (deck.length !== DECK_SIZE) throw new Error(`deck: expected ${DECK_SIZE} cards, got ${deck.length}`);
  const out: bigint[] = [];
  for (const { c1, c2 } of deck) {
    const a = toWire(c1);
    const b = toWire(c2);
    out.push(a.x, a.y, b.x, b.y);
  }
  return out;
}

export function fieldsToDeck(fields: bigint[]): Ciphertext[] {
  if (fields.length !== 4 * DECK_SIZE) throw new Error(`deck: expected ${4 * DECK_SIZE} fields`);
  const deck: Ciphertext[] = [];
  for (let i = 0; i < DECK_SIZE; i++) {
    const b = 4 * i;
    deck.push({ c1: fromWire(fields[b], fields[b + 1]), c2: fromWire(fields[b + 2], fields[b + 3]) });
  }
  return deck;
}

// ─── commitment ──────────────────────────────────────────────────────────

let bbApi: any = null;

/**
 * Poseidon2 over BN254, as `Poseidon2::hash(deck, 208)` computes it in-circuit.
 *
 * bb.js's poseidon2Hash was checked against the pinned INITIAL_DECK_COMMITMENT
 * (0x1673af...71ad) -- a value produced by circuits/deck_init, not by this
 * code -- and matches byte for byte. scripts/check_client_crypto.mjs re-runs
 * that comparison, so a bb.js upgrade that changed the hash would be caught
 * rather than silently producing commitments the circuit rejects.
 */
export async function commitment(deck: Ciphertext[]): Promise<bigint> {
  const fields = deckToFields(deck);
  if (!bbApi) {
    const { Barretenberg, BackendType } = await import('@aztec/bb.js');
    bbApi = await Barretenberg.new({ backend: BackendType.Wasm, threads: 1 });
  }
  const toBuf = (v: bigint) => {
    const b = new Uint8Array(32);
    let x = v;
    for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
    return b;
  };
  const { hash } = await bbApi.poseidon2Hash({ inputs: fields.map(toBuf) });
  let v = 0n;
  for (const byte of hash as Uint8Array) v = (v << 8n) | BigInt(byte);
  return v;
}

/** The value PokerGame pins as INITIAL_DECK_COMMITMENT. */
export const INITIAL_DECK_COMMITMENT =
  0x1673af0c7a0064af6bb3a70b30eec058d85bec4857307bde801f9244ba8271adn;

// ─── the shuffle ─────────────────────────────────────────────────────────

export type ShuffleWitness = {
  deckOut: Ciphertext[];
  /** perm[j] = which INPUT index lands at OUTPUT slot j -- the circuit's convention. */
  perm: number[];
  /** Re-randomisation scalar per output slot. */
  scalars: bigint[];
};

/**
 * A uniform permutation, Fisher-Yates over crypto-quality randomness.
 *
 * This is the secret the whole protocol protects: anyone who learns it reads
 * the final deck straight off, because a_0 is canonical and public and seat i's
 * hole cards are always at positions 2i and 2i+1 (docs/PROTOCOL.md §9.1). It
 * must never be logged, persisted, or sent anywhere.
 *
 * `Math.random` would be a complete break, not a weakness -- V8's xorshift
 * state is recoverable from a handful of outputs.
 */
export function randomPermutation(n: number = DECK_SIZE): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = uniformBelow(i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

/** Rejection-sampled index in [0, bound) -- `% bound` on a random word is biased. */
function uniformBelow(bound: number): number {
  const limit = Math.floor(0x100000000 / bound) * bound;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % bound;
  }
}

/**
 * Apply a secret permutation and re-randomise every card under the joint key.
 *
 * Re-randomisation is what makes this worth proving. Permuting alone leaves
 * the output ciphertexts byte-identical to the inputs, so anyone could read
 * the permutation straight off by matching them up.
 *
 *   c1' = c1 + r*G      c2' = c2 + r*Y
 */
export function shuffle(deckIn: Ciphertext[], jointKey: Point, perm?: number[]): ShuffleWitness {
  if (jointKey === null) throw new Error('deck: joint key is the identity -- every card would be in the clear');
  const p = perm ?? randomPermutation(deckIn.length);
  const seen = new Set(p);
  if (p.length !== deckIn.length || seen.size !== deckIn.length) {
    throw new Error('deck: permutation is not a bijection');
  }

  const scalars: bigint[] = [];
  const deckOut: Ciphertext[] = [];
  for (let j = 0; j < p.length; j++) {
    const src = deckIn[p[j]];
    const r = randomScalar();
    scalars.push(r);
    deckOut.push({ c1: add(src.c1, mulG(r)), c2: add(src.c2, mul(r, jointKey)) });
  }
  return { deckOut, perm: p, scalars };
}

const MASK_128 = (1n << 128n) - 1n;

/**
 * The circuit's input map, ready for `Noir.execute`.
 *
 * `EmbeddedCurveScalar::new(lo, hi)` splits a scalar at 128 bits, low first --
 * the same split circuits/deck_init uses. Fields are hex strings because Noir's
 * ABI encoder wants strings, not bigints.
 */
export function shuffleCircuitInputs(args: {
  jointKey: Point;
  deckIn: Ciphertext[];
  witness: ShuffleWitness;
  hashIn: bigint;
  hashOut: bigint;
}) {
  const { jointKey, deckIn, witness, hashIn, hashOut } = args;
  if (jointKey === null) throw new Error('deck: joint key is the identity');
  const hex = (v: bigint) => '0x' + v.toString(16);
  return {
    pk_x: hex(jointKey.x),
    pk_y: hex(jointKey.y),
    hash_in: hex(hashIn),
    hash_out: hex(hashOut),
    deck_in: deckToFields(deckIn).map(hex),
    deck_out: deckToFields(witness.deckOut).map(hex),
    perm: witness.perm.map((v) => v.toString()),
    r_lo: witness.scalars.map((r) => hex(r & MASK_128)),
    r_hi: witness.scalars.map((r) => hex(r >> 128n)),
  };
}

// ─── positions ───────────────────────────────────────────────────────────
//
// PokerGame's canonical order, the one open_deck and the reveal path both
// assume: seat s's hole cards at 2s and 2s+1, community card k at
// 2*max_seats + k, and seat s's high-card draw at 2*max_seats + 5 + s. The
// contract knows this convention, so it is never sent.

export function seatHolePositions(seat: number): [number, number] {
  return [2 * seat, 2 * seat + 1];
}

export function communityPosition(k: number, maxSeats: number): number {
  return 2 * maxSeats + k;
}

/**
 * Where seat `s` draws for the button.
 *
 * It is an ordinary deck position on purpose. The draw that decides who
 * posts which blind comes out of the same committed, shuffle-proven deck as
 * every other card and needs the same n-of-n decryption -- so the button is
 * decided by a card nobody could choose, see early, or fake.
 */
export function drawPosition(seat: number, maxSeats: number): number {
  return 2 * maxSeats + 5 + seat;
}

export function inPlayPositions(maxSeats: number): number[] {
  const holes = Array.from({ length: 2 * maxSeats }, (_, i) => i);
  const community = Array.from({ length: 5 }, (_, k) => 2 * maxSeats + k);
  const draws = Array.from({ length: maxSeats }, (_, s) => 2 * maxSeats + 5 + s);
  return [...holes, ...community, ...draws];
}

export { DECK_SIZE, G, N };
