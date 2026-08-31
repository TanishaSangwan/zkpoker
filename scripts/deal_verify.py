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

DEAL CONVENTION: this mirrors what `settle_table_by_hand` enforces on-chain
(round 8), so a deal this script calls fair is exactly a deal the contract
accepts:

    seat N's hole cards  = deck[2N], deck[2N+1]
    community card k     = deck[2 * max_seats + k]     for k in 0..4

Note `max_seats` is the table's CAPACITY (fixed at `create_table`), not the
number of seats actually occupied — the contract reserves two deck slots per
seat whether or not anyone sits there, so community cards start after all of
them. Pass `--max-seats` when the table has empty seats; it defaults to
`--seats`.

Hole-card ORDER within a seat is not significant: the contract accepts
(h1,h2) or (h2,h1), so this script compares a seat's cards as a set.

Until round 8 this script dealt round-robin (seat 0 gets deck[0] and
deck[seats], the way a human deals) while the contract required contiguous
pairs. The two disagreed for every seat at every table size, so an honest
dealer was reported as a cheat and vice versa. Fixed 2026-08-31.

Usage:

    python3 deal_verify.py --seed 0x1234... --seats 6
    python3 deal_verify.py --seed 0x1234... --seats 2 --max-seats 6 \\
        --claimed claimed_deal.json

`claimed_deal.json` shape (the "community" key is optional):

    {"0": [51, 12], "1": [3, 40], "community": [7, 8, 9, 10, 11]}

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

# Fixed by the contract's deck-position convention — see the module
# docstring. HOLE_CARDS_PER_SEAT is what makes seat N's slots 2N/2N+1, so it
# is not a tunable parameter here.
HOLE_CARDS_PER_SEAT = 2
COMMUNITY_CARDS = 5
# PokerGame::MAX_TABLE_SEATS. Chosen so 2*23 + 5 = 51 <= 52.
MAX_TABLE_SEATS = 23

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


def deal(seed: int, seats: int, max_seats: int) -> tuple[dict[int, list[int]], list[int]]:
    """Recompute the hole cards and community cards a seed implies.

    Uses the contract's deck-position convention (see the module docstring):
    seat N takes deck[2N]/deck[2N+1], community cards start after every
    seat's reserved pair at 2*max_seats. Returns (hands, community).
    """
    if not 1 <= max_seats <= MAX_TABLE_SEATS:
        raise ValueError(f"max_seats must be 1..{MAX_TABLE_SEATS} (PokerGame::MAX_TABLE_SEATS), got {max_seats}")
    if not 1 <= seats <= max_seats:
        raise ValueError(f"seats must be 1..max_seats ({max_seats}), got {seats}")

    deck = seeded_shuffle(seed)
    hands = {seat: [deck[2 * seat], deck[2 * seat + 1]] for seat in range(seats)}
    community_start = HOLE_CARDS_PER_SEAT * max_seats
    community = [deck[community_start + k] for k in range(COMMUNITY_CARDS)]
    return hands, community


def parse_seed(raw: str) -> int:
    return int(raw, 16) if raw.lower().startswith("0x") else int(raw)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", required=True, help="revealed seed, decimal or 0x-hex")
    parser.add_argument("--seats", type=int, required=True, help="number of seats actually dealt")
    parser.add_argument(
        "--max-seats",
        type=int,
        help="the table's max_seats (capacity, from create_table). Determines where community "
        "cards start (2*max_seats). Defaults to --seats; pass it explicitly if the table has "
        "empty seats, or the community cards will be read from the wrong positions.",
    )
    parser.add_argument(
        "--cards-per-seat",
        type=int,
        default=HOLE_CARDS_PER_SEAT,
        help=argparse.SUPPRESS,  # kept only so old invocations don't hard-fail; must be 2
    )
    parser.add_argument("--claimed", help="path to a JSON file of seat -> [card indices] to check against")
    args = parser.parse_args()

    if args.cards_per_seat != HOLE_CARDS_PER_SEAT:
        print(
            f"--cards-per-seat must be {HOLE_CARDS_PER_SEAT}: the contract's deck-position "
            f"convention (seat N -> 2N/2N+1) is what makes this tool's output checkable, and it "
            f"hard-codes two hole cards per seat.",
            file=sys.stderr,
        )
        return 2

    max_seats = args.max_seats if args.max_seats is not None else args.seats

    try:
        seed = parse_seed(args.seed)
    except ValueError:
        print(f"Could not parse --seed {args.seed!r} as decimal or 0x-hex", file=sys.stderr)
        return 2

    try:
        recomputed, community = deal(seed, args.seats, max_seats)
    except ValueError as error:
        print(f"Bad deal parameters: {error}", file=sys.stderr)
        return 2

    print(f"Recomputed deal for seed={hex(seed)}, seats={args.seats}, max_seats={max_seats}:\n")
    for seat, cards in recomputed.items():
        print(f"  seat {seat}: {[card_name(c) for c in cards]}  (indices {cards})")
    print(f"  community: {[card_name(c) for c in community]}  (indices {community})")

    if not args.claimed:
        print("\nNo --claimed file given: nothing to check against, printed the recomputed deal only.")
        return 0

    try:
        with open(args.claimed, encoding="utf-8") as handle:
            claimed_raw = json.load(handle)
        claimed_community = claimed_raw.pop("community", None)
        claimed = {int(seat): cards for seat, cards in claimed_raw.items()}
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Could not read/parse --claimed {args.claimed!r}: {error}", file=sys.stderr)
        return 2

    mismatches = []
    for seat, cards in recomputed.items():
        claimed_cards = claimed.get(seat)
        # Hole-card order within a seat is not significant — the contract
        # accepts (h1,h2) or (h2,h1) — so compare as multisets.
        if claimed_cards is None or sorted(claimed_cards) != sorted(cards):
            mismatches.append((f"seat {seat}", cards, claimed_cards))

    # Community order IS significant: card k must sit at 2*max_seats + k.
    if claimed_community is not None and list(claimed_community) != community:
        mismatches.append(("community", community, claimed_community))

    print()
    if mismatches:
        print("DEAL DOES NOT MATCH THE REVEALED SEED:")
        for label, expected, got in mismatches:
            print(f"  {label}: seed implies {expected}, claim says {got}")
        return 1

    checked = "every seat" if claimed_community is None else "every seat and the community cards"
    print(f"Deal matches the revealed seed for {checked}. Fair deal confirmed.")
    if claimed_community is None:
        print("(No \"community\" key in the claim file — community cards were not checked.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
