#!/usr/bin/env python3
"""Regenerate cairo-verifier/src/card_table.cairo.

Card i is the Grumpkin point M_i = (i+1)*G. The +1 matters: 0*G is the point
at infinity, which has no affine (x, y) representation and so could not be
carried inside a ciphertext.

The client-side card encoder MUST agree with this table exactly. If it does
not, decryption yields a point matching no card and every reveal fails --
loudly, at least, rather than silently mis-decoding.

    python3 scripts/gen_card_table.py > /dev/null && git diff --stat

Needs garaga installed (pip install garaga==1.1.0).
"""

import sys
from pathlib import Path

from garaga.curves import CURVES, CurveID
from garaga.points import G1Point

OUT = Path(__file__).resolve().parent.parent / "cairo-verifier" / "src" / "card_table.cairo"

HEADER = """// Card encoding table for the mental-poker deck.
//
// Card i is the Grumpkin point M_i = (i+1)*G. The +1 matters: 0*G is the
// point at infinity, which has no affine (x, y) representation and could
// not be carried in a ciphertext.
//
// Generated, do not hand-edit. Regenerate with scripts/gen_card_table.py.
// The client encoder MUST agree with this table exactly or decryption
// yields a point that matches no card and every reveal fails.
//
// Only x is stored. The decrypted point is a genuine curve point, so x
// determines y up to sign and the 52 x-coordinates are distinct (checked at
// generation time) -- x alone identifies the card.

// Returns the x-coordinate of card `i`, or 0 if `i` is out of range. 0 is
// safe as a sentinel because it is not a valid Grumpkin x for any card.
pub fn card_x(i: u8) -> u256 {
"""


def main() -> int:
    curve = CURVES[CurveID.GRUMPKIN.value]
    g = G1Point(curve.Gx, curve.Gy, CurveID.GRUMPKIN)
    points = [g.scalar_mul(i + 1) for i in range(52)]

    xs = [p.x for p in points]
    if len(set(xs)) != 52:
        print("FATAL: x-coordinates collide; lookup by x is unsound", file=sys.stderr)
        return 1

    body = "\n".join(
        f"    if i == {i} {{\n        return 0x{p.x:x};\n    }}" for i, p in enumerate(points)
    )
    OUT.write_text(HEADER + body + "\n    0\n}\n")
    print(f"wrote {OUT} (52 cards, all x distinct)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
