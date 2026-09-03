# V2 spike results: shuffle circuit cost

Spike defined in `V2-MENTAL-POKER.md` §9. Run 2026-08-31.

**Status: partially complete.** Circuit built and gate counts measured. The
on-chain verification gas — the number the kill criteria actually turn on —
is **not** measured yet, and is blocked (§5).

Circuit: `circuits/shuffle/` (`src/main.nr`).

---

## 1. Toolchain (pinned)

| Tool | Version | Note |
| --- | --- | --- |
| `nargo` | 1.0.0-beta.22 | Not the latest (beta.26). Pinned deliberately: beta.22 is the newest entry in Aztec's `bb-versions.json`, so it is the newest Noir with a *known-good* bb pairing. Using beta.26 would have meant guessing at ACIR compatibility. |
| `bb` | 5.0.0-nightly.20260522 | The pair beta.22 maps to. |
| `@aztec/bb.js` | 5.0.0-nightly.20260522 | WASM build, same version. This is what actually produced the numbers — see §5. |

Both installed userland (`~/.nargo`, `~/.bb`), no root.

---

## 2. Measurements

Circuit as specified: 52 cards, permute + re-randomize, ElGamal over
Grumpkin, deck commitments public and decks private.

| Variant | Gates | Subgroup | Commitment overhead |
| --- | --- | --- | --- |
| Shuffle core only (no commitments) | 81,719 | 2^17 | — |
| **Poseidon2 commitments** ← shipped | **92,352** | **2^17** | **+10,633** |
| Pedersen commitments | 211,559 | 2^18 | +129,840 |

All three are the same circuit differing only in the commitment scheme, so
the overhead column is attributable to the hash alone. ACIR opcodes for the
Pedersen variant: 4,535.

**Poseidon2 is 12x cheaper than Pedersen here** (10,633 vs 129,840 gates
for two 208-field hashes) and keeps the circuit at 2^17 instead of 2^18 —
halving the proving work. `circuits/shuffle/` uses Poseidon2 on the
strength of this measurement.

---

## 3. Findings

**The naive per-card construction is cheaper than the spec assumed.** The
104 Grumpkin scalar muls come to 81,719 gates. `V2-MENTAL-POKER.md` §5
called them "the cost driver" and named Bayer–Groth as the likely
optimization; at this size the shuffle core is not obviously the thing to
replace, and Bayer–Groth is not urgent.

**The commitment scheme mattered more than the elliptic-curve work — until
it was changed.** With Pedersen, hashing 208 field elements twice cost
~129,840 gates, *more than the entire shuffle*, and pushed the circuit
across a power-of-two boundary into 2^18 — doubling proving work rather
than merely adding to it. Swapping to Poseidon2 cut that to ~10,633 and
brought the circuit back to 2^17.

The lesson generalizes: at this circuit size the commitment scheme was
worth more attention than the cryptographic core, and the first choice was
made for availability (Pedersen is a native stdlib blackbox in this Noir
version, Poseidon2 is not) rather than cost. Worth re-checking whenever a
primitive gets chosen because it was simply the one to hand.

**Where the circuit now stands: 92,352 gates, 2^17.** That is an ordinary
circuit size, not an alarming one. Whether it is *affordable* still depends
entirely on §5's unmeasured verifier gas.

## 3a. A cross-field problem the commitment choice runs into

Whatever hash is chosen has a constraint beyond gate count: this circuit
works over **BN254**, while Starknet's native Poseidon is over the **STARK
field**. There is no cheap primitive shared by both, so "hash the deck
in-circuit, re-hash the calldata in Cairo, compare" does not have an
obvious efficient implementation.

Options, none free, all unmeasured: have the contract not re-hash at all
and treat deck/commitment mismatch as an off-chain dispute (weakens the
guarantee); make the decks public inputs so no in-circuit hash is needed
(option 2 above); or eat a non-native hash on one side. **This is now a
blocking design question for §4.3 of the protocol spec, not a footnote.**

---

## 4. What this implies per hand

One shuffle proof per player per hand, chained. At *n* players that is *n*
proofs of this size, sequentially, before any card is dealt (spec §7).

Gate count alone doesn't decide affordability — the verifier cost on
Starknet does, and that is exactly what is still missing.

---

## 5. Blocked: proving time and on-chain gas

**This host cannot run the native prover.** The CPU (Intel Core Ultra 5
226V, in a VM) reports `avx: NO` / `avx2: NO` — the hypervisor does not
expose AVX to the guest — and the official `bb` binary is AVX2-compiled, so
it dies with SIGILL (exit 132) on every invocation, `--version` included.
`@aztec/bb.js`'s `bb` CLI shells out to the same native binary and fails
identically.

Gate counts above came from bb.js's **WASM** backend, which does not need
AVX2. That worked fine.

**Not measured, and deliberately not estimated:**

- **Proving time.** WASM, single-threaded, on 2 vCPUs without AVX2 is so
  far from the "normal laptop" the kill criterion names that any number
  from this host would be misleading rather than conservative. Needs a
  machine with AVX2.
- **Starknet verification gas.** Needs the Garaga verifier generated from a
  VK, deployed to Sepolia, and called. Two blockers: `bb write_vk` is the
  native binary (bb.js's `getVerificationKey` is a possible way around
  it, untested), and deploying to Sepolia needs a funded account, which
  needs the project owner.

**So the §9 kill criteria cannot be evaluated yet.** The gate counts are
encouraging on their own — 2^17 is an ordinary circuit size, not an
alarming one — but "encouraging" is not the bar the spec set.

---

## 6. Next steps

1. ~~Measure Poseidon2 as the commitment~~ — **DONE**, and adopted: 12x
   cheaper than Pedersen, circuit back to 2^17 (§2).
2. **Measure the public-deck variant** (no in-circuit hashing at all). Now
   a much narrower trade than it was: it would save only the remaining
   ~10,633 gates while adding ~416 public inputs, so it is probably not
   worth it — but it is the natural escape hatch if §3a's cross-field
   problem has no good answer.
3. ~~Move to a machine with AVX2 — or try bb.js `getVerificationKey`~~ —
   **PARTIALLY DONE, see §7**: still no AVX2 on this host (re-confirmed,
   not just carried over from the old assumption), but WASM proving turned
   out fast enough that AVX2 is no longer the blocker it looked like.
   `getVerificationKey` works.
4. **Then** deploy a Garaga verifier to Sepolia and get the gas number,
   which is what actually decides naive-vs-Bayer–Groth. **Still blocked**
   — see §7's Garaga finding. Deploying to Sepolia also still needs a
   funded account from the project owner, independent of that.

Nothing in the Cairo contract should change until step 4 reports.

---

## 7. Real proof generated and verified (2026-09-01)

Picking up exactly where §5/§6 left off. Same host as the whole spike —
re-confirmed, not assumed: `bb` still SIGILLs (exit 132) here, no AVX2 in
this VM (the very first re-check this session used a shell one-liner whose
exit status was always 0 because of a `grep | head` pipeline bug, which
briefly looked like AVX2 was present — it isn't; corrected before relying
on it for anything).

### 7a. A real witness — the first one this circuit ever had

`circuits/shuffle/Prover.toml` held all-zero placeholders through the whole
spike (§1–§6) — enough for `nargo compile`'s gate count, which doesn't
check constraint satisfaction, but not a witness anyone could actually
prove with; all-zero `perm` fails the circuit's own injectivity check on
the second iteration.

Built a real one with a throwaway companion Noir program
(`circuits/witness_gen/`, deleted after use) that computes genuine Grumpkin
points via the same `std::embedded_curve_ops` the shuffle circuit uses —
joint key `PK = 7·G` (test-only secret), the deterministic initial deck
(fixed randomness `r0=1`, per §4.2 of the protocol spec), a real derangement
permutation (reverse order), and distinct re-randomization scalars — then
prints every value `nargo execute` needs, in TOML-ready form.

**Checked, not assumed:** running `nargo execute` on the real
`circuits/shuffle/` circuit against this witness reports "Circuit witness
successfully solved" — every constraint holds: both Poseidon2 commitments,
the permutation-injectivity check, and all 104 EC re-encryption ops.

### 7b. Real proving time and proof size — the §9 kill criterion, measured

`@aztec/bb.js@5.0.0-nightly.20260522` (the pinned version, §1), forced onto
its WASM backend (`BackendType.Wasm`, so it can't silently fall back to the
broken native binary):

| Step | Time | Notes |
| --- | --- | --- |
| Barretenberg WASM init | 761 ms | |
| **Proof generation** | **5.67 s** | default target — 458 fields, 14,656 bytes |
| **Proof verification** | **1.04 s** | same run, `verifyProof` |

Re-run with `verifierTarget: 'evm'` (keccak-zk — the target Garaga actually
consumes, §7c) for a second, independent data point: **5.63 s** to prove,
proof **9,152 bytes**, verified locally (`true`).

**This resolves the open kill criterion.** §9 of the protocol spec said "if
proving time on a normal laptop is bad enough to break the UX, reconsider
table size or pipelining." ~5.6 seconds, on a 2-vCPU VM with no AVX2 and a
single-threaded WASM backend — the *worst* case this project has access to
— is not that number. A real machine will be faster. Six players shuffling
in sequence is on the order of 30–40 seconds of proving, which is slow
enough to design the UX around (progress indicator, maybe pipeline the next
hand's shuffle during the current showdown) but not the "implausible"
outcome the kill criterion was checking for.

### 7c. Garaga: installed, and a real, diagnosed blocker

`garaga` was not installed anywhere before this session (`ModuleNotFoundError`
on a bare `import garaga`). Getting it installed was its own small blocker:
`pip install garaga` failed building `crypto-cpp-py` from source (no
prebuilt wheel for this host's Python 3.13; wheels exist only up to
cp312) — needed `cmake`, which needs `apt install cmake`, which needs root
this environment doesn't have. **Worked around**, not skipped: downloaded
Kitware's portable static `cmake` release tarball, put it on `PATH` for the
build only. `garaga==1.1.0` installed clean after that — genuinely usable,
not a partial install.

**`garaga gen`'s only working Honk system is `ultra_keccak_zk_honk`** (its
own source: `ProofSystem.UltraStarknetZKHonk` exists in the enum but is
commented `# Disabled.`) — so the target is `verifierTarget: 'evm'`/`'evm-no-zk'`
on the bb.js side, not `'starknet'` (which this bb.js build also flatly
rejects: `Invalid proof system settings: oracle_hash_type='starknet'...`,
reproduced under every flag combination tried, and again on
`@aztec/bb.js@6.0.0-nightly.20260831` — not a version-pin issue, that
oracle mode just doesn't work against this circuit on either release).

With the correct target, VK extraction and proof generation both succeed
(§7b's second row). But `garaga gen --system ultra_keccak_zk_honk --vk ...`
fails:

```
AssertionError: invalid public inputs offset: 5
```

from `garaga`'s own `HonkVk.from_bytes` (`precompiled_circuits/zk_honk.py`),
which hardcodes `assert public_inputs_offset == 1`. **Diagnosed, not just
hit:**

- Decoded the VK header by hand (bytes `[0:32]`=`log_circuit_size`,
  `[32:64]`=`public_inputs_size`, `[64:96]`=`public_inputs_offset` — same
  fields `HonkVk.from_bytes` reads): our VK reports `log_circuit_size=17`
  (matches the measured 2^17 circuit exactly — a real cross-check that the
  parsing is right), `public_inputs_size=12`, `offset=5`. Garaga's own
  bundled example VK (`garaga/starknet/honk_contract_generator/examples/
  vk_ultra_keccak.bin`, a small 2^12 test circuit) reports `offset=1`.
- **Ruled out ZK-masking as the cause**: re-extracted the VK with
  `verifierTarget: 'evm-no-zk'` — offset is still 5. Not a ZK-vs-non-ZK
  artifact.
- **Ruled out a bb version mismatch**: identical offset (5) from both
  `@aztec/bb.js@5.0.0-nightly.20260522` (pinned) and
  `@aztec/bb.js@6.0.0-nightly.20260831` (current). If this were a stale-bb
  problem, the two releases should have disagreed.
- Public inputs count (12) doesn't match this circuit's real 4 (`pk_x,
  pk_y, hash_in, hash_out` — the number bb.js itself reports for "public
  inputs" in the proof). Something in Honk's VK serialization is counting
  or offsetting differently than `garaga==1.1.0`'s parser expects,
  independent of anything on this project's side.

**Net position:** the ZK proving pipeline itself — witness, proof,
verification — is real, fast, and confirmed correct. Turning that into a
*deployed on-chain verifier* via Garaga is not a "try again with more
patience" blocker; it's a specific, reproduced incompatibility between this
circuit's Honk VK layout and `garaga==1.1.0`'s parser that needs upstream
investigation (an older/newer garaga release, or filing the exact
repro above) before it's worth spending more time on locally.

### 7d. What this changes in §9's kill criteria

- Proving time: **cleared** (§7b).
- Verification gas: **cleared — see §8**, resolved the same session.

---

## 8. A real verifier, deployed, and the real gas number (2026-09-01)

§7c's blocker turned out to have a real fix, not just a diagnosis. Garaga's
own docs pin a specific toolchain — `nargo 1.0.0-beta.16` + `@aztec/bb.js@
3.0.0-nightly.20251104` — quite different from this project's pinned
`nargo 1.0.0-beta.22` + `bb 5.0.0-nightly.20260522` (chosen for §1's
gate-count measurements, on different grounds). A VK generated with that
older pairing reports `public_inputs_offset = 1`, `public_inputs_size = 20`
(the real 4 public inputs + Barretenberg's fixed 16-element pairing-point
object — confirms the §7c hypothesis exactly). Full toolchain/circuit-patch
details are in `circuits/shuffle_verifier/README.md`; the short version is
three small, mechanical incompatibilities (an `EmbeddedCurvePoint`
constructor that doesn't exist in beta.16, a pinned `poseidon` crate
version that doesn't compile against beta.16's stdlib, non-ASCII comment
characters beta.16's parser rejects) — not a rewrite.

**`garaga gen` succeeded** against a VK from this pairing — a real,
compiling `UltraKeccakZKHonkVerifier` contract
(`circuits/shuffle_verifier/`). Declared and deployed to a local
`starknet-devnet`. Then, genuinely tested both directions, not just the
happy path:

- **A real proof, verified on-chain**: called
  `verify_ultra_keccak_zk_honk_proof` with real calldata (`garaga
  calldata`, 3,053 felts) for the same real shuffle witness §7 proved
  locally. Returned `Ok` with all 4 public inputs — reconstructed `pk_x`
  from the returned `(low, high)` u256 by hand and confirmed it matches
  the value committed to at proving time exactly.
- **A corrupted proof, rejected on-chain**: flipped one felt deep in the
  proof body (index 500 of 3,053, well past the public-inputs prefix) and
  called the same entrypoint. Reverted with `"proof point not on curve"` —
  a real cryptographic rejection, not a rubber stamp.

**The real gas number** (`starknet_getTransactionReceipt` on the accepted
verification, actually invoked as a state-changing transaction, not just
estimated):

| | |
| --- | --- |
| L2 gas | **811,907,200** |
| L1 gas | 0 |
| L1 data gas | 128 |
| Fee charged (devnet pricing) | **≈0.812 STRK** |

This is devnet's gas *pricing*, not necessarily Sepolia/mainnet's — but the
L2 gas *amount* is a protocol-level execution-cost figure that should carry
over. At 6 players/hand that's ≈4.87 billion L2 gas and ≈4.87 STRK in
verification fees alone, sequential (spec §7's own latency note — six
shuffle txs can't parallelize regardless of gas). **This is the number
§9's kill criteria have been waiting on since the spike began** — judging
whether that's affordable for a real table size is now a real decision on
real data, not a placeholder.

**What this does NOT close:**

- `verify_ultra_keccak_zk_honk_proof`'s interface doesn't match
  `IShuffleVerifier::verify_shuffle` — `PokerGame` isn't wired to this yet.
  Needs a thin adapter contract, not a direct swap for
  `MockShuffleVerifier`.
- Client-side proving in a browser is still completely untested — §7's
  proving happened in Node.
- Only the shuffle proof is covered. The DLEQ decryption-share proof
  (spec §4.4–§4.6) has no circuit and no verifier at all yet.
