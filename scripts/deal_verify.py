#!/usr/bin/env python3
"""Recompute a poker deal from a revealed seed and check it against a claimed
seat/card mapping — the "provably fair" check for the V1 (trusted-dealer,
commit-reveal) design in ../docs/DESIGN.md.

This is a client-side auditing tool, not part of the Cairo contract. Anyone
who observed `commit_deal` (the seed_hash) and `reveal_seed` (the seed) events
on-chain can run this independently of the dealer.

SHUFFLE: `seeded_shuffle` below is a line-for-line port of
../cairo/src/shuffle.cairo's `shuffled_deck` — same Poseidon-based
Fisher-Yates, same per-step draw (`poseidon_hash([seed, step]) % bound`),
same swap order — so this script's output matches the on-chain computation
bit-for-bit, not just "plausibly similar". That equivalence is pinned by two
Cairo regression tests (`poseidon_vector_check.cairo`,
`shuffle_vector_check.cairo`) that assert Cairo's `core::poseidon` and this
file's Poseidon dependency (`poseidon-py`, see requirements.txt) agree on
concrete test vectors — re-run those tests if you touch either side.

Needs: `pip install -r requirements.txt` (just `poseidon-py`, a small
prebuilt-wheel package — no native/Rust toolchain required).

NOTE on scope: this script reproduces the *deck* from a revealed seed. The
Cairo contract does not yet check a submitted hole/community card against a
specific position in that deck at settlement (`settle_table_by_hand` only
checks cards are in-range and distinct — see docs/DESIGN.md open items).
Doing that on-chain needs a fixed seat->deck-position convention, which
needs a `max_seats`-like concept the contract doesn't have yet. Until then,
this script's per-seat dealing order (round-robin, matching how Hold'em is
actually dealt) is this tool's own convention for *presenting* a recomputed
deal — not something the contract enforces.

Usage:

    python3 deal_verify.py --seed 0x1234... --seats 6 --cards-per-seat 2 \\
        --claimed claimed_deal.json

`claimed_deal.json` shape:

    {"0": [51, 12], "1": [3, 40], ...}   # seat -> card indices (0-51)

Exit codes:

    0  recomputed deal matches the claim
    1  mismatch — the dealer dealt something other than what the seed implies
    2  bad input (couldn't parse args or claim file)
"""

from __future__ import annotations

import argparse
import json
import sys

from poseidon_py.poseidon_hash import poseidon_hash_many

DECK_SIZE = 52

RANKS = "23456789TJQKA"
SUITS = "cdhs"


def card_name(index: int) -> str:
    rank = RANKS[index % 13]
    suit = SUITS[index // 13]
    return f"{rank}{suit}"


def _draw_index(seed: int, step: int, bound: int) -> int:
    """Matches cairo/src/shuffle.cairo's `draw_index` exactly: a Poseidon
    hash of (seed, step), reduced mod bound. Not rejection-sampled (small
    modulo bias) — same accepted simplification as the Cairo side, at this
    scale (52-element deck)."""
    h = poseidon_hash_many([seed, step])
    return h % bound


def seeded_shuffle(seed: int) -> list[int]:
    """Poseidon-based Fisher-Yates over a 52-card deck, seeded by `seed`.

    Line-for-line match of cairo/src/shuffle.cairo's `shuffled_deck` — see
    the module docstring above for how that equivalence is verified.
    """
    deck = list(range(DECK_SIZE))
    idx = DECK_SIZE - 1
    while idx != 0:
        j = _draw_index(seed, idx, idx + 1)
        deck[idx], deck[j] = deck[j], deck[idx]
        idx -= 1
    return deck


def deal(seed: int, seats: int, cards_per_seat: int) -> dict[int, list[int]]:
    deck = seeded_shuffle(seed)
    if seats * cards_per_seat > DECK_SIZE:
        raise ValueError("seats * cards_per_seat exceeds deck size")
    hands: dict[int, list[int]] = {seat: [] for seat in range(seats)}
    pos = 0
    for _round in range(cards_per_seat):
        for seat in range(seats):
            hands[seat].append(deck[pos])
            pos += 1
    return hands


def parse_seed(raw: str) -> int:
    return int(raw, 16) if raw.lower().startswith("0x") else int(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", required=True, help="revealed seed, decimal or 0x-hex")
    parser.add_argument("--seats", type=int, required=True, help="number of seats dealt")
    parser.add_argument("--cards-per-seat", type=int, default=2, help="hole cards per seat (default: 2, Texas Hold'em)")
    parser.add_argument("--claimed", help="path to a JSON file of seat -> [card indices] to check against")
    args = parser.parse_args()

    try:
        seed = parse_seed(args.seed)
    except ValueError:
        print(f"Could not parse --seed {args.seed!r} as decimal or 0x-hex", file=sys.stderr)
        return 2

    try:
        recomputed = deal(seed, args.seats, args.cards_per_seat)
    except ValueError as error:
        print(f"Bad deal parameters: {error}", file=sys.stderr)
        return 2

    print(f"Recomputed deal for seed={hex(seed)}, seats={args.seats}, cards_per_seat={args.cards_per_seat}:\n")
    for seat, cards in recomputed.items():
        print(f"  seat {seat}: {[card_name(c) for c in cards]}  (indices {cards})")

    if not args.claimed:
        print("\nNo --claimed file given: nothing to check against, printed the recomputed deal only.")
        return 0

    try:
        with open(args.claimed, encoding="utf-8") as handle:
            claimed_raw = json.load(handle)
        claimed = {int(seat): cards for seat, cards in claimed_raw.items()}
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Could not read/parse --claimed {args.claimed!r}: {error}", file=sys.stderr)
        return 2

    mismatches = []
    for seat, cards in recomputed.items():
        claimed_cards = claimed.get(seat)
        if claimed_cards != cards:
            mismatches.append((seat, cards, claimed_cards))

    print()
    if mismatches:
        print("DEAL DOES NOT MATCH THE REVEALED SEED:")
        for seat, expected, got in mismatches:
            print(f"  seat {seat}: seed implies {expected}, claim says {got}")
        return 1

    print("Deal matches the revealed seed for every seat. Fair deal confirmed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
