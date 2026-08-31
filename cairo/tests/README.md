# Test suite — RUNS AND PASSES (98/98, first executed 2026-08-31)

**Status: green.** The entire suite compiles and passes on Linux with
`snforge 0.63.0` / `scarb 2.18.0`:

```bash
cd cairo && snforge test --features testing
# Collected 98 test(s) from zkpoker package
#   Running 30 test(s) from src/     <- poker_hand, shuffle, vector checks
#   Running 68 test(s) from tests/   <- this directory
# Tests: 98 passed, 0 failed, 0 ignored, 0 filtered out
```

`--features testing` is **required** — it gates `../src/mocks.cairo` (see
"How it was unblocked" below). Without it, `cairo/tests/` cannot compile.

Note that **`snforge test` now runs the `src/` unit tests too** (the 30
`poker_hand`/`shuffle`/vector-check tests). The previously-documented
`scarb test -- -t unit` no longer collects them: with `snforge_std` present,
its `#[test]` attribute macro owns test collection and `cairo_test` sees
zero. One command covers everything now — prefer it. (`scarb test` on its
own fails, since it doesn't pass `--features testing` to the integration
crate.)

This suite (`helpers.cairo`, `test_lifecycle.cairo`, `test_betting.cairo`,
`test_settlement.cairo`, `test_hand_eval.cairo`, `../src/mocks.cairo`) was
written against the contract as of round 5 of the security review (plus
round 6's streets/`settle_table_by_hand` addition for `test_hand_eval.cairo`
specifically), following the `cairo-testing` skill's coverage rules and the
"Required Tests" lists from all five `../../security-review-*.md` reports.

**Every test was authored carefully against the actual contract, re-read
multiple times, and one real bug was caught and fixed this way** (both
reentrancy regression tests initially had the malicious token impersonate
a separate "MALLORY" identity, which would have hit the `NOT_SEAT_OWNER`/
`NOT_DEALER` check before ever reaching the `reentrancy_lock` check the
test was meant to isolate — fixed by having the token contract itself act
as the seat owner/dealer, matching the audit's own attack narrative).
**That careful authoring held up: on the first real execution, zero tests
failed.** Only the two structural/environment problems below had to be
fixed — no test's actual logic or assertions needed changing.

## How it was unblocked (history — was "never run" through 2026-08-31)

Originally written on Windows, where `snforge` ships no binary and building
it needed a Rust/cargo toolchain that wasn't installed, so the suite was
never executed or even compile-checked. On a Linux machine with `snforge`
already installed, two real bugs surfaced on the first run:

1. **`mocks` was `#[cfg(test)]`-gated** in `../src/lib.cairo`. snforge
   compiles `cairo/tests/` as a separate `zkpoker_tests` crate linked
   against `zkpoker` built **without** `cfg(test)`, so `use
   zkpoker::mocks::...` resolved to nothing (E0006) and cascaded into ~40
   spurious `<missing>`-type Drop/Copy errors across the suite. It would
   also have failed at runtime regardless: `declare("MockErc20")` needs a
   real compiled contract class in the package's `starknet-contract`
   target, which a `cfg(test)` module never produces. **Fixed** by gating
   it on a Scarb feature instead (`#[cfg(feature: "testing")]` +
   `[features] testing = []`), which keeps the mock out of the production
   build exactly as before — verified: `scarb build` emits only
   `PokerGame`, no `MockErc20`.
2. **Events weren't `pub`.** `PokerGame`'s `Event` enum, all 11 event
   structs, and all 27 of their fields were private (edition 2024_07
   defaults both items and struct fields to private), so every
   `assert_emitted` in this suite failed with E2099/E2059 "not visible in
   this context". **Fixed** by making them `pub` — a Cairo-level name
   visibility change only; emitted events were always public on-chain data.

The old Windows-era warning that adding `snforge_std` as a dev-dependency
breaks even a plain `scarb build` **does not reproduce here** (Linux has
the prebuilt plugin, so there's no `cargo fetch` fallback) — it's now a
normal dev-dependency in `cairo/Scarb.toml`, and `scarb build` was
re-verified clean with it present.

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
