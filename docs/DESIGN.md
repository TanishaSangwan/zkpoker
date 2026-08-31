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

— 24 tests, every hand category plus tie-break edge cases (wheel straight,
flush-beats-straight, kicker comparisons, full-house trip-rank ties), plus
(added round 7) `assert_valid_deck_cards`'s range/distinctness checks, all
passing. Contrast with `cairo/tests/` (the contract-level integration
tests), which needs `snforge` and has never run in this environment — see
"Test suite" below.

**What `settle_table_by_hand` does and doesn't guarantee.** It removes
"trust the dealer's claimed winner" — the winner is a deterministic
function of the submitted cards, checkable by anyone re-running
`poker_hand::best_of_7` on the same inputs. As of round 7 it also rejects
cards that couldn't come from a real deck (out-of-range or duplicated —
`assert_valid_deck_cards`, called before any scoring). **As of round 8, it
also removes "trust that the submitted cards are the cards actually
dealt"**: it requires `reveal_seed` to have run (`SEED_NOT_REVEALED`
otherwise), recomputes `shuffle::shuffled_deck(revealed_seed)`, and checks
every submitted card against its canonical position in it —
`CARD_MISMATCH` on any disagreement (seat *N*'s hole cards must be the
deck's values at positions `2N`/`2N+1`; community cards must match
positions `2*max_seats..2*max_seats+5` in order). A submission now has to
be the actual committed-and-revealed deal, not merely a plausible-looking
one — this is the full provenance fix the RFP's "provably fair" claim
needs, closing what round 7 left open.

## Deck shuffle from seed (`cairo/src/shuffle.cairo`, round 8)

The on-chain half of the "swap `deal_verify.py`'s PRNG" item: a Poseidon-based
Fisher-Yates shuffle, pure function, same testing story as `poker_hand.cairo`
(genuinely run via `scarb test -- -t unit`, no `snforge` needed) —

- `shuffled_deck(seed: felt252) -> Array<u8>` — the full 52-card deck (values
  0-51), deterministically shuffled from `seed`. Each Fisher-Yates draw is
  `poseidon_hash([seed, step]) % bound` (`step` = the current shuffle
  position, so consecutive draws in one shuffle never collide); not
  rejection-sampled (a plain `%` has a small modulo bias), an accepted
  simplification at 52 elements, consistent with V1's overall commit-reveal
  model rather than a cryptographically airtight RNG.
- Tested directly: `shuffled_deck` produces a genuine permutation (every
  value 0-51 appears exactly once, not just "52 elements"), is deterministic
  for a given seed, and differs across seeds — 4 tests, all passing.
- **Cross-verified against Python, not just self-consistent.** `poseidon-py`
  (a small prebuilt-wheel PyPI package, no native/Rust toolchain needed —
  `starknet-py` was tried first and abandoned: its dependency resolution
  hung for 20+ minutes on this Windows machine without ever starting a
  download, a known pain point with its native-extension dependencies) gave
  a pure-Python `poseidon_hash_many` to check against. Two Cairo regression
  tests pin this: `poseidon_vector_check.cairo` (a raw `poseidon_hash_span`
  call vs. a Python-computed vector) and `shuffle_vector_check.cairo` (a
  full `shuffled_deck(42)` output, all 52 cards, vs. the same computation
  ported to Python) — both passing, so this isn't "should match", it's
  checked. `scripts/deal_verify.py`'s `seeded_shuffle` is now that same
  Python port (previously `random.Random(seed)`, an explicit stand-in) —
  see that file's own docstring.

**Seat-count concept (also round 8, follow-up pass).** Wiring the shuffle
into `settle_table_by_hand` needs a fixed seat -> deck-position convention
(e.g. seat *N*'s hole cards at positions `2N`/`2N+1`, community cards after
all seats' hole-card slots), which needs the contract to know how many
seats a table has. It didn't (`seat` was an arbitrary `felt252`, not a
dense 0..N-1 index) — now it does:

- `create_table` takes a new `max_seats: u32` argument, stored per
  `table_id` (`table_max_seats`, readable via `get_table_max_seats`).
  Rejected (`BAD_MAX_SEATS`) if zero or over `MAX_TABLE_SEATS` (23 — the
  largest seat count that still leaves room for 5 community cards after
  every seat's 2 hole cards in a 52-card deck: `2*23+5 = 51 <= 52`).
- `join_table` rejects (`BAD_SEAT`) any `seat` that doesn't parse as a
  `u32`, or parses fine but is `>= max_seats`. This is what guarantees
  every taken seat on a table is a genuine dense index — the actual
  precondition the shuffle-position check will need.
- This is a **breaking interface change**: every `create_table` call site,
  including all of `cairo/tests/`, now passes `max_seats` — updated (with
  new regression tests for `BAD_MAX_SEATS`/`BAD_SEAT`) but, like the rest
  of that suite — now executed and passing (see "Test suite" below).

**Wired into `settle_table_by_hand` (round 8, same session, follow-up
pass).** The module and the seat-index precondition above both now feed a
real check: `settle_table_by_hand` requires `reveal_seed` to have run
(`SEED_NOT_REVEALED` otherwise), recomputes
`shuffle::shuffled_deck(revealed_seed)`, and asserts every submitted card
matches its canonical position (`CARD_MISMATCH` otherwise) — see "Hand
evaluation" above for the full writeup. The shuffle-from-seed item, across
this round's whole arc (shuffle module, seat-count concept, this wiring),
is now **closed** at the contract level.

`cairo/tests/test_hand_eval.cairo`'s `settle_table_by_hand` tests were
reworked to match: hand-picked cards would now fail `CARD_MISMATCH` before
ever reaching scoring, so the clear-winner and tie tests now use real
cards derived from an actual committed/revealed seed. Finding a seed that
produces a clean win (and, separately, an exact tie) for a specific
2-seat deal isn't something to guess by hand, so both were found by
brute-force search over seeds in Python — reusing the same verified
Poseidon shuffle as the cross-checks above, plus a Python port of
`poker_hand.cairo`'s exact scoring algorithm that was itself cross-checked
against `poker_hand.cairo`'s own test vectors (wheel straight, full-house
tie-break, `best_of_7` category selection, etc.) before being trusted for
the search. The resulting deck positions were then independently
confirmed a second way — by calling `shuffle::shuffled_deck` directly in a
genuinely-run `scarb test -- -t unit` scratch test — before being baked
into the `snforge`-only test file (see that file's own header for the
regenerate-if-needed Python snippet). Two new regression tests
(`SEED_NOT_REVEALED`, `CARD_MISMATCH` on a wrong hole card and separately
a wrong community card) cover the new checks directly. Like the rest of
`cairo/tests/`, these now run and pass (see "Test suite") — the deck-math
inputs are independently verified, the `snforge` test flow itself isn't.

## Buy-in, betting, payout flow (SDK / wallet side)

- **Buy-in**: player shields USDC into the pool as a note at sit-down
  (`strk20-wallet-api` shield action, or `strk20-privacy-sdk` `deposit()` if
  you're holding keys server-side).
- **Actions**: `bet` / `fold` / `commit_deal` / `reveal_seed` calls are
  submitted paymaster-side so the submitting address is never the player's
  wallet — read per-player activity off this contract's own events, never
  off the transaction envelope. In practice `bet` moves funds via a plain
  ERC20 `approve`/`transfer_from` (see "Privacy boundary" above — bet
  amounts are intentionally public), so it's a normal contract call, not an
  STRK20 wallet-action.
- **Payout**: `settle_table` + `privacy_invoke` land in the same batched
  transaction as the winner's `CreateOpenNote` action (phase 6 before
  phase 7), matching the "at most one invoke, and it comes after the open
  note exists" rule in the STRK20 phase table.

  **Resolved design question (found + closed, round 9): option (a) — the
  winner pre-registers a payout note before settlement.** The STRK20
  wallet-action pattern most examples show (`strk20-wallet-api` skill's
  private-defi reference, and the starter kit's own echo-helper demo)
  creates the open note *and* invokes the helper in the *same*
  transaction — the invoke's calldata references `${openNoteIds[0]}`, a
  note id the wallet generates fresh, right then. But
  `settle_table`/`settle_table_by_hand` record `pending_payout` keyed by a
  `note_id` the *dealer* chooses, in an *earlier*, separate transaction —
  so the dealer's choice and a later fresh `${openNoteIds[0]}` would never
  naturally match.

  Two things made option (a) — decouple note creation from the claim,
  across two transactions — checkable rather than a guess: `notes-and-
  nullifiers.md` shows `note_id = h(NOTE_ID_TAG, channel_key, token,
  index, 0)` and that an open note's amount is `0` "while awaiting
  deposit" — so a bare `CreateOpenNote` with no paired invoke is a
  complete, self-contained, zero-funded action (nothing to balance to
  zero within that transaction, satisfying the phase table's per-token
  invariant on its own), not something that needs bundling with a
  same-transaction fill. And `actions-and-proofs.md`'s phase table already
  allows a transaction to consist of *just* `InvokeExternal` (phase 7) —
  no `CreateOpenNote` in the same transaction is required, since a
  transaction "may skip phases". So: create the note in one transaction
  (alone), invoke against its already-known id in a separate, later one.

  What was missing on the *contract* side, not just the frontend: the only
  way to write `note_id_owner` (which `settle_table`'s own
  `payout_note_ids[i]` check requires) was `join_table`, coupled to taking
  a seat — a player reserving a note purely for payout, independent of any
  seat, had no way to register it. **Fixed**: `register_payout_note(note_id)`
  — same `NOTE_ID_TAKEN` protection as `join_table`'s note registration,
  factored into a shared internal helper (`register_note_id_owner`), no
  seat or table involved. A hole-card note can't be reused for this either
  way — it's an *encrypted* note (`CreateEncNote`), and open-vs-encrypted
  is fixed at note creation via the salt, so it can never later become an
  open note `privacy_invoke`'s `OpenNoteDeposit` can fill.

  The resulting flow: (1) the intending winner submits a standalone
  `CreateOpenNote` action; (2) they read the resulting note_id from their
  *wallet's own* activity/notes view — this dApp deliberately can't
  compute or list it itself, since that needs the private `channel_key`
  STRK20 keeps inside the wallet, never exposed to a dApp; (3) they call
  `register_payout_note(that_note_id)` and give the same value to the
  dealer; (4) the dealer uses it in `payout_note_ids[i]` when settling;
  (5) later, the winner claims with a bare `invoke` action (no paired
  `CreateOpenNote` this time — the note already exists) naming that same
  literal `note_id`, not `${openNoteIds[0]}`. See `/poker`'s "Reserve a
  payout note" and "Claim a payout" sections
  (`src/app/poker/PokerPanel.tsx`) and HANDOFF.md for the implementation
  detail, including what's still unverified against a live pool (step 2's
  wallet-side discoverability — plausible from the deterministic note_id
  derivation, but not tested against a real wallet in this environment).

## Frontend (`src/app/poker/`, round 9)

Drives `PokerGame` directly — every contract entrypoint has a form, plus a
"Load table" panel reading all `get_*` views at once. Deliberately an
operator/admin-style panel (raw felt/hex inputs, comma-separated lists),
not a polished poker-table UI with rendered cards — matches this project's
existing `WalletAccountV6Tag.tsx` demo's own aesthetic and is a defensible
scope for a hackathon frontend pass on top of everything else already
built. Cards accept rank+suit notation (`"As"`, `"Th"`, `"2c"`) or a plain
0-51 index, matching `scripts/deal_verify.py`'s convention.

- `src/utils/pokerGameAbi.ts` — the real compiled ABI from
  `cairo/target/dev/zkpoker_PokerGame.contract_class.json`, copied in (not
  hand-written) and diffed byte-for-byte against that file to confirm the
  transcription was exact, not eyeballed. Regenerate the same way if the
  contract's interface changes.
- `src/app/poker/pokerActions.ts` — pure contract-call wiring, separate
  from the UI: builds `Call`s via `starknet.js`'s `CallData.compile`
  against that ABI, computes `commit_deal`'s Poseidon hash client-side
  (`hash.computePoseidonHashOnElements`, verified during this session to
  match Cairo's `core::poseidon::poseidon_hash_span` exactly, single- and
  two-element cases both cross-checked in Cairo tests), and does the
  felt/card-notation parsing.
- `src/app/poker/PokerPanel.tsx` — the actual UI: table lookup/state,
  create/join, bet+approve (one multicall)/fold, dealer actions
  (commit/mark-dealt/reveal/advance-street), both settle paths, reclaim,
  reserve-a-payout-note + register (round 9), and claim.
- Every ABI type was runtime-verified against `starknet.js`'s `CallData`
  (including the unusual `Span<(u8,u8)>` `settle_table_by_hand` needs) —
  see HANDOFF.md for the exact checks run.
- `PokerGame` isn't deployed anywhere yet (`cairo/address.md`) — the page
  shows a clear "not deployed on this network" banner
  (`NEXT_PUBLIC_POKERGAME_MAINNET`/`_SEPOLIA`, both default `0x0`) rather
  than failing silently, same pattern as the starter kit's own echo-helper
  gating.
- **Not wired**: hole-card encryption (the STRK20 `CreateEncNote` action,
  "phase 5") — `join_table`'s `hole_card_note_id` is entered manually, with
  an in-UI explanation of what would normally produce it. Needs the pool
  live plus real `strk20-privacy-sdk` integration; out of scope for this
  pass.
- Verified: `npx tsc --noEmit` clean, a full `next build --webpack`
  succeeds (including static generation of `/poker`), and the dev server
  actually serves both `/` and `/poker` with 200s and no compile/runtime
  errors in the server log — checked directly (`curl` + the dev server's
  own log), not assumed. Not checked: an actual browser session (no
  Chrome-extension connection available in this environment) or any call
  against a real deployed contract, since none exists yet.

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

**Round 6** added three things after round 5: the `reveal_seed` Poseidon
fix (see below), multi-street betting (`advance_street`, plus a new `bet`
guard), and `settle_table_by_hand` (a substantial new entrypoint reusing
`settle_table`'s security patterns but genuinely new code).

**Round 7 re-audit** (targeted specifically at round 6's additions, not a
full-repo scan) — full detail in `../security-review-20260831-120606.md`:
confirmed `advance_street`/`settle_table_by_hand`'s dealer gating, zero
external calls, `table_street` single-writer status, and the pot-splitting
conservation identity all hold with no bypass. Found **1 Medium**:

1. Neither `settle_table_by_hand` nor `poker_hand::evaluate_5` checked
   submitted cards were real (`< 52`) or distinct — a dealer could
   fabricate an impossible hand (duplicate card values, or an out-of-range
   value silently folded by `% 13`) to steer the on-chain-computed winner.
   Didn't grant new *power* (the dealer already controls `settle_table`'s
   trusted winner list), but undermined `settle_table_by_hand`'s specific
   "checkable by anyone" claim. **FIXED**: new
   `poker_hand::assert_valid_deck_cards` (range + pairwise-distinct check
   over the full community+hole card set), called before any scoring.

Six/seven rounds in, the security surface has narrowed to one accepted
low-severity gap (round 5's constructor zero-`pool` item) plus whatever a
future audit finds in code written after round 7.

## Test suite

Written (`cairo/tests/*.cairo`, `cairo/src/mocks.cairo`) following the
`cairo-testing` skill's coverage rules and the "Required Tests" lists from
all five security-review reports — full lifecycle, betting, and settlement
coverage, including a dedicated regression test per historical finding
(value fabrication, fee-on-transfer, cross-table note_id/token hijacking,
reentrancy on both `bet` and `settle_table`, pool spoofing, unchecked
approve, etc.).

**Runs and passes: 102/102** (2026-08-31, Linux with snforge 0.63.0):

```bash
cd cairo && snforge test --features testing   # 30 from src/, 72 from tests/
```

`--features testing` is required — it gates `cairo/src/mocks.cairo`. The
suite went unexecuted for its whole authoring life (written on Windows,
where snforge ships no binary). On first execution two structural bugs had
to be fixed — `mocks` was `#[cfg(test)]`-gated (invisible to snforge's
separate integration-test crate, and never compiled to a declarable
contract class), and the events weren't `pub` (edition 2024_07 defaults
items and fields private, so `assert_emitted` couldn't see them). **No
test's logic or assertions needed changing, and nothing failed once it
compiled.** See `cairo/tests/README.md` for the full writeup and the
remaining coverage gaps (no fuzz tests, no `privacy_invoke`-specific
reentrancy test, no multi-table stress).

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

1. ~~Get `snforge` running and actually run the test suite~~ — **DONE**
   (2026-08-31). 102/102 pass via `snforge test --features testing`; see
   "Test suite" above for the two structural bugs the first run surfaced.
   **Still open from this item:** the coverage gaps `cairo/tests/README.md`
   lists — no fuzz tests, no `privacy_invoke`-specific reentrancy test, no
   multi-table stress. "102 passing" means every test that exists passes,
   not that coverage is complete.
2. ~~Shuffle-from-seed on-chain~~ — **DONE (round 8)**. The module, the
   seat-count concept it needs, and the `settle_table_by_hand` wiring that
   actually checks submitted cards against the seed-derived deck are all
   in place — see "Deck shuffle from seed" above. This was the last piece
   of the provenance gap (round 7 fixed card *validity/distinctness*, not
   *provenance*); it's now closed at the contract level, and its
   `cairo/tests/` coverage now runs and passes (item 1). What remains is
   an audit pass: round 8's checks have never been through cairo-auditor.
3. Bet-matching / turn-order enforcement for `advance_street` — currently
   a dealer can advance streets without every active seat having called
   the current bet.
4. ~~Frontend: wire `PokerGame` actions into the starter-kit UI~~ —
   **DONE (round 9)**, at `/poker` (`src/app/poker/`) rather than replacing
   the original demo — see "Frontend" above. Every contract entrypoint has
   a form; verified via a clean `tsc`, a clean `next build`, and the dev
   server actually serving both pages with no errors. One thing this
   didn't close: hole-card encryption (`CreateEncNote`) isn't wired —
   needs the pool live plus real SDK integration.
5. Generalization write-up for the pitch: the "card-as-encrypted-note +
   commit-reveal deal" pattern applies to Battleship, Mafia, and sealed-bid
   auctions, per the RFP's own framing — worth a slide, not more code.
6. A round 8/9 *security* sweep is now ripe — round 8 added real
   access-control-shaped surface (`create_table`'s `max_seats` bound,
   `join_table`'s seat bound) and a new value-moving check
   (`settle_table_by_hand`'s card-position assertions); round 9 added
   `register_payout_note` (another `note_id_owner`-binding entrypoint,
   same shape as `join_table`'s). None of it has been through
   `cairo-auditor` yet.
7. ~~Resolve the payout-claim `note_id` design question~~ — **DONE
   (round 9)**: picked option (a) — see "Buy-in, betting, payout flow"
   above for the full resolution (`register_payout_note` plus the
   two-transaction reserve-then-claim flow). What's *not* independently
   verified: whether a real wallet's UI actually surfaces a freshly
   created open note's id the way step 2 of that flow assumes — plausible
   from the deterministic `note_id` derivation in `notes-and-nullifiers.md`,
   not tested against a live wallet.
