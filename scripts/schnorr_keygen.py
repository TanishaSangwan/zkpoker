#!/usr/bin/env python3
"""Generate a Grumpkin keypair and a Schnorr proof of knowledge of its secret,
in the exact form `SchnorrKeyVerifier` (cairo-verifier/) accepts.

This is the prover side of the rogue-key defence in
docs/V2-MENTAL-POKER.md §4.1: a player must prove they know the secret
behind the key share they register, or the last registrant could choose
pk_last = X - sum(other shares) and own the joint key alone.

GRUMPKIN
    y^2 = x^3 - 17  over  Fp, where
    p (base field)  = BN254's SCALAR field  (~2.19e76)
    n (scalar order)= BN254's BASE field    (~2.19e76)
    Note p and n are swapped relative to BN254 — that is what makes
    BN254/Grumpkin a cycle, and it is easy to mix up.

BIP340 EVEN-Y CONVENTION
    Garaga's verifier requires the public key to have an EVEN y, and the
    nonce point R likewise. Keys are normalised here by negating the secret
    when y is odd, exactly as BIP340 does. A key with odd y will simply be
    rejected on-chain, so normalise before registering.

CHALLENGE
    e = Poseidon(rx.limb0..limb3, pk_x.low, pk_x.high, pk_y.low, pk_y.high)
    using Starknet's Poseidon, with rx as four 96-bit limbs. The verifier
    recomputes this and refuses a proof whose e does not match — without
    that check the scheme is trivially forgeable (pick any s and e, set
    R = sG - eP).

Needs: pip install -r scripts/requirements.txt  (poseidon-py)

Usage:
    python3 scripts/schnorr_keygen.py --secret 12345
    python3 scripts/schnorr_keygen.py --secret 12345 --nonce 999
"""

from __future__ import annotations

import argparse
import json
import sys

from poseidon_py.poseidon_hash import poseidon_hash_many

# Grumpkin base field = BN254 scalar field
P = 21888242871839275222246405745257275088548364400416034343698204186575808495617
# Grumpkin scalar order = BN254 base field
N = 21888242871839275222246405745257275088696311157297823662689037894645226208583
B = -17 % P
# Generator: Grumpkin's standard generator (x=1, y=sqrt(-16))
GX = 1
GY = 17631683881184975370165255887551781615748388533673675138860


def inv(a: int, m: int = P) -> int:
    return pow(a, m - 2, m)


def is_on_curve(pt) -> bool:
    if pt is None:
        return True
    x, y = pt
    return (y * y - x * x * x - B) % P == 0


def add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1) * inv(2 * y1) % P
    else:
        lam = (y2 - y1) * inv(x2 - x1) % P
    x3 = (lam * lam - x1 - x2) % P
    y3 = (lam * (x1 - x3) - y1) % P
    return (x3, y3)


def mul(k: int, pt):
    k %= N
    result = None
    addend = pt
    while k:
        if k & 1:
            result = add(result, addend)
        addend = add(addend, addend)
        k >>= 1
    return result


G = (GX, GY)


def limbs96(v: int) -> list[int]:
    """Garaga u384: four 96-bit limbs, little-endian."""
    mask = (1 << 96) - 1
    return [(v >> (96 * i)) & mask for i in range(4)]


def u256_parts(v: int) -> tuple[int, int]:
    return v & ((1 << 128) - 1), v >> 128


def challenge(rx: int, pk: tuple[int, int]) -> int:
    pkx_lo, pkx_hi = u256_parts(pk[0])
    pky_lo, pky_hi = u256_parts(pk[1])
    return poseidon_hash_many(limbs96(rx) + [pkx_lo, pkx_hi, pky_lo, pky_hi])


def normalise_even_y(secret: int) -> tuple[int, tuple[int, int]]:
    """BIP340: force an even-y public key by negating the secret if needed."""
    pk = mul(secret, G)
    assert pk is not None, "secret must be non-zero mod n"
    if pk[1] % 2 != 0:
        secret = (-secret) % N
        pk = mul(secret, G)
    assert pk is not None and pk[1] % 2 == 0
    return secret, pk


def prove(secret: int, nonce: int) -> dict:
    secret, pk = normalise_even_y(secret)

    # R must also have even y (the verifier checks the recomputed point's
    # y parity), so normalise the nonce the same way.
    k = nonce % N
    assert k != 0, "nonce must be non-zero mod n"
    R = mul(k, G)
    assert R is not None
    if R[1] % 2 != 0:
        k = (-k) % N
        R = mul(k, G)
    assert R is not None and R[1] % 2 == 0

    e = challenge(R[0], pk)
    s = (k + e * secret) % N

    # Self-check the verification equation the contract will run:
    #   sG - eP == R
    lhs = add(mul(s, G), mul((-e) % N, pk))
    assert lhs is not None and lhs[0] == R[0] and lhs[1] % 2 == 0, "proof failed self-check"

    return {
        "secret": secret,
        "pk_x": pk[0],
        "pk_y": pk[1],
        "rx": R[0],
        "ry": R[1],
        "s": s,
        "e": e,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--secret", required=True, help="secret key, decimal or 0x-hex")
    ap.add_argument("--nonce", default="0xdeadbeefcafe", help="Schnorr nonce k (decimal or 0x-hex)")
    ap.add_argument("--json", action="store_true", help="emit JSON only")
    args = ap.parse_args()

    parse = lambda r: int(r, 16) if r.lower().startswith("0x") else int(r)
    out = prove(parse(args.secret), parse(args.nonce))

    if args.json:
        print(json.dumps({k: str(v) for k, v in out.items()}, indent=2))
        return 0

    print("Grumpkin Schnorr proof of knowledge\n")
    print(f"  secret (normalised) : {out['secret']}")
    print(f"  pk.x                : {out['pk_x']}")
    print(f"  pk.y                : {out['pk_y']}   (even: {out['pk_y'] % 2 == 0})")
    print(f"  R.x                 : {out['rx']}")
    print(f"  s                   : {out['s']}")
    print(f"  e (challenge)       : {out['e']}")
    print()
    print("Cairo u256 literals:")
    for name in ("pk_x", "pk_y", "rx", "s", "e"):
        lo, hi = u256_parts(out[name])
        print(f"  {name:5} = u256 {{ low: {lo}, high: {hi} }}")
    print()
    print(f"rx as Garaga u384 limbs: {limbs96(out['rx'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
