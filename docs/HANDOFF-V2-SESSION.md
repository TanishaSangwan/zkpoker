# zkpoker — V2 session handoff (2026-09-01 → 2026-09-02)

Read this if you're picking up mid-V2-work. It's a session-log companion to
the main `HANDOFF.md` (still the primary doc — read that first for overall
project state, the V1 contract's full audit history, and toolchain basics).
This file exists because a lot happened in one unbroken session that isn't
reflected anywhere else yet: local devnet deployment, a frontend UI
redesign, and — the main event — going from "V2 shuffle circuit exists but
has never produced a real proof" to "a real ZK shuffle proof is verified
on-chain by a real deployed Cairo verifier, with measured gas."

**Nothing in this session is committed to git.** `git status` at the top of
this conversation showed all of it as modified/untracked on `main`. Do not
commit without asking the user first — this is both the project's own
documented convention (`HANDOFF.md` §1) and was reinforced by the user
directly earlier in this session.

---

## 0. Read these next, in this order

1. `docs/V2-MENTAL-POKER.md` — the V2 mental-poker protocol spec (ElGamal
   over Grumpkin, per-player shuffle chain, Schnorr key registration,
   decryption shares). Status header at the top is kept current — as of
   this session it reflects the real on-chain verifier result.
2. `docs/V2-SPIKE-RESULTS.md` — the spike log. §7 and §8 (both added this
   session) are the real proof-generation and real on-chain-verification
   writeups, including the toolchain-gotcha diagnosis and real gas numbers.
3. `circuits/shuffle_verifier/README.md` — the standalone writeup of the
   Garaga toolchain compatibility issue and exact reproduction steps.
4. This file — session narrative, current repo state, and prioritized
   remaining work.

---

## 1. What actually happened this session, in order

### 1a. Local devnet deployment (V1 contract)
Deployed the existing V1 `PokerGame`/`MockErc20` stack to a local
`starknet-devnet` via `sncast`. Required temporarily adding
`default = ["testing"]` to `cairo/Scarb.toml`'s `[features]` to get
`sncast declare` to see the `testing`-gated mocks, then reverting it
(confirmed clean via `scarb clean && scarb build` afterward — the repo's
`Scarb.toml` is unchanged from git's perspective). New `cairo/snfoundry.toml`
(untracked) holds `[sncast.devnet0]`/`[sncast.devnet1]` profiles.

**This devnet instance no longer exists** — the VM restarted mid-session
(see §2 below) and a fresh devnet was started for the verifier-deployment
work. If you want to resume live V1 gameplay testing, redeploy
`PokerGame`/`MockErc20`/`MockShuffleVerifier` fresh; there's no state to
recover.

### 1b. Local-devnet frontend wiring
Added a devnet-connect path into the Next.js app without touching the
original starter-kit `/` page:
- `.env.local` (gitignored): RPC URL + the (now-stale, post-restart)
  deployed addresses.
- `src/utils/constants.ts`: `devnetRpcUrl`, `DEVNET_PROVIDER_INDEX = 3`,
  `myFrontendProviders[3]`, `NetworkLabels`, `PokerGameDevnet`,
  `defaultDevnetToken`.
- `src/app/components/client/provider/devnetAccountContext.ts` (new):
  zustand store `useDevnetAccount`, deliberately separate from the
  existing `walletContext.ts`.
- `src/app/components/client/WalletHandle/ConnectDevnet.tsx` (new): reads
  devnet predeployed accounts via JSON-RPC `devnet_getPredeployedAccounts`,
  builds a starknet.js v10 `Account` (note: v10's constructor takes an
  options object — `new Account({provider, address, signer})`, not the old
  positional form).

### 1c. Play/Verify UI redesign
User's actual ask, after clarifying in chat (not via the structured
question tool, which they declined twice — they prefer clarifying by
typing): *"I want it such that a beginner can try it without any issue and
an expert can verify everything they want to."* Result: `PokerPanel.tsx`
gained a `mode` toggle (persisted to `localStorage`, key `"pokerUiMode"`):
- **Play mode**: an oval `.felt` table (seats trig-positioned around an
  ellipse), Quick Start/Quick Join/Quick Commit/Quick Reveal buttons that
  wrap the raw contract calls with sane defaults (`randomFelt()` for
  seeds), an action bar (bet/fold).
- **Verify mode**: the original raw operator-panel fields, plus a new
  "Fairness Check" section using `src/app/poker/fairness.ts` (new — a
  verified JS port of `cairo/src/shuffle.cairo`'s Poseidon Fisher-Yates,
  checked byte-for-byte against `shuffle_vector_check.cairo`'s pinned
  seed=42 test vector) so a player can independently recompute the deck
  from a revealed seed and check their own cards client-side.

Real bugs caught and fixed during this pass (not just compiler-clean —
actually re-read): `tableState` null-narrowing didn't survive into a
nested `function` declaration (fixed by hoisting `const maxSeats =
tableState.maxSeats` before the nested function); several `onClick={handleBet}`
references needed wrapping in arrow functions once the handlers grew
optional params.

### 1d. Live 1-on-1 hand + a real rules gap found
User played a hand against the assistant seated at seat 1, assistant
watching on-chain state via background polling per the user's explicit
instruction ("keep watching the game in background dont keep asking me").
User then hit a real, confirmed gap: **`advance_street`/`bet`/`fold` don't
enforce bet-matching or turn order** — a street can be advanced whenever
either player wants, regardless of whether bets are matched. This is
already documented as an open item in `HANDOFF.md` §7 item 3 and in
`advance_street`'s own doc comment in `lib.cairo` — confirmed still true,
not yet fixed. Not in scope for this session's pivot (see next).

### 1e. The pivot: V2 shuffle work
User's explicit direction, verbatim:
> "ok first i want you to implement the v2 shuffling algo i.e. every
> player shuffles the deck. ZKPs prove that each shuffle is valid and that
> the dealer has actually gone through the shuffle truthfully also the
> dealer should not be the player as it is right now it should be the
> algorithm running off chain."

This reframed the remaining session around V2 (`docs/V2-MENTAL-POKER.md`),
which already existed as a spec + an unproven Noir circuit
(`circuits/shuffle/src/main.nr`) from a prior session
(`docs/V2-SPIKE-RESULTS.md` documents the earlier gate-count-only spike).
Asked "what is left now?" and got a 6-item breakdown (reproduced in §3
below). User said **"start with 1 now"** — item 1, the on-chain verifier.

### 1f. Item 1: real witness → real proof → real deployed verifier → real gas
This is the substantive technical work of the session. Full blow-by-blow
is in `docs/V2-SPIKE-RESULTS.md` §7–§8 and
`circuits/shuffle_verifier/README.md`; summary:

1. **Real witness.** `circuits/shuffle/Prover.toml` had all-zero
   placeholders. Replaced with genuine Grumpkin EC values (a real keypair,
   a real 52-card permutation, a real ElGamal-style re-randomization
   scalar) computed via a throwaway Noir helper program (since deleted).
   Confirmed via `nargo execute` → "Circuit witness successfully solved".
2. **Real proof.** Used `@aztec/bb.js` (WASM backend — the native `bb`
   binary SIGILLs on this VM, no AVX2, confirmed twice) to generate a real
   UltraHonk proof. Measured: WASM init 761ms, proof gen 5.67s / 14,656
   bytes / 458 fields (default target), 5.63s / 9,152 bytes (evm/keccak-zk
   target).
3. **Blocked on Garaga.** `garaga gen` kept rejecting our VK:
   `public_inputs_offset == 1` assertion failed, ours reported `offset = 5`.
   Ruled out ZK-masking and bb-version-within-our-pin as causes.
4. **Root cause found**, not worked around: Garaga 1.1.0 is built against
   a specific older toolchain pairing — `nargo 1.0.0-beta.16` +
   `@aztec/bb.js@3.0.0-nightly.20251104` — not the project's normal pin
   (`nargo 1.0.0-beta.22`). Confirmed two ways: (a) testing bb.js 6.0.0
   against our ACIR still gave offset=5, ruling out a bb-only fix; (b)
   testing bb 3.0.0-nightly against our *existing* beta.22-compiled ACIR
   failed outright ("Length is too large" — ACIR incompatibility), ruling
   out a bb-only downgrade. Compiling the circuit itself under beta.16
   needed three small patches (see `circuits/shuffle_verifier/README.md`
   for exact diffs): `EmbeddedCurvePoint::new()` doesn't exist in beta.16's
   stdlib (use the struct literal), the pinned `poseidon` crate needed
   downgrading from v0.3.0 to v0.1.1 (stdlib signature change), and
   non-ASCII characters in comments aren't accepted by beta.16's parser.
   None of this touched the real, checked-in `circuits/shuffle/` — the
   patched copy lives in `circuits/shuffle_verifier/example_proof/beta16_build/`
   as a parallel, Garaga-only build.
5. **Regenerated VK+proof** under the matched toolchain: `offset = 1`,
   confirmed correct — Garaga's own runtime warning text
   ("Detected versions of bb and nargo are not compatible...") matched the
   diagnosis exactly once triggered against a mismatched pairing.
6. **`garaga gen --system ultra_keccak_zk_honk`** succeeded — produced a
   real, compiling Cairo verifier project at `circuits/shuffle_verifier/`
   (`IUltraKeccakZKHonkVerifier::verify_ultra_keccak_zk_honk_proof`).
7. **Declared + deployed** to the (post-restart) local devnet: class hash
   `0x12cba98a5a71e62a4566cdd5de432bf781d349c432c9c7e72f603ecf2edbce8`,
   address `0x05a1d1c2be5c7fc9f312c560054f82e3ae5224b7754e960fa923f911f97205cc`.
   (These addresses are only valid against that specific devnet run — redo
   the declare/deploy if the devnet has restarted since.)
8. **Real on-chain positive test**: generated real calldata via
   `garaga calldata`, called the deployed verifier — got `Ok` with all 4
   public inputs (`pk_x, pk_y, hash_in, hash_out`) matching known values;
   `pk_x` reconstructed by hand from the raw `u256` response and confirmed
   exact.
9. **Real on-chain negative test**: corrupted one felt deep in the proof
   body, called again — real revert, `"proof point not on curve"` (genuine
   cryptographic checking, not a rubber stamp).
10. **Real gas measured** via an actual `sncast invoke` +
    `starknet_getTransactionReceipt`: **L2 gas 811,907,200**, L1 gas 0, L1
    data gas 128, actual_fee ≈ 0.812 STRK (devnet pricing). This is the
    exact number `docs/V2-MENTAL-POKER.md` §9's kill criteria needed and
    didn't have before this session.
11. Restored the shared `nargo` toolchain back to the project's pin
    (`noirup --version 1.0.0-beta.22`) afterward — confirmed the real,
    original `circuits/shuffle/` (untouched) still compiles and executes
    cleanly under it (`nargo execute` → "Circuit witness successfully
    solved") as the very last action before this handoff was written.
12. Persisted every working artifact into the repo itself, not `/tmp` —
    `/tmp` was wiped once already this session by an unrelated VM restart
    and everything in it (bb.js installs, garaga venv, cmake, the witness
    helper, in-progress proof files) was lost and had to be rebuilt from
    scratch. Repo files survived because they're not in `/tmp`. See §4 for
    exact paths.

### 1g. Also built this session, adjacent to item 1
- **`scripts/dealer_bot.mjs`** (new, untracked): a standalone Node script
  (starknet.js, loads the PokerGame ABI at runtime from
  `cairo/target/dev/zkpoker_PokerGame.contract_class.json` — no TS import
  needed) implementing the "dealer is an off-chain algorithm, not a
  player" half of the user's V2 request, but only for the **V1** contract
  surface (commit/reveal, not the V2 shuffle chain yet). Does:
  `create <table_id> <token> <buy_in> <max_seats>` (creates + commits a
  bot-drawn seed), `watch <table_id>` (polls every 3s, checks real
  bet-matching via decoded `Fold` events — not a shape-guess, uses the
  real `hash.starknetKeccak("Fold")` selector — advances streets when all
  active seats have matched contributions, fast-forwards an uncontested
  fold to Showdown, reveals the seed and settles via real computed cards
  at showdown). **Explicitly flagged in its own comments**: the
  settlement step reuses each seat's hole-card note as its own payout
  note, which is a DEVNET-DEMO SIMPLIFICATION, not something to deploy for
  real. This does NOT yet drive the V2 shuffle chain
  (`register_shuffle_key`/`begin_shuffle`/`submit_shuffle`) — that's item
  4 in §3 below, still unstarted.
- A live logic bug in the bot's own "uncontested win" fast-path was caught
  and fixed during on-devnet testing before it could misbehave — see the
  bot's `maybeAdvanceStreet` for the corrected logic.

---

## 2. Environment gotcha specific to this session

**The scratch VM restarted mid-session** (likely an underlying host
event, not anything in-repo) and wiped `/tmp` entirely — every tool
installed there (bb.js, the garaga Python venv, a cmake build, the
witness-gen helper program, in-progress proof binaries) was gone. Nothing
under the repo directory was affected. Lesson applied for the rest of the
session (and worth repeating going forward): **any artifact worth keeping
gets copied into the repo, not left in `/tmp`.** That's why
`circuits/shuffle_verifier/example_proof/` exists as checked-in binary
artifacts rather than a "regenerate it yourself" pointer only.

Toolchain state as of end-of-session:
- Main project pin: `nargo 1.0.0-beta.22` (restored, confirmed working).
- Garaga-only, separate: `nargo 1.0.0-beta.16` + `@aztec/bb.js@3.0.0-nightly.20251104`
  installed for the verifier-generation detour — see
  `circuits/shuffle_verifier/README.md` for exact reproduction if this
  needs to be redone (e.g. if `/tmp` is wiped again, or on a fresh
  machine).
- `circuits/shuffle_verifier/.tool-versions` pins `scarb 2.16.1` +
  `starknet-foundry 0.57.0` (different from `cairo/.tool-versions`'
  `scarb 2.18.0` — Garaga's generator pins its own versions; both
  installed side-by-side via asdf, nothing in `cairo/` touched).

---

## 3. The full "what's left" breakdown (as given to the user, item 1 now done)

1. ~~**On-chain shuffle verifier**~~ — **substantially done this session**
   for its original scope (real proof, real deployed verifier, positive +
   negative on-chain tests, real gas measured — both §9 kill criteria in
   `docs/V2-MENTAL-POKER.md` now have real numbers instead of estimates).
   **Still open within this item**: the generated verifier's interface
   (`verify_ultra_keccak_zk_honk_proof(full_proof_with_hints: Span<felt252>)
   -> Result<Span<u256>, felt252>`) does not match what `PokerGame` expects
   (`IShuffleVerifier::verify_shuffle(proof, public_inputs)`) — wiring it
   in for real needs a small adapter contract translating between the two
   interfaces. Not built. `MockShuffleVerifier` (in `cairo/src/mocks.cairo`)
   is still what `PokerGame` actually talks to.
2. **Card dealing & decryption** (spec §4.4–§4.6 in
   `docs/V2-MENTAL-POKER.md`): Chaum-Pedersen DLEQ decryption-share proof,
   a `submit_decryption_share` entrypoint. Nothing built yet.
3. **V2 frontend UI**: `register_shuffle_key`, `begin_shuffle`/
   `submit_shuffle` with real client-side proving (the browser-side
   proving path is completely untested — everything this session proved
   was generated server-side/CLI-side), decryption-share submission UI.
   Nothing built yet.
4. **Extend `scripts/dealer_bot.mjs`** to orchestrate the V2 shuffle chain
   specifically: call `begin_shuffle` once all players' keys are
   registered, watch each `submit_shuffle` deadline, call
   `claim_shuffle_timeout` on a stalled submitter. The bot currently only
   drives the V1 commit-reveal flow (§1g above) — this is a distinct,
   larger extension, not a small tweak.
5. **Security audit of the new V2 surface**: `register_shuffle_key`,
   `begin_shuffle`, `submit_shuffle`, `claim_shuffle_timeout` (all already
   exist in `cairo/src/lib.cairo` per the V2 spec — check current state,
   they may predate this session), and `cairo-verifier/`'s
   `SchnorrKeyVerifier` (new/untracked this session in its own right —
   `scripts/schnorr_keygen.py` alongside it). Follow the same
   4-parallel-agent `cairo-auditor` process `HANDOFF.md` §5 documents in
   detail — none of this has been through it yet.
6. **Nothing from this whole session is committed.** Needs explicit
   go-ahead before any `git add`/`git commit`.

Also still true from before this session's pivot (not superseded, just
deprioritized): bet-matching/turn-order enforcement in
`advance_street`/`bet`/`fold` (§1d above) — a real, user-confirmed gap in
the **V1** contract, untouched this session.

---

## 4. Where everything lives (file map for this session's work)

```
circuits/shuffle/Prover.toml           real witness values (not the V2 spec's
                                         circuit itself — that's unchanged)
circuits/shuffle_verifier/             the generated Cairo verifier project
  src/honk_verifier.cairo               IUltraKeccakZKHonkVerifier trait +
                                         impl (~300 lines)
  src/honk_verifier_circuits.cairo      generated, ~3674 lines
  src/honk_verifier_constants.cairo     generated, ~4267 lines
  src/lib.cairo, Scarb.toml, .tool-versions
  README.md                             the toolchain-gotcha writeup + repro
  example_proof/
    vk.bin, proof.bin, public_inputs.bin, calldata_array.txt
                                         the actual working artifacts used
                                         for the real on-chain test above
    beta16_build/{main.nr, Nargo.toml, Prover.toml}
                                         the patched circuit copy that
                                         compiles under beta.16, used only
                                         to feed Garaga — NOT the real
                                         circuit source of truth
docs/V2-SPIKE-RESULTS.md               §7 (real proof) and §8 (real
                                         verifier + gas) added this session
docs/V2-MENTAL-POKER.md                status header updated to reflect
                                         real on-chain result; note added
                                         under §1 about scripts/dealer_bot.mjs
scripts/dealer_bot.mjs                 off-chain dealer bot, V1 flow only
                                         (see §1g above)
scripts/schnorr_keygen.py              untracked, adjacent to cairo-verifier/
cairo-verifier/                        untracked dir, SchnorrKeyVerifier —
                                         not reviewed in detail this session,
                                         confirm current contents before
                                         relying on the description above
src/app/poker/PokerPanel.tsx           Play/Verify mode redesign (§1c)
src/app/poker/poker.module.css         styles for the above
src/app/poker/fairness.ts              verified JS port of the shuffle algo
src/app/components/client/WalletHandle/ConnectDevnet.tsx
src/app/components/client/provider/devnetAccountContext.ts
                                         devnet wallet connect (§1b)
src/utils/constants.ts                 devnet + V1 wiring additions
cairo/snfoundry.toml                   sncast devnet profiles (§1a)
```

---

## 5. Recommended next step

Pick up at item 1's remaining gap (the `PokerGame`↔verifier adapter
contract) if continuing the natural sequence, or jump straight to item 2
(decryption/dealing) or item 4 (dealer bot V2 extension) if the user
directs otherwise — this session's pattern throughout has been the user
naming which numbered item to tackle next rather than the assistant
self-selecting scope. Ask, don't assume, if picking this up cold and the
user hasn't said which item.
