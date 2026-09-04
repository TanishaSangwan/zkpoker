# Security review, round 8 — four-agent vector scan

**Date:** 2026-09-04
**Scope:** the full `PokerGame` surface, with emphasis on the ~1,600 lines
added on 2026-09-03/04 (dealing, showdown scoring, betting rounds) plus
`cairo-verifier/src/{dleq,adapter,card_table}.cairo`.
**Method:** `starknet-skills:cairo-auditor`, four agents in parallel over
the project's standard vectors — access control · external calls and
reentrancy · math and economics · storage and trust — then merged and
deduplicated by root cause.

This supersedes `security-review-20260904-dealing-and-betting.md`, which
was a single manual pass run while the skill bundle was missing. All three
findings from that pass were independently re-confirmed as fixed here.

**Every finding below was demonstrated with a proof-of-concept test that
passed against the vulnerable code before being fixed and inverted into a
regression test.** Two of them (B and D) had an existing test asserting the
*buggy* behaviour as intended; those tests are inverted, not deleted.

179 tests pass.

---

## Findings

Ranked by merged severity. "Confidences" lists the independent scores the
agents that raised each one gave it.

### A. [P1, 90/88/85] `join_table` was ungated on hand state — FIXED

Every betting-round predicate derives membership from `seat_owner`:
`is_active()`, `round_complete()` and `settle_from_reveals`'s contender
walk all count any seat with a non-zero owner. A late joiner who simply
never acted made `round_complete()` false forever, so `advance_street`
reverted permanently, showdown became unreachable, and money already in
`table_pot` could only be resolved by the dealer's trusted `settle_table`
or the 24-hour refund.

One transaction. No funds, no cards, no key, repeatable on any table with a
free seat.

**Fixed:** seats freeze once the table is settled, voided, shuffling, or
holding a pot. Regression: `test_cannot_join_once_the_pot_is_live`.

### B. [P1, 88/86/82] `settle_from_reveals` gave every loser a free veto — FIXED

It asserted that every contender had revealed both hole cards. A player who
simply did not show — mucking, or going offline — reverted settlement for
everyone and stranded the pot until the reclaim timeout. A player who knew
they had lost could therefore deny the winner their profit at no cost.

**Fixed:** mucking forfeits rather than blocks. An unrevealed seat is
skipped and the pot goes to the best hand among those who showed. Tracked
with a parallel `revealed_flags` array rather than a score-0 sentinel,
since 0 is a reachable score. Settlement still reverts if *nobody* showed.

Regressions: `test_settle_from_reveals_mucking_forfeits_it_does_not_veto`
(inverted from `..._unrevealed_contender_rejected`, which encoded the bug),
`test_settle_from_reveals_all_muck_rejected`.

### C. [P0, 85/80] Reclaiming a stake was a free option — FIXED

`reclaim_stalled_bet` withdrew a seat's contribution from the pot but never
removed the seat from the hand — no `seat_folded` write, so `is_active()`
still counted it and every settlement path still treated it as a contender.
The timeout runs from `table_created_at`, not from the last action, so any
table older than 24 hours qualifies while play is still going on.

Take your money back, keep your claim on the pot: lose the hand and you
lost nothing, win it and you collect the rest of the pot on top of the
refund. The PoC played it end to end — ALICE reclaimed her 1,000, still
held the action, and was still awarded the remaining 1,000.

**Fixed:** reclaiming folds the seat. Deliberately *no* `active_count > 1`
guard of the kind `fold` has — this is the escape hatch from a stalled
table and must always work, and a table where everyone reclaims ends with
an empty pot, so nothing is stranded. `settle_table` additionally refuses
to name a folded seat as a winner, closing the dealer half of the path.

Regression: `test_reclaim_forfeits_the_hand`.

### D. [P1, 78/68] `begin_shuffle` could exclude a seated player from the joint key — FIXED

It built the participant list by taking whoever happened to have registered
a key and silently skipping the rest. That was written as a liveness
property — a keyless seat should not block the chain forever — but the
dealer picks the moment it fires.

Calling `begin_shuffle` one block before a player registers excluded them
from the joint key while leaving them seated: still dealt hole cards at
positions `2*seat` and `2*seat+1`, still an active seat for betting, still
a contender at showdown. Their cards are then encrypted under a key made
only of the *other* players' shares — the participants can collectively
read the excluded player's hand, and the excluded player cannot read their
own. In the limit where only the dealer registers, the dealer alone knows
the whole deck: exactly the trusted dealer this protocol exists to remove.

**Fixed:** every seated player must have registered before the chain can
start. Combined with A, `participants == seated players` is now an
invariant for the whole hand rather than a snapshot of one moment.

Regression: `test_begin_shuffle_requires_every_seated_player_to_have_a_key`
(inverted from `test_begin_shuffle_skips_seats_without_keys`).

### E. [P2, 76/72] Winnings were paid into a note that can never be filled — FIXED

`award()`, `settle_table` and `settle_table_by_hand` all credited
`seat_note`, the note_id supplied at `join_table` — documented as the
player's **encrypted** hole-card note. Open vs. encrypted is fixed when a
note is created at the pool layer, so it can never become the OPEN note
`privacy_invoke`'s `OpenNoteDeposit` has to fill. The pot was credited to a
note nothing could pay out.

Round 9's `register_payout_note` was added for exactly this, but both
settle paths assert `payout_note_ids[i] == seat_note` — so the fix was
unreachable from the moment it landed.

**Fixed:** `bind_payout_note(table, seat, note)` binds an open note to a
seat, and a single `payout_note_of()` helper (bound note if set, else
`seat_note`) is what all three settlement paths read, so they cannot drift
apart again. Seat-owner-only, refused after settlement, and subject to the
same `register_note_id_owner` rule as every other note path. Seats that
never bind keep the old behaviour exactly.

Regressions: `test_winnings_follow_the_bound_payout_note`,
`test_unbound_seat_still_paid_into_seat_note`,
`test_bind_payout_note_by_non_seat_owner_rejected`,
`test_bind_payout_note_cannot_steal_someone_elses_note`.

### F. [P2, 78] Betting-round state mutators ignored the reentrancy lock — FIXED

`bet()` holds `reentrancy_lock` across its token transfer while it is
midway through writing street, turn and epoch state, but `advance_street`,
`fold` and `check` — which mutate exactly that state — never looked at the
lock. A token that is also the table's dealer (a setup
`test_bet_reentrancy_blocked` already establishes as arrangeable) advanced
the street from inside `transfer_from`, so `bet()` finished by crediting
`street_contributed` to the street that had just ended.

**Fixed:** all three check the lock. Checked, not held — none of them makes
an external call. Regression: `test_advance_street_during_bet_blocked`.

### G. [P2, adjacent observation] A table whose seat 0 was empty was unplayable — FIXED

`action_turn` was never initialised, so it sat at storage-default seat 0.
`assert_on_turn` compares against it literally, and everything that moves it
(`mark_acted`, `fold`, `reset_turn`) is reachable only from an on-turn
action or from `advance_street`, which needs `round_complete`. So on a table
whose seat 0 was never occupied, every seat was permanently off-turn and
nobody could bet, check or fold — from creation.

**Fixed:** `join_table` points the turn at the lowest occupied seat, the
same rule `reset_turn` applies at every street start. Regression:
`test_table_without_seat_zero_is_playable`.

### H. [P3, 65] Shuffle entrypoints called the verifier with no lock — FIXED

`register_shuffle_key` and `submit_shuffle` were the last two external-call
paths without the guard. `submit_shuffle` is the one that matters:
`deck_commitment` and `shuffle_turn` — the chain head itself — are written
after the verifier call returns.

Not currently exploitable (the verifier address is constructor-pinned, so
unlike `bet`'s `table_token` it is not caller-controlled), but every other
call-out path takes the lock and an inconsistent guard is what a later
change turns into a real finding. **Fixed:** both now take and release it.

### I. [P0 on re-rating, 62 as filed] The deck could not be opened at all against the real verifier — FIXED

Filed as "`create_table` accepts a `max_seats` the pinned circuit can't
verify" and scored below threshold. It is worse than that, and it was
introduced by this round's own fix to A's sibling finding.

`circuits/deck_open` fixes `K = 5` at compile time, so its Garaga verifier
exposes exactly `1 + K + 4K = 26` public inputs. Deriving the position set
from `max_seats` (the anti-griefing fix) made the contract's input vector
`1 + k + 4k` long for `k = 2*max_seats + 5` — 46 values on a two-seat
table. The adapter compares lengths before anything else, so `open_deck`
could never succeed on **any** table. Only `MockShuffleVerifier`, which
ignores its inputs, hid it.

Raising `K` does not work either: garaga 1.1.0 caps a verifier at 99 public
inputs, so `1 + 5k <= 99` allows `k <= 19` — seven seats.

**Fixed:** `open_deck` takes a chunk index and proves `DECK_OPEN_K`
positions at a time, strictly in order; one circuit serves every table
size. A final partial chunk repeats the last in-play position, which the
circuit proves like any other slot and which rewrites an identical value.
The anti-griefing property is unchanged — positions are still fully
derived, `chunk` is checked rather than trusted, and `deck_opened` only
flips once the last chunk lands, so stopping halfway leaves the hand
recoverable by anyone rather than bricked.

Verified against the real artifacts rather than by arithmetic:
`circuits/deck_open_verifier/example_proof/calldata_array.txt` declares 26
public inputs over 52 felts — `deck_hash` (lo,hi), positions 0..4, then 20
card limbs — byte for byte the vector the contract now builds.

Regression: `test_open_deck_partial_open_is_unexpressible` extended to
cover chunk skipping and half-open state.

---

## Re-confirmed as still fixed

All four agents independently re-verified that rounds 1–7's fixes hold, and
that the three findings from the earlier manual pass are complete:
`open_deck`'s derived positions, `fold`'s `active_count > 1` guard, and the
reentrancy locks on the three reveal paths.

## Below threshold — not fixed, documented

- **`reveal_hole_card` is callable by anyone** (confidence 60). It verifies
  the commitment but not that the caller owns the seat. Not reachable: the
  commitment covers the player's own decryption share, which no other party
  can compute — the same fact that makes hole cards private at all — plus a
  blinding factor. One line stricter if the commitment scheme ever changes.
- **Raising after a round completes reopens it** (confidence 50).
  Self-limiting: every raise costs real money and forces the raiser to risk
  it. Min-raise rules are game design, not a security control.

## Still open — pre-existing, out of this round's scope

- ~~**The joint key is dealer-supplied.**~~ **CLOSED 2026-09-04, after this
  review.** `VerifierAdapter::verify_joint_key` sums the registered shares on
  Grumpkin and `begin_shuffle` asserts on it. See PROTOCOL.md §10. Finding D
  is what made the check meaningful: the summed set is exactly the seated
  set, so a dealer can neither impose a key nor quietly leave a player out
  of it.
- ~~**`initial_commitment` is dealer-supplied**~~ **CLOSED 2026-09-04, after
  this review.** The parameter is gone; the contract pins
  `INITIAL_DECK_COMMITMENT`. Shuffles only permute and re-randomise, so the
  multiset of cards in play is whatever the starting deck held — a dealer
  colluding with the first shuffler could have stacked it. See PROTOCOL.md
  §10.
- **No accusation path.** A party who withholds a decryption share deadlocks
  the hand with no on-chain evidence of who did it.
- **`n`-of-`n` liveness.** One player disconnecting freezes community
  reveals permanently; timing them out does not produce their share.
