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
  cairo/src/lib.cairo          PokerGame contract — see §4/§5, NOT fully hardened yet
  cairo/Scarb.toml              package "zkpoker", scarb build succeeds clean
  scripts/deal_verify.py        fairness-check CLI, tested working, PRNG is a
                                 stand-in (see docs/DESIGN.md open items)
  docs/DESIGN.md                architecture, fairness model, security-review
                                 timeline (keep this updated as you go)
  security-review-*.md          one file per audit round (3 so far), see §5
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

No test suite exists yet (`cairo-testing` skill is installed, unused).

---

## 4. The contract's actual current state — READ THIS CAREFULLY

`PokerGame` in `cairo/src/lib.cairo` implements: table creation/joining,
commit-reveal dealing (`commit_deal`/`mark_dealt`/`reveal_seed`), bet/fold
pot accounting, `settle_table`, and the STRK20 `privacy_invoke` payout hook.

**It has been through three audit rounds and is not done.** Rounds 1 and 2
each found Critical bugs that were fixed and rebuilt immediately. **Round 3
found two more Critical bugs and one High that are NOT yet fixed** — the
session was interrupted mid-decision on how to fix one of them (see §6).
Do not treat this contract as safe. Do not deploy it anywhere with real
value. The file's own header comment (top of `cairo/src/lib.cairo`) is kept
up to date with a summary of this history — read it too.

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

### Round 3 (file: `security-review-20260830-205751.md`) — **CURRENT STATE, NOT YET ACTED ON**
Confirmed rounds 1-2's identity/reentrancy fixes hold. Found:
1. **[P0, conf 90, NOT FIXED]** `note_id_owner` fixes *identity* reuse of a
   `note_id` but not *token* reuse: `settle_table` unconditionally
   overwrites `payout_token[note_id]` every call. Register the same
   `note_id` at two of your own tables using different tokens — settle a
   fabricated big balance in a worthless token first, then settle a
   zero-pot hand in a real token second, and the real token silently
   becomes the denomination for the whole accumulated (fabricated) balance.
   Agreed fix (not applied): before overwriting `payout_token`, assert
   `existing_pending == 0 || existing_token == token`.
2. **[P0, conf 88, NOT FIXED, DECISION PENDING]** Round 2's `bet()` fix
   means real funds now sit in `table_pot` until `settle_table` runs — but
   only the fixed `table_dealer` can ever call it, with no timeout or
   override. An abandoned/malicious dealer permanently locks real bettor
   funds. **This is where the session stopped** — see §6, three candidate
   fixes were proposed and the user was about to be asked to pick one.
3. **[P1, conf 80, NOT FIXED]** `bet()`'s new `transfer_from` call violates
   checks-effects-interactions (`table_pot` credited *after* the external
   call) and `bet()` takes no reentrancy lock — a malicious `token` (pinned
   once at `create_table`, no allowlist) can reenter `bet`/`fold`/
   `join_table`. Reentering `privacy_invoke` itself is confirmed *not*
   possible (its caller check would see the token contract, not the real
   pool). Agreed fix (not applied): reorder to CEI + take the existing
   `reentrancy_lock` in `bet()` too.
4. **[P2, conf 76, NOT FIXED]** `bet()` trusts the nominal `amount`
   parameter instead of measuring the actual balance delta — a fee-on-
   transfer token would let real balance drift below recorded `table_pot`.
   Agreed fix (not applied): read `balance_of` before/after `transfer_from`,
   credit the actual delta.
5. Below threshold, unchanged: constructor zero-`pool` guard (conf 62),
   `approve()` return unchecked (conf 50).

**Full technical detail, exact fix diffs, and required-tests lists for all
of the above are in the three `security-review-*.md` files — this section
is a summary, not a replacement for reading them before you fix anything.**

---

## 6. Pending decision — START HERE if resuming this exact thread

The user was asked how to fix round 3's finding 2 (dealer-abandoned table
recovery) and asked for this handoff doc instead of answering yet. **Ask
them directly, or make a call and document it**, among:

- **Timeout-based self-refund** (the recommended default): each seat can
  reclaim exactly what it personally contributed via `bet()` if the table
  hasn't been settled within a fixed window after creation. Needs new
  storage (`table_created_at`, `seat_contributed`, `table_settled` — the
  last one to block reclaiming after a hand *legitimately* resolved, since
  a losing seat's contribution correctly became the winner's payout, not a
  refund target), a new `reclaim_stalled_bet` entrypoint, `IErc20::transfer`
  (only `approve`/`balance_of`/`transfer_from` exist today), and a timeout
  constant (candidate: 24h — not decided).
- **Pool-level force-settle override**: the pinned `pool` address can force
  settlement/refund after a timeout instead of per-seat self-refund. Fewer
  new fields, but gives `pool` new privileged power over every table.
- **Accept and document for the hackathon demo**: reasonable if the
  intended demo usage has the dealer role held by the app's own trusted
  backend rather than an arbitrary player — but say so explicitly in
  `docs/DESIGN.md` rather than silently leaving it.

Whichever is chosen, findings 1, 3, and 4 from round 3 have agreed fix
shapes already (see §5) and can be applied immediately without further
input — they were not blocked on anything.

**After applying round 3's fixes, run a round 4 audit** (same procedure as
§5) before considering the contract's security work "done" — the pattern
across this whole project has been that each fix round surfaces the next
layer of issues once agents specifically re-check it, and round 3 is the
first round where a *previously-dismissed* finding had to be escalated
because an earlier fix changed its risk profile. Don't assume round 3's
fixes are the last ones needed.

---

## 7. Everything else still open (beyond the security findings above)

In rough priority order — see `docs/DESIGN.md` "Open items" for the
canonical, kept-up-to-date list:

1. Resolve §6, apply round 3 fixes, re-audit (round 4).
2. Pin the real commitment hash in `reveal_seed` — currently a literal
   placeholder (`let computed_hash = seed;`), needs a real Poseidon hash
   matching whatever the actual STRK20 pool uses.
3. Build the test suite (`cairo-testing` skill, unused so far) — there is a
   backlog of "Required Tests" across all three audit reports, plus basic
   happy-path coverage for the full table lifecycle.
4. Multi-street betting + hand evaluation — `settle_table` still trusts an
   externally-supplied winner list; no pre-flop/flop/turn/river structure,
   no on-chain or proven hand ranking exists at all yet. Biggest remaining
   game-logic gap.
5. Swap `scripts/deal_verify.py`'s PRNG (currently Python's `random.Random`,
   explicitly a stand-in) for a Poseidon-based Fisher-Yates, so the same
   computation could eventually be proven in-circuit.
6. Wire the frontend — `src/` still runs the starter kit's original demo UI
   (wallet connect + shield/unshield/echo). Nothing calls `PokerGame` yet.
7. Deploy to Sepolia once tests pass — needs the real STRK20 pool address as
   the constructor arg; record the deployed address in `cairo/address.md`
   and wire it into `src/utils/constants.ts`.
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
