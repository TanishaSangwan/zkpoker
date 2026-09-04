# zkpoker protocol — collaborative shuffle, threshold decryption, no trusted dealer

**This supersedes the V1/V2 framing.** There is one protocol now. `docs/DESIGN.md`
(V1 trusted-dealer commit-reveal) and `docs/V2-MENTAL-POKER.md` describe earlier
designs and are kept only for history — where they disagree with this file, this
file wins. `docs/V2-SPIKE-RESULTS.md` stays authoritative for *measurements*,
because every number in it was taken from real runs.

Status: **specification + partial implementation.** What exists and what doesn't
is itemised in §10. Nothing here should be read as "built" unless §10 says so.

---

## 1. The design invariant

> **Generation** of every proof happens on the device holding the relevant
> secret — never on-chain, never on a shared server. **Verification** is the
> only thing that touches Starknet.

This is not a performance choice. Anything on-chain is public, so a proof
generated on-chain would broadcast the exact secret it exists to hide. And
verification must be on-chain, because that is what makes an outcome
*enforceable*: money moves only on results the contract checked itself.

Every design decision below follows from this one line.

---

## 2. Cryptographic foundation

| | Choice | Why |
|---|---|---|
| **Group** | Grumpkin | Base field = BN254's scalar field, so EC ops are *native* inside the proving system. Garaga supports it on-chain (curve id 5). Already used by the working Schnorr verifier |
| **Proof system** | UltraHonk (Noir + Barretenberg), Starknet flavour | No per-circuit trusted setup |
| **Card encoding** | card `i` → curve point `M_i = g^i` | Decryption yields a point; recover `i` by lookup in a 52-entry constant table |
| **Deck chaining** | Starknet-native Poseidon, computed **by the contract** | See §7 — this replaces the in-circuit Poseidon2 commitment |

### 2.1 Why not the STARK curve

An earlier draft of this protocol specified Starknet's native STARK curve for
all ElGamal/Schnorr/DLEQ, reasoning that it "avoids emulated-curve overhead."
That is true on-chain and **backwards in-circuit**, which is where the cost
actually lives.

A circuit's native field is BN254's scalar field. EC arithmetic is free only
for a curve whose *base field equals that field* — Grumpkin. The STARK curve's
base field is ~2^251; a product of two such elements (~2^502) overflows BN254
outright, so every multiplication needs multi-limb decomposition, hint-based
reduction, and range checks.

| Encryption curve | Shuffle circuit (104 scalar muls) | On-chain Schnorr/DLEQ |
|---|---|---|
| STARK curve | ~350K constraints *per* scalar mul → **~36M total**. Client-side proving impossible | Native, cheap |
| **Grumpkin** | native field arithmetic → **~500K total**, client-side proving viable | Garaga emulated, moderate |

The STARK curve moves emulation off the on-chain side — where Garaga makes it
cheap and there are only ~60 checks per hand — and onto the circuit side, where
there are 104 scalar muls and where client-side proving is non-negotiable per §1.

### 2.2 Why not Groth16

Groth16 verifies ~20–30× cheaper than Honk and has tiny proofs. It also needs a
**per-circuit trusted setup**. Whoever runs phase 2 for the shuffle circuit can
forge shuffle proofs — fabricate a "valid" shuffle that is not a permutation and
deal themselves aces undetectably, with every other check in the protocol still
passing.

That risk lands precisely on the claim this project exists to make. A
multi-contributor ceremony mitigates it and is standard practice, but
"provably fair, assuming the ceremony was honest" is materially weaker than
"there is no ceremony to compromise."

**This decision is cheap to revisit.** `cairo-verifier/src/lib.cairo`'s header
already notes why: verifiers live behind an address and an interface, so
swapping proof systems never touches `PokerGame`. Ship on Honk; revisit Groth16
with a real ceremony if mainnet volume ever makes gas binding.

#### A correction: the Keccak transcript is not the problem

An earlier version of this document claimed most of the 811M was **Keccak in
the Fiat–Shamir transcript**, and that Garaga's `ultra_starknet_zk_honk`
flavour — Poseidon instead of Keccak — would cut it to the 200–400M range.
**That was wrong, and it was measured wrong.**

Two findings:

**1. The variant does not exist.** Garaga 1.1.0 supports only `groth16` and
`ultra_keccak_zk_honk`. `ProofSystem.UltraStarknetZKHonk` is commented out in
`garaga/curves.py` with the note `# Disabled.`, the generator branch in
`gen.py` is commented out, and the Cairo side ships only `KeccakHasherState` —
no Poseidon hasher exists in `zk_honk_transcript.cairo` at all. 1.1.0 is also
the latest release on PyPI. The surrounding code is visibly dead:
`supported_curves` references `ProofSystem.UltraKeccakHonk` and
`UltraStarknetHonk`, neither of which exists as an enum member, so that path
would `AttributeError` if reached. Re-enabling it would mean generating a
security-critical verifier from code upstream deliberately disabled, with no
way to validate soundness beyond "it accepted one proof." Not done.

**2. It would barely have mattered.** Measured on devnet with a purpose-built
benchmark contract, per hash over a comparable payload:

| | L2 gas per hash |
|---|---:|
| `keccak::cairo_keccak` (128 u64 words) | **1,634,074** |
| `poseidon_hash_span` (64 felts) | **202,963** |

Poseidon is **8.1× cheaper per hash** — the intuition was right. But the ZK
Honk transcript performs roughly 27 digests (11 `digest()` sites, one inside a
`log_circuit_size` loop), so the whole swap is worth about **38.6M gas: 4.8%
of the 811M**. And 128 words per digest is generous for a 9,408-byte proof, so
treat 4.8% as an upper bound.

**Honk verification is expensive because Honk verification is expensive** —
pairings, MSMs and sumcheck, not hashing. The practical consequence is that
there is no cheap fix for the largest cost in this protocol. If per-hand gas
ever becomes binding, the real lever is Groth16 (structurally cheaper
verification, at the cost of a per-circuit ceremony — §2.2 above) or fewer
shuffle rounds (§9), not a different transcript hash.

---

## 3. The three proof systems

| | Proof | Generated by | Proves | Verified on-chain | Count @ n=6 |
|---|---|---|---|---|---|
| **1** | **Schnorr PoK** | each party, once per table | knowledge of `x_X` behind published `y_X` | immediately | 7 |
| **2** | **Shuffle** (SNARK) | each shuffler | `a_i` is a permutation + re-encryption of `a_{i-1}`, hiding π | immediately | 6 |
| **3** | **DLEQ** (Chaum–Pedersen) | every party, per card | `d_X = c1^{x_X}` for the *registered* `y_X` | community: immediately · hole: only at showdown | ~119 made, ~63 verified |

Only **one** is a SNARK. Schnorr and DLEQ are Sigma protocols — a few group
elements, generated in microseconds, no circuit, no setup. The entire gas and
latency budget collapses onto the shuffle.

Each blocks a distinct attack. Drop any one and there is a concrete theft:

- **No Schnorr** → rogue-key attack. The last registrant picks
  `y_last = X − Σ(others)` for an `X` whose secret they know. The joint key
  becomes theirs alone; they read every hole card at the table and *every
  shuffle proof still verifies*, because nothing about the shuffle is wrong.
- **No shuffle proof** → a cheater deals themselves aces.
- **No DLEQ** → a cheater lies about what their card decrypts to.

---

## 4. Protocol

### Phase 0 — Table setup (per table, not per hand)

1. Each party `X ∈ {P_1..P_n, D}` samples `x_X`, computes `y_X = g^{x_X}`, and
   builds a Schnorr PoK — **client-side**.
2. `register_shuffle_key(y_X, proof)` — contract verifies the PoK and stores `y_X`.
3. The contract accumulates `y = ∏ y_X` **incrementally**, one point addition per
   registration rather than `n` at the end.
4. Players escrow their buy-in (`join_table`).

The initial deck `a_0` needs neither storage nor calldata: defined as encryption
with `r = 0`, it is `(identity, M_i)` for `i = 0..51` — fully determined by the
card encoding, identical for every table, nothing to agree on or commit to.

### Phase 1 — Shuffle chain

For `i = 1..k` (see §9 on choosing `k`), player `P_i`:

**Client-side:** sample a secret permutation π and 52 re-randomization scalars;
compute `a_i` where `a_i[j] = (c1 + r_j·G, c2 + r_j·y)` for the card at `π(j)`;
generate the shuffle proof.

**On-chain:** `submit_shuffle(table_id, deck_out, proof)`. The contract:
1. recomputes `poseidon_native(deck_in)` from the proof's public inputs and
   asserts it equals the stored commitment,
2. verifies the proof,
3. stores `poseidon_native(deck_out)`,
4. advances the round and resets the deadline.

Re-randomization is what makes this worth proving. Permuting alone leaves output
ciphertexts byte-identical to inputs, so anyone could read the permutation
straight off.

The chain is **sequential** — `P_{i+1}` cannot start until `a_i` exists.

### Phase 2 — Dealing hole cards

For each hole-card position belonging to `P_i`:

1. Every other party `X` computes `d_X = c1^{x_X}` and a DLEQ proof, and sends
   both **privately to `P_i` only**.
2. `P_i` verifies each proof **client-side** — instant feedback, no chain round-trip.
3. `P_i` posts `Commit(all n+1 shares ‖ proofs ‖ ρ)` on-chain — one hash.
4. `P_i` recovers their card locally: `m = c2 · (∏ d_X)^{-1}`, then table lookup.

**`P_i` commits to the whole received set, not just their own share.** An earlier
draft had `P_i` commit only to `d_i`; at showdown the contract would then be
missing the other `n` shares — they were sent privately and never touched the
chain — and could not recompute the card at all.

**Privacy property:** decrypting `P_i`'s card requires `d_i = c1^{x_i}`, which only
`P_i` can compute. Every other party — including the dealer — can pool everything
they hold and remain one share short. Getting it means solving a discrete log.

> Nobody can read your hole cards, even if every other party at the table
> colludes.

### Phase 3 — Community cards (flop / turn / river)

1. All `n+1` parties compute `(d_X, proof)` and **broadcast publicly** — this card
   is meant to be seen.
2. **Any single party** (in practice the dealer bot) submits all `n+1` in one
   transaction. DLEQ proofs are self-authenticating — each binds `d_X` to the
   registered `y_X` — so it does not matter who carries them.
3. The contract verifies every DLEQ, computes `m = c2 · (∏ d_X)^{-1}`, maps `m`
   to a card index, and stores it.

An earlier draft specified "a single Starknet multicall … succeeds only if every
proof verifies." **A multicall is one account making many calls**, so `n+1`
different players cannot share one. It is also unnecessary: the contract does the
combination itself, so a malicious submitter can only *refuse* — a liveness
failure, never a soundness one.

> A fully malicious dealer cannot produce a wrong community card.

### Phase 4 — Showdown

The player opens their Phase-2 commitment, publishing all `n+1` shares and proofs.
The contract rehashes the opening against the stored commitment, verifies every
DLEQ, recomputes the card, and feeds it to `best_of_7`.

**No new proof is generated here.** The player republishes DLEQ proofs the *other*
parties produced during dealing — the proving work happened before they had even
seen their cards. This step needs soundness, not zero-knowledge: nothing is being
hidden, so no SNARK is involved and it is orders of magnitude cheaper than a shuffle.

Three independent locks make the card unique:

- **The ciphertext is pinned** by the verified shuffle chain.
- **The commitment binds** — posted during dealing, *before betting*, so no
  shopping for a friendlier share set after seeing the board.
- **DLEQ is sound** — fabricating a share means forging against a registered key.

A player who declines to open simply does not win. Mucking stays legal; the
contract pays only hands it verified itself. Most hands end with everyone folding
to one player, and cost nothing here.

### Phase 5 — Settlement

Existing escrow/pot machinery pays out the strongest verified hand, splitting ties.

---

## 5. Exactly what is on-chain

### Storage (persistent, contract-readable)

| What | Size @ n=6 |
|---|---|
| `shuffle_key[table, party]` | 7 × 4 felts (Grumpkin coords are ~254-bit → `u256` → 2 felts each) |
| `joint_key[table]` | 4 felts |
| `deck_commitment[table]` | 1 felt — **hash only**, overwritten each round |
| `shuffle_round`, `deadline` | 2 felts |
| `hole_commitment[table, seat, slot]` | 12 × 1 felt |
| `community_card[table, k]` | 5 felts, plaintext |
| `revealed_hole[table, seat]` | ≤ 12 felts |
| pot / escrow / settled | existing, audited |

≈100 slots per hand. **The deck is never in storage.**

### Calldata (published and auditable, not contract-readable afterward)

| What | Size |
|---|---|
| Deck as proof public inputs | 208 values → 416 felts |
| Shuffle proof + Garaga hints | ~3,000 felts (measured: 3,053) |
| Community decryption shares | 7 × ~50 felts |
| Showdown openings | ~700 felts per showing player |

Starknet settles only *state diffs* to L1 — measured L1 data gas for a verifier
call was **128** — which is why publishing whole decks this way is affordable.

### Never on-chain, in any form

Secret keys `x_X` · permutations π · re-randomization scalars · hole-card shares
during play (commitment only) · **the hole cards themselves**, unless voluntarily
shown at showdown.

---

## 6. Cost

All three primitives are now measured on devnet from real transaction receipts,
positive and negative cases both.

| | Shuffle proof | Deck opening | **DLEQ share** |
|---|---|---|---|
| Proof generation | 7,209 ms | 764 ms | **~instant (Sigma)** |
| Calldata | 3,053 felts | 2,989 felts | **58 felts** |
| **L2 gas to verify** | **811,907,200** | **772,299,520** | **64,607,680** |
| L1 data gas | 128 | 128 | 128 |

A DLEQ costs **12.6× less** than a SNARK verification, and its calldata is
**53× smaller**. That gap is the whole reason only the shuffle needs a circuit.

### 6.1 Per hand at n=6 — and the surprise

| Phase | Count | L2 gas |
|---|---:|---:|
| Shuffle chain (k=6) | 6 | 4,871,443,200 |
| **Community DLEQ** (5 cards × 7 shares) | 35 | **2,261,268,800** |
| **Showdown DLEQ** (2 players × 2 cards × 7) | 28 | **1,809,015,040** |
| Deck opening | 1 | 772,299,520 |
| Schnorr registration | 7 | *(per table, not per hand)* |
| **Total** | | **≈ 9.7 billion** |

**DLEQ verification is 42% of the hand — more than the entire shuffle chain.**
That inverts the assumption this protocol was designed around. Individually a
DLEQ is cheap; there are just 63 of them, and `n`-of-`n` threshold decryption
means the count grows with players *and* with cards.

### 6.2 Share aggregation — built and measured, `O(1)` in players

Random-linear-combination batching, the obvious approach, **loses**: combining
`n+1` proofs gives two MSMs of size `2n+3`, which at n=6 is 30 scalar muls
against 28 unbatched.

The structure that works exploits two facts the protocol already has: every
share of one card uses the **same** `H = c1`, and the contract already stores
the **joint key** `Y = Σ y_X`. Since `Y = X·G` and `D = Σ d_i = X·H` for the
joint secret `X = Σ x_i`, the statement `log_G(Y) = log_H(D)` is a *single*
DLEQ — and the individual proofs sum directly into one:

```
R1 = Σ k_i·G = K·G      R2 = Σ k_i·H = K·H      S = Σ (k_i + e·x_i) = K + e·X

S·G − e·Y = (K + eX)G − e(XG) = K·G = R1        (and likewise for H, D)
```

**Measured on devnet, and it needs no contract change** — it is the same
`DleqVerifier` with `(Y, H, D)` substituted for `(PK, H, d)`:

| Parties aggregated | Calldata | L2 gas | Result |
|---:|---:|---:|---|
| 2 | 58 felts | — | `true` |
| 7 | 58 felts | **64,327,680** | `true` |
| 24 (max table) | 58 felts | **64,007,680** | `true` |
| 7, one dishonest | 58 felts | — | **`false`** |

Flat in the number of players. **7× cheaper at n=6, 24× at a full table.**

Two things this costs, both real:

- **A commitment round is mandatory.** `e` depends on `R1 = Σ R1_i`, so whoever
  reveals last could grind their `R1_i` against everyone else's — the classic
  naive-multisignature weakness (Wagner; the original MuSig flaw). Deployment
  must run three rounds: commit `Poseidon(R1_i, R2_i)`, reveal only once every
  commitment is in, then compute `s_i`. Shares are exchanged off-chain anyway,
  so this is free on-chain. `scripts/dleq_prove.py` models the honest case and
  does **not** enforce it — the dealer bot must.
- **Accountability is lost on failure.** A failed aggregate proves someone
  cheated but not who. The fallback is to demand individual proofs and verify
  those at `(n+1) × 64.6M` to identify the culprit — expensive, but only on
  dispute, which is the right way round.

### 6.3 Revised per-hand cost

| Phase | Count | L2 gas |
|---|---:|---:|
| Shuffle chain (k=6) | 6 | 4,871,443,200 |
| Deck opening | 1 | 772,299,520 |
| Community DLEQ (aggregated) | 5 | 321,638,400 |
| Showdown DLEQ (aggregated) | 4 | 257,310,720 |
| **Total** | | **≈ 6.22 billion** |

Down from 9.7B. DLEQ falls from **42% of the hand to 9%**, and the shuffle
chain is decisively dominant again at 78%.

The remaining lever is the shuffle, and both cheap versions of it are now
closed off. Swapping the transcript to Poseidon is worth ~4.8% and does not
exist in Garaga 1.1.0 (§2.2). Capping the chain below `n` is **rejected on
security grounds** (§9.1). What is left:

- **Shuffle the next hand's deck during the current hand's betting** (§9).
  Does not reduce gas, but removes the latency entirely from the critical path.
- **Groth16**, if per-hand gas ever becomes genuinely binding — structurally
  cheaper verification, paid for with a per-circuit trusted setup (§2.2).

**~6.2B L2 gas per hand is the honest number for a fully trustless hand**, and
it does not currently go lower without giving something up. That is the
correct trade for this project: the shuffle chain is the guarantee, not an
overhead to be optimised away.

Cheap hands stay cheap: everyone folding pre-flop reveals no community cards
and reaches no showdown, costing **zero** verifications beyond the shuffle.

### 6.2 Still estimated

- Poseidon-transcript Honk (`ultra_starknet_zk_honk`) landing in the 200–400M
  range (§2.2). Unverified, and now clearly worth doing — it would cut the
  largest remaining term.
- Browser proving (§9).

---

## 7. The cross-field hash problem, and its resolution

`circuits/shuffle/src/main.nr` commits to both decks with **Poseidon2 over
BN254** and exposes only 4 public inputs. Its own comments flag the consequence
as a blocking design question:

> this circuit works over BN254, while Starknet's native Poseidon is over the
> STARK field. There is no cheap primitive shared by both.

So the contract **cannot** check that a submitted deck matches the committed
hash — that would mean implementing BN254-Poseidon2 in Cairo over emulated
254-bit arithmetic.

This is not cosmetic. Without that binding, whoever posts the deck can fabricate
one entirely: anyone can encrypt any `M_i` under the *public* joint key as
`(r·G, M_i + r·y)`. Every subsequent decryption succeeds and yields exactly the
cards the attacker picked, with every DLEQ verifying honestly. Complete break.

### 7.1 The obvious fix does not work — measured

The tempting fix is to stop hashing in-circuit: expose both decks as public
inputs and let the contract chain rounds with its own native Poseidon. It was
built and it is a dead end.

**Garaga 1.1.0 cannot generate a verifier for a circuit with more than 99 total
public inputs.** It builds an internal identifier
`zk_honk_sumcheck_size_<log_n>_pub_<num_public_inputs>` and asserts it fits a
felt252 short string:

```
AssertionError: Name 'zk_honk_sumcheck_size_17_pub_434' is too long
to fit in a felt252, size is: 32
```

The prefix is 29 characters at `log_n = 17`, leaving exactly two digits. Exposing
both decks needs 418 real inputs + 16 for the pairing-point object = **434**.

This is an upstream limitation, not a misconfiguration. Cairo short strings cap
at 31 characters — a constraint `HANDOFF.md` §8 already documents this project
hitting once before, in test assertion messages.

For the record, the change did work up to that point: the circuit compiled and
solved, and gate count dropped **92,352 → 82,133** (bb.js 5.2.0
`acirGetCircuitSizes`, same ACIR both sides). But both sit in the same 2^17
subgroup, so it bought headroom, not speed.

### 7.2 What actually works: a separate deck-opening proof

Keep the shuffle circuit exactly as it is — decks private, Poseidon2 commitments,
4 public inputs. The contract stores `hash_out` as an **opaque `u256` lifted
straight out of the proof's public inputs**. It never computes a hash; it only
ever compares two.

Then a second, much smaller circuit (`circuits/deck_open/`) proves what the
committed deck holds at chosen positions:

```
main(deck_hash: pub, positions: pub [K], cards: pub [4K], deck: private [208])
    assert Poseidon2(deck) == deck_hash
    for each i: assert deck[4*positions[i] .. +4] == cards[4i .. +4]
```

The contract checks `deck_hash` equals its stored commitment — a `u256`
comparison — and takes `cards` as verified ciphertexts. The BN254/STARK-field
mismatch is never bridged because it is never crossed.

**Measured end-to-end on devnet, both directions:**

| | Shuffle verifier | Deck-open verifier |
|---|---|---|
| Public inputs | 20 | 42 |
| ACIR opcodes | 1,756 | 363 |
| Proof generation | 7,209 ms | **764 ms** |
| Proof size | 9,408 B | 8,256 B |
| Starknet calldata | 3,053 felts | 2,989 felts |
| **On-chain verification** | **811,907,200 L2 gas** | **772,299,520 L2 gas** |

Positive test: returns `Ok` with all 26 public inputs — `deck_hash` reconstructed
exactly, positions `0,1,2,3,4`, and the first card matching `deck_out[0]`
byte-for-byte. Negative test: one felt flipped mid-proof → `Err("Proof
verification failed")`.

**The important number is that 772M is barely below the shuffle's 811M.** Honk
verification cost is dominated by fixed pairing and MSM work, not by circuit
size — a circuit 5× smaller costs 5% less to verify. So an opening proof is
priced like a shuffle proof, and the protocol must use as few as possible.

### 7.3 Consequence: one opening per hand

Opening a ciphertext reveals *nothing* — the ciphertexts are already public in
the deck, and the card values come only from DLEQ decryption later. So all
in-play positions can be opened **once**, immediately after the shuffle chain,
and revealed progressively afterwards.

At n=6 that is 12 hole + 5 community = 17 cards. Dropping `positions` from the
public inputs in favour of a fixed canonical order (seat 0 card 0, seat 0 card 1,
… then community 0–4 — the contract knows the convention) gives
`17 × 4 + 1 = 69` public inputs, + 16 = **85**. Under the 99 cap.

One opening proof per hand, not one per reveal.

---

## 8. Liveness: `n`-of-`n` cuts both ways

Decryption needs a share from **every** party. There is a real asymmetry in what
that buys:

| | `n`-of-`n` is… | Why |
|---|---|---|
| **Hole cards** | a **feature** | Nobody reads your cards even if everyone else colludes |
| **Community cards** | a **liability** | One dropout freezes the table permanently — and the card becomes public anyway, so what is it protecting? |

If a player closes their laptop after the flop, nobody can compute their share and
the turn can never be revealed. **Timing them out does not help** — folding a
player does not produce their share.

Options for community cards:

- **Void-and-refund on timeout.** Simplest and honest, but any player can grief a
  table by walking away.
- **Threshold `t`-of-`n`** via Shamir-shared keys. Survives dropouts; cost is that
  `t` colluding players could decrypt the board *early*, before betting.
  `t = n−1` tolerates exactly one dropout while requiring near-total collusion.

Recommended: `t = n−1` for community cards, strict `n`-of-`n` for hole cards.
**Open decision** — it changes Phase 0, so it must be settled before the state
machine is built.

Separately, a party who never delivers a hole-card share deadlocks that player with
no on-chain evidence of who did it — free griefing. Needs an **accusation path**:
`accuse(table_id, X)` forces `X` to post their share publicly within a deadline or
forfeit. Same shape as the existing `claim_shuffle_timeout`.

---

## 9. Sequencing and UX

The shuffle chain is sequential: 6 rounds of (prove → submit → confirm), roughly
**34 s of pure proving** plus block confirmations — 1–3 minutes before the first
card is dealt.

One mitigation, not built:

- **Shuffle the next hand's deck during the current hand's betting.** Pipelines
  the cost away entirely, changes no security property, and is the right fix.

### 9.1 Why the chain is NOT capped at `k < n` — rejected

Capping the chain looks like free money: "unbiased as long as ≥1 shuffler is
honest" does not obviously require all `n`, and `k=3` would cut ~2.4B L2 gas
and ~17 s of proving. It was implemented and then **reverted**, because the
premise is wrong.

If every seat in the chain colludes, they know the composed permutation
`π₁∘…∘π_k`. `a_0` is canonical and public, so knowing the composition tells
them exactly which card sits at every position of the final deck — and seat
`i`'s hole cards are always at positions `2i` and `2i+1`. **They read the
entire table without decrypting anything.** The joint key does not help here;
no decryption is involved.

So a player outside the chain gets **no protection from it at all**. "Cap at
`k=3`" means seats 3…n−1 are trusting seats 0…2 — structurally the same
trusted-dealer arrangement this protocol exists to remove, just with a
different set of trustees.

A voluntary opt-in variant was also built and reverted. It is sound for anyone
who opts in — your own permutation stays secret, so you are protected no matter
who else cheats — but opting *out* still means trusting, and a player saving
gas without understanding they have surrendered the guarantee is a footgun in a
game with money on the table. Given the choice between a cheaper hand and a
hand nobody has to trust anyone for, this project takes the second.

**Every player shuffles. `k = n`. The cost stands.**

Also unverified: the 5.67 s was measured with the WASM backend *server-side*.
**Browser proving has never been tested.** Same WASM, so it should be comparable —
but "should be" is not "measured," and the entire client-side story rests on it.

---

## 10. What exists, what doesn't

**Built and working:**
- `cairo-verifier/` — Schnorr PoK verifier on Grumpkin, via Garaga. The rogue-key defence.
- `cairo/src/poker_hand.cairo` — hand evaluation, 24 passing unit tests.
- `PokerGame` betting/escrow/pot/payout — seven audit rounds.
- `circuits/shuffle/` — real ElGamal-over-Grumpkin shuffle circuit with a correct
  bijection check. Real witness, real proof.
- `circuits/shuffle_verifier/` — Garaga-generated Cairo verifier, deployed to devnet,
  genuinely accepted a real proof and rejected a corrupted one.
- `cairo-verifier/src/adapter.cairo` — **the single contract `PokerGame` talks to.**
  Routes all four checks to their real verifiers and, for the two Garaga ones,
  binds the returned public inputs to what `PokerGame` asked about. Measured
  overhead: **271,360 L2 gas, 0.04%**. A valid proof replayed against a
  different deck hash is rejected (`false`), which is the point.
- `scripts/dealer_bot.mjs` — off-chain dealer skeleton (drives the *old* flow).

**Not built:**
- The §7 circuit change (public-input decks) and re-measurement.
- ~~Joint-key accumulation on-chain~~ — **done, 2026-09-04.**
  `VerifierAdapter::verify_joint_key` sums the registered shares on Grumpkin
  with `ec_safe_add` and compares both coordinates; `begin_shuffle` collects
  the shares in the same walk that freezes the participant list and asserts on
  the answer. Until this landed, `joint_pk_x/y` was a dealer-supplied parameter
  nothing on-chain checked: a dealer could publish a key of their own choosing
  and read every hole card at the table while every proof in the chain still
  verified, because the shuffle circuit honestly proves re-randomisation under
  whatever key it is handed and each seat's Schnorr proof only says that seat
  knows its own secret. Nothing tied the two together.

  The adapter rejects off-curve shares (the group law does not hold there), a
  sum of infinity (`Y = O` makes `c2 = M + r*Y = M` — every card in the clear),
  and compares **both** coordinates, since `-Y` shares `Y`'s x and is a
  different key. Measured: **2.49M L2 gas at 3 seats, 4.83M at 23** — about
  117K per additional seat, and 0.6% of one shuffle-proof verification at the
  largest table the contract allows. Verified against real curve points in
  `cairo-verifier/tests/test_joint_key.cairo`; fixtures from
  `scripts/joint_key_check.py`, which independently checks that the
  point-by-point sum equals `(Σ secrets)·G`.
- ~~`initial_commitment` is still dealer-supplied~~ — **done, 2026-09-04.**
  The parameter is gone: `a_0` depends on nothing — not the joint key, not the
  players, not the table — so `PokerGame` pins `INITIAL_DECK_COMMITMENT`
  instead and there is nothing left to supply or disagree about.

  Not a secrecy break, but not harmless either. Shuffles only permute and
  re-randomise, so the multiset of cards in play is whatever the starting deck
  contained. A dealer colluding with the first shuffler could name a commitment
  to a deck of their own choosing: duplicates, missing cards, or points outside
  the 52-card encoding, which strand the hand at reveal time.

  The value is `Poseidon2(a_0)` =
  `0x1673af0c7a0064af6bb3a70b30eec058d85bec4857307bde801f9244ba8271ad`. Cairo
  cannot compute it (§7 — Poseidon2 is over BN254, Cairo's Poseidon is over the
  STARK field), so it is produced by the new `circuits/deck_init`, which builds
  `a_0` in-circuit and returns the hash. `scripts/check_initial_commitment.py`
  re-runs that circuit and compares it against both the contract constant and
  the test fixture, so the two copies cannot silently drift.

  Verified end to end rather than by construction: the **untouched**
  `circuits/shuffle` solves its witness with `deck_in = a_0` and `hash_in` set
  to this value, confirming both the constant and the identity encoding
  (`(0, 0)`, which is what Noir's embedded-curve addition treats as the
  identity) are what the first link of the chain actually consumes.
- **Showdown scoring** — `settle_from_reveals` scores from cards the contract
  itself proved and pays out. Takes **no caller input beyond the table**: every
  card comes from storage a reveal proof bound, every payout note from
  `join_table`'s binding, so anyone may settle and nobody can steer it. An
  uncontested pot needs no cards shown at all.
- The accusation path (§8) and the threshold decision.
- Any client UI for the above; browser proving.
- ~~Bet-matching and turn-order enforcement~~ — **done.** `bet`/`fold`/`check`
  are turn-ordered; a street cannot end until every seat still in the hand has
  acted since the last raise and matched the high; a raise reopens the action.

**To be deleted:** V1 commit-reveal (`commit_deal`/`reveal_seed`/`shuffle.cairo`),
`MockShuffleVerifier`, the seed-based fairness UI.

---

## 11. Build order

1. **Poker rules** — bet matching, turn order. Against existing audited machinery;
   the difference between a toy and a real game.
2. **Circuit change (§7)** + regenerate verifier + **measure** the three unknowns in §6.
3. **DLEQ** — Cairo verifier and client prover.
4. **Phase 2–4 state machine** + accusation path.
5. **Dealer bot** rework for the new flow.
6. **Client** — key registration, shuffle proving in-browser, share exchange, showdown.
7. **Audit** the whole new surface, per `HANDOFF.md` §5's process.

Steps 1 and 2 are independent and can proceed in either order.
