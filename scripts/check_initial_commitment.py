#!/usr/bin/env python3
"""Guards INITIAL_DECK_COMMITMENT against silent drift.

PokerGame pins the commitment to a_0, the protocol's one and only starting
deck (docs/PROTOCOL.md section 4 phase 0). Cairo cannot compute that value
-- it is Poseidon2 over BN254 while Cairo's Poseidon is over the STARK
field (section 7) -- so the constant is produced by circuits/deck_init and
hard-coded.

That is a hash written in two places that nothing otherwise ties together.
If the card encoding, the deck layout, or the Poseidon version ever
changes, the contract would keep pinning a stale value and the first
shuffle in every chain would fail to verify with no clue why. This runs
the circuit and compares.

    python3 scripts/check_initial_commitment.py

Exits non-zero on a mismatch. Needs nargo on PATH.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CIRCUIT = ROOT / "circuits" / "deck_init"
CONTRACT = ROOT / "cairo" / "src" / "lib.cairo"
FIXTURE = ROOT / "cairo" / "tests" / "test_shuffle.cairo"


def from_circuit() -> int:
    out = subprocess.run(
        ["nargo", "execute"], cwd=CIRCUIT, capture_output=True, text=True
    )
    if out.returncode != 0:
        sys.exit(f"nargo execute failed:\n{out.stdout}\n{out.stderr}")
    m = re.search(r"Circuit output:\s*(0x[0-9a-fA-F]+)", out.stdout)
    if not m:
        sys.exit(f"could not find the circuit output in:\n{out.stdout}")
    return int(m.group(1), 16)


def from_contract() -> int:
    src = CONTRACT.read_text()
    m = re.search(
        r"const INITIAL_DECK_COMMITMENT: u256 = u256 \{\s*"
        r"low:\s*(\d+),\s*high:\s*(\d+),?\s*\}",
        src,
    )
    if not m:
        sys.exit("could not find INITIAL_DECK_COMMITMENT in cairo/src/lib.cairo")
    return int(m.group(1)) | (int(m.group(2)) << 128)


def from_fixture() -> int:
    src = FIXTURE.read_text()
    m = re.search(
        r"const A0: u256 = u256 \{\s*low:\s*(\d+),\s*high:\s*(\d+),?\s*\}", src
    )
    if not m:
        sys.exit("could not find the A0 fixture in cairo/tests/test_shuffle.cairo")
    return int(m.group(1)) | (int(m.group(2)) << 128)


def main() -> None:
    circuit = from_circuit()
    places = {
        "cairo/src/lib.cairo": from_contract(),
        # The test asserts the contract pins a_0. If the fixture were
        # copied from the contract rather than from the circuit, that
        # assertion would be a tautology -- so it is checked here too.
        "cairo/tests/test_shuffle.cairo": from_fixture(),
    }
    bad = {k: v for k, v in places.items() if v != circuit}
    if bad:
        lines = "\n".join(f"  {k}: {v:#x}" for k, v in bad.items())
        sys.exit(
            "INITIAL_DECK_COMMITMENT has drifted.\n"
            f"  circuits/deck_init: {circuit:#x}\n"
            f"{lines}\n"
            "Update them to the circuit's value."
        )
    print(f"ok: {circuit:#x} (contract and test fixture both agree)")


if __name__ == "__main__":
    main()
