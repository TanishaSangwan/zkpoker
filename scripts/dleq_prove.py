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


def aggregate(secrets: list[int], h: G1Point, rng: random.Random):
    """Aggregate n parties' decryption shares into ONE DLEQ proof.

    Each party i holds x_i with PK_i = x_i*G and contributes d_i = x_i*H.
    Summing gives Y = sum(PK_i) and D = sum(d_i), and because
    Y = X*G and D = X*H for the joint secret X = sum(x_i), the statement
    "log_G(Y) == log_H(D)" is a single DLEQ over the JOINT key -- which the
    contract already stores. Individual proofs sum straight into it:

        R1 = sum(k_i*G) = K*G      R2 = sum(k_i*H) = K*H
        S  = sum(k_i + e*x_i) = K + e*X

        S*G - e*Y = (K + eX)G - e(XG) = K*G = R1   (and likewise for H, D)

    So verification cost is O(1) in the number of players, and the on-chain
    verifier needs no change at all -- it is the same DleqVerifier with
    (Y, H, D) substituted for (PK, H, d).

    ROUND STRUCTURE MATTERS. e depends on R1 = sum(R1_i), so a party who
    reveals R1_i last could grind it against the others' choices. That is
    the standard naive-multisignature weakness (Wagner / the original MuSig
    flaw). Real deployment must therefore run three rounds: commit to
    Poseidon(R1_i, R2_i) first, reveal only once every commitment is in,
    then compute s_i. Shares are exchanged off-chain anyway, so this costs
    nothing on-chain. This function models the honest case and does not
    enforce the commitment round -- the dealer bot must.

    ACCOUNTABILITY TRADE-OFF: if the aggregate fails to verify, you learn
    that someone was dishonest but not who. The fallback is to demand
    individual proofs from each party and verify those (n+1 x 64.6M gas) to
    identify the culprit. Cheap in the normal case, expensive only on
    dispute -- which is the right way round.
    """
    pks, ds, r1s, r2s, ks = [], [], [], [], []
    for x in secrets:
        pks.append(G.scalar_mul(x))
        ds.append(h.scalar_mul(x))
        k = rng.randrange(1, N)
        ks.append(k)
        r1s.append(G.scalar_mul(k))
        r2s.append(h.scalar_mul(k))

    def psum(points):
        acc = points[0]
        for p in points[1:]:
            acc = acc.add(p)
        return acc

    Y, D, R1, R2 = psum(pks), psum(ds), psum(r1s), psum(r2s)
    e = challenge(Y, h, D, R1, R2)
    S = sum((k + e * x) % N for k, x in zip(ks, secrets)) % N

    e_neg = (-e) % N
    proof = (
        u256_pair(S) + u256_pair(e)
        + msm_hint([G, Y], [S, e_neg])
        + msm_hint([h, D], [S, e_neg])
    )
    public_inputs = (
        u256_pair(Y.x) + u256_pair(Y.y)
        + u256_pair(h.x) + u256_pair(h.y)
        + u256_pair(D.x) + u256_pair(D.y)
    )
    assert G.scalar_mul(S).add(Y.scalar_mul(e_neg)) == R1, "aggregate R1 mismatch"
    assert h.scalar_mul(S).add(D.scalar_mul(e_neg)) == R2, "aggregate R2 mismatch"
    return proof, public_inputs, {"Y": Y, "D": D, "e": e, "S": S}


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
    ap.add_argument("--aggregate", type=int, metavar="N", default=0,
                    help="aggregate N parties' shares into ONE proof over the joint key. "
                         "Verification cost is independent of N")
    ap.add_argument("--bad-aggregate", action="store_true",
                    help="with --aggregate: one party contributes a share computed from a "
                         "different secret, so D != X*H and the aggregate must fail")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    x = rng.randrange(1, N)
    # Stand-in for a card ciphertext's c1. Any curve point works; using a
    # known multiple of G keeps this reproducible.
    h = G.scalar_mul(rng.randrange(1, N))

    if args.aggregate:
        secrets = [rng.randrange(1, N) for _ in range(args.aggregate)]
        if args.bad_aggregate:
            # One dishonest party: their PK still goes into Y honestly, but
            # their published share is x'*H for some other x'. D is then no
            # longer X*H, so no S can satisfy both equations at once.
            honest = secrets[:]
            proof, public_inputs, dbg = aggregate(honest, h, rng)
            liar = rng.randrange(1, N)
            bad_D = dbg["D"].add(h.scalar_mul(liar))
            public_inputs[8:12] = u256_pair(bad_D.x) + u256_pair(bad_D.y)
            e_neg = (-dbg["e"]) % N
            proof[24:44] = msm_hint([h, bad_D], [dbg["S"], e_neg])
            print(f"# {args.aggregate} parties, ONE dishonest -- D != X*H", file=sys.stderr)
        else:
            proof, public_inputs, dbg = aggregate(secrets, h, rng)
            print(f"# aggregated {args.aggregate} parties into one proof", file=sys.stderr)
        calldata = [len(proof)] + proof + [len(public_inputs)] + public_inputs
        print(f"# e = {hex(dbg['e'])}", file=sys.stderr)
        print(" ".join(str(v) for v in calldata))
        return 0

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
