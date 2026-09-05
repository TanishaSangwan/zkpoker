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

### 8.2 The threshold decision — SETTLED: strict `n`-of-`n`, no threshold

**Decided 2026-09-04. `t`-of-`n` is rejected.** The recommendation this section
used to carry — `t = n−1` for community cards, strict `n`-of-`n` for hole cards —
**is not implementable**, and the global version of it is barred by the project's
one standing rule.

**It is not implementable, because there is only one key.** The shuffle circuit
takes a single `pk` and re-randomises *every* card under it (`circuits/shuffle`:
`c2' = c2 + r·pk`, one `pk` parameter). The permutation moves cards freely across
all 52 slots, so every ciphertext in the deck — hole and community alike — is
encrypted to the same joint key `Y`. A threshold is a property of a **key**, not
of a position. "`t`-of-`n` for community cards and `n`-of-`n` for hole cards"
cannot be expressed over one key, and this section previously assumed it could.

Two keys do not rescue it:

- **Re-randomise hole slots under `Y_hole` and community slots under `Y_comm`.**
  Fails: the permutation moves a card between the two regions across rounds, so it
  accumulates randomness under both keys and then needs *both* secrets — the
  stricter threshold, not a mixed one.
- **Constrain the permutation to be block-diagonal** so hole slots only ever
  permute among hole slots. That fixes the algebra and destroys the game: `a_0` is
  public and positional, so the hole pool would be a publicly known `2n`-card
  subset of the deck.
- **A separate re-keying pass after a full shuffle** would work in principle, at
  the cost of a second 52-card proof per party — doubling the single most
  expensive thing in the protocol (811.9M gas × `n`) to buy tolerance for one
  dropout.

**And the global version is barred.** If the threshold is a property of the one
key, then `t < n` means any `t` parties can reconstruct the secret behind `Y` and
read **every hole card at the table**. Not "could decrypt the board early" — every
player's hand, silently, at any moment: the Shamir shares are in their hands from
Phase 0 and nothing can gate *when* they choose to combine them. At the table
sizes that matter this is absurd on its face — heads-up is `n = 2`, so `t = n−1`
means *one* opponent reads your cards. That is trust between players, which this
project does not trade for anything (§1).

Considered and also rejected: **escrowing each key under a time-lock puzzle or
VDF**, opened only after a proven dropout. It does not close the hole, it prices
it — a party with more compute opens the escrow early — and it is a large amount
of machinery to buy a weaker guarantee than the one being given up.

**The settled answer is void-and-forfeit**, and §8.1 is what makes it hold up. The
objection to void-and-refund was that "any player can grief a table by walking
away" — which was true when walking away was free. It is not free now: an
accusation names the party, and conviction redistributes their stake to everyone
else at the table. A dropout still ends the hand; it just costs the dropper and
pays the victims.

One liveness win is already banked and worth stating, because it diverges from
Phase 0 as written above: the implementation's key set is **seated players only,
not players + dealer**. `begin_shuffle` sums `seat_pk` over occupied seats and the
dealer holds no share. That costs nothing — the joint key is secure as long as one
*player* is honest about their own key, and the shuffle is secure as long as one
player shuffles honestly — and it removes an entire party from the set that can
stall the table. §4 phase 0's `{P_1..P_n, D}` is the older design; the contract is
the newer one.

What remains genuinely open is **not** the threshold: it is that a dropout ends
the hand at all. Nothing in this trust model can produce a share its owner never
computed. Improving that means changing the trust model, and the answer is no.

### 8.0 What happens when a player leaves, by phase

| Phase | Mechanism | Outcome |
|---|---|---|
| Shuffle chain | `claim_shuffle_timeout`, 10 min | hand voided, walker named, **stake forfeited** to the others |
| Betting round | `claim_action_timeout`, 10 min | walker **folded**, hand continues; their chips stay in the pot |
| Decryption / reveals | `accuse_share` → `claim_share_timeout`, 1 h | hand voided, walker named, **stake forfeited** |
| Showdown | none needed | mucking forfeits rather than blocks; everyone else settles |

The betting row is the only *recoverable* stall, and it is handled
differently for that reason. A missing decryption share can never be produced
by anybody else, so those paths end the hand. A missing **bet** costs nothing
to supply — folding is a perfectly good answer — so the seat is folded and
play goes on.

It also needs no forfeit bolted on: a folded seat's contribution stays in the
pot and goes to whoever wins it. Walking away already hands your money to the
players who stayed.

Two guards keep the clock from misfiring. It is refused while `table_pot` is
zero, because before the first bet of a hand every seat technically owes a
check and a clock that bit then would let seats be folded out during setup;
and it is refused once `round_complete` is true, because then the seat on turn
owes nothing and what the table is waiting on is `advance_street`.

~~**Known gap, not closed:** `advance_street` is dealer-only.~~ — **CLOSED
2026-09-05.** `advance_street` is now **permissionless**, so a dealer who walks
away once a round is complete no longer stalls the hand.

The reasoning was already written here and it held up: the call takes only a
`table_id`, its precondition `round_complete` is computed on-chain, and its
effect is fixed (street + 1, turn reset). A caller chooses nothing, so
restricting who may send it bought no safety and cost real liveness. Same
argument as `settle_from_reveals`, `open_deck`, `claim_shuffle_timeout` and
`claim_action_timeout`.

Two tests replace the one that asserted the old behaviour: a bystander who is
neither dealer nor seat can advance a **complete** round, and nobody — dealer,
seat or stranger — can advance an **incomplete** one.

**`begin_shuffle` stays dealer-only, deliberately.** It freezes the participant
list, so a permissionless version would let anyone start the chain the moment
two of six intended players had registered, locking the rest out. Deciding when
to stop waiting for players is a judgement call; advancing a completed round is
not. That distinction is the whole reason one changed and the other did not.

### 8.0.1 On automating the dealer

Asked directly — should the dealer be a bot, or a contract? Neither, and the
answer is worth recording because it is easy to get backwards.

A contract cannot be the dealer: contracts do not initiate transactions on
Starknet, so "the dealer is a contract" only moves the question to who calls
it, and there is no keeper primitive. A bot has the same problem in a worse
form — it becomes a **liveness dependency**, which is precisely the gap above.

But the deeper point is that there is almost nothing left to automate. What
this protocol calls a dealer holds no key share, does not shuffle, receives no
cards, cannot influence the deck, and after the change above has exactly one
discretionary power left: choosing when to close registration. Everything else
is either done by players with proofs, or by an entrypoint anyone may call.

So the automated dealer is a **keeper**, not an authority:
`scripts/keeper.mjs` watches a table and does the parts that need no
judgement — opening the deck (which needs a proof but no secret, §7.3) and
advancing completed rounds. Run it, don't run it, or run three; the only thing
it can do is advance a hand the contract already agrees is ready. That is only
true because the calls are permissionless, which is why that change had to come
first.

### 8.1 The accusation path — built

A party who never delivers a share deadlocked the table with nothing on-chain
saying who. The reveal path cannot tell you either: it verifies the **aggregate**
share against the joint key — which is what makes it `O(1)` in players (§6.2) —
and an aggregate that fails proves someone cheated but not which someone.

Three entrypoints, shaped like `claim_shuffle_timeout`:

| | |
|---|---|
| `accuse_share(table, seat, position)` | starts a 1-hour clock against one seat for one deck position |
| `answer_accusation(table, seat, position, share, proof)` | clears it, posting that seat's **individual** share with a DLEQ against the seat's *own* registered key (`log_G(pk) == log_c1(share)`), not the joint key |
| `claim_share_timeout(table, seat, position)` | convicts a seat that stayed silent |

An answered accusation can never be re-raised for that position, so a seat cannot
be ground down by repeated accusations. Late answers are refused even before
anyone calls the timeout, so a conviction cannot be dodged by front-running it
with the share that was owed an hour ago — the rule `submit_shuffle` already
applies to its own deadline.

**Who may accuse is not "anyone".** Answering publishes a share. For a *community*
position that costs nothing — the card is about to be public anyway — so any seat
still in the hand may accuse. For a *hole* position it is different: seat `S`'s
card needs every party's share, so if all of them were forced on-chain the card
would become publicly readable mid-hand. Only `S` may accuse over positions `2S`
and `2S+1`. That does not remove the exposure; it makes it `S`'s own decision,
taken only when the alternative is a hand `S` can no longer play, and it stops
anyone else from stripping `S`'s cards by accusing each party in turn. Verifiable
encryption to `S`'s key would remove the trade-off outright — that is a circuit
this project does not have.

**Conviction costs the griefer their stake.** `n`-of-`n` means the missing share
can never be produced by anyone else, so the hand is over however this is handled;
what the accusation adds is a name *and a cost*. The convicted seat's contribution
is redistributed pro rata over everyone else who put money in, remainder to the
first of them. `table_pot` is untouched, so the ordinary reclaim path pays the new
amounts out with no further changes. A defaulter nobody else backed keeps their
stake — there is no one to compensate, and burning it would strand the tokens in
the contract with no owner.

`claim_shuffle_timeout` forfeits on the same terms. Leaving that path free would
simply move the griefing one phase earlier: stall the shuffle instead of the
reveal, and the hand still dies with the griefer paying nothing.

**What this does not fix:** the `t`-of-`n` decision above. An accusation assigns
blame and cost; it does not produce the missing share, so a community card still
cannot be opened after a dropout. That remains open.

---

## 9. Sequencing and UX

The shuffle chain is sequential: 6 rounds of (prove → submit → confirm), roughly
**29 s of pure proving** plus block confirmations — 1–3 minutes before the first
card is dealt.

One mitigation, not built:

- **Shuffle the next hand's deck during the current hand's betting.** Pipelines
  the cost away entirely, changes no security property, and is the right fix.

### 9.0 Browser proving — measured, 2026-09-04

Everything above assumed a player can build their own shuffle proof in a
browser. They have to: handing the witness to anyone else hands them the
permutation, and the permutation is the secret the protocol protects. That
assumption had never been tested — the numbers were server-side WASM, on a
different machine with a different memory limit and a different engine.

Harness: `scripts/browser-proving/`. Headless Chromium 149, 6 threads,
cross-origin isolated, 4 GB JS heap.

| | ms |
|---|---|
| Witness generation | 375 |
| Proving, 6 threads (3 runs) | 4466 · 4797 · 5279 |
| **Client-side total per shuffle** | **~5.2 s** |
| Proving, 1 thread | 9870 |

**The measurement that matters is not the timing.** The verification key the
browser derives is **byte-identical** (1,888 bytes) to the one Garaga generated
the *deployed* verifier from, so the browser is proving against the contract
actually on chain — not merely producing something bb.js will verify for
itself. The four public inputs come back exactly as `Prover.toml` set them and
the proof is the same 9,408 bytes as the devnet-verified `proof.bin`.
`run.mjs` exits non-zero if that VK ever stops matching.

**Cross-origin isolation is worth 2.1×.** Multithreaded proving needs
`SharedArrayBuffer`, which browsers grant only to a cross-origin-isolated page.
Without `COOP`/`COEP` headers bb.js silently falls back to one thread and
proving goes 4.8 s → 9.9 s. Most static hosts do not set those headers; a
deployment that forgets them does not break, it just doubles every player's
wait. **This is a deployment requirement, not a nicety.**

Note the toolchain is deliberately *not* the project pin: `nargo 1.0.0-beta.16`
+ `@aztec/bb.js@3.0.0-nightly.20251104`, the pairing Garaga 1.1.0 requires and
therefore the one the deployed verifier came from. Proving the beta.22 build
would produce a proof the on-chain verifier rejects (§ the `public_inputs_offset`
incompatibility in `circuits/shuffle_verifier/README.md`), so measuring it would
have measured nothing.

---

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

### 9.2 The identity-point defect — found and FIXED, 2026-09-05

Building the browser client turned up a defect that stopped the first shuffle
of every hand, and that no earlier measurement could have caught. It is fixed;
this is the record.

**The bug.** `a_0` is `(identity, M_i)`, and the identity is encoded `(0, 0)` —
it has to be, because a deck slot is four bare fields and Noir's
`EmbeddedCurvePoint` carries a third component, `is_infinite`. The circuit
rebuilt each ciphertext with `is_infinite: false`, which is a lie for those
slots.

| Toolchain | `deck_in = a_0`, before the fix |
|---|---|
| nargo/acvm **1.0.0-beta.22** (project pin) | solves |
| acvm **1.0.0-beta.16** (what the deployed verifier requires) | **fails** |

```
Failed to solve blackbox function: embedded_curve_add, reason:
Point (0x0…0, 0x0…0) is not on curve
```

**Why the obvious fix does not work.** Setting `is_infinite` honestly —
`(x == 0) & (y == 0)` — still fails. beta.16's `embedded_curve_add` runs an
on-curve check on the **raw coordinates** that a *witness-derived*
`is_infinite` does not suppress. A *compile-time constant* `is_infinite: true`
does suppress it, which is exactly why a small hand-written test of "can
beta.16 add the point at infinity?" answers yes and misses this entirely.

**The fix.** Never let `(0, 0)` reach the blackbox. Substitute an arbitrary
on-curve point for the identity, add, then discard that branch and return the
other operand, because `O + q = q`:

```noir
fn add_encoded(x: Field, y: Field, q: EmbeddedCurvePoint) -> EmbeddedCurvePoint {
    let is_inf = (x == 0) & (y == 0);
    let base = if is_inf { EmbeddedCurvePoint::generator() } else { /* (x, y) */ };
    let sum = base + q;
    if is_inf { q } else { sum }
}
```

Both branches are computed and one is selected, so the stand-in is never
observed and constrains nothing. Outputs are re-encoded canonically
(`encode_x`/`encode_y`), so a result landing on infinity is published as
`(0, 0)` rather than whatever representation it carries — without that, the
next link would decode a different point than this one proved.

Only `(0, 0)` maps to infinity, and nothing real is captured: a curve point
with `x = 0` needs `y² = −17`, so `y ≠ 0`.

**Why seven review rounds missed it.** §9.0's browser-proving measurement used
`circuits/shuffle_verifier/example_proof/beta16_build/Prover.toml`, and that
fixture is a **mid-chain** shuffle — its `deck_in` contains *no zeros at all*.
Only the first link of a chain has identity points in its input, and until a
client existed, nothing ever ran it. §10's "verified end to end" claim for the
pinned commitment was true and was made under beta.22, which is **not** the
toolchain that produces proofs the deployed verifier accepts.

**Verified, not assumed.** The circuit change moves the VK, so the verifier was
regenerated (`scripts/regen_shuffle_verifier.mjs`, then `garaga gen`). Only
`honk_verifier_constants.cairo` changed; the verifier logic is byte-identical.
A real **first-link** proof — `hash_in` = `INITIAL_DECK_COMMITMENT` — was
generated under beta.16 and is checked in as the test fixture. Three tests pass
against the regenerated verifier: it accepts that proof (269.7M L2 gas, 3,053
felts), it returns the four public inputs with `hash_in` equal to the pinned
commitment, and it rejects a corrupted proof.

**What it costs.** Measured, not estimated:

| | before | after |
|---|---:|---:|
| ACIR opcodes (`nargo info`) | 1,756 | **4,460** |
| `log_circuit_size` in the VK | 17 | **17** |
| Proof size | 9,408 B | 9,408 B |
| VK size | 1,888 B | 1,888 B |
| Starknet calldata | 3,053 felts | 3,054 felts |

Opcodes go up 2.5×, because `add_encoded` costs two point-selects and an
equality test per ciphertext and there are 104 of them, plus the output
re-encoding. But `log_circuit_size` is **unchanged at 17**: the circuit still
sits in the same subgroup, which is what actually sets proving and verification
cost. The same thing §7.1 observed about the 92,352 → 82,133 change applies
here in reverse — this spends headroom, not time.

Both circuit copies were changed together and both still solve the mid-chain
fixture, so this is not a regression trade.

`circuits/shuffle/src/main.nr` and
`circuits/shuffle_verifier/example_proof/beta16_build/main.nr` **must stay
semantically identical** — the latter is what Garaga compiles into the deployed
verifier. They differ only in spelling, because beta.22 made `is_infinite` a
private field with an accessor while beta.16 exposes it.

**A rejection is a panic, not an `Err`.** Corrupting a proof desynchronises the
MSM hints Garaga derives from it, so `msm_g1` asserts
(`'Wrong GLV/FakeGLV decomposition'`) before any pairing check. That is safe
here and was checked rather than assumed: all five verifier call sites in
`PokerGame` end in `assert(..)`, so a panic and a `false` both revert with no
state written. The difference is diagnostic only. Anything that ever wants to
*continue* on a `false` must not assume it will get one.

---

### 9.3 Deck delivery — found and FIXED, 2026-09-05

`submit_shuffle` used to publish a commitment and a proof, and nothing else.
Decks travelled player-to-player off-chain, so each shuffler had to *choose* to
deliver.

**The inversion.** `claim_shuffle_timeout` convicts
`shuffle_order[shuffle_turn]` — the seat whose turn it is. But the seat able to
stall the chain is the **previous** one: post your commitment, satisfying your
own deadline, then never send the deck. The next seat has nothing to shuffle
and cannot invent one (it would need a preimage of the stored commitment). When
its clock runs out, **it** is convicted and **its** stake is forfeited. The
griefer paid nothing and the victim paid everything — the exact inversion the
forfeit exists to prevent (§8.1).

**The fix: publish the deck as calldata.** `submit_shuffle(table_id,
new_commitment, deck, proof)` now takes all 208 `u256` and asserts the length.
Delivery is part of the transaction that advances the turn, so it can no longer
be withheld separately from it. There is nothing left to not-send.

Publishing is safe, and this is worth being explicit about because it looks
alarming. The deck is private to the **circuit** — only its Poseidon2
commitment is a public input, which is what keeps the verifier under Garaga's
99-input cap (§7.1) — but the ciphertexts are not secret. Re-randomisation is
*precisely* what makes the output reveal nothing about the permutation, and
reading a card still needs every party's decryption share. §5 already budgeted
the deck as calldata.

The contract also stores `poseidon_hash_span` of what was published — **Starknet's**
Poseidon over the calldata, which it computes itself. That is not, and cannot
be, the BN254 commitment (§7). It is a handle: a client can confirm it read the
bytes the transaction actually carried instead of trusting an RPC's event
index. `get_published_deck_hash` / `get_published_deck_seat` expose it, and a
small `DeckPublished` event carries the hash so the transaction can be located.
The deck itself is deliberately *not* re-emitted — 416 felts twice would double
the data cost for nothing, since anyone holding the transaction can check it
against the stored hash.

**Cost, measured.** Same test (`test_full_shuffle_chain_completes`, a two-link
chain) before and after:

| | before | after |
|---|---:|---:|
| L2 gas | 27,020,980 | **34,033,238** |
| L1 data gas | 3,840 | 4,032 |

**≈3.5M L2 gas per `submit_shuffle`** — the Poseidon over 416 felts, two
storage writes and the event. Against the 811.9M a shuffle proof costs to
verify, that is **0.43%**.

---

### 9.3.1 What is still not adjudicable, and what happens instead

Publishing kills silent withholding. It does not let the contract check that
the published deck *opens the commitment it is chained to*: that means
recomputing a BN254 Poseidon2 hash in Cairo, which is the whole of §7. It was
worth confirming there is no cheap way around it, and there is not — a linear
fingerprint the contract could recompute with Garaga's field ops is forgeable,
because one linear equation in 208 unknowns is trivially solvable, and a
full-deck opening proof would need 261 public inputs against a cap of 99 (or 11
chunked proofs at ~772M each, more than an entire hand).

So a shuffler can still publish a deck that does not match, and the chain dies.
`dispute_deck(table_id)` is the answer:

- callable **only** by the seat whose turn it is — a bystander who could end
  the hand would be a cheaper griefing tool than stalling;
- **only** once the chain has a real publisher, since position 0 consumes the
  pinned canonical `a_0` that nobody publishes;
- **only** before that seat's own deadline, so a seat that already let its
  clock expire cannot dispute its way out of the forfeit it has earned.

It voids the hand and **forfeits nobody**. That is deliberate. Rather than
convict on a coin-flip it cannot resolve, the contract ends the hand and every
seat reclaims exactly what it put in.

**Why no-forfeit is safe here specifically.** The shuffle chain runs *before
any betting*: every seat has contributed exactly its buy-in, no card, share or
bet exists, and no information has been revealed. Voiding returns everyone to
where they started. A frivolous dispute is therefore a denial-of-service that
costs its caller gas and gains it nothing — and it is strictly better than the
alternative it replaces, which was forfeiting the stake of a player who
provably could not act. The same reasoning would **not** hold after betting
opens, which is why `dispute_deck` is confined to the shuffle phase.

---

### 9.6 Garaga's JS calldata carries its own length prefix

Found 2026-09-05, and only by sending a real transaction.

`getZKHonkCallData` returns a complete Starknet calldata array: the span's
length first, then its contents. The `garaga calldata --format array` CLI emits
the contents **without** that prefix — which is why the checked-in fixtures are
3,053 felts and the JS call returns 3,054.

starknet.js's ABI encoder adds the length itself when it serialises a
`Span<felt252>` argument. So passing the raw JS array through gives the verifier
two prefixes, and it fails deep inside the Honk verifier with
`deserialization failed` — no mention of calldata, no mention of length.

**Nothing short of a transaction catches this.** bb verifies the proof happily,
`garaga` is satisfied, and the browser check passes: none of them go near the
ABI encoder. It took `PokerGame -> VerifierAdapter -> the real verifier` on a
live devnet, and it would have broken every proof the UI ever submitted.

`src/lib/shuffle.ts` and `src/lib/deckOpen.ts` now strip the prefix, and
**assert** it was there rather than slicing blindly — a future garaga that
stops prefixing fails loudly instead of silently truncating a proof.

---

### 9.7 Community reveals were not gated on the street — FIXED

Found 2026-09-05, by playing a hand and noticing the board was face-up during
pre-flop betting.

`reveal_community_card` checked that the table existed, was not voided or
settled, that the deck was open, that the index was in range, that the card was
not already revealed, and that the position had been proved. It checked
**nothing about when**. So the entire board was revealable the instant the deck
opened, and every bet was then placed with the river visible.

That is not a griefing edge case. It is the game not being poker.

The gate is now explicit, and mirrored in the client:

| street | revealable |
|---|---|
| 0 pre-flop | nothing |
| 1 flop | indices 0, 1, 2 |
| 2 turn | index 3 |
| 3 river | index 4 |

**Why the contract has to enforce it.** A reveal needs a decryption share from
every party, so an honest client could refuse to contribute for a card that is
not due — and the client now does exactly that, both in its automatic share
service and by disabling the manual buttons. But a rule that holds only while
every client is well-behaved is not a rule the contract is entitled to assume:
one modified client, or one player who wants to see the river before betting
and can talk the others into sending shares, and the hand is decided on
information nobody should have had.

Four tests pin it: the flop refused pre-flop, the **turn refused on the flop**
(the case a naive "any card once betting starts" gate would let through), the
river refused on the turn, and the whole board opening exactly when due. 208
contract tests pass.

**This is the second defect in this section found by playing rather than
testing**, after §9.6, and neither was reachable from a single client or a unit
test. The first hand played end to end was worth more than the round of review
that preceded it.

---

### 9.4 The SRS is a third-party runtime dependency

Worth stating because it is invisible until it fails: bb.js does not ship the
structured reference string. On the first proof in a browser it fetches it from
`https://crs.aztec.network` — a 6.4 GB file it range-requests for the points
the circuit size needs — and caches the result in IndexedDB. The URL is
hardcoded in bb.js's browser CRS path; there is no option to point it
elsewhere.

Three consequences a deployment should know about:

- **A player's first shuffle depends on a host this project does not control.**
  If it is down or blocked, proving does not start. Later proofs come from the
  IndexedDB cache.
- **It is a cross-origin fetch from a cross-origin-isolated page.** It works
  today; a future tightening of that host's headers, or of COEP, would break it
  in a way that looks like a client bug.
- **Removing it means serving the SRS same-origin** and intercepting bb.js's
  fetch, since the URL cannot be configured. Not done, and it is a deployment
  choice rather than a protocol one — but it is the difference between a client
  that works offline and one that does not.

`scripts/check_browser_client.mjs` passes `--ignore-certificate-errors` for
this fetch alone, because headless Chromium in the dev sandbox does not trust
that host's CA even though `curl` on the same machine does. That flag is
harness-only and changes nothing the app ships.

---

---

### 9.5 The hole-card aggregate cannot be built at dealing time

Found 2026-09-05, building the dealing client. §4 phase 4 and the implemented
contract describe two different things, and the difference decides when a
proof can be made.

**§4 phase 4** says the player republishes *all* `n+1` shares and proofs, and
the contract verifies every DLEQ. **`reveal_hole_card`** takes **one** share
and **one** proof, checked against the table's **joint key** — the aggregate
from §6.2, which is what makes a reveal `O(1)` in players. The aggregate was
introduced for cost after phase 4 was written, and this seam was never
re-examined.

It matters because an aggregate DLEQ needs a challenge over `D = Σ d_i`, and
every co-signer needs that challenge to produce its `s_i`. But `open_deck`
publishes **every** in-play ciphertext before dealing, hole positions included.
So `c2` is on-chain, and anyone who learns `D` for seat `S`'s hole position
computes `c2 − D` and reads `S`'s card.

Three ways out:

| | |
|---|---|
| Reveal `D` at dealing so everyone can compute the challenge | **Rejected — it is the break itself.** Every co-signer reads the card. |
| `S` sends only the challenge `e`, keeping `D` secret | **Rejected.** That is blind Schnorr signing: co-signers sign a value they cannot check. Not obviously broken for one signature, but a party blind-signing under a long-term key across many concurrent sessions is exactly the ROS setting (Benhamouda et al.), and a forgery here means claiming a different card at showdown. Not a risk to take silently to save a round. |
| Build the aggregate at **showdown**, when the card is being revealed anyway | **Taken.** |

**What the chosen option costs, stated plainly.** It diverges from phase 4's
"no new proof is generated here": there *is* a new proof at showdown, and it
needs the other parties to still be reachable. A player who cannot assemble it
cannot show, and mucking forfeits rather than blocks — so a departed player can
cost a showing player a pot they would have won. That is a liveness failure,
not a soundness one, and it is the same shape as every other `n`-of-`n`
dependency in §8.

The commitment still does its job. `S` computes `D` at dealing time from the
individual shares (each verified locally against its sender's registered key,
§4 phase 2) and commits `Poseidon(D ‖ ρ)` before betting. So the card is bound
before the board exists; only the *proof* is assembled later, and it must open
the commitment already standing.

**Community cards are unaffected** — their shares are public by design, so
their aggregate is built as soon as the shares are in.

**The honest fix**, not done here, is to make the contract's hole path accept
`n` individual proofs as phase 4 describes, at `n ×` the verification cost, or
to add verifiable encryption of shares to `S`'s key — a circuit this project
does not have and which §8.1 already notes would remove a different trade-off
in the accusation path.

---

---

## 10. What exists, what doesn't

**Deployed and exercised end to end (local devnet, 2026-09-05):**
`scripts/deploy_local.sh` puts all six contracts on a local
`starknet-devnet --seed 0` in dependency order, and
`scripts/smoke_local.mjs` then runs the stack with **real proofs throughout**:
Schnorr key registration accepted by the deployed verifier, the joint key
summed and checked on Grumpkin by the real `VerifierAdapter`, the full shuffle
chain (2 Honk proofs, 18.2 s and 20.3 s to prove, 3,053 felts each, both
accepted on-chain), and `open_deck` in 2 chunks (~12 s each, the second padded
`5,6,7,8,8` exactly as the contract derives it), finishing with the stored
ciphertexts compared against the final deck position by position.

This is the only thing in the repo that runs `PokerGame -> VerifierAdapter ->
the real Garaga verifiers` together on a chain — every other test isolates one
layer, and round 8's finding I is what that costs. It immediately earned its
keep by turning up §9.6. Addresses in `cairo/address.md`.

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
- ~~The threshold (`t`-of-`n`) decision~~ — **settled 2026-09-04: rejected, strict
  `n`-of-`n` stays.** Not implementable as recommended (one joint key covers the
  whole deck, so the threshold cannot be per-position) and barred as a global
  change (any `t` parties would read every hole card). See §8.2.
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
- ~~The accusation path (§8)~~ — **done, 2026-09-04.** `accuse_share` /
  `answer_accusation` / `claim_share_timeout`, with conviction forfeiting the
  defaulter's stake pro rata to the other contributors, and
  `claim_shuffle_timeout` forfeiting on the same terms. See §8.1.
- ~~Browser proving~~ — **done, 2026-09-04.** Measured end to end in headless
  Chromium: ~5.2 s client-side per shuffle (375 ms witness + ~4.8 s proof) on 6
  threads, 9.9 s single-threaded. The browser's VK is byte-identical to the
  deployed verifier's. See §9.0 and `scripts/browser-proving/`.
- ~~Any client UI for the above~~ — **built, 2026-09-05.** `src/lib/` carries
  the client crypto (Grumpkin, Schnorr, DLEQ individual + aggregate, the deck
  and its Poseidon2 commitments, the shuffle prover, encrypted share exchange,
  seat-key custody) and `src/app/poker/` the table: seating, key registration,
  the shuffle chain, betting with the action clock, timeouts and settlement.
  `/poker/selftest` is a deployment check that proves one real shuffle and
  reports whether the host is cross-origin isolated.

  Verified rather than asserted: `scripts/check_client_crypto.mjs` bundles the
  client modules, generates fixtures, and writes
  `cairo-verifier/tests/test_client_vectors.cairo`, where the **real**
  `SchnorrKeyVerifier` and `DleqVerifier` accept them — 19 tests, including the
  aggregate opening a named card through `verify_card_reveal`. bb.js's
  `poseidon2Hash` over `a_0` reproduces `INITIAL_DECK_COMMITMENT` byte for
  byte, so the browser computes commitments in the circuit's own hash.
  `scripts/check_browser_client.mjs` drives the production build headlessly and
  confirms COOP/COEP, cross-origin isolation and 6-thread proving.

  Building it also surfaced two defects nothing else could have, **both now
  fixed**: §9.2's identity-point bug, which stopped the first shuffle of every
  chain under the deployed verifier's own toolchain (verifier regenerated, with
  a real first-link proof checked in as its test fixture), and §9.3's
  deck-delivery inversion, where withholding a deck off-chain got the *next*
  seat convicted and forfeited. The deck is now published as calldata, so
  delivery cannot be withheld, and `dispute_deck` ends a hand built on an
  unusable deck without robbing anyone.

  **Deck opening is wired up too (2026-09-05).** `circuits/deck_open` now has
  a beta.16 build, and the VK it produces is **byte-identical** to the one the
  deployed deck-open verifier was generated from, so the browser proves against
  the contract actually on chain. `src/lib/deckOpen.ts` mirrors the contract's
  chunking and its padding rule (a short final chunk repeats the last in-play
  position), and the table opens one chunk per click.

  Verified against the real verifier rather than a mock: the checked-in fixture
  is an opening of the deck **the shuffle circuit actually produced** — its
  `deck_hash` is the `hash_out` of the a_0 shuffle proof — which is what
  exercises the join between the two circuits. Three tests pass at 257.3M L2
  gas: the proof is accepted, the 26 public inputs come back in exactly the
  order `open_deck` rebuilds them (`deck_hash`, 5 positions, 20 coordinates —
  round 8's finding I was precisely this going wrong while a mock hid it), and
  a corrupted proof is rejected. `scripts/prove_deck_open.mjs` regenerates it.

  **Dealing, reveals, showdown and accusations are wired up (2026-09-05).**
  `src/lib/dealing.ts` runs the share exchange — individual shares verified
  client-side as they arrive, hole shares ECIES-encrypted to the recipient's
  registered key — and the three-round commit/reveal/respond the aggregate
  requires. `src/lib/reveal.ts` builds what `verify_reveal_at` checks, and the
  table panel covers dealing, community reveals, showdown and the
  accuse/answer/claim path.

  Building it turned up §9.5: the hole-card aggregate cannot be assembled at
  dealing time without either handing every co-signer the card or blind-signing
  under a long-term key, so it is assembled at showdown instead. That is a real
  divergence from §4 phase 4 and it is written up rather than hidden.

  Verified: the hole commitment this client computes is reproduced by Cairo's
  own `poseidon_hash_span`, and the reveal statement is built in exactly the
  order `verify_reveal_at` rebuilds it — both pinned in
  `cairo-verifier/tests/test_client_vectors.cairo` (21 tests).

  Not verified end to end: a real multi-party deal. The transport is
  `BroadcastChannel`, which spans tabs of one browser — enough to demonstrate a
  table, not a deployment. A relay or WebRTC drops in behind the same
  interface, and every hole share is encrypted to its recipient regardless, so
  a relay that could read messages still could not read cards.
- ~~Bet-matching and turn-order enforcement~~ — **done.** `bet`/`fold`/`check`
  are turn-ordered; a street cannot end until every seat still in the hand has
  acted since the last raise and matched the high; a raise reopens the action.

**To be deleted:** V1 commit-reveal (`commit_deal`/`reveal_seed`/`shuffle.cairo`),
`MockShuffleVerifier`. ~~The seed-based fairness UI~~ — **deleted 2026-09-05**
(`src/app/poker/fairness.ts` and `pokerActions.ts` are gone; nothing in the
client calls the V1 entrypoints any more).

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
