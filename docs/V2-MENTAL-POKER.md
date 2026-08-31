# V2: collaborative shuffle with no trusted dealer — protocol spec

Status: **specification only. Nothing here is implemented.** V1
(trusted-dealer commit-reveal, `docs/DESIGN.md`) is what currently ships.

This answers the RFP's V2 ("Noir + Garaga mental poker, no trusted dealer").
It replaces V1's shuffle core rather than extending it — see §8 for exactly
what gets deleted.

**Decisions already made** (2026-08-31, with the project owner):
- Every player shuffles the deck themselves; each shuffle is its own
  Starknet transaction carrying a ZK proof.
- Drop-out policy: **all-of-n decryption + timeout forfeit** (§6). No
  threshold keys — no coalition of players may ever read another player's
  hole cards, and liveness is bought with forfeits instead.
- Build order: this spec, then a Noir circuit spike to measure real proof
  size and on-chain verification gas *before* committing to the design
  (§9).

---

## 1. Why the dealer can't be the one proving

The intuitive version of this protocol — "each player tells the dealer how
to shuffle, the dealer applies it and proves they did" — does not work. If
players hand their permutations to the dealer, **the dealer learns every
permutation**, and therefore the whole deck order. You would have proven the
dealer honest while handing them precisely the knowledge that lets them
cheat.

So: each player applies their **own secret permutation** and proves *that*
in zero knowledge. Nobody proves anything on anyone else's behalf. After all
*n* players have shuffled, the composed permutation is known to no one
unless **all** *n* collude. The trusted dealer role disappears — which is
the actual point of V2.

The dealer seat survives only as a mechanical role (advancing streets,
submitting settlement), never as a holder of secrets.

---

## 2. Primitives

**Curve.** ElGamal on **Grumpkin**, Noir's embedded curve for a BN254-based
proving stack. This is a load-bearing choice: the shuffle circuit does ~104
scalar multiplications (§5), and on the embedded curve those are close to
native in-circuit. Doing this EC work on the STARK curve inside a Noir
circuit would be brutally expensive. Cairo has no native Grumpkin either —
Garaga supplies both the on-chain proof verifier and the EC ops needed for
share verification (§4.4).

**Card encoding.** Card `c ∈ 0..51` maps to curve point `M_c = c·G`.
Decryption recovers `M_c` and then recovers `c` by lookup over the 52
candidates — the discrete log is tiny by construction, so this is a table
lookup, not a hard problem.

**Encryption.** ElGamal under a joint public key `PK`:

```
Enc(M, r) = (r·G,  M + r·PK)          ciphertext = (C1, C2)
```

**Joint key.** `PK = Σ PK_i`, where player *i* holds `sk_i` and
`PK_i = sk_i·G`. No single party holds the decryption key, and decryption
requires **every** share (§6).

**Re-randomization.** Given `(C1, C2)` and fresh `r'`:

```
ReRand((C1,C2), r') = (C1 + r'·G,  C2 + r'·PK)
```

Same plaintext, unlinkable ciphertext.

---

## 3. Why re-randomization is not optional

This is the step implementations most often drop, and dropping it silently
destroys the entire protocol.

If a player only **permutes** the ciphertexts, every output ciphertext is
byte-identical to some input ciphertext. Anyone can trivially match them up
and read off the permutation. The ZK proof would be perfectly valid and
perfectly useless — it would prove a permutation that everyone can already
see.

Re-encrypting each card with fresh randomness makes every output look
unrelated to every input, while still decrypting to the same card. **Permute
+ re-randomize together** are what hide the permutation.

---

## 4. Protocol phases

### 4.1 Key setup

Each player submits `PK_i` **plus a Schnorr proof of knowledge of `sk_i`**.

The proof is mandatory, not decorative. Without it a player who moves last
can mount a **rogue-key attack**: choose `PK_last = X − Σ(other PK_i)` for
an `X` they control, making the joint key entirely theirs and letting them
decrypt every card alone. Proof of knowledge of the discrete log kills this.

Contract computes and pins `PK = Σ PK_i` for the hand.

### 4.2 Initial deck

52 ciphertexts encrypting `M_0..M_51` with fixed public randomness. Fully
deterministic, so every participant can recompute it and the contract need
only pin its hash. No proof required — there is no secret yet.

### 4.3 The shuffle chain

Players shuffle in seat order, **one Starknet transaction each**:

```
player i:
  input   D(i-1)                       52 ciphertexts
  secret  permutation π, randomness r[0..51]
  output  D(i)[j] = ReRand( D(i-1)[π⁻¹(j)], r[j] )
  proves  ∃ π, r such that the above holds
          (revealing neither π nor r)
```

The contract verifies proof *i* against `(hash(D(i-1)), hash(D(i)), PK)` and
advances the chain. **On-chain storage is the hash only** — the 52
ciphertexts travel in calldata/events, since storing 104 curve points per
shuffle step per hand would be gratuitous. The proof binds to the hashes, so
the hash is sufficient to keep the chain honest.

Each step has a deadline (§6).

### 4.4 Dealing hole cards

Seat *N* takes deck positions `2N` and `2N+1` — **the same convention
`settle_table_by_hand` already enforces today**, deliberately kept so the
existing scoring and settlement path survives unchanged.

To open a hole card for player *i*: **every other player** publishes a
partial decryption share

```
s_j = sk_j · C1        with a Chaum–Pedersen DLEQ proof that
                       log_G(PK_j) = log_C1(s_j)
```

The DLEQ proof is what stops a player submitting a garbage share to corrupt
someone's hand. It's a handful of EC ops — cheap enough to verify directly
in Cairo via Garaga, no SNARK needed.

Player *i* then computes `M = C2 − Σ_{j≠i} s_j − sk_i·C1` and looks up the
card.

**Why this is safe even though the shares are public:** the on-chain shares
are exactly the *n−1* shares that are not player *i*'s. Recovering the card
needs all *n*. Only player *i* can supply the last one, so only player *i*
learns the card — everyone else sees nothing but curve points.

### 4.5 Community cards

Same mechanism, but **all** *n* players publish shares, so anyone can
complete the decryption. Gated per street: 3 shares-sets for the flop, then
turn, then river — the existing `advance_street` state machine drives this.

### 4.6 Showdown

Each remaining player publishes the share for their *own* hole cards, making
them public. The contract now holds real card indices and feeds them into
**the existing `poker_hand::best_of_7` scoring and pot-splitting logic,
unchanged** — that code, its 24 unit tests, and the settlement/payout path
all survive V2 intact.

---

## 5. The circuit (what the spike must build)

**Shuffle proof.**

```
public   PK, hash(D_in), hash(D_out)
private  π (permutation), r[0..51]

constraints
  1. re-encryption: D_out[j] == D_in[π⁻¹(j)] + (r[j]·G, r[j]·PK)
     → 52 × 2 = 104 scalar multiplications on Grumpkin  ← dominates
  2. π really is a permutation: multiset-equality / grand-product
     argument over a random challenge
  3. hashes match the claimed decks
```

Constraint 1 is the cost driver. If the naive circuit proves too large,
the fallback is a **Bayer–Groth** shuffle argument (log-size, the classic
result for exactly this problem) rather than proving each re-encryption
individually.

**Decryption-share proof.** Chaum–Pedersen DLEQ. Small enough to verify
directly in Cairo through Garaga rather than as a SNARK.

**No gas or gate-count estimates are given here on purpose.** I don't have
measured numbers for a Honk verifier on Starknet at this circuit size, and
guessing them is exactly the kind of number that gets quoted back later as
fact. §9 measures them.

---

## 6. Drop-outs: all-of-n + timeout forfeit

**Chosen policy.** Decryption requires every player's share. A player who
misses a deadline — for their shuffle step, or for any decryption share —
**forfeits**: their stake is surrendered and the hand is voided and refunded
to the remaining players.

**What this buys:** no coalition, of any size, can ever read another
player's hole cards. Maximum privacy.

**What it costs — state this plainly in any pitch:** a malicious player can
grief the table by stalling every hand. They pay for it each time (forfeited
stake), so it is expensive rather than free, but it is not prevented.

**Why not threshold (t-of-n):** it fixes liveness — any *t* players can
decrypt, so the game survives drop-outs — but any *t* **colluding** players
can then read everyone's hole cards. That is a permanent, undetectable
attack surface, and at real-money poker's collusion rates it is the wrong
trade. Rejected deliberately.

**Consequence to design around:** a forfeit cannot "continue the hand
without that player" — their share is genuinely gone and the affected
ciphertexts are undecryptable forever. Void-and-refund is the only coherent
resolution. `reclaim_stalled_bet`'s existing timeout machinery generalizes
to this.

---

## 7. Latency (the honest UX cost)

Before a single card is dealt, the hand needs *n* **sequential** shuffle
transactions, each preceded by client-side proof generation. Six players
means six proofs and six txs, and the chain cannot be parallelized — player
*i* needs `D(i-1)` before starting.

Then dealing needs *n−1* share submissions per hole card, though those *are*
parallel and can be batched.

This is inherent to the construction, not an implementation defect. It
should shape the product: fewer seats, or a shuffle pipelined during the
previous hand.

---

## 8. Impact on the existing contract

**Deleted:** `commit_deal`, `reveal_seed`, `mark_dealt`, `shuffle.cairo`'s
role in settlement, the `CARD_MISMATCH` / `SEED_NOT_REVEALED` provenance
checks, and `scripts/deal_verify.py` (there is no seed left to verify a deal
against — the proofs replace it).

**Added:** `register_key` (PK + Schnorr PoK), `submit_shuffle`
(deck hash + proof), `submit_decryption_share` (share + DLEQ), per-phase
deadlines, forfeit resolution.

**Survives unchanged:** the whole table/seat/bet/pot machinery,
`poker_hand`'s evaluation and its unit tests, pot splitting, settlement,
`privacy_invoke` payouts, `note_id_owner` binding, and the reentrancy
guards. V2 changes *where cards come from*, not what happens to the money.

Note that this deletes several things rounds 1–8 audited and hardened. The
audit history in `HANDOFF.md` §5 stays relevant for the surviving code and
must not be treated as covering any of the new surface.

---

## 9. Spike plan (next step)

Goal: **decide feasibility on measured numbers, not estimates.**

1. Minimal Noir circuit for the §5 shuffle proof over Grumpkin, 52 cards.
2. Measure: gate count, proving time on a normal laptop, proof size.
3. Generate the Garaga verifier, deploy to Sepolia, **measure actual
   verification gas per shuffle proof**.
4. Multiply by *n* players/hand and judge against the hackathon's target
   table size.

**Kill criteria — decide these before seeing results, not after:**
- If per-shuffle verification gas makes a 6-player hand implausible, drop to
  Bayer–Groth before touching any contract code.
- If proving time on a normal laptop is bad enough to break the UX (players
  wait per shuffle), reconsider table size or pipelining.

Only after the spike clears should any Cairo change land.

---

## 10. Open questions

- **Key setup cadence:** per hand (safest, costs *n* txs every hand) or per
  session (cheaper, but a leaked `sk_i` compromises every hand in the
  session)? Leaning per-hand; needs the gas numbers from §9.
- **Point validation:** every submitted curve point needs on-curve and
  subgroup checks. Cheap, and catastrophic to omit.
- **Proof-system pin:** exact Noir/Barretenberg/Garaga versions, pinned like
  `cairo/.tool-versions` does for Scarb — Garaga's verifier codegen tracks
  its proving stack closely.
- **Where the shuffle order comes from** and what happens if a player joins
  mid-shuffle-chain (probably: chain is fixed at hand start, late joiners
  wait for the next hand).
