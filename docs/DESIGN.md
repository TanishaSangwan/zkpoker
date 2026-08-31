# STRK[20] Provably Fair On-Chain Poker — design (V1)

Hackathon target: https://strk20.starknet.io/hackathon
RFP: https://strk20.starknet.io/rfp/private-poker

This is the V1 scope only. The RFP's V2 (Noir + Garaga mental poker, no
trusted dealer) is explicitly "aspirational" and is out of scope for the
hackathon window — call it out as the roadmap, don't attempt it here.

## What "provably fair" means in V1

No shuffle-correctness STARK circuit. Instead: **commit-reveal**.

1. Dealer commits `seed_hash = H(seed)` on-chain (`commit_deal`) before any
   card is dealt.
2. Hole cards are dealt off-chain as STRK20 encrypted notes — one note per
   seat, encrypted to that player's channel key, created via the pool's
   normal `CreateEncNote` action (phase 5 in the STRK20 phase table). The
   `PokerGame` contract does not see or touch card content; it only records,
   on-chain, which `note_id` went to which seat (`join_table` / `mark_dealt`).
3. At showdown, the dealer reveals `seed` (`reveal_seed`). The contract
   checks it against the stored `seed_hash`.
4. Anyone — not just the players — can now run `scripts/deal_verify.py` with
   the revealed seed and recompute the exact deal, then diff it against the
   seat -> note_id mapping that was public on-chain the whole time. If the
   dealer dealt something other than what the seed implies, this tool proves
   it, after the fact.

This is weaker than a STARK-proven shuffle (it requires the seed to be
revealed at all, and trusts the dealer not to have a way to bias the
commit/reveal gap), but it ships in a hackathon window and every claim it
makes is independently checkable. The natural hardening path (V1.5): prove
in-circuit that the committed seed deterministically produces the claimed
deal, so the pool itself rejects a bad `reveal_seed` instead of merely
letting observers catch it after the fact.

## Privacy boundary (per the RFP's visibility table)

| Element | Status | How |
|---|---|---|
| Hole cards | Hidden | Encrypted STRK20 notes, one per seat |
| Player identity | Hidden | Paymaster-submitted actions; the pool's relayer address is what appears on-chain, never the player's wallet |
| Bet amounts | **Public** (by design) | `bet`/`fold` calls and the running pot are plain on-chain state — poker needs public pot math |
| Stack / session history | Hidden | Buy-ins are shielded notes; only the owning player's viewing key can read a stack size |
| Showdown reveal | Public, selectively | Only the revealed `seed` and the winners' cards become public; folded players' hole cards never have to be revealed |

## Contract (`cairo/src/lib.cairo`)

`PokerGame` implements the STRK20 anonymizer pattern (`privacy_invoke`) plus
table/betting bookkeeping:

- `create_table` / `join_table` — table setup, seat reservation, hole-card
  note_id recording.
- `commit_deal` / `mark_dealt` / `reveal_seed` — the commit-reveal fairness
  flow above.
- `bet` / `fold` — pot accounting, gated by `advance_street`'s
  PreFlop/Flop/Turn/River/Showdown structure (round 6). `advance_street`
  doesn't enforce that every active seat matched the current bet before
  moving on — a real betting-round structure, not yet a fully-enforced
  betting engine.
- `settle_table` — splits a table's pot across winners' *open notes* (a note
  that skips amount encryption, so a payout amount produced by contract logic
  after proving can be filled in — see the `strk20-privacy` skill's notes on
  open notes) and records what's owed per `note_id`. Still takes a trusted
  winner list as input.
- `settle_table_by_hand` (round 6) — the on-chain-showdown alternative: given
  each non-folded seat's revealed hole cards and the 5 revealed community
  cards, computes every seat's best 5-of-7 hand via the `poker_hand` module
  and pays the pot to the actual strongest hand(s), splitting ties. Removes
  "trust the dealer's claimed winner"; does NOT yet remove "trust that the
  submitted cards are the cards actually dealt" — see "Hand evaluation"
  below and the open items list.
- `privacy_invoke` — the pool's phase-7 (`InvokeExternal`) hook. Pays out
  exactly what `pending_payout[note_id]` says is owed, then clears it. This
  differs from the starter kit's echo-helper demo (which just grabs "whatever
  balance we're holding") because a real poker contract holds several
  tables' funds concurrently — payouts must be tracked per note, not per
  balance.

Everything in the contract is unaudited scaffolding. Run the
`cairo-auditor` skill (from `starknet-skills`) on it before it ever touches
a real pool or real funds, and use `cairo-contract-authoring` /
`cairo-testing` while filling in the TODOs.

## Hand evaluation (`cairo/src/poker_hand.cairo`, round 6)

Standard Texas Hold'em hand ranking as pure functions — `evaluate_5` (score
one 5-card hand) and `best_of_7` (best 5-of-7, trying all 21 combinations).
Higher score wins; ties compare exactly (category, then up to 5 tie-break
ranks). This is the one piece of Cairo logic in this whole project that is
**genuinely unit-tested and verified**, not just carefully written: it has
zero dependency on storage, external calls, or `snforge` (no cheat codes or
contract deployment needed to test pure functions), so Scarb's own bundled
`cairo_test` runner exercises it for real —

```bash
cd cairo && scarb test -- -t unit
```

— 19 tests, every hand category plus tie-break edge cases (wheel straight,
flush-beats-straight, kicker comparisons, full-house trip-rank ties), all
passing. Contrast with `cairo/tests/` (the contract-level integration
tests), which needs `snforge` and has never run in this environment — see
"Test suite" below.

**What `settle_table_by_hand` does and doesn't guarantee.** It removes
"trust the dealer's claimed winner" — the winner is a deterministic
function of the submitted cards, checkable by anyone re-running
`poker_hand::best_of_7` on the same inputs. It does **not** remove "trust
that the submitted hole cards are the cards actually dealt to that seat" —
nothing on-chain today ties a submitted hole card back to the seed
commitment (`reveal_seed`) the way `deal_verify.py` does off-chain. Closing
that gap needs the shuffle-from-seed algorithm to move on-chain too (see
open items below) so `settle_table_by_hand` could assert a submitted card
matches the seat's position in the committed-and-revealed deck.

## Buy-in, betting, payout flow (SDK / wallet side)

- **Buy-in**: player shields USDC into the pool as a note at sit-down
  (`strk20-wallet-api` shield action, or `strk20-privacy-sdk` `deposit()` if
  you're holding keys server-side).
- **Actions**: `bet` / `fold` / `commit_deal` / `reveal_seed` calls are
  submitted paymaster-side so the submitting address is never the player's
  wallet — read per-player activity off this contract's own events, never
  off the transaction envelope.
- **Payout**: `settle_table` + `privacy_invoke` land in the same batched
  transaction as the winner's `CreateOpenNote` action (phase 6 before
  phase 7), matching the "at most one invoke, and it comes after the open
  note exists" rule in the STRK20 phase table.

## Security review

Ran the `cairo-auditor` skill (4-agent vector scan) against `lib.cairo` on
2026-08-30 — 2 Critical, 1 High, 1 Medium, 1 below-threshold Low, all rooted
in the contract trusting caller-supplied identity instead of anything pinned
in storage. Full report: `../security-review-20260830-194015.md`.

**Fixed:** `privacy_invoke` now checks a `pool` address pinned by the
constructor (not the caller-supplied `pool_address` argument) and binds each
payout to the token `settle_table` recorded for it; `create_table` records a
per-table `dealer`, and `settle_table` requires the caller to be that dealer
and checks `payout_note_ids` against real seat ownership; a reentrancy lock
guards `privacy_invoke`'s external `balance_of` call; the integer-division
remainder in `settle_table` no longer gets stranded.

**Follow-up fix (same day):** added a `seat_owner` map — `join_table`
records the joining caller, and `bet`/`fold` now require the caller to match
it. `commit_deal`/`mark_dealt`/`reveal_seed` now require the caller to match
`table_dealer`. All previously-unauthorized game-state entrypoints are now
caller-checked.

**Re-audit (2026-08-30):** ran `cairo-auditor` again against that follow-up.
Confirmed holding, no bypass: the `seat_owner`/`table_dealer` identity
checks (including the zero-address-default question above — a real caller
can never be the zero address, so it fails closed), and the `privacy_invoke`
reentrancy lock (traced concretely; fully closes the prior double-spend
window). But surfaced **2 new Critical findings**:

1. The `seat_owner` check gates *identity*, not *value* — a self-dealt table
   (attacker is both dealer and sole seat-owner) could still call `bet` with
   an arbitrary amount, since it only did `table_pot += amount` with no real
   transfer, then drain the fabricated payout via `privacy_invoke` against
   the contract's shared per-token balance.
2. `pending_payout`/`payout_token` are keyed by bare `note_id` with no
   `table_id`, and `join_table` accepted any caller-supplied `note_id` with
   no ownership check — so an attacker could register a victim's real
   `note_id` on their own throwaway table and hijack (freeze or
   redenominate) that note's payout.

**Fixed:** `bet` now calls `erc20.transfer_from(caller, this, amount)` before
crediting `table_pot` (requires the caller to have approved this contract);
`join_table` now binds each `note_id` to whoever registers it first via a
`note_id_owner` map, and `settle_table` cross-checks it before honoring a
payout.

Also flagged, below the audit's confidence threshold at the time:
- No recovery path if a dealer goes dark mid-table — later escalated, see
  round 3 below.
- The constructor doesn't reject a zero `pool` address — still not fixed
  (below threshold; self-inflicted deploy-time misconfiguration only, not
  attacker-reachable).

**Round 3 re-audit:** confirmed rounds 1-2's identity/reentrancy fixes hold.
Found **2 new Critical, 1 High, 1 Medium** — full detail in
`../security-review-20260830-205751.md`:

1. `note_id_owner` fixed *identity* reuse of a `note_id` but not *token*
   reuse — `settle_table` unconditionally overwrote `payout_token[note_id]`,
   so settling the same `note_id` at a second table in a different token
   silently relabeled an accumulated (possibly fabricated) balance into
   that token. **FIXED**: `settle_table` now asserts
   `existing_pending == 0 || existing_token == token` before rewriting
   `payout_token`.
2. Round 2's `bet` fix meant real funds now sit in `table_pot` until
   `settle_table` runs, which escalated the "no dealer recovery path" item
   above from a hardening note to a Critical: an abandoned/malicious dealer
   could permanently lock real bettor funds. **FIXED** (user chose
   "timeout-based self-refund" among 3 options): new `reclaim_stalled_bet`
   entrypoint lets a seat reclaim exactly what it personally contributed
   (tracked via `seat_contributed`) once `SETTLE_TIMEOUT_SECS` (24h) has
   passed since `create_table` and the table isn't `table_settled`.
3. `bet()`'s `transfer_from` call had no reentrancy lock and credited
   `table_pot` only after the call returned. **FIXED**: `bet` now takes the
   shared `reentrancy_lock` for its full body.
4. `bet()` trusted the nominal `amount` parameter instead of the actual
   balance delta (fee-on-transfer token risk). **FIXED**: measures
   `balance_of` before/after `transfer_from`, credits the real delta.

**Round 4 re-audit** (targeted at round 3's new `reclaim_stalled_bet` code):
confirmed rounds 1-3 hold — `reclaim_stalled_bet`'s identity/timeout/
double-reclaim/reentrancy guards, and `table_pot == Σ seat_contributed`
proven to hold by induction across every bet/reclaim interleaving. Found
**2 more Critical** — full detail in `../security-review-20260831-090322.md`:

1. Neither `bet()` nor `settle_table()` checked `table_settled` — a bet
   could land after a table settled (permanently unreclaimable, since
   `reclaim_stalled_bet` is itself blocked by `table_settled`), and
   `settle_table` could be called a second time. **FIXED**: both now assert
   `!table_settled` at entry.
2. `settle_table` was excluded from the shared `reentrancy_lock` even
   though it mutates the same state `bet`/`reclaim_stalled_bet`/
   `privacy_invoke` guard — a dealer-controlled token could reenter it
   mid-`bet()`, settling a stale pot before the in-flight bet's
   contribution landed. **FIXED**: `settle_table` now asserts
   `!reentrancy_lock` at entry (checks, doesn't need to hold, the lock —
   it makes no external calls itself).

**Round 5 re-audit** (genuinely fresh pass across all four partitions, not
just re-verification): confirmed every round 1-4 fix holds with no bypass
or regression — `reentrancy_lock` formally proven to never persist as
`true` across a transaction boundary, and `settle_table`'s payout math
proven correct even with duplicate seats/note_ids in one call. **First
round to find no new Critical or High.** One long-standing below-threshold
item finally crossed the confidence bar — full detail in
`../security-review-20260831-091541.md`:

1. `privacy_invoke`'s `approve()` return value was unchecked — a token
   returning `false` instead of reverting could mark a payout as sent with
   no real allowance granted, permanently unrecoverable. **FIXED**: now
   asserts the return value, matching the pattern already used for
   `transfer_from`/`transfer` elsewhere in the file.

**Still open** (below round 5's confidence threshold, not attacker-
exploitable, not yet fixed):
- The constructor doesn't reject a zero `pool` address (Low severity,
  self-inflicted misconfiguration only — would brick the whole contract's
  payouts if deployed wrong, but no attacker can trigger it post-deploy).

Five rounds in, the security surface has narrowed to one accepted
low-severity gap.

**Round 6 is feature work, not yet audited.** After round 5, three things
were added without a follow-up `cairo-auditor` pass: the `reveal_seed`
Poseidon fix (small, see below), multi-street betting (`advance_street`,
plus a new `bet` guard), and `settle_table_by_hand` (a substantial new
entrypoint reusing `settle_table`'s security patterns but genuinely new
code — array-input handling, score comparison, a second pot-distribution
path). Treat all of round 6 as unaudited. `settle_table_by_hand` in
particular is the highest-value target for a round 7 sweep: it's the
newest, largest, most structurally different addition since round 1.

## Test suite

Written (`cairo/tests/*.cairo`, `cairo/src/mocks.cairo`) following the
`cairo-testing` skill's coverage rules and the "Required Tests" lists from
all five security-review reports — full lifecycle, betting, and settlement
coverage, including a dedicated regression test per historical finding
(value fabrication, fee-on-transfer, cross-table note_id/token hijacking,
reentrancy on both `bet` and `settle_table`, pool spoofing, unchecked
approve, etc.).

**Not yet run.** This machine has no `snforge` (no Windows binary; building
from source needs a Rust toolchain that isn't installed either) — see
`cairo/tests/README.md` for the full explanation and exact setup steps for
whoever runs it next. The tests were authored carefully and re-read
multiple times (one real bug was caught this way — see the README), but
are unverified until an actual `snforge test` run.

## `reveal_seed` commitment hash

Fixed (post round 5): `reveal_seed` previously compared the revealed seed
against its own commitment with a literal identity check
(`computed_hash = seed`) — any seed "verified" against itself, so
`commit_deal` carried no real cryptographic binding at all, despite reading
as a normal commit-reveal scheme. Now uses
`core::poseidon::poseidon_hash_span(array![seed].span())`. `commit_deal`'s
interface doc comment in `cairo/src/lib.cairo` specifies the exact
construction any off-chain dealer tooling must match when computing
`seed_hash` to submit. `cairo/tests/test_lifecycle.cairo`'s commit/reveal
tests were updated to commit the real hash instead of the raw seed.

Deliberately unchanged: this hashes the seed alone, no `table_id` or other
domain separator mixed in. A dealer reusing the identical seed value across
two tables produces the same commitment for both — harmless, since
`seed_hash` is stored per `table_id` and there's no cross-table lookup that
could confuse the two; it would just be a dealer mistake, not something
another party could exploit.

## Open items (in priority order for the hackathon)

1. Round 7 `cairo-auditor` sweep covering round 6 (Poseidon fix,
   multi-street betting, `settle_table_by_hand`) — the biggest unaudited
   surface in the contract right now.
2. Get `snforge` running (Linux/Mac/WSL — see `cairo/tests/README.md`) and
   actually run the test suite (`cairo/tests/`, now including
   `test_hand_eval.cairo`'s streets/settle_table_by_hand coverage); fix
   whatever the first real compile/run surfaces. (`poker_hand`'s own unit
   tests already run and pass today — see "Hand evaluation" above.)
3. Move the shuffle-from-seed algorithm on-chain (Poseidon-based
   Fisher-Yates, replacing `deal_verify.py`'s Python `random.Random` stand-
   in) so `settle_table_by_hand` can eventually verify a submitted hole
   card actually matches the committed-and-revealed deck, not just trust
   the dealer's submission. Two birds: this is also the long-standing
   "swap `deal_verify.py`'s PRNG" item.
4. Bet-matching / turn-order enforcement for `advance_street` — currently
   a dealer can advance streets without every active seat having called
   the current bet.
5. Frontend: wire `PokerGame` actions into the starter-kit UI
   (`src/app/components`), replacing the echo-helper demo flow.
6. Generalization write-up for the pitch: the "card-as-encrypted-note +
   commit-reveal deal" pattern applies to Battleship, Mafia, and sealed-bid
   auctions, per the RFP's own framing — worth a slide, not more code.
