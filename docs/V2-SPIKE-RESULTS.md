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
3. **Move to a machine with AVX2** — or try bb.js `getVerificationKey` — to
   unblock proving time and the Garaga path.
4. **Then** deploy a Garaga verifier to Sepolia and get the gas number,
   which is what actually decides naive-vs-Bayer–Groth.

Nothing in the Cairo contract should change until step 4 reports.
