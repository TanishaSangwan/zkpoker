# Test suite — has NOT been run or compile-checked

**Exception: `cairo/src/poker_hand.cairo` and `cairo/src/shuffle.cairo`'s
own unit tests DO run and DO pass** — 30 tests total, via
`cd cairo && scarb test -- -t unit`. Those modules have no
storage/external-call/cheat-code dependency, so they need none of the
`snforge` machinery this directory's suite needs. See their module doc
comments and `docs/DESIGN.md` "Hand evaluation" / "Deck shuffle from seed"
for why. Everything below is about *this* directory (`cairo/tests/`), which
is a different, still-unrun story.

This suite (`helpers.cairo`, `test_lifecycle.cairo`, `test_betting.cairo`,
`test_settlement.cairo`, `test_hand_eval.cairo`, `../src/mocks.cairo`) was
written against the contract as of round 5 of the security review (plus
round 6's streets/`settle_table_by_hand` addition for `test_hand_eval.cairo`
specifically), following the `cairo-testing` skill's coverage rules and the
"Required Tests" lists from all five `../../security-review-*.md` reports.
**It has not been executed, and could not even be compile-checked**, on the
machine it was written on:

- Starknet Foundry (`snforge`) ships no Windows binary.
- Building it from source needs a Rust/cargo toolchain, which wasn't
  installed, and adding it wasn't judged worth the time (see the git
  history / conversation this came from for the full reasoning).
- `scarb build --test` can compile test code without the `snforge` binary
  itself — but even that needs `snforge_std`'s companion compiler plugin
  (`snforge_scarb_plugin`), which had no prebuilt Windows binary for the
  version tried and fell back to `cargo fetch` — still blocked without
  Rust. Adding `snforge_std` as a dev-dependency was tried and reverted
  after it broke even the **plain** `scarb build` (Scarb resolves the full
  dependency graph, dev-dependencies included, for any build) — see
  `cairo/Scarb.toml`'s comment.

**Every test was authored carefully against the actual contract, re-read
multiple times, and one real bug was caught and fixed this way** (both
reentrancy regression tests initially had the malicious token impersonate
a separate "MALLORY" identity, which would have hit the `NOT_SEAT_OWNER`/
`NOT_DEALER` check before ever reaching the `reentrancy_lock` check the
test was meant to isolate — fixed by having the token contract itself act
as the seat owner/dealer, matching the audit's own attack narrative). That
said, treat every test in this suite as **unverified** until it's actually
run. Cairo/Starknet-specific syntax mistakes (dispatcher trait bounds,
event-path resolution, u128/u256 conversions) are plausible even with
careful review, and this notably has not caught any that might exist.

## To run this suite

You need a machine with `snforge` — Linux, macOS, or WSL on Windows (not
native Windows).

1. Install Starknet Foundry: https://foundry-paradigm.xyz (or
   `curl -L https://sh.starkli.sh | sh` doesn't apply — see the official
   `snfoundryup` installer instead — check the docs for the current
   command, this changes).
2. Add to `cairo/Scarb.toml` (removed from the committed file for the
   reason above — Scarb.toml itself documents this):
   ```toml
   [dev-dependencies]
   snforge_std = "0.63.0"  # match your installed snforge CLI version — run `snforge --version`

   [tool.scarb]
   allow-prebuilt-plugins = ["snforge_std"]
   ```
3. From `cairo/`: `snforge test`
4. Fix whatever breaks. Start with `helpers.cairo` and one simple test
   (`test_create_table_success` in `test_lifecycle.cairo`) before the more
   involved reentrancy/regression tests — if the deploy/dispatcher pattern
   itself needs adjustment, better to find that on the simplest test first.

## What's covered

- **Full lifecycle**: `create_table`, `join_table`, `commit_deal`,
  `mark_dealt`, `reveal_seed` — success, access control (authorized +
  unauthorized), and state-machine negative paths, each with event
  assertions on the success case.
- **Betting**: `bet`, `fold`, `reclaim_stalled_bet` — same pattern, plus:
  - `test_bet_value_fabrication_without_real_transfer_rejected` (round 2)
  - `test_bet_fee_on_transfer_credits_only_received_amount` (round 3)
  - `test_bet_reentrancy_blocked` (round 3/4/5)
  - the full `reclaim_stalled_bet` timeout/ownership/double-reclaim set
    (round 3)
- **Settlement**: `settle_table`, `privacy_invoke` — same pattern, plus:
  - `test_settle_table_remainder_credited_to_first_winner` (round 1)
  - `test_settle_table_cross_table_token_relabel_rejected` (round 3)
  - `test_settle_table_twice_rejected` / `test_bet_after_settlement_rejected`
    (round 4)
  - `test_settle_table_reentrancy_blocked` (round 4)
  - `test_privacy_invoke_wrong_caller_rejected` /
    `test_privacy_invoke_wrong_token_rejected` (round 1)
  - `test_privacy_invoke_approve_failure_rejected` (round 5)
- **Streets and hand evaluation** (`test_hand_eval.cairo`, round 6, extended
  round 8): `advance_street` success/access-control/past-Showdown, `bet`
  closing once Showdown is reached, and `settle_table_by_hand` — a
  clear-winner case and a genuine tie-split case, plus its own
  access-control/state-machine/input-shape negative paths, plus (round 7)
  `test_settle_table_by_hand_out_of_range_card_rejected` /
  `test_settle_table_by_hand_duplicate_card_across_seats_rejected` for the
  card-validation fix, plus (round 8) `test_settle_table_by_hand_
  seed_not_revealed_rejected` / `..._wrong_hole_card_rejected` /
  `..._wrong_community_card_rejected` for the deck-provenance check, plus
  `test_settle_table_by_hand_three_seat_table` — every other test in the
  file uses the default 2-seat fixture, so this is the only coverage of
  `settle_table_by_hand`'s position math (`community_start = 2*max_seats`)
  at a `max_seats` other than 2.
  `poker_hand::best_of_7`/`evaluate_5`/`assert_valid_deck_cards` and
  `shuffle::shuffled_deck` themselves are separately, genuinely tested —
  see the note at the top of this file. As of round 8, the clear-winner,
  tie, and three-seat tests use REAL cards derived from an actual
  committed/revealed seed (not hand-picked) — `settle_table_by_hand` now
  requires this and would reject a fabricated hand with `CARD_MISMATCH`
  before ever scoring it. See `test_hand_eval.cairo`'s own header for how
  those seeds/cards were found and doubly-verified (Python search
  cross-checked against `poker_hand.cairo`'s test vectors, then the
  resulting deck positions
  independently confirmed again via a genuinely-run Cairo
  `scarb test -- -t unit` scratch check).

## What's NOT covered (known gaps, deliberately left for time)

- `privacy_invoke` reentrancy specifically (the mock's reentrancy hook is
  only wired into `transfer_from`, not `balance_of`/`approve` — round 5
  formally proved this path safe by other means, so it wasn't prioritized).
- Fuzz tests (`#[fuzzer(...)]`) on numeric inputs — the `cairo-testing`
  skill recommends these; none written yet.
- The below-threshold constructor zero-`pool` gap — there's no assertion
  to test against since it isn't fixed (would need
  `#[should_panic]`-free "accepts zero, documents current behavior"
  framing if added).
- Multi-table / multi-seat stress scenarios beyond the two-seat fixtures
  `helpers.cairo` sets up.
- `advance_street` bet-matching/turn-order enforcement — there isn't any to
  test yet (see `docs/DESIGN.md` open items).
