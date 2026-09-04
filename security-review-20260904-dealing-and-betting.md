# Security review — dealing, showdown scoring, betting rounds, verifier adapter

> **SUPERSEDED** by `security-review-20260904-round8-four-agent.md`, which
> ran the proper `cairo-auditor` 4-agent vector scan once the skill bundle
> was reinstalled. All three findings below were independently re-confirmed
> as fixed there, and the scan found six more. Kept for the record.

**Date:** 2026-09-04
**Scope:** the 1,585 lines added on 2026-09-03/04 — `cairo/src/lib.cairo`'s
dealing/settlement/betting additions, `cairo-verifier/src/{dleq,adapter,card_table}.cairo`.
**Method:** manual review partitioned by the same four vectors the project's
`cairo-auditor` process uses (access control · external calls + reentrancy ·
math + economics · storage + trust).

**⚠️ This was NOT run with `cairo-auditor`.** That skill lives in the
`starknet-skills` bundle, which `HANDOFF.md` §2 records as missing on this
machine and which is still missing. This review is one reviewer's pass, not
the 4-agent parallel vector scan rounds 1–7 used. **It should be re-run with
the real tooling before this contract goes anywhere near real value.**

Both P1/P2 findings below were **demonstrated with proof-of-concept tests
that passed against the vulnerable code** before being fixed and inverted
into regression tests — not asserted from reading.

---

## Findings

### 1. [P1, confidence 90] — FIXED. `open_deck` griefing bricks a hand permanently

`open_deck` was callable by anyone, one-shot, and took the deck positions as
a **caller-supplied parameter** without checking they covered the seats and
board actually in play.

The deck travels in public calldata, so **any observer can construct a valid
opening proof.** A griefer submits one opening a single irrelevant position.
`deck_opened` flips true, the real positions are never stored, and from then
on:

- `open_deck` refuses to run again (`DECK_ALREADY_OPENED`), and
- every `reveal_community_card` / `reveal_hole_card` fails
  `POSITION_NOT_OPENED`.

The hand can never reach showdown. `settle_from_reveals` cannot run. The pot
is stranded until `reclaim_stalled_bet`'s 24-hour timeout. Cost to the
attacker: one transaction, no stake at the table.

**Fix applied:** positions are now **derived on-chain** from `max_seats`
(`2*max_seats` hole slots then 5 community slots). The caller supplies only
ciphertexts, in canonical order, and a wrong-length array is rejected. A
partial open is no longer expressible.

Regression: `test_open_deck_partial_open_is_unexpressible`.

### 2. [P2, confidence 88] — FIXED. The last player in a hand could fold and strand the pot

`fold` checked seat ownership and turn order but not how many players were
left. The last remaining player — who has already **won** — could fold,
dropping the contender count to zero. `settle_from_reveals` then reverts with
`NO_CONTENDERS` and nobody can collect; the pot waits for the reclaim
timeout.

Reachable in two hands of play: A bets, B folds, A folds.

Mostly a foot-gun (a UI would not offer the button), but it is also a way to
burn a pot deliberately, and `reclaim_stalled_bet` only returns each seat its
own contribution — so a player who was losing can deny the winner their
profit at no cost beyond their own already-committed stake.

**Fix applied:** `assert(active_count > 1)` in `fold`.

Regression: `test_last_player_cannot_fold`.

### 3. [P3, confidence 70] — FIXED. External verifier calls without the reentrancy lock

`open_deck`, `reveal_community_card` and `reveal_hole_card` all call out to
the verifier contract and none took `reentrancy_lock`, while `bet`,
`settle_table`, `settle_table_by_hand`, `settle_from_reveals` and
`privacy_invoke` all guard it (rounds 3 and 4).

Not currently exploitable: the verifier address is **constructor-pinned**, so
unlike `bet`'s `table_token` it is not caller-controlled, and the reachable
reentrant writes are idempotent. Rated P3 on that basis rather than dismissed
— an inconsistent guard is what a later change turns into a real finding, and
round 4 finding 2 added exactly this guard to `settle_table` for the same
reason.

**Fix applied:** all three now take and release the lock around the external
call, matching `bet`.

---

## Below confidence threshold — not fixed

### 4. [confidence 60] `reveal_hole_card` is callable by anyone

It verifies the commitment but does not check the caller is the seat owner.
Anyone who learned a player's shares and blinding factor could force their
hand to be shown, defeating the voluntariness of mucking.

Not fixed because it is not currently reachable: the commitment covers the
player's **own** decryption share, which no other party can compute (that is
the same fact that makes hole cards private at all), plus a blinding factor.
Restricting to the seat owner would still be stricter and costs one line —
worth doing if the commitment scheme ever changes.

### 5. [confidence 50] Raising after a round completes reopens it

Nothing stops a player acting again once `round_complete` is true but before
`advance_street` runs. A raise bumps the epoch and reopens the action, so a
player could stall a street indefinitely.

This is self-limiting — every raise costs real money and forces the raiser to
risk it — and min-raise rules are a game-design feature, not a security
control. Documented rather than fixed.

---

## Verified sound (checked, no finding)

- **`bet`'s reentrancy lock still releases.** The bet-matching code added
  today sits inside the lock; `reentrancy_lock.write(false)` remains the last
  statement.
- **`award` cannot credit note id 0.** `join_table` writes `seat_note` and
  `seat_owner` together under the same key with no early return between, and
  `is_active` requires a non-zero owner — so every contender has a real note.
- **`settle_from_reveals` takes no caller-controlled input.** Contenders are
  derived by walking seats; cards come from storage written only after
  verifier confirmation; payout notes come from `seat_note`. There is nothing
  to steer, which is what makes it safe for anyone to call.
- **`claimed_card` is checked, not trusted**, in three independent places:
  the verifier recomputes `m = c2 − D` and compares to the encoding table,
  `card_x` returns 0 for out-of-range indices and the caller rejects 0, and
  `assert_valid_deck_cards` re-checks range and distinctness at settlement.
- **The adapter binds public inputs.** A cryptographically valid proof from
  another table or an earlier round is rejected because the returned public
  inputs are compared against what `PokerGame` supplied from storage.
  Demonstrated on devnet: flipping one bit of the claimed deck hash turns
  `true` into `false`.
- **Position arithmetic cannot overflow.** `max_seats ≤ 23`, so
  `2*max_seats + 5 ≤ 51` and `k*4 ≤ 204`.
- **Pot split conserves.** `share = pot / n`, `remainder = pot − share*n`,
  remainder to the first winner (round 1 finding 4) — reused unchanged from
  `settle_table`.
- **`advance_turn` terminates.** Bounded by `max_seats` iterations; a table
  with no active seat leaves the turn unchanged rather than spinning.

---

## Pre-existing, out of scope, still open

- **The joint key is dealer-supplied.** `begin_shuffle` takes `joint_pk_x/y`
  as parameters and never checks they equal `Σ seat_pk`. Players verify
  off-chain. Now fixable — `cairo-verifier/src/adapter.cairo` exists and can
  do curve arithmetic — but not addressed here.
- **`initial_commitment`** is dealer-supplied the same way.
- **No accusation path.** A party who withholds a decryption share deadlocks
  the hand with no on-chain evidence of who did it.
- **`n`-of-`n` liveness.** One player disconnecting freezes community reveals
  permanently; timing them out does not produce their share.
