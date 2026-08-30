#!/usr/bin/env python3
"""Recompute a poker deal from a revealed seed and check it against a claimed
seat/card mapping — the "provably fair" check for the V1 (trusted-dealer,
commit-reveal) design in ../docs/DESIGN.md.

This is a client-side auditing tool, not part of the Cairo contract. Anyone
who observed `commit_deal` (the seed_hash) and `reveal_seed` (the seed) events
on-chain can run this independently of the dealer.

PRNG NOTE: this uses Python's `random.Random(seed)` as a stand-in so the tool
runs with zero dependencies during the hackathon. That PRNG is NOT something
you could re-derive inside a Cairo contract or a STARK circuit. Before this
claim ships anywhere real, swap `seeded_shuffle` for a Poseidon-based
Fisher-Yates (or equivalent STARK-friendly construction) so the same
computation can eventually be proven on-chain per the RFP's "STARK-proven
dealing" requirement, instead of only being reproducible off-chain.

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
import random
import sys

DECK_SIZE = 52

RANKS = "23456789TJQKA"
SUITS = "cdhs"


def card_name(index: int) -> str:
    rank = RANKS[index % 13]
    suit = SUITS[index // 13]
    return f"{rank}{suit}"


def seeded_shuffle(seed: int) -> list[int]:
    """Deterministic Fisher-Yates over a 52-card deck, seeded by `seed`.

    See the PRNG NOTE above: swap this for a Poseidon-based construction
    before treating its output as provable rather than merely reproducible.
    """
    deck = list(range(DECK_SIZE))
    rng = random.Random(seed)
    for i in range(DECK_SIZE - 1, 0, -1):
        j = rng.randrange(i + 1)
        deck[i], deck[j] = deck[j], deck[i]
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
