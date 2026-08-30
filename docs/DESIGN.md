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
- `bet` / `fold` — pot accounting. **Multi-street betting and hand ranking
  are not implemented** — `settle_table` currently takes a trusted winner
  list as input. That's ordinary game logic to build next, not a privacy
  concern, and is intentionally left out of this skeleton.
- `settle_table` — splits a table's pot across winners' *open notes* (a note
  that skips amount encryption, so a payout amount produced by contract logic
  after proving can be filled in — see the `strk20-privacy` skill's notes on
  open notes) and records what's owed per `note_id`.
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

Also flagged, below the audit's confidence threshold, not yet fixed:
- No recovery path if a dealer goes dark mid-table or `pool` needs rotating
  — both are fixed forever at `create_table`/construction with no
  grant/rotate ABI, so a stuck dealer or a redeployed pool permanently stalls
  the affected table(s).
- The constructor doesn't reject a zero `pool` address — a deploy mistake
  would silently brick every `privacy_invoke` call.

**Still open** (tracked, not yet fixed):
- `approve()`'s return value is unchecked in `privacy_invoke` (Low severity,
  non-conforming-ERC20 edge case).
- The two below-threshold items just above (dealer/pool recovery path, zero
  `pool` guard).
- Re-run `cairo-auditor` again after any further change to `lib.cairo`, and
  once more before this goes anywhere near a real pool or real funds.

## Open items (in priority order for the hackathon)

1. Decide whether to fix the dealer/pool recovery-path gap and the
   zero-`pool` constructor guard now or accept them for the hackathon demo.
2. Pin the actual commitment hash in `reveal_seed` (currently a placeholder
   equality check) — Poseidon, to match what the pool itself hashes with.
3. Swap `deal_verify.py`'s PRNG for a Poseidon-based Fisher-Yates so the same
   computation is provable in-circuit later, not just reproducible off-chain.
4. Multi-street betting rounds + hand ranking for `settle_table`'s winner
   input.
5. Frontend: wire `PokerGame` actions into the starter-kit UI
   (`src/app/components`), replacing the echo-helper demo flow.
6. Generalization write-up for the pitch: the "card-as-encrypted-note +
   commit-reveal deal" pattern applies to Battleship, Mafia, and sealed-bid
   auctions, per the RFP's own framing — worth a slide, not more code.
