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

**Location:** `C:\Users\TANISHA\OneDrive\Desktop\zkpoker\` (moved here from
an earlier `strk20-poker` folder mid-session — if you find any leftover
references to that name anywhere, they're stale; the project's real name is
`zkpoker`, matching `package.json` and `cairo/Scarb.toml`).

**Git:** initialized (`git init`), everything staged, **nothing committed
yet**. The user has been asked and hasn't requested a commit — don't commit
without asking first.

**⚠️ Important caveat on "what's been checked":** every audit round in this
project scanned only `cairo/src/lib.cairo` (the one Cairo file that exists).
Nothing else — the frontend, scripts, or docs — has had any security review.
If you add more Cairo files, they are unaudited until you run `cairo-auditor`
on them too.

---

## 2. Environment / toolchain state

- **Scarb 2.18.0** is installed at
  `%LOCALAPPDATA%\Programs\scarb\scarb-v2.18.0-x86_64-pc-windows-msvc\bin`,
  added to the **user** PATH (not system-wide). **Gotcha:** a shell that was
  already open when this was installed won't see it on PATH — open a new
  terminal, or reference the binary by full path.
- **Node v24.20.0**, npm installed (`npm install` done — 103 packages). One
  unaddressed `npm audit` finding: `sharp` has a high-severity libvips CVE,
  fix requires a breaking version bump — deliberately left alone so far.
- **Skills installed** (project-local, symlinked into `.claude/skills/` for
  Claude Code, and into `.agents/skills/` as the real install target — don't
  delete `.agents/skills/`, `.claude/skills/` just points at it):
  - `strk20-privacy`, `strk20-anonymizer-contracts`, `strk20-privacy-sdk`,
    `strk20-wallet-api` — STRK20 concepts/SDK/wallet integration
  - `starknet-skills` (Keep Starknet Strange) — bundles `cairo-auditor`,
    `cairo-contract-authoring`, `cairo-testing`, `cairo-optimization`,
    `cairo-toolchain`, `account-abstraction`, `starknet-network-facts`
  - None of these show up in a fresh session's "available skills" listing
    (they were installed mid-conversation) — the `Skill` tool call will
    fail with "Unknown skill". **Workaround used throughout this project:**
    read the skill's `SKILL.md` / `workflows/*.md` / `agents/*.md` files
    directly from `.agents/skills/starknet-skills/cairo-auditor/` and follow
    them manually via `Agent` tool calls. See §5 for exactly how the audits
    were run — repeat that pattern.

---

## 3. What's built so far

```
zkpoker/
  cairo/src/lib.cairo          PokerGame contract — see §4/§5
  cairo/src/mocks.cairo         test-only mock ERC20, #[cfg(test)]-gated,
                                 never in the production build
  cairo/Scarb.toml              package "zkpoker", scarb build succeeds
                                 clean — has a comment explaining why
                                 snforge_std is deliberately NOT declared
                                 as a dependency here (see §4a)
  cairo/tests/                  full test suite, WRITTEN BUT NOT RUN — see
                                 §4a and cairo/tests/README.md before you
                                 trust any of it
  scripts/deal_verify.py        fairness-check CLI, tested working, PRNG is a
                                 stand-in (see docs/DESIGN.md open items)
  docs/DESIGN.md                architecture, fairness model, security-review
                                 timeline (keep this updated as you go)
  security-review-*.md          one file per audit round (5 so far), see §5
  HANDOFF.md                    this file
  src/, public/, package.json   still the ORIGINAL starter-kit demo UI
                                 (Akashneelesh/strk20-starter-kit) — nothing
                                 wired to PokerGame yet
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
pot accounting, `reclaim_stalled_bet` (timeout-based refund for an
abandoned dealer), `settle_table`, and the STRK20 `privacy_invoke` payout
hook.

**It has been through five audit rounds.** Every Critical/High finding
found so far has been fixed and rebuilt clean. Round 5 (the most recent)
was a genuinely fresh full pass, not just re-verification, and found
nothing above Low severity — the first round to do so. **One accepted
low-severity gap remains** (constructor doesn't reject a zero `pool`
address — self-inflicted deploy misconfiguration only, not attacker-
reachable). This is a meaningfully better state than earlier in the
project, but "5 clean-ish rounds" is not the same as "audited" — still
don't deploy this anywhere with real value without at least getting the
test suite actually running first (see §4a) and ideally a real,
non-AI security review before mainnet. The file's own header comment (top
of `cairo/src/lib.cairo`) is kept up to date with a summary of this
history — read it too.

### 4a. Test suite: written, NOT run — read this before trusting it

A full test suite exists at `cairo/tests/` (+ `cairo/src/mocks.cairo` for
a configurable mock ERC20) following the `cairo-testing` skill's coverage
rules, with a dedicated regression test per historical audit finding.
**It has never been executed, and could not even be compile-checked**, on
this machine: Starknet Foundry (`snforge`) ships no Windows binary, and
building it from source needs a Rust/cargo toolchain that isn't installed.
`scarb build --test` (which can compile test code without the `snforge`
binary) was tried, but even that needs `snforge_std`'s companion compiler
plugin, which had no prebuilt Windows binary at the version tried and fell
back to `cargo fetch` — still blocked. **Adding `snforge_std` as a
dev-dependency was tried and reverted after it broke the *plain*
`scarb build`** (Scarb resolves the full dependency graph, dev-dependencies
included, regardless of target) — don't repeat that mistake; read
`cairo/Scarb.toml`'s comment before touching it.

Full explanation, exact setup steps, and what's covered vs. not:
`cairo/tests/README.md`. **First thing to do with this project on a
machine that has `snforge`**: follow that README, run the suite, and fix
whatever the first real compile/run surfaces — treat every test as
unverified until then, even though each was authored carefully and
re-read multiple times (one real bug was caught this way during writing:
both reentrancy regression tests initially had the wrong identity
impersonating the malicious token, which would have tripped the
`NOT_SEAT_OWNER`/`NOT_DEALER` check before ever reaching the
`reentrancy_lock` check being tested — fixed by having the token contract
itself act as the seat owner/dealer).

**If you run `cairo-auditor` again**, note that its file-discovery
(`find ... -name "*.cairo"`) will now also pick up `cairo/src/mocks.cairo`
— it's `#[cfg(test)]`-gated and never in the production build, but the
auditor doesn't know that distinction. Either mentally discount findings
scoped to that file, or pass `cairo/src/lib.cairo` explicitly as the
target instead of a full-repo scan.

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
hold. **Only one accepted gap remains** (constructor zero-`pool`
validation, Low, not attacker-reachable). Five rounds in, the contract's
security surface has genuinely narrowed — this is a good point to shift
effort to the test suite rather than open a round 6 speculatively; resume
auditing only if the contract changes again first.

---

## 7. Everything else still open (beyond the security findings above)

In rough priority order — see `docs/DESIGN.md` "Open items" for the
canonical, kept-up-to-date list:

1. **Get the test suite actually running** — it's written (`cairo/tests/`,
   see §4a) but never executed or compile-checked on this machine (no
   `snforge` on Windows). Highest-value next step: get onto a machine with
   `snforge` (Linux/Mac/WSL), follow `cairo/tests/README.md`, run it, and
   fix whatever the first real pass surfaces.
2. ~~Pin the real commitment hash in `reveal_seed`~~ — **DONE**, post
   round 5: now uses `core::poseidon::poseidon_hash_span(array![seed].span())`,
   see `docs/DESIGN.md` "`reveal_seed` commitment hash" and the doc comment
   on `commit_deal` in `lib.cairo` for the exact off-chain construction any
   dealer tooling must match. `test_lifecycle.cairo`'s commit/reveal tests
   were updated to match (they previously committed the raw seed, matching
   the old placeholder behavior — would now fail `SEED_MISMATCH` if unfixed
   test files were run against the new code). **Not re-audited yet** — this
   was applied after round 5, so a round 6 sweep should at least glance at
   `reveal_seed`/`commit_deal` even if nothing else changed.
3. Multi-street betting + hand evaluation — `settle_table` still trusts an
   externally-supplied winner list; no pre-flop/flop/turn/river structure,
   no on-chain or proven hand ranking exists at all yet. Biggest remaining
   game-logic gap.
4. Swap `scripts/deal_verify.py`'s PRNG (currently Python's `random.Random`,
   explicitly a stand-in) for a Poseidon-based Fisher-Yates, so the same
   computation could eventually be proven in-circuit. (Different from item 2
   above — this is the *deck-shuffle* algorithm, not the seed commitment.)
5. Wire the frontend — `src/` still runs the starter kit's original demo UI
   (wallet connect + shield/unshield/echo). Nothing calls `PokerGame` yet.
6. Deploy to Sepolia once tests pass — needs the real STRK20 pool address as
   the constructor arg; record the deployed address in `cairo/address.md`
   and wire it into `src/utils/constants.ts`.
7. Housekeeping: first git commit (ask the user first), `npm audit fix`
   decision on `sharp`, pitch/demo narrative (the "card-as-encrypted-note +
   commit-reveal" pattern generalizes to Battleship/Mafia/sealed-bid
   auctions per the RFP's own framing — good pitch material).
8. Re-check https://strk20.starknet.io/hackathon closer to submission — it
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
  the new PATH — say so if a fresh `scarb: command not found` shows up.
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
