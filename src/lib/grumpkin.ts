// Grumpkin curve arithmetic, client side.
//
// Every secret in this protocol lives here: the key share behind a seat's
// registered public key, the decryption shares that open a card, and the
// re-randomisation scalars that hide a shuffle. docs/PROTOCOL.md §1 is the
// reason this is a browser module and not a server one -- generation happens
// on the device holding the secret, always.
//
//   y^2 = x^3 - 17  over Fp
//   p (base field)   = BN254's SCALAR field
//   n (scalar order) = BN254's BASE field
//
// p and n are swapped relative to BN254 -- that is what makes the two a
// cycle, and it is the single easiest thing to get wrong here. `P` reduces
// coordinates; `N` reduces scalars. They are never interchangeable.
//
// Cross-checked against scripts/schnorr_keygen.py (which carries the same
// constants and is the fixture source for the deployed Schnorr verifier's
// Cairo tests) by scripts/check_client_crypto.mjs.

/** Base field modulus -- reduces COORDINATES. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Scalar field order -- reduces SCALARS (secrets, nonces, challenges). */
export const N = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
/** Curve constant b in y^2 = x^3 + b. */
export const B = ((-17n % P) + P) % P;

/**
 * A curve point, or `null` for the identity.
 *
 * The identity is `null` here and `(0, 0)` on the wire -- see `toWire`. Noir's
 * embedded-curve addition treats `(0, 0)` as the point at infinity, and
 * `circuits/deck_init` builds the initial deck with it, so that encoding is
 * fixed by the circuit rather than chosen here.
 */
export type Point = { x: bigint; y: bigint } | null;

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

/** Modular inverse via Fermat -- p is prime, so a^(p-2) = a^-1. */
export function inv(a: bigint, m: bigint = P): bigint {
  if (mod(a, m) === 0n) throw new Error('grumpkin: inverse of zero');
  return powMod(mod(a, m), m - 2n, m);
}

export function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

export function isOnCurve(pt: Point): boolean {
  if (pt === null) return true;
  const { x, y } = pt;
  return mod(y * y - x * x * x - B, P) === 0n;
}

export function eq(a: Point, b: Point): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}

export function neg(pt: Point): Point {
  return pt === null ? null : { x: pt.x, y: mod(-pt.y, P) };
}

export function add(p1: Point, p2: Point): Point {
  if (p1 === null) return p2;
  if (p2 === null) return p1;
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return null; // P + (-P) = O
  const lam =
    x1 === x2 && y1 === y2
      ? mod(3n * x1 * x1 * inv(2n * y1), P) // doubling; b drops out of the derivative
      : mod((y2 - y1) * inv(x2 - x1), P);
  const x3 = mod(lam * lam - x1 - x2, P);
  const y3 = mod(lam * (x1 - x3) - y1, P);
  return { x: x3, y: y3 };
}

export function sub(p1: Point, p2: Point): Point {
  return add(p1, neg(p2));
}

/** Double-and-add. Not constant time -- see the note in `randomScalar`. */
export function mul(k: bigint, pt: Point): Point {
  let s = mod(k, N);
  if (s === 0n || pt === null) return null;
  let result: Point = null;
  let addend: Point = pt;
  while (s > 0n) {
    if (s & 1n) result = add(result, addend);
    addend = add(addend, addend);
    s >>= 1n;
  }
  return result;
}

/** The standard Grumpkin generator. */
export const G: Point = {
  x: 1n,
  y: 17631683881184975370165255887551781615748388533673675138860n,
};

export function mulG(k: bigint): Point {
  return mul(k, G);
}

// ─── wire encoding ───────────────────────────────────────────────────────
//
// The identity is `(0, 0)` everywhere it crosses a boundary -- circuit
// witness, contract calldata, transport. `(0, 0)` satisfies no curve
// equation, so it can never collide with a real point.

export function toWire(pt: Point): { x: bigint; y: bigint } {
  return pt === null ? { x: 0n, y: 0n } : pt;
}

export function fromWire(x: bigint, y: bigint): Point {
  if (x === 0n && y === 0n) return null;
  const pt = { x, y };
  if (!isOnCurve(pt)) throw new Error(`grumpkin: point (${x}, ${y}) is not on the curve`);
  return pt;
}

// ─── scalars ─────────────────────────────────────────────────────────────

/**
 * A uniform scalar in [1, N), rejection-sampled.
 *
 * Rejection rather than `mod N` because N is not a power of two: reducing a
 * 256-bit draw biases the low end, and these scalars are secret keys and
 * Schnorr nonces where bias is exploitable. The bias is tiny (N is within
 * 2^-127 of 2^254) but the fix is three lines.
 *
 * The point arithmetic above is variable-time, so this module leaks timing on
 * secret scalars. That is not a regression against the alternative -- every
 * comparable browser stack (noble, bb.js's own JS paths) is in the same
 * position, and the mitigation that matters is that these secrets never
 * leave the device.
 */
export function randomScalar(): bigint {
  const buf = new Uint8Array(32);
  for (;;) {
    crypto.getRandomValues(buf);
    let v = 0n;
    for (const b of buf) v = (v << 8n) | BigInt(b);
    if (v >= 1n && v < N) return v;
  }
}

// ─── card encoding ───────────────────────────────────────────────────────
//
// Card i is (i+1)*G, for i in 0..51 -- NOT i*G, which would make card 0 the
// identity and indistinguishable from an unencrypted slot. This must agree
// with cairo-verifier/src/card_table.cairo (whose card 0 is x = 0x1, i.e.
// G itself) and with circuits/deck_init/src/main.nr, which builds the same
// points to derive the pinned initial commitment.

export const DECK_SIZE = 52;

let cardPointCache: Point[] | null = null;

/** The 52 card points, M_0..M_51, computed once. */
export function cardPoints(): Point[] {
  if (cardPointCache) return cardPointCache;
  const pts: Point[] = [];
  let acc: Point = null;
  for (let i = 0; i < DECK_SIZE; i++) {
    acc = add(acc, G); // (i+1)*G by repeated addition -- 52 adds, not 52 muls
    pts.push(acc);
  }
  cardPointCache = pts;
  return pts;
}

let cardByXCache: Map<bigint, number> | null = null;

/**
 * Recover a card index from a decrypted point, or `null` if it is not a card.
 *
 * x alone identifies the card: no two of the 52 points share an x-coordinate
 * (checked at table-generation time -- see card_table.cairo's header), so
 * this cannot be ambiguous. A `null` here means decryption produced a point
 * outside the encoding, which is what a fabricated deck looks like.
 */
export function cardFromPoint(pt: Point): number | null {
  if (pt === null) return null;
  if (!cardByXCache) {
    cardByXCache = new Map();
    cardPoints().forEach((p, i) => cardByXCache!.set(p!.x, i));
  }
  const i = cardByXCache.get(pt.x);
  return i === undefined ? null : i;
}

// ─── human-readable cards ────────────────────────────────────────────────
//
// Matches cairo/src/poker_hand.cairo and scripts/deal_verify.py exactly:
// card = suit*13 + rank, rank 0-12 ('2'..'A'), suit 0-3.

const RANKS = '23456789TJQKA';
const SUITS = ['c', 'd', 'h', 's'] as const;
const SUIT_GLYPHS = ['♣', '♦', '♥', '♠'] as const;

export function cardToName(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

export function cardToGlyph(card: number): { rank: string; suit: string; red: boolean } {
  const suit = Math.floor(card / 13);
  return { rank: RANKS[card % 13], suit: SUIT_GLYPHS[suit], red: suit === 1 || suit === 2 };
}
