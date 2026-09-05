// Chaum-Pedersen DLEQ prover -- the client half of threshold decryption.
//
// Proves log_G(PK) == log_H(D): one secret x satisfies both PK = x*G and
// D = x*H, without revealing x. In play, H is a card's ciphertext component
// c1 and D is this party's decryption share, so the proof says "this share
// was computed with the same secret whose key I registered at setup". Drop
// it and a player lies about what their card decrypts to
// (docs/PROTOCOL.md §3).
//
// Port of scripts/dleq_prove.py, including its Garaga MSM hints. Verified by
// cairo-verifier/tests/test_client_vectors.cairo, which feeds fixtures this
// module generated to the real DleqVerifier and checks that it accepts them
// -- and rejects them once tampered with.
//
// ── The commitment round is NOT optional ────────────────────────────────
// `aggregate` sums n parties' proofs into one, which is what makes reveals
// O(1) in players (docs/PROTOCOL.md §6.2). The challenge depends on
// R1 = SUM(R1_i), so whoever reveals their nonce point LAST can grind it
// against everyone else's -- the classic naive-multisignature break (Wagner;
// the original MuSig flaw). `aggregate` models the honest case only. The
// caller MUST run `commitNonce` / reveal / `respond` in three rounds. That
// is what `src/lib/shares.ts` does; nothing here enforces it.

import { G, N, Point, add, mul, mulG, randomScalar, sub } from './grumpkin';
import { limbs96, poseidonSpan, u256Parts } from './felt';

let garaga: typeof import('garaga') | null = null;

/** Loads garaga's wasm once. Must be awaited before any prove/aggregate. */
export async function initProver(): Promise<void> {
  if (garaga) return;
  const mod = await import('garaga');
  await mod.init();
  garaga = mod;
}

/** Garaga curve id for Grumpkin. Matches DleqVerifier's `GRUMPKIN: usize = 5`. */
const GRUMPKIN = 5;

/**
 * FakeGlvHint per (point, scalar): Q as 8 limbs, then s1, s2 -- 10 felts each.
 *
 * Grumpkin has no endomorphism, so Garaga's `msm_g1` dispatches to
 * `msm_fake_glv` and asserts `hint.len() == n * 10`. Passing
 * include_points_and_scalars=false and serialize_as_pure_felt252_array=false
 * gives exactly those felts and nothing else.
 */
function msmHint(points: Point[], scalars: bigint[]): bigint[] {
  if (!garaga) throw new Error('dleq: call initProver() first');
  const flat: bigint[] = [];
  for (const p of points) {
    if (p === null) throw new Error('dleq: cannot build an MSM hint for the identity');
    flat.push(p.x, p.y);
  }
  const out = garaga.msm_calldata_builder(flat as any, scalars as any, GRUMPKIN, false, false);
  const hint = (out as unknown as bigint[]).map((v) => BigInt(v as any));
  if (hint.length !== points.length * 10) {
    throw new Error(`dleq: expected ${points.length * 10} hint felts, got ${hint.length}`);
  }
  return hint;
}

const pointLimbs = (p: Point): bigint[] => {
  if (p === null) throw new Error('dleq: identity has no transcript encoding');
  return [...limbs96(p.x), ...limbs96(p.y)];
};

/** Mirror of DleqVerifier::compute_challenge -- Poseidon over five points. */
export function challenge(pk: Point, h: Point, d: Point, r1: Point, r2: Point): bigint {
  const buf = [...pointLimbs(pk), ...pointLimbs(h), ...pointLimbs(d), ...pointLimbs(r1), ...pointLimbs(r2)];
  if (buf.length !== 40) throw new Error('dleq: transcript must be 40 limbs');
  return poseidonSpan(buf);
}

export type DleqProof = {
  /** 44 felts: s low/high, e low/high, then two 20-felt MSM hints. */
  proof: bigint[];
  /** 12 felts: pk, h, d as u256 low/high pairs. */
  publicInputs: bigint[];
  pk: Point;
  h: Point;
  d: Point;
  e: bigint;
  s: bigint;
};

function serialise(pk: Point, h: Point, d: Point, s: bigint, e: bigint): DleqProof {
  const eNeg = (N - (e % N)) % N;
  const hint1 = msmHint([G, pk], [s, eNeg]);
  const hint2 = msmHint([h, d], [s, eNeg]);
  const proof = [...u256Parts(s), ...u256Parts(e), ...hint1, ...hint2];
  const publicInputs = [pk!, h!, d!].flatMap((p) => [...u256Parts(p.x), ...u256Parts(p.y)]);
  if (proof.length !== 44) throw new Error(`dleq: proof must be 44 felts, got ${proof.length}`);
  if (publicInputs.length !== 12) throw new Error('dleq: public inputs must be 12 felts');
  return { proof, publicInputs, pk, h, d, e, s };
}

/**
 * One party's individual share and its proof.
 *
 * This is what an accused player posts to `answer_accusation` -- it proves
 * against that party's OWN registered key, so it names them. The normal
 * reveal path uses `aggregate` over the joint key, which is cheaper but says
 * nothing about who did or did not contribute (docs/PROTOCOL.md §8.1).
 */
export function prove(x: bigint, h: Point, nonce?: bigint): DleqProof {
  const pk = mulG(x);
  const d = mul(x, h);
  if (pk === null || d === null) throw new Error('dleq: degenerate secret or base point');

  const k = nonce ?? randomScalar();
  const r1 = mulG(k);
  const r2 = mul(k, h);
  if (r1 === null || r2 === null) throw new Error('dleq: degenerate nonce');

  const e = challenge(pk, h, d, r1, r2);
  const s = (k + e * x) % N;

  // The verifier recomputes R1 = s*G - e*PK and R2 = s*H - e*D. Check both
  // locally before spending a transaction to learn otherwise.
  const eNeg = (N - (e % N)) % N;
  if (!samePoint(add(mulG(s), mul(eNeg, pk)), r1)) throw new Error('dleq: R1 self-check failed');
  if (!samePoint(add(mul(s, h), mul(eNeg, d)), r2)) throw new Error('dleq: R2 self-check failed');

  return serialise(pk, h, d, s, e);
}

const samePoint = (a: Point, b: Point) => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y);

// ─── aggregation ─────────────────────────────────────────────────────────

/** Round 1: what each party broadcasts before anyone reveals a nonce point. */
export function commitNonce(r1: Point, r2: Point): { commitment: bigint; r1: Point; r2: Point } {
  return { commitment: poseidonSpan([...pointLimbs(r1), ...pointLimbs(r2)]), r1, r2 };
}

export type PartyContribution = {
  /** This party's registered key share, pk_i = x_i*G. */
  pk: Point;
  /** This party's decryption share, d_i = x_i*H. */
  d: Point;
  r1: Point;
  r2: Point;
  /** s_i = k_i + e*x_i, computed only after every nonce point is revealed. */
  s: bigint;
};

/**
 * Round 3 helper: this party's response, once the aggregate challenge is known.
 *
 * `e` must be computed from the SUMS of every party's revealed (r1, r2) --
 * never from this party's own. That is the whole point of the three rounds.
 */
export function respond(x: bigint, k: bigint, e: bigint): bigint {
  return (k + e * x) % N;
}

/**
 * Combine n parties' contributions into a single DLEQ against the joint key.
 *
 * Since Y = X*G and D = SUM(d_i) = X*H for the joint secret X = SUM(x_i), the
 * statement log_G(Y) == log_H(D) is one DLEQ and the individual proofs sum
 * directly into it. Flat in the number of players: 58 felts of calldata at any
 * table size, against 58 per party unaggregated.
 *
 * A failed aggregate proves someone cheated but not who -- that is what the
 * accusation path exists for.
 */
export function aggregate(contributions: PartyContribution[], h: Point): DleqProof {
  if (contributions.length === 0) throw new Error('dleq: nothing to aggregate');
  const sum = (pts: Point[]) => pts.reduce<Point>((acc, p) => add(acc, p), null);

  const Y = sum(contributions.map((c) => c.pk));
  const D = sum(contributions.map((c) => c.d));
  const R1 = sum(contributions.map((c) => c.r1));
  const R2 = sum(contributions.map((c) => c.r2));
  if (Y === null || D === null || R1 === null || R2 === null) {
    throw new Error('dleq: an aggregate summed to the identity');
  }

  const e = challenge(Y, h, D, R1, R2);
  const S = contributions.reduce((acc, c) => (acc + c.s) % N, 0n);

  const eNeg = (N - (e % N)) % N;
  if (!samePoint(add(mulG(S), mul(eNeg, Y)), R1)) {
    throw new Error('dleq: aggregate R1 mismatch -- a contribution is wrong or e was computed too early');
  }
  if (!samePoint(add(mul(S, h), mul(eNeg, D)), R2)) {
    throw new Error('dleq: aggregate R2 mismatch -- a contribution is wrong or e was computed too early');
  }

  return serialise(Y, h, D, S, e);
}

/**
 * Recover the plaintext point from a ciphertext and the combined share.
 *
 * m = c2 - D, where D = SUM(d_i) = X*c1. The contract does this itself inside
 * `verify_card_reveal`; doing it here too means a player sees their card
 * before paying for a transaction, and catches a bad share locally.
 */
export function recoverPoint(c2: Point, D: Point): Point {
  return sub(c2, D);
}
