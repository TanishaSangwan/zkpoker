# zkpoker — Handoff

Read this before touching anything. It exists because this project changed
hands mid-session — a previous agent scaffolded and iterated on it, and this
doc is what a new agent (or human) needs to pick it up cold.

**Read `docs/DESIGN.md` next** — it has the architecture and the fairness
model in detail. This file is about *state and process*: what's been done,
what broke, what's still open, and what decisions are still pending.

---

## 1. What this project is

Hackathon entry for **https://strk20.starknet.io/hackathon**, answering the
**[Provably Fair On-Chain Poker RFP](https://strk20.starknet.io/rfp/private-poker)**.
Poker on Starknet using STRK20 (Starknet's privacy pool): hole cards as
encrypted notes, commit-reveal dealing (V1 — not yet the RFP's "aspirational"
V2 STARK-proven shuffle), paymaster-hidden player identity, private buy-ins
and payouts.

**Location:** `~/Documents/zkpoker` on Linux (was
`C:\Users\TANISHA\OneDrive\Desktop\zkpoker\` — if you find leftover
references to that path or to an earlier `strk20-poker` folder name, they're
stale; the project's real name is `zkpoker`, matching `package.json` and
`cairo/Scarb.toml`).

**Git:** on `main`, pushed to https://github.com/TanishaSangwan/zkpoker.
As of 2026-08-31: rounds 1-8 work, then the test-suite fix (48da45a), then
round 9's frontend + register_payout_note merged in from origin, then (this
Windows session, uncommitted as of this writing) round 10's hole-card
dealing (§4f). Don't commit without asking first.

**⚠️ Important caveat on "what's been checked":** rounds 1-5 scanned only
`cairo/src/lib.cairo` as it stood after round 5. Round 7 covered
`cairo/src/poker_hand.cairo` too (round 6's addition), explicitly
targeted rather than a full-repo scan. `cairo/src/mocks.cairo` has never
been audited and never will need to be under normal circumstances —
feature-gated (`testing`), never in the production build, low stakes, and
was deliberately excluded from round 7's scope for that reason. Nothing
outside `cairo/` — frontend, scripts, docs — has ever had a security
review. See §5's "Round 7" entry for exactly what it covered and found.

---

## 2. Environment / toolchain state

**As of 2026-08-31 this project is on a Linux machine (Kali), not the
original Windows one.** Everything below marked "Windows" is historical —
kept because the constraints matter if it ever moves back, but none of it
applies here. Current toolchain, all via **asdf**:

- `scarb 2.18.0` (pinned in `cairo/.tool-versions`; asdf shipped 2.20.0 by
  default, so 2.18.0 was installed explicitly with `asdf install scarb
  2.18.0` — without it every `scarb` call fails with "No version is set").
- `snforge 0.63.0` (asdf plugin `starknet-foundry`), plus `starknet-devnet
  0.9.0`, `cairo-coverage`, `cairo-profiler` in `~/.tool-versions`.
- `node v24.20.0` via **nvm at `~/.config/nvm`** (not the default `~/.nvm`).
  Non-login shells don't source it — if `npm`/`npx` is "not found", run
  `export NVM_DIR="$HOME/.config/nvm"; . "$NVM_DIR/nvm.sh"` first.

Historical (Windows):

- **Scarb 2.18.0** was installed at
  `%LOCALAPPDATA%\Programs\scarb\scarb-v2.18.0-x86_64-pc-windows-msvc\bin`,
  added to the **user** PATH (not system-wide). **Gotcha:** a shell that was
  already open when this was installed won't see it on PATH — open a new
  terminal, or reference the binary by full path.
- **Node v24.20.0**, npm installed (`npm install` done — 103 packages). One
  unaddressed `npm audit` finding: `sharp` has a high-severity libvips CVE,
  fix requires a breaking version bump — deliberately left alone so far.
- **Skills** (project-local, real content in `.agents/skills/`, with
  `.claude/skills/` holding relative symlinks into it for Claude Code —
  don't delete `.agents/skills/`). **These are tracked in git as of
  2026-08-31**, precisely because the untracked copies did not survive the
  Windows -> Linux move (see the missing bundle below). Reinstall/refresh
  with `npx skills add <source>`; `skills-lock.json` records source + hash.
  - **Present:** `strk20-privacy`, `strk20-anonymizer-contracts`,
    `strk20-privacy-sdk`, `strk20-wallet-api` — STRK20 concepts/SDK/wallet
    integration, from `welttowelt/strk20-skills`.
  - **⚠️ MISSING on this machine:** `starknet-skills` (Keep Starknet
    Strange) — the bundle containing `cairo-auditor`,
    `cairo-contract-authoring`, `cairo-testing`, `cairo-optimization`,
    `cairo-toolchain`, `account-abstraction`, `starknet-network-facts`. It
    was installed on the old Windows machine, was never committed, and is
    gone. **§5's audit procedure reads files out of
    `.agents/skills/starknet-skills/cairo-auditor/` and cannot run as
    written until this is reinstalled** — do that before attempting the
    round 9/10 audit that rounds 8 and 9 still need.
  - Skills installed mid-conversation don't show up in that session's
    "available skills" listing — the `Skill` tool call fails with "Unknown
    skill" until a fresh session. **Workaround used throughout this
    project:** read the skill's `SKILL.md` / `workflows/*.md` /
    `agents/*.md` files directly and follow them manually via `Agent` tool
    calls. See §5 for exactly how the audits were run — repeat that pattern.

---

## 3. What's built so far

```
zkpoker/
  cairo/src/lib.cairo          PokerGame contract — see §4/§5
  cairo/src/poker_hand.cairo    Texas Hold'em hand evaluation, pure functions.
                                 Genuinely unit-tested (24 tests, passing) via
                                 `scarb test -- -t unit` — see §4a. Part of
                                 the production build. NOT security-audited.
  cairo/src/shuffle.cairo       Poseidon-based Fisher-Yates deck shuffle from
                                 a seed. Pure functions, genuinely tested same
                                 way as poker_hand — see §4b. WIRED into
                                 settle_table_by_hand (§4c) — provenance gap
                                 closed, see §7 item 5.
  cairo/src/poseidon_vector_check.cairo,
  cairo/src/shuffle_vector_check.cairo
                                 #[cfg(test)]-only regression tests pinning
                                 Cairo's core::poseidon output against an
                                 independently-computed Python value — see §4b
  cairo/src/mocks.cairo         test-only mock ERC20, gated on the
                                 `testing` Scarb FEATURE (not #[cfg(test)]
                                 — that made cairo/tests/ uncompilable;
                                 see §4a), never in the production build
  cairo/Scarb.toml              package "zkpoker", scarb build succeeds
                                 clean. snforge_std IS a dev-dependency
                                 now (the old Windows blocker doesn't
                                 apply on Linux) and [features] testing
                                 gates mocks.cairo — see §4a
  cairo/tests/                  full contract-level test suite (incl.
                                 streets/settle_table_by_hand). RUNS AND
                                 PASSES — 102/102 with src/'s unit tests,
                                 via `snforge test --features testing`.
                                 See §4a and cairo/tests/README.md
  scripts/deal_verify.py        fairness-check CLI, tested working. Shuffle
                                 is now the same Poseidon Fisher-Yates as
                                 cairo/src/shuffle.cairo (was random.Random —
                                 see §4b); needs `pip install -r
                                 scripts/requirements.txt` (poseidon-py, a
                                 small prebuilt wheel, no native toolchain)
  docs/DESIGN.md                architecture, fairness model, security-review
                                 timeline (keep this updated as you go)
  security-review-*.md          one file per audit round (5 so far — round 6
                                 hasn't been audited yet), see §5
  HANDOFF.md                    this file
  src/app/page.tsx, .../WalletAccountV6Tag.tsx
                                 the ORIGINAL starter-kit demo UI
                                 (Akashneelesh/strk20-starter-kit), untouched
                                 except a nav link to /poker
  src/app/poker/                round 9: PokerGame's own frontend — see §4d.
                                 NOT the starter kit's page; a new route.
  src/utils/pokerGameAbi.ts,
  src/utils/erc20Abi.ts         ABIs used by src/app/poker/ — see §4d
```

`scarb build` in `cairo/` succeeds with **zero warnings** as of the last
edit. Always confirm this still holds after any change:

```bash
export PATH="$PATH:/c/Users/TANISHA/AppData/Local/Programs/scarb/scarb-v2.18.0-x86_64-pc-windows-msvc/bin"
cd cairo && scarb build
```

---

## 4. The contract's actual current state — READ THIS CAREFULLY

`PokerGame` in `cairo/src/lib.cairo` implements: table creation/joining,
commit-reveal dealing (`commit_deal`/`mark_dealt`/`reveal_seed`), bet/fold
pot accounting structured into PreFlop/Flop/Turn/River/Showdown streets
(`advance_street`, round 6), `reclaim_stalled_bet` (timeout-based refund for
an abandoned dealer), `settle_table` (trusted winner list) plus
`settle_table_by_hand` (round 6 — computes the winner on-chain via
`poker_hand::best_of_7` instead), and the STRK20 `privacy_invoke` payout
hook.

**It has been through seven audit rounds** (five on rounds 1-5's code,
round 7 targeted specifically at round 6's multi-street/hand-eval
addition). Every Critical/High finding across all seven has been fixed and
rebuilt clean. Round 8 (a previous session, after round 7, two passes) was
feature work, not an audit round — see §4b: the on-chain deck-shuffle
module, `create_table`/`join_table`'s new `max_seats`/seat-bound checks,
and (the second pass) wiring that shuffle into `settle_table_by_hand` so
it now checks submitted cards against the actual committed-and-revealed
deck (`SEED_NOT_REVEALED`/`CARD_MISMATCH`) — all real new
access-control/value-moving surface, unaudited — see §4b. Round 9 (same
prior session) was the frontend pass (§4d) plus one small contract
addition it required, `register_payout_note` (§4e) — likewise unaudited.
Round 10 (this session, on Windows, after pulling round 8/9 plus the
Linux-side test/bug-fix work — see §4f) wired hole-card encryption into
that same frontend, no contract changes. **One accepted
low-severity/below-threshold gap remains, plus one open item**: the
constructor doesn't reject a zero `pool` address (round 5), and
bet-matching/turn-order enforcement isn't implemented for `advance_street`.
The shuffle-provenance gap that was open through round 7 (hole cards
submitted to `settle_table_by_hand` not tied back to the seed commitment)
is now **closed** — round 8 built the shuffle module, the seat-count
precondition, and the `settle_table_by_hand` check itself, all three (see
§7 item 5). The payout-claim design gap found early in round 9 is also now
**closed** — see §4e. None of the remaining items are findings from any
audit round; all are documented open items — see §7. Regardless of audit
status: don't deploy any of this anywhere with real value without also
getting the test suite running (see §4a) and ideally a real, non-AI
security review before mainnet. The file's own
header comment (top of `cairo/src/lib.cairo`) is kept up to date with a
summary of this history — read it too.

### 4a. Test suite: RUNS AND PASSES — 102/102 (updated 2026-08-31, Linux)

**This section's old "written but never run" status is RESOLVED.** The full
suite — `cairo/tests/` included — compiles and passes on this Linux machine
(`snforge 0.63.0`, `scarb 2.18.0` via asdf):

```bash
cd cairo && snforge test --features testing
# Collected 102 test(s): 30 from src/, 72 from tests/
# Tests: 102 passed, 0 failed, 0 ignored, 0 filtered out
```

`--features testing` is mandatory (it gates `src/mocks.cairo`). Two real
structural bugs had to be fixed to get here — **no test's logic or
assertions needed changing, and nothing failed once it compiled**:

1. `mocks` was `#[cfg(test)]`-gated, but snforge builds `cairo/tests/` as a
   separate crate linked against `zkpoker` compiled *without* `cfg(test)`,
   so `zkpoker::mocks` didn't exist for it (and `declare("MockErc20")` would
   have had no compiled class even if it had compiled). Now gated on a
   Scarb feature (`#[cfg(feature: "testing")]` + `[features] testing = []`),
   which still keeps it out of the production build — verified: `scarb
   build` emits only `PokerGame`.
2. `PokerGame`'s `Event` enum, its 11 event structs, and their 27 fields
   weren't `pub` (edition 2024_07 defaults items *and* fields private), so
   every `assert_emitted` failed to see them. Now `pub` — a Cairo name
   visibility change only; events were always public on-chain.

`snforge_std` is now a normal dev-dependency; the Windows-era warning that
it breaks a plain `scarb build` does not reproduce on Linux (prebuilt
plugin, no `cargo fetch` fallback) — re-verified clean.

**Superseded:** `scarb test -- -t unit` (the old command below) no longer
collects anything — snforge's `#[test]` macro owns collection once
`snforge_std` is present, so `cairo_test` sees 0 tests. The 30 unit tests it
used to run are now part of the 102 above. Historical form:

```bash
cd cairo && scarb test -- -t unit   # now reports 0 tests — use snforge
```

The contract-level suite at `cairo/tests/` (+ `cairo/src/mocks.cairo` for a
configurable mock ERC20) follows the `cairo-testing` skill's coverage rules,
with a dedicated regression test per historical audit finding. All 68 of its
tests now pass alongside src/'s 30.

**Historical (Windows), kept so the constraint is understood if this moves
back to a machine without `snforge`:** the suite went unexecuted and not
even compile-checked for its whole authoring life, because Starknet Foundry
ships no Windows binary and building from source needs a Rust/cargo
toolchain that wasn't installed. `scarb build --test` was tried but needs
`snforge_std`'s companion compiler plugin, which had no prebuilt Windows
binary at the version tried and fell back to `cargo fetch` — blocked.
Adding `snforge_std` as a dev-dependency broke even the *plain* `scarb
build` there (Scarb resolves the full dependency graph regardless of
target). **None of that applies on Linux** — the prebuilt plugin exists, so
`snforge_std` is now a normal dev-dependency and `scarb build` stays clean.

What's covered vs. not: `cairo/tests/README.md`. Note the coverage gaps it
lists are still real (no fuzz tests, no `privacy_invoke`-specific reentrancy
test, no multi-table stress) — "102 passing" means every test that exists
passes, not that coverage is complete. Each test was authored carefully and
re-read multiple times, which held up: nothing failed on first execution
(one real bug had already been caught during writing:
both reentrancy regression tests initially had the wrong identity
impersonating the malicious token, which would have tripped the
`NOT_SEAT_OWNER`/`NOT_DEALER` check before ever reaching the
`reentrancy_lock` check being tested — fixed by having the token contract
itself act as the seat owner/dealer).

### 4b. Deck shuffle: also genuinely verified — and cross-checked vs. Python

`cairo/src/shuffle.cairo`'s `shuffled_deck(seed) -> Array<u8>` is the same
kind of pure-function module as `poker_hand.cairo` — no storage, no external
calls, tested for real via `scarb test -- -t unit` (4 tests: correct length,
genuine permutation of 0-51, deterministic per seed, differs across seeds —
all passing today).

What makes this one different from `poker_hand`: it also had to match a
second implementation exactly — `scripts/deal_verify.py`'s Python side needs
to reproduce the *identical* deck from a revealed seed, bit-for-bit, or the
"anyone can independently verify" claim in docs/DESIGN.md is false. That was
checked, not assumed:

1. `pip install starknet-py` (the obvious choice for a battle-tested
   Starknet Poseidon) hung for 20+ minutes resolving dependencies without
   downloading anything, on this Windows machine with no Rust/cargo
   toolchain (a known pain point — several of its native-extension deps
   need a compiler). Killed it; don't retry that package here without a
   Rust toolchain installed first.
2. `pip install poseidon-py` instead — small, prebuilt Windows wheel,
   installed in seconds, no native toolchain needed. `poseidon_py.
   poseidon_hash.poseidon_hash_many` is what `scripts/deal_verify.py` now
   uses (`scripts/requirements.txt` pins `poseidon-py==0.2.0`).
3. Two Cairo regression tests prove the equivalence rather than just
   assert it: `poseidon_vector_check.cairo` (Cairo's `core::poseidon::
   poseidon_hash_span` vs. a Python-computed vector for the same input) and
   `shuffle_vector_check.cairo` (the full 52-card `shuffled_deck(42)`
   output vs. the same shuffle ported to Python, run end-to-end — this one
   also exercises `shuffle.cairo`'s array-rebuild `swap` helper, not just
   the hash). Both pass. Regenerate either vector's expected value with the
   Python snippet in that Cairo file's own comment if you ever touch
   `shuffle.cairo` or bump `poseidon-py`.

**Seat-count concept added (same round 8, follow-up).** The shuffle module
needs a fixed seat -> deck-position convention to ever be checked against
(seat *N* at positions `2N`/`2N+1`), which needs the contract to know a
table's seat count — it didn't (`seat` was an arbitrary `felt252`). Now:
`create_table` takes `max_seats: u32` (nonzero, `<= MAX_TABLE_SEATS` = 23 —
`2*23+5=51<=52`, leaves room for 5 community cards), stored per table and
readable via the new `get_table_max_seats`; `join_table` rejects any `seat`
that doesn't parse as a `u32 < max_seats` (`BAD_MAX_SEATS`/`BAD_SEAT`,
respectively). **This is a breaking interface change** — every
`create_table` call site was updated, including all of `cairo/tests/`
(`helpers.cairo`'s new `TWO_SEATS` constant, plus new regression tests in
`test_lifecycle.cairo` for both new error paths). These were unexecuted
when written; they now run and pass with the rest of the suite (§4a).
The `felt252 -> u32` conversion logic was additionally verified directly
at the time, before `snforge` was available:
a throwaway `scarb test -- -t unit` check confirmed `try_into()` panics on
an out-of-`u32`-range felt252 and compares correctly in-range, matching
exactly what `join_table` relies on, before that scratch file was deleted.

### 4c. Provenance wiring: settle_table_by_hand now uses the real deck

Same round 8, second pass (still this session): `settle_table_by_hand` now
requires `reveal_seed` to have run for the table (`SEED_NOT_REVEALED`
otherwise), recomputes `shuffle::shuffled_deck(revealed_seed)`, and checks
every submitted card against its canonical position — seat *N*'s hole
cards must be the deck's values at positions `2N`/`2N+1` (either order),
and `community_cards[k]` must equal the deck's position `2*max_seats + k`
(`CARD_MISMATCH` on any mismatch). This is the actual provenance fix — see
`settle_table_by_hand`'s own doc comment in `lib.cairo` and
docs/DESIGN.md's "Deck shuffle from seed" section. **The shuffle-from-seed
item, across this whole round-8 arc, is now closed at the contract level.**

The hard part of this pass wasn't the contract code — it was that
`cairo/tests/test_hand_eval.cairo`'s existing `settle_table_by_hand` tests
all used hand-picked cards (e.g. "ALICE holds pocket aces"), which now fail
`CARD_MISMATCH` before ever reaching scoring, since they don't correspond
to any real seed's shuffle output. Rather than leave those tests broken or
delete the coverage, they were reworked to use **real cards derived from an
actual committed/revealed seed**:

1. Finding a seed that produces a clean win (and, separately, an exact
   tie) between two specific seats isn't guessable by hand — solved by
   brute-force search over seeds in Python, reusing the same
   already-verified Poseidon shuffle from §4b, plus a Python port of
   `poker_hand.cairo`'s exact scoring algorithm (category/tie-break rules,
   wheel-straight handling, `best_of_7`'s 21-subset search).
2. That Python scorer was cross-checked against `poker_hand.cairo`'s own
   test vectors (wheel straight, straight-flush-beats-quads, full-house
   trip-rank tie-break, `best_of_7` category selection) before being
   trusted for the search — same "verify, don't assume" standard as the
   Poseidon cross-check.
3. The winning seeds' resulting deck positions were then independently
   confirmed a **second, Cairo-only** way: a throwaway `scarb test --
   -t unit` scratch test called `shuffle::shuffled_deck` directly and
   asserted the exact card values at every relevant position, genuinely
   run and passing, before being deleted and the same values baked into
   the `snforge`-only test file. So the deck-math inputs to those tests
   are independently confirmed twice (Python + Cairo). The `snforge` test
   flow around them (dispatcher calls, cheat codes, event assertions) was
   unexecuted when written and now runs and passes — see §4a.
4. `helpers.cairo` gained a shared `seed_hash_of` helper (previously only
   `test_lifecycle.cairo` had a local copy) since `test_hand_eval.cairo`
   now needs it too for `commit_deal`.
5. Two new regression tests cover the new checks directly:
   `test_settle_table_by_hand_seed_not_revealed_rejected` and
   `test_settle_table_by_hand_wrong_hole_card_rejected` /
   `..._wrong_community_card_rejected` (a real, distinct-but-wrong card
   substituted for one real card — distinguishes this from the round-7
   `assert_valid_deck_cards` check, which those wrong cards would still
   pass).

If you touch `shuffle.cairo`'s algorithm or `poker_hand.cairo`'s scoring,
the baked-in seeds/cards in `test_hand_eval.cairo` may need regenerating —
see that file's own header comment for the exact Python snippet.

**Follow-up, same session: `max_seats != 2` coverage gap closed.** Every
test above (and everywhere else in `cairo/tests/`) used a 2-seat table, so
nothing exercised `settle_table_by_hand`'s `community_start = 2*max_seats`
arithmetic at any other size — a subtle off-by-one specific to a
non-2 `max_seats` could have slipped through. Closed with
`test_settle_table_by_hand_three_seat_table`: a real 3-seat table (ALICE/
BOB/new fixture `CAROL()`), same verification standard as above (a 3-seat
deal for the same seed as the clear-winner scenario — `shuffled_deck`
depends only on the seed, not on how many seats it gets sliced for, so
seat0/seat1's cards are identical to the 2-seat case; only seat2's cards
and the shifted `community_start` are new — independently confirmed via
another throwaway `scarb test -- -t unit` scratch check before being
baked in). `helpers.cairo` gained `CAROL()`, `SEAT_2`, `NOTE_C`, and
`THREE_SEATS` for this.

**If you run `cairo-auditor` again**, note that its file-discovery
(`find ... -name "*.cairo"`) will now also pick up `cairo/src/mocks.cairo`
— it's `#[cfg(test)]`-gated and never in the production build, but the
auditor doesn't know that distinction. Either mentally discount findings
scoped to that file, or pass `cairo/src/lib.cairo` explicitly as the
target instead of a full-repo scan.

### 4d. Frontend (round 9): `/poker` drives PokerGame directly

New session, new round number (9 — round 8 was all Cairo; this is the
first frontend work). `src/app/poker/` is a genuinely functional, verified
frontend for every `PokerGame` entrypoint — deliberately an operator/admin
panel (raw felt/hex fields, comma-separated lists for `settle_table_by_hand`),
not a polished poker table with rendered cards. That's a scope call, not a
shortcut forced by running out of time — see docs/DESIGN.md's "Frontend"
section for the reasoning.

**Files**: `src/utils/pokerGameAbi.ts` (the real compiled ABI, copied from
`cairo/target/dev/zkpoker_PokerGame.contract_class.json` and diffed
byte-for-byte to confirm — not eyeballed), `src/utils/erc20Abi.ts` (minimal,
for the bet-approval flow), `src/utils/constants.ts` (extended:
`pokerGameAddressForIndex`, `defaultPokerToken` — same "0x0 = not deployed"
pattern as the existing `echoHelperForIndex`), `src/app/poker/pokerActions.ts`
(pure contract-call wiring — no React), `src/app/poker/PokerPanel.tsx` (the
actual UI, ~750 lines, one file — matches `WalletAccountV6Tag.tsx`'s own
monolithic-component convention rather than over-fragmenting into many small
files), `src/app/poker/page.tsx` + `PokerPageClient.tsx` (route shell — split
in two because Next.js route `metadata` exports need a server component, and
the actual UI needs `"use client"`), `src/app/poker/poker.module.css`.

**Real bug caught and fixed while building this** (worth knowing about if
you write more React here): a `useSection()` helper was first written as a
function *defined inside* `PokerPanel`'s own body that itself called
`useState` — a nested "hook" that violates the Rules of Hooks (React
requires hooks to be called from a stable, top-level location; a hook
defined inside another component's render function is recreated every
render and is explicitly called out as invalid in React's own docs). It
happened to still work by luck here (11 call sites, always in the same
order, every render), but was refactored out anyway: a module-level plain
async function `runAction(setResult, ...)` that calls no hooks itself,
paired with 11 directly-declared `useState` calls in the component body.
Also caught: a genuinely broken placeholder (`tableTokenOf`) left over from
realizing mid-write that `PokerGame` has no `get_table_token` view — fixed
by having the Bet section's token field just reuse `ctToken` from Create
Table instead of trying to read something that isn't there. **Neither of
these was caught by `tsc` or the Next.js build** — both are logic bugs a
type-checker can't see; they were caught by re-reading the code, the same
standard applied to the Cairo side all session.

**Verification actually run** (all in this session, not assumed):
- Diffed the transcribed ABI against the real compiled JSON via `node`
  (`JSON.stringify` equality) — exact match.
- Compiled representative calls (`create_table`, `bet`, and specifically
  `settle_table_by_hand`'s unusual `Span<(u8,u8)>` hole-cards parameter)
  through `starknet.js`'s real `CallData.compile` — all produced correct
  Cairo calldata (length-prefixed spans, tuples flattened correctly).
- Verified `starknet.js`'s `hash.computePoseidonHashOnElements` matches
  Cairo's `core::poseidon::poseidon_hash_span` for the single-element case
  `commit_deal`/`reveal_seed` actually use (the two-element case was
  already confirmed in round 8) — via a throwaway
  `js_poseidon_scratch.cairo` test, genuinely run and passing, then
  deleted, same pattern as every other cross-language check this session.
- Verified `shortString.encodeShortString('TABLE_1')` produces the exact
  same felt as Cairo's `'TABLE_1'` short-string literal (hand-computed the
  ASCII hex and compared).
- `npx tsc --noEmit` clean across the whole project.
- `npm run build` (`next build --webpack`) succeeded, including static
  generation of `/poker`.
- Started the dev server, `curl`'d both `/` and `/poker` — HTTP 200, no
  error markers in the HTML, no compile/runtime errors in the server log.
  **No actual browser was used** — the Chrome extension wasn't connected in
  this environment (`tabs_context_mcp` returned "Browser extension is not
  connected"). If you have it available, a real click-through is still
  worth doing; HTTP-level checks don't catch every possible runtime issue
  (e.g. a hook order bug that only manifests on a specific interaction
  path, though the one found above was caught by reading, not running).
- No ESLint config exists in this starter kit at all (`next lint` /
  `npx eslint` both fail — no `eslint.config.*`) — this predates round 9,
  not something broken by it. Manually re-verified Rules-of-Hooks
  compliance by reading every hook call site instead (see the bug above).

Also not done: hole-card encryption (`CreateEncNote`) — `join_table`'s
`hole_card_note_id` field is manual entry with an explanatory note, since
wiring the real thing needs the STRK20 pool live plus real
`strk20-privacy-sdk` integration, out of scope for this pass.

### 4e. Payout-claim design gap: RESOLVED (round 9, option (a))

The gap described in the original round-9 pass (a dealer-chosen
`payout_note_ids[i]` had no way to match the fresh `${openNoteIds[0]}` a
wallet generates at claim time) is now closed — the user picked option (a):
the winner pre-registers a payout note before settlement. Full reasoning
in docs/DESIGN.md's "Buy-in, betting, payout flow" (the "Resolved design
question" paragraph); short version of what changed:

- **Contract** (`cairo/src/lib.cairo`): new entrypoint
  `register_payout_note(note_id)` — binds `note_id_owner[note_id]` to the
  caller, same `NOTE_ID_TAKEN` "first registration wins" rule as
  `join_table`'s own note_id binding, but standalone (no seat, no
  `table_id`). The shared logic was factored into an internal (not
  embedded, not part of `IPokerGame`) `#[generate_trait]` helper,
  `register_note_id_owner` — `join_table` now calls it too instead of
  duplicating the zero-check/assert. New event: `PayoutNoteRegistered`. 4
  new tests in `cairo/tests/test_lifecycle.cairo` (success + event,
  `NOTE_ID_TAKEN` by a different owner, same-owner idempotent re-register,
  and cross-use with `join_table`'s own registration). These now run and
  pass — they were part of the merge that brought the suite to 102/102
  (§4a). One fix was needed: `PayoutNoteRegistered` was declared without
  `pub`, which the tests can't construct for `assert_emitted`; made `pub`
  like every other event.
- **Frontend** (`src/app/poker/PokerPanel.tsx`): a new "Reserve a payout
  note" section (create a standalone open note via a bare `CreateOpenNote`
  STRK20 action, then `register_payout_note` it — two steps, two separate
  transactions, deliberately not combined since the UI can't itself learn
  the note_id from the first one — see below), and the "Claim a payout"
  section was rewritten: no more paired `transfer OPEN` +
  `${openNoteIds[0]}`; now a bare `invoke` action naming the literal,
  already-registered `note_id` directly.
- **What made option (a) more than a guess**: `notes-and-nullifiers.md`
  (the `strk20-privacy` skill) shows `note_id` is fully deterministic
  (`h(NOTE_ID_TAG, channel_key, token, index, 0)`) and that an open note's
  amount is `0` "while awaiting deposit" — so a bare, unfunded
  `CreateOpenNote` is a complete, self-balancing action on its own (the
  phase table's per-token invariant needs nothing paired with it), and
  `actions-and-proofs.md`'s phase table already allows a transaction to be
  *just* `InvokeExternal` (phases may be skipped). Both are exactly what
  option (a)'s two-separate-transactions shape needs — checked against the
  actual skill references, not assumed.
- **What's still NOT independently verified**: whether a real wallet's own
  UI actually surfaces a freshly created open note's id the way the
  "Reserve a payout note" section's step 2 assumes (read it from your
  wallet's activity view, since this dApp deliberately can't compute or
  list it itself — that needs the private `channel_key` STRK20 keeps
  inside the wallet). This is plausible given the deterministic derivation
  above, but nothing in this session touched a real wallet to confirm it
  — flagged in-UI (the caution box in that section) rather than assumed
  solved.

### 4f. Hole-card encryption: wired (round 10) — with the same class of caveat

**Context on where this session picked up**: the previous session's own
final status report said "here's what's left" and this Windows machine had
just pulled the Linux-side work (98/98 -> 102/102 tests, the
`deal_verify.py` deck-position bug fix, the V2 spec, skills tracked in
git). This session immediately hit a real, current blocker: `scarb build`
fails on THIS machine (`error: could not execute process: cargo fetch` —
no Rust toolchain) because the Linux commit made `snforge_std` an
unconditional dev-dependency, which is fine on Linux (prebuilt plugin) but
not on Windows (same class of problem `cairo/tests/README.md` already
documented once). **Unresolved as of this section** — flagged to the user,
not fixed unilaterally (reverting would break the Linux setup if they pull
again). If you're reading this on Windows and `scarb build` fails the same
way, this is why; see if a decision got made (install Rust here, or treat
Windows as frontend-only) before assuming it's still broken.

The user then asked for item 4 of that status report specifically: wire
`CreateEncNote` for hole cards. Same research-first approach as the
payout-note gap (§4e) — checked every installed skill reference
(`strk20-privacy`, `strk20-privacy-sdk`, `strk20-wallet-api`,
`strk20-anonymizer-contracts`) for a documented way to encode non-monetary
data (a card pair) into a note. **None exists** — `CreateEncNote` only
ever appears naming the phase, never with a worked example of carrying
arbitrary data. So this project had to invent one:

- `packHoleCards(card1, card2) = card1*52 + card2` (range `0..2703`,
  `pokerActions.ts`) — **this project's own convention, not a sourced
  STRK20 pattern.** Say so if you build on it elsewhere.
- Sent as a real transfer of that many units (dust — at most 2703 in the
  token's smallest unit) of the table's own token: `Deposit` (phase 3,
  `+amount`, into the dealer's temp balance) immediately followed by
  `Transfer` (phase 5, `CreateEncNote`, `-amount`, to the recipient) —
  nets to zero within one transaction, satisfying the per-token balance
  invariant `actions-and-proofs.md` documents, without needing any
  auxiliary "fake" token or new contract deployment. The dealer just needs
  to actually hold that many units of a token they already handle for
  buy-ins.
- New export in `pokerActions.ts`: `packHoleCards`/`unpackHoleCards`,
  round-trip-verified with plain arithmetic (`node -e` check, several
  boundary pairs including `(0,0)` and `(51,51)`) before wiring into the
  UI — same "verify the mechanism before trusting it" standard as
  everything else this session.
- New "Deal hole cards" section in `PokerPanel.tsx`, placed *before* "Join
  table" — the flow was reordered, not just extended. An encrypted note's
  id is channel-index-deterministic (same fact from `notes-and-
  nullifiers.md` that resolved §4e), but for a *dealer-to-recipient*
  transfer neither party can predict it in advance the way a
  *self-directed* open note's creator can — so `join_table` now happens
  *after* dealing, once the recipient has read their real note_id from
  their own wallet, not before.
- **What this does NOT close**, flagged in-UI same as §4e: whether a real
  wallet's UI actually lets the recipient look up the note_id a plain
  transfer landed at, and whether the pool genuinely accepts this
  dust-amount Deposit+Transfer pair without issue. Neither checked against
  a live pool — no wallet or pool was reachable from this session either.

Verification actually run for this pass: `npx tsc --noEmit` clean, a full
`next build --webpack` succeeded (including static regeneration of
`/poker`), hook-order compliance re-checked by reading every `useState`
call site (all top-level, unconditional — same discipline as round 9,
where a real Rules-of-Hooks bug was caught this way), and the packing
round-trip checked in isolation before use. Not run: anything against a
live wallet or pool (none available here), and no browser click-through
(no Chrome extension connection in this environment, same as round 9).

---

## 5. Security review history (full detail)

Three rounds of `cairo-auditor` were run, each as a 4-agent parallel vector
scan (Access Control+Upgradeability / External Calls+Reentrancy /
Math+Economics / Storage+Components+Trust), merged and deduplicated by root
cause. **How this was actually executed** (since the skill isn't registered
in a fresh session — repeat this pattern for round 4+):

1. `find` for in-scope `.cairo` files → `/tmp/cairo-audit-files.txt`.
2. Run the deterministic preflight:
   `python3 .agents/skills/starknet-skills/scripts/quality/audit_local_repo.py --repo-root <repo> --scan-id <name> --output-dir /tmp`
   (has consistently returned 0 hits — it's a weak pattern-scan signal only).
3. Build 4 bundle files (`/tmp/cairo-audit-agent-{1,2,3,4}-bundle.md`), each
   = full in-scope code + `references/judging.md` +
   `references/report-formatting.md` + `references/attack-vectors/attack-vectors-N.md`
   (N=1..4), all under
   `.agents/skills/starknet-skills/cairo-auditor/`.
4. Spawn 4 parallel `Agent` tool calls (general-purpose, foreground/async —
   NOT `run_in_background`), each given the full text of `agents/vector-scan.md`
   pasted into the prompt plus a pointer to its bundle file and line count.
   **On round 2+, also tell each agent explicitly what prior rounds found
   and fixed, and ask it to verify those fixes hold from its partition's
   lens** — this caught real regressions (see round 3, finding 2, which is
   an *escalation* of an old "accepted" finding, not a fresh bug — an agent
   re-evaluating an old finding in light of a new fix is what caught it).
5. Merge results: dedupe by root cause (keep highest confidence version,
   merge attack-path details from others), sort P0→P3 then by confidence
   descending within tier, insert a "Below Confidence Threshold" separator
   at the first point overall where confidence drops below 75.

### Round 1 (file: `security-review-20260830-194015.md`)
2 Critical, 1 High, 1 Medium, 1 below-threshold Low — all rooted in the
contract trusting caller-supplied identity instead of anything pinned in
storage:
1. `privacy_invoke`'s pool check compared a caller-supplied argument against
   itself (tautology) — **FIXED**: constructor now pins a real `pool`
   address; `privacy_invoke` checks `caller == self.pool.read()`.
2. No caller/dealer check anywhere — **FIXED** (partially, see follow-up):
   `create_table` records a `table_dealer`; `settle_table` requires it and
   validates `payout_note_ids` against real seat ownership.
3. Reentrancy in `privacy_invoke` via `balance_of` before `pending_payout`
   was cleared — **FIXED**: added `reentrancy_lock`.
4. Integer-division remainder in `settle_table` stranded — **FIXED**:
   credited to the first winner.
5. `approve()`'s return value unchecked — **NOT FIXED**, accepted (Low,
   below threshold), still open as of round 3.

### Follow-up (same day, hand-applied, not separately audited before round 2)
Round 1's fix only restricted `settle_table`. Added: `seat_owner` map
(`join_table` records it; `bet`/`fold` require the caller to match) and
dealer-only checks on `commit_deal`/`mark_dealt`/`reveal_seed`.

### Round 2 (file: `security-review-20260830-203649.md`)
Verified the follow-up held (no bypass in the identity checks, including the
zero-address-default question — a real caller is never the zero address, so
it fails closed). **Found 2 new Critical:**
1. `bet()` gated *identity* (via `seat_owner`) but not *value* — a
   self-dealt table could still fabricate `table_pot` with zero real
   backing, then drain it via `privacy_invoke` against the contract's
   *shared* per-token balance. **FIXED**: `bet()` now calls
   `erc20.transfer_from(caller, contract, amount)` and asserts success
   before crediting `table_pot`.
2. `pending_payout`/`payout_token` keyed by bare `note_id` (no `table_id`)
   let an attacker register a victim's real `note_id` on their own
   throwaway table and hijack/freeze that note's payout. **FIXED**: added
   `note_id_owner` map, bound at `join_table`, cross-checked in
   `settle_table`.

Also flagged, below threshold, **not fixed**:
- No recovery path for dealer/pool roles (conf 70 at the time).
- Constructor doesn't reject a zero `pool` address (conf 60).

### Round 3 (file: `security-review-20260830-205751.md`) — **FIXED**
Confirmed rounds 1-2's identity/reentrancy fixes hold. Found and fixed:
1. **[P0, conf 90, FIXED]** `note_id_owner` fixed *identity* reuse of a
   `note_id` but not *token* reuse: `settle_table` unconditionally
   overwrote `payout_token[note_id]` every call, letting a settled fabricated
   balance be silently relabeled into a real token via a second, even
   zero-pot, table. **Fix applied**: before overwriting `payout_token`,
   `settle_table` now asserts `existing_pending == 0 || existing_token == token`.
2. **[P0, conf 88, FIXED]** Round 2's `bet()` fix meant real funds now sit
   in `table_pot` until `settle_table` runs — but only the fixed
   `table_dealer` could ever call it, with no timeout or override, so an
   abandoned/malicious dealer could permanently lock real bettor funds.
   **User chose "timeout-based self-refund"** (of 3 options offered — see
   below). New storage `table_created_at`/`seat_contributed`/
   `table_settled`, new entrypoint `reclaim_stalled_bet(table_id, seat)`,
   new `IErc20::transfer`, `SETTLE_TIMEOUT_SECS = 86400` (24h, not
   independently validated against real session lengths).
3. **[P1, conf 80, FIXED]** `bet()`'s `transfer_from` call had no
   reentrancy lock and credited `table_pot` only after the call returned —
   a malicious `token` (pinned once at `create_table`, no allowlist) could
   reenter `bet`/`fold`/`join_table`. **Fix applied**: `bet()` now takes the
   shared `reentrancy_lock` for its whole body.
4. **[P2, conf 76, FIXED]** `bet()` trusted the nominal `amount` parameter
   instead of measuring the actual balance delta — a fee-on-transfer token
   would let real balance drift below recorded `table_pot`. **Fix
   applied**: `bet()` reads `balance_of` before/after `transfer_from` and
   credits the measured delta.
5. Below threshold, unchanged, **still not fixed**: constructor zero-`pool`
   guard (conf 62), `approve()` return unchecked (conf 50).

Rebuilt clean (`scarb build`, zero warnings) after all four fixes.

### Round 4 (file: `security-review-20260831-090322.md`) — **FIXED**
Targeted re-audit of round 3's new `reclaim_stalled_bet` code. Confirmed
holding: `reclaim_stalled_bet`'s identity/timeout/double-reclaim/reentrancy
guards, and — proven by induction across every `bet`/`reclaim_stalled_bet`
interleaving — `table_pot == Σ seat_contributed`, so no seat can ever
extract more than it contributed. Found and fixed **2 new Critical**:
1. **[conf 92, FIXED]** Neither `bet()` nor `settle_table()` checked
   `table_settled` — a bet could land after a table settled (and become
   permanently unreclaimable, since `reclaim_stalled_bet` is itself gated
   on `!table_settled`), and `settle_table` could be called a second time.
   **Fix applied**: both now assert `!table_settled` at entry.
2. **[conf 80, FIXED]** `settle_table` was excluded from the shared
   `reentrancy_lock` despite mutating the same state the other three
   functions guard — a dealer-controlled token could reenter it
   mid-`bet()`. **Fix applied**: `settle_table` now asserts
   `!reentrancy_lock` at entry (it makes no external calls itself, so
   checking without holding the lock is sufficient).

Rebuilt clean (`scarb build`, zero warnings) after both fixes.

### Round 5 (file: `security-review-20260831-091541.md`) — **FIXED**
Genuinely fresh full pass across all four partitions (not just
re-verification) — **first round to find no new Critical or High**.
Confirmed with formal reasoning, not just re-checking: `reentrancy_lock`
can never persist as `true` across a transaction boundary (every writer
traced; Cairo reverts undo the `write(true)` on any failure); `settle_table`'s
payout math holds even with duplicate seats/note_ids in one call (the
credited sum is an algebraic identity pinned to the collected pot);
`table_buy_in`'s non-enforcement is a deliberate, documented layering
choice, not a bug. One long-standing below-threshold item finally crossed
the confidence bar:
1. **[conf 78, FIXED]** `privacy_invoke`'s `approve()` return value was
   unchecked — a token returning `false` instead of reverting could mark a
   payout as sent with no real allowance granted, permanently
   unrecoverable. **Fix applied**: now asserts the return value
   (`TRANSFER_FAILED` on `false`), matching the existing pattern for
   `transfer_from`/`transfer`.

Rebuilt clean (`scarb build`, zero warnings).

**Full technical detail, exact fix diffs, and required-tests lists for all
of the above are in the five `security-review-*.md` files — this section
is a summary, not a replacement for reading them before you touch this
contract again.**

### Round 6 — feature work, NOT audited (no security-review file for it)

After round 5, three things were added with no `cairo-auditor` follow-up:

1. **`reveal_seed` Poseidon fix** (small): the seed-commitment check was a
   literal identity comparison (`computed_hash = seed`) through round 5 —
   any seed "verified" against itself, so `commit_deal` carried no real
   binding despite reading as a normal commit-reveal scheme. Now uses
   `core::poseidon::poseidon_hash_span(array![seed].span())`. `commit_deal`'s
   doc comment specifies the exact construction off-chain dealer tooling
   must match. `test_lifecycle.cairo`'s commit/reveal tests were updated to
   match (they'd have failed `SEED_MISMATCH` against the old raw-seed
   commits otherwise).
2. **Multi-street betting**: new `advance_street` (dealer-only,
   PreFlop→Flop→Turn→River→Showdown, one step at a time), and `bet` now
   refuses once a table reaches Showdown. Explicitly does NOT enforce
   bet-matching/turn-order before advancing, and does NOT gate any
   on-chain card disclosure to a street boundary (community cards, like
   hole cards, are still only ever revealed once at showdown via the
   existing `reveal_seed` — see the interface doc comment on
   `advance_street` for the full reasoning).
3. **`settle_table_by_hand`** — new entrypoint, on-chain-showdown
   alternative to `settle_table`. Dealer submits each non-folded seat's
   hole cards + the 5 community cards; the function computes every seat's
   best 5-of-7 hand via the new `poker_hand` module and pays the pot to
   the actual strongest hand(s) (splitting ties), instead of trusting a
   dealer-supplied winner list. Reuses `settle_table`'s exact security
   patterns (dealer-only, reentrancy check, `table_settled`,
   `note_id_owner`/`payout_token` binding) — same shape, genuinely new
   code (array-input handling across 3 passes: verify+score, find max,
   distribute). **This is the single largest unaudited chunk of code in
   the contract right now.**

`poker_hand.cairo` itself (`evaluate_5`/`best_of_7`) is genuinely
unit-tested — 19 tests, all passing, via `scarb test -- -t unit` (see
§4a) — but "unit-tested for correctness" and "security-audited" are
different things; nothing has checked it (or `settle_table_by_hand`) for
the kind of caller-identity/reentrancy/value-fabrication issues rounds 1-5
found repeatedly elsewhere in this file. **No `security-review-*.md` file
exists for round 6** — round 7 (below) is that audit.

Rebuilt clean (`scarb build`, zero warnings) after each of the three
changes above; unit tests re-run and still 19/19 passing after the
contract integration.

### Round 7 (file: `security-review-20260831-120606.md`) — **FIXED**
Targeted re-audit of round 6's additions specifically (explicit-file mode:
`lib.cairo` + `poker_hand.cairo`, `mocks.cairo` deliberately excluded —
test-only). Confirmed clean: `advance_street`/`settle_table_by_hand`'s
dealer gating (byte-for-byte consistent with rounds 1-5); zero external
calls anywhere in the new code, verified by direct read, so the existing
check-without-hold `reentrancy_lock` pattern is sound there too (one real
asymmetry found — `advance_street` skips the lock check entirely — traced
to a dead end: requires attacker-controlled dealer AND token, and grants
nothing beyond a direct call already would); `table_street` confirmed
single-writer, never resettable; `settle_table_by_hand`'s independent
reimplementation of `settle_table`'s write logic diffed line-by-line with
nothing missing or weakened; pot-splitting math proven conservation-exact,
division-by-zero structurally impossible; no partial-state-before-panic
risk. Found **1 Medium**:
1. **[conf 75, FIXED]** Neither `settle_table_by_hand` nor
   `poker_hand::evaluate_5` checked submitted cards were real (`< 52`) or
   distinct — a dealer could fabricate an impossible hand (duplicate card
   values, or an out-of-range value silently folded by `% 13`) to steer
   the computed winner. Didn't grant new *power* (dealer already controls
   `settle_table`'s trusted list) but undermined `settle_table_by_hand`'s
   own "checkable by anyone" claim. **Fix applied**: new
   `poker_hand::assert_valid_deck_cards` (range + pairwise-distinct check
   over the full community+hole card set), called before any scoring in
   `settle_table_by_hand`. 5 new unit tests (now 24 total, all passing) +
   2 new unverified integration regression tests in
   `cairo/tests/test_hand_eval.cairo`.

Rebuilt clean (`scarb build`, zero warnings) after the fix; unit tests
re-run, 24/24 passing.

**Full technical detail for all seven rounds is in the seven
`security-review-*.md` files — this section is a summary, not a
replacement for reading them before you touch this contract again.**

---

## 6. Resolved decision (kept for context)

Round 3 finding 2 needed a product decision on recovering an
abandoned-dealer table. Three options were offered; **the user picked
"timeout-based self-refund"** (implemented as `reclaim_stalled_bet`, see
§5 above). The other two — a pool-level force-settle override, or
accepting the risk and just documenting it for the demo — were not chosen
but remain valid alternatives if this needs revisiting (e.g. if 24h turns
out to be the wrong window, or if the self-refund model doesn't fit the
actual game-session UX once the frontend exists).

**Rounds 4 and 5 both ran.** Round 4 found and fixed two Critical gaps in
round 3's new code. Round 5 — a genuinely fresh pass, not just
re-verification — found nothing above Low severity, and formally confirmed
(not just spot-checked) that the reentrancy lock and payout-math invariants
hold. **Only one accepted gap remained after round 5** (constructor
zero-`pool` validation, Low, not attacker-reachable).

**Then round 6 happened** (multi-street betting + `settle_table_by_hand` —
see §5) — real feature work, genuinely valuable, but new code that hadn't
been through the audit process rounds 1-5 went through. **Round 7 closed
that gap**: targeted specifically at round 6's additions, found and fixed
one Medium (card validation in `settle_table_by_hand`). As of round 7, the
contract's *entire* Cairo surface (`lib.cairo` + `poker_hand.cairo`; not
`mocks.cairo`, deliberately — test-only) has been through at least one
audit pass. Any *future* change still needs its own audit round, same as
always — this isn't a one-time clearance.

---

## 7. Everything else still open (beyond the security findings above)

In rough priority order — see `docs/DESIGN.md` "Open items" for the
canonical, kept-up-to-date list:

1. ~~**Get the test suite actually running**~~ — **DONE** (2026-08-31, on
   Linux). All 102 tests pass: `cd cairo && snforge test --features testing`.
   See §4a for the two structural bugs that had to be fixed (cfg(test)-gated
   mocks, non-`pub` events) — no test logic changed, nothing failed once it
   compiled. **The remaining coverage gaps in `cairo/tests/README.md` are
   still open** (no fuzz tests, no `privacy_invoke`-specific reentrancy
   test, no multi-table stress) — worth closing before any real deployment.
2. ~~Pin the real commitment hash in `reveal_seed`~~ — **DONE**, see round 6
   in §5.
3. ~~Multi-street betting + hand evaluation~~ — **DONE** (round 6, §5):
   `advance_street` + `settle_table_by_hand`. ~~Card validation~~ —
   **DONE** (round 7, §5): `assert_valid_deck_cards`. **Bet-matching/
   turn-order enforcement is still open** (not done — see
   `advance_street`'s doc comment); ~~`settle_table_by_hand` doesn't
   verify submitted hole cards against the seed commitment~~ — **DONE**,
   see item 5.
4. A round 8/9 *security* sweep (`cairo-auditor`) is now ripe — round 8
   added real access-control-shaped surface (`create_table`'s `max_seats`
   bound, `join_table`'s seat bound) and a new value-moving check
   (`settle_table_by_hand`'s card-position assertions); round 9 added
   `register_payout_note` (another `note_id_owner`-binding entrypoint,
   same shape as `join_table`'s). None of round 8 or round 9 has been
   through `cairo-auditor` yet — see `docs/DESIGN.md` open item 6 and §4b
   in this file.
5. ~~Move the shuffle-from-seed algorithm on-chain~~ / ~~seat-count
   concept~~ / ~~wire it into settle_table_by_hand~~ — **ALL DONE**
   (round 8, §4b/§4c): `cairo/src/shuffle.cairo`'s Poseidon-based
   Fisher-Yates exists, is genuinely tested, and is cross-verified
   bit-for-bit against `scripts/deal_verify.py`'s Python side
   (`random.Random` is gone). `create_table` takes `max_seats` and
   `join_table` enforces `seat < max_seats` (`BAD_MAX_SEATS`/`BAD_SEAT`).
   `settle_table_by_hand` now requires `reveal_seed` (`SEED_NOT_REVEALED`)
   and asserts every submitted card matches its position in
   `shuffle::shuffled_deck(revealed_seed)` (`CARD_MISMATCH`) — see §4c for
   the full writeup, including how `cairo/tests/test_hand_eval.cairo`'s
   existing hand-picked-card tests were reworked to use real,
   seed-derived cards (found via a doubly-verified Python+Cairo search)
   instead. **The shuffle-from-seed item is fully closed at the contract
   level.** (`assert_valid_deck_cards`'s range/distinctness check is now
   largely redundant for calls that reach it — kept anyway as
   defense-in-depth.)
6. ~~Wire the frontend~~ — **DONE (round 9)**, at `/poker`
   (`src/app/poker/`) — see §4d. The original starter-kit demo
   (wallet connect + shield/unshield/echo) is untouched at `/`, just gained
   a nav link across. ~~Hole-card encryption (`CreateEncNote`) is manual
   entry~~ — **also done (round 10)**, see §4f: a "Deal hole cards"
   section with this project's own card-packing convention.
6a. ~~Resolve the payout-claim `note_id` design question~~ — **DONE
   (round 9)**: picked option (a) — see §4e for the full resolution
   (`register_payout_note` plus the two-transaction reserve-then-claim
   flow) and docs/DESIGN.md "Buy-in, betting, payout flow" for the
   reasoning behind why option (a) is mechanically sound. Not
   independently verified: whether a real wallet's UI actually surfaces a
   freshly created open note's id the way that flow assumes (§4e's last
   bullet) — round 10's hole-card dealing flow (§4f) has the exact same
   open caveat, for the same underlying reason.
6b. Resolve the current cross-platform build blocker (§4f's opening
   paragraph): `snforge_std` is now unconditional in `cairo/Scarb.toml`
   (correct on the Linux machine, breaks `scarb build` on Windows with no
   Rust toolchain — confirmed live this session). Needs a decision: install
   Rust here, keep Cairo work Linux-only, or something else — not something
   to silently resolve either way.
7. Deploy to Sepolia once tests pass — needs the real STRK20 pool address as
   the constructor arg; record the deployed address in `cairo/address.md`
   and wire it into `src/utils/constants.ts` (`PokerGameSepolia` — same
   file now also has `pokerGameAddressForIndex`, round 9).
8. Housekeeping: first git commit (ask the user first), `npm audit fix`
   decision on `sharp`, pitch/demo narrative (the "card-as-encrypted-note +
   commit-reveal" pattern generalizes to Battleship/Mafia/sealed-bid
   auctions per the RFP's own framing — good pitch material).
9. Re-check https://strk20.starknet.io/hackathon closer to submission — it
   was a near-empty client-rendered shell (just an AVNU banner link) when
   last checked; actual rules/deadline/submission format may populate
   later. `WebFetch` can't render it (SPA); the Chrome extension
   (`mcp__claude-in-chrome__*`) wasn't connected when last tried — check
   `tabs_context_mcp` again, it may be connected now.

---

## 8. Problems encountered this session (so you don't repeat the debugging)

- **`npx skills add` installs into two places**: the real content lands in
  `.agents/skills/<name>/`, and `.claude/skills/<name>` is a symlink to it
  for Claude Code specifically. Don't delete `.agents/skills/` thinking
  `.claude/skills/` is the real copy.
- **Skills installed mid-session aren't in the `Skill` tool's registry**
  until a fresh session picks them up — calling `Skill(skill: "cairo-auditor")`
  fails with "Unknown skill" even though the files are right there. Read the
  skill's markdown files directly and follow them manually (see §5).
- **A starter-kit clone can carry stale personal config**: this project was
  scaffolded from `Akashneelesh/strk20-starter-kit`, which shipped
  `.codex/hooks.json` and `.cursor/hooks.json` pointing at
  `/Users/akash/...` paths (the original author's machine) — harmless here
  (Claude Code doesn't read them) but was deleted as irrelevant clutter,
  along with `.serena/` and the starter kit's own `.git` history.
- **Scarb has no simple Windows installer** — no `curl | sh` or winget
  equivalent worked cleanly; had to download the exact-version `.zip` from
  the GitHub releases page, extract to `%LOCALAPPDATA%\Programs\scarb\`, and
  add its `bin` to the **user** PATH via PowerShell's
  `[Environment]::SetEnvironmentVariable`. An already-open shell won't see
  the new PATH — say so if a fresh `scarb: command not found` shows up. **This
  keeps happening across sessions** (hit again in round 8): `scarb` was not
  on `PATH` in a brand-new shell even after the earlier PATH fix. Find it
  fresh with (Bash) `find ~ -maxdepth 4 -iname "*scarb*" 2>/dev/null` (look
  for `AppData/Local/Programs/scarb/scarb-v<version>.../bin`), then
  `export PATH="<that bin dir>:$PATH"` for the session, rather than trusting
  the PATH change persisted.
- **`pip install starknet-py` can hang indefinitely on Windows without a
  Rust/cargo toolchain** — dependency resolution alone ran 20+ minutes with
  zero output and never started downloading (native-extension deps like
  `fastecdsa`/`crypto-cpp-py` are the likely cause, same class of problem as
  `snforge_std` needing `cargo fetch`). Don't wait on it again. For a
  Starknet-matching Poseidon hash in Python with no native toolchain, use
  `pip install poseidon-py` instead (`poseidon_py.poseidon_hash.
  poseidon_hash_many`) — small prebuilt wheel, installs in seconds, and its
  output was cross-verified to match Cairo's `core::poseidon::
  poseidon_hash_span` exactly (see §4b).
- **OneDrive file locks**: deleting/emptying a directory immediately after
  heavy file activity in it (e.g. right after `npm install` or unzipping)
  sometimes fails with "Device or resource busy" — OneDrive's sync process
  briefly holds a handle. Retrying the same command a moment later has
  always worked; it's not a real error.
- **`contract_address_const` is deprecated** in this Cairo version (2.18.0)
  — use `use core::num::traits::Zero;` and `.is_zero()`/`.is_non_zero()` on
  a `ContractAddress` instead. Already fixed once in this codebase; don't
  reintroduce it.
- **The hackathon page is a client-rendered SPA** — `WebFetch` only ever
  returned a near-empty shell (an AVNU banner announcement), not real
  content. If you need the actual rules, either try the Chrome extension
  tools again (wasn't connected last time this was tried) or ask the user
  to paste the content.
- **`scarb build --test` needing `snforge` for EVERYTHING is a red
  herring** — it only needs `snforge_std`'s plugin because `cairo/tests/`
  imports it. A pure-function module with no storage/external-call/
  cheat-code dependency can be unit-tested with zero extra tooling: add
  `[dev-dependencies] cairo_test = "2.18.0"` (safe — confirmed it doesn't
  break `scarb build` the way `snforge_std` did) and co-locate
  `#[cfg(test)] mod tests { #[test] fn ... }` in the same file. Run with
  `scarb test -- -t unit` (`-t unit` is essential — it's what skips
  `cairo/tests/`, which still needs `snforge` and would otherwise fail the
  whole run). This is how `cairo/src/poker_hand.cairo`'s 24 tests (and
  round 8's `shuffle.cairo`/`poseidon_vector_check.cairo`/
  `shuffle_vector_check.cairo`, 8 more) actually run and pass in this
  environment — see §4a/§4b. Worth remembering for any future pure-logic
  Cairo work here.
- **Cairo `felt252` short-string literals cap at 31 characters** — a
  `#[should_panic(expected: '...')]` or `assert(cond, '...')` string longer
  than that fails with `E3009: The value does not fit within the range of
  type core::felt252` at compile time. Hit this writing `poker_hand`'s
  tests; keep assert/panic messages short.
- **`Array<T>` in Cairo has no in-place mutation** (no `arr[i] = x`,
  no removal from the middle) — sorting/filtering utilities need a
  rebuild-a-new-array style (see `sort_desc`/`kickers_excluding` in
  `poker_hand.cairo` for a working pattern: repeated max-extraction into a
  new array, or filter-and-append into a new array). Don't reach for
  in-place index assignment, it doesn't exist for `Array`.
