#!/usr/bin/env python3
"""Chaum-Pedersen DLEQ prover over Grumpkin, matching cairo-verifier's
DleqVerifier byte for byte.

Proves log_G(PK) == log_H(D) without revealing the secret x. In the
protocol H is a card ciphertext's c1 and D is that party's decryption
share d_X = c1^{x_X}, so this is what proves a share was computed with the
same secret whose public key the party registered at setup.

Run standalone to emit a real proof plus the sncast calldata for it:

    python3 scripts/dleq_prove.py            # valid proof
    python3 scripts/dleq_prove.py --corrupt  # flip one felt, for the negative test

Needs garaga installed (pip install garaga==1.1.0).

CRITICAL: the challenge encoding here must match DleqVerifier's
compute_challenge exactly -- Poseidon over 96-bit limbs of five points, in
the order PK, H, D, R1, R2. A mismatch here is the single most likely
reason an honest proof gets rejected, which is why the verifier also
exposes its own hashing for cross-checking.
"""

import argparse
import random
import sys

from garaga.curves import CURVES, CurveID
from garaga.points import G1Point
from garaga.hints.io import bigint_split
from garaga.hints import fake_glv
from poseidon_py.poseidon_hash import poseidon_hash_many

CURVE = CURVES[CurveID.GRUMPKIN.value]
N = CURVE.n
G = G1Point(CURVE.Gx, CURVE.Gy, CurveID.GRUMPKIN)


def limbs(v: int) -> list[int]:
    """u384 as Cairo sees it: four 96-bit limbs."""
    return bigint_split(v, 4, 2**96)


def point_limbs(p: G1Point) -> list[int]:
    return limbs(p.x) + limbs(p.y)


def u256_pair(v: int) -> list[int]:
    return [v % 2**128, v // 2**128]


def challenge(pk, h, d, r1, r2) -> int:
    """Mirror of DleqVerifier::compute_challenge."""
    buf = point_limbs(pk) + point_limbs(h) + point_limbs(d) + point_limbs(r1) + point_limbs(r2)
    assert len(buf) == 40
    return poseidon_hash_many(buf)


def msm_hint(points: list[G1Point], scalars: list[int]) -> list[int]:
    """Garaga FakeGlvHint x len(points): Q (8 limbs) + s1 + s2 = 10 felts each.

    Grumpkin has no endomorphism, so msm_g1 dispatches to msm_fake_glv and
    asserts hint.len() == n * 10.
    """
    out: list[int] = []
    for pt, sc in zip(points, scalars):
        Q, s1, s2 = fake_glv.get_fake_glv_hint(pt, sc)
        out += limbs(Q.x) + limbs(Q.y) + [s1, s2]
    return out


def prove(x: int, h: G1Point, rng: random.Random):
    """Produce (proof_felts, public_input_felts) for secret x and base h."""
    pk = G.scalar_mul(x)
    d = h.scalar_mul(x)

    k = rng.randrange(1, N)
    r1 = G.scalar_mul(k)
    r2 = h.scalar_mul(k)

    e = challenge(pk, h, d, r1, r2)
    s = (k + e * x) % N

    # The verifier recomputes R1 = s*G - e*PK and R2 = s*H - e*D, so the
    # hints must be for exactly those MSMs.
    e_neg = (-e) % N
    hint1 = msm_hint([G, pk], [s, e_neg])
    hint2 = msm_hint([h, d], [s, e_neg])
    assert len(hint1) == 20 and len(hint2) == 20

    proof = u256_pair(s) + u256_pair(e) + hint1 + hint2
    public_inputs = (
        u256_pair(pk.x) + u256_pair(pk.y)
        + u256_pair(h.x) + u256_pair(h.y)
        + u256_pair(d.x) + u256_pair(d.y)
    )
    assert len(proof) == 44, len(proof)
    assert len(public_inputs) == 12, len(public_inputs)

    # Local sanity: the same equations the contract will check.
    assert G.scalar_mul(s).add(pk.scalar_mul(e_neg)) == r1, "R1 mismatch"
    assert h.scalar_mul(s).add(d.scalar_mul(e_neg)) == r2, "R2 mismatch"

    return proof, public_inputs, {"pk": pk, "h": h, "d": d, "r1": r1, "r2": r2, "e": e, "s": s}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corrupt", action="store_true",
                    help="flip one felt mid-proof. NOTE: this lands in the MSM hint, so "
                         "Garaga panics on 'Wrong FakeGLV decomposition' rather than the "
                         "DLEQ equation failing -- it tests hint integrity, not soundness")
    ap.add_argument("--wrong-share", action="store_true",
                    help="the attack that matters: a decryption share computed with a "
                         "DIFFERENT secret than the registered key, everything else "
                         "internally consistent. This is a dishonest player trying to make "
                         "their card decrypt to something they prefer")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    x = rng.randrange(1, N)
    # Stand-in for a card ciphertext's c1. Any curve point works; using a
    # known multiple of G keeps this reproducible.
    h = G.scalar_mul(rng.randrange(1, N))

    if args.wrong_share:
        # Prove honestly for x' != x, then publish it against x's public key.
        # Only the DLEQ relation between PK and D is false.
        #
        # The MSM hints must be REGENERATED for the substituted PK. Hints are
        # public computational aids, not secrets, so a real attacker computes
        # them freely -- leaving the stale ones in place would only trip
        # Garaga's "wrong FakeGLV result" assertion and prove nothing about
        # soundness. With consistent hints the MSM runs cleanly and the
        # challenge comparison is what has to catch this.
        x_other = rng.randrange(1, N)
        proof, public_inputs, dbg = prove(x_other, h, rng)
        pk_honest = G.scalar_mul(x)
        public_inputs[0:4] = u256_pair(pk_honest.x) + u256_pair(pk_honest.y)

        s, e = dbg["s"], dbg["e"]
        e_neg = (-e) % N
        proof[4:24] = msm_hint([G, pk_honest], [s, e_neg])
        print("# substituted PK of a different secret, hints regenerated to match",
              file=sys.stderr)
        print("# log_G(PK) != log_H(D); only the challenge check can catch this",
              file=sys.stderr)
    else:
        proof, public_inputs, dbg = prove(x, h, rng)

    if args.corrupt:
        proof[len(proof) // 2] += 1

    print(f"# DLEQ over Grumpkin, seed={args.seed}, corrupt={args.corrupt}", file=sys.stderr)
    print(f"# e = {hex(dbg['e'])}", file=sys.stderr)
    print(f"# proof felts: {len(proof)}, public_inputs felts: {len(public_inputs)}", file=sys.stderr)
    # sncast --calldata wants a flat raw felt list; Span<felt252> args each
    # need their own length prefix.
    calldata = [len(proof)] + proof + [len(public_inputs)] + public_inputs
    print(" ".join(str(v) for v in calldata))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
