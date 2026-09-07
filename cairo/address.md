# Deployments

## Starknet Sepolia — 2026-09-08 (stacks, all-in, side pots)

The current deployment.

| | class hash | address |
|---|---|---|
| `UltraKeccakZKHonkVerifier` (shuffle) | `0x052273e9c0b297c2aabe7f97fa2d10727a6ba113c44c69d9123eda277a3ea8c1` | `0x04f9be63aa39f83da74659e32bdb8bc0114f449ff47b93d70b9602b1c3a80541` |
| `UltraKeccakZKHonkVerifier` (shuffle+open) | `0x02c3c713738112c195b07aabdab09499e3ee01083ee7ab87b943a3040928ccb8` | `0x066a5f04dc4d34630d753e7094d58a8f4bace08a7b50a51485df18c4ba58f255` |
| `UltraKeccakZKHonkVerifier` (deck open, K=19) | `0x022c7ee726115333ef86c172dea4d794aaa5eef01ed7922d83a40811b28e28e6` | `0x01ed80924c16e11f709784bcd05f98ecf378db726f3fc42111b11b8e162fccb8` |
| `SchnorrKeyVerifier` | `0x05c89ad6970fcccd1ae338de0509b189f9a37004470898d451ebb4be92f8537e` | `0x03fa647c8158bed248f33de1d7666a37efa8e1ed27ac8762a6fe01b195501766` |
| `DleqVerifier` | `0x07258c8fea11a1b883e1bf8ec83d7d60898d33d09f6e7fd6e5e2efe06b793329` | `0x062ef330e18c2e052417912ddd21b9dc980f09df03d9a44ae915390e84a0eef4` |
| `VerifierAdapter` | `0x0005ea1a1e9d87b175564e871c7c6570b8aab28f47066f74b812d6235a9c50be` | `0x04c58a3fa9a221439908871d21cbf2f05ef72ed1e74197a2e96298b90cc4b3a1` |
| `PokerGame` | *(new)* | `0x0042d80afb94a3ec7984a97e1b9790593b2eb8aed77f96c717ebe236434bd75d` |

**What is new.** `table_buy_in` is enforced: a table created with a buy-in
escrows chips at `join_table`, betting draws them down, a seat that cannot
cover may fold or go all-in, and settlement splits the pot into layers so a
short stack wins only what it matched. `leave_table` cashes out between
hands. The rising blind ladder takes a `unit`, so `10^18` gives 10/20 STRK
through 300/600 STRK instead of 10/20 wei. A table created with `buy_in = 0`
keeps the original wallet-funded betting exactly as it was.

**Only `PokerGame` was redeclared** — the six other classes were already on
chain from the 2026-09-07 deploy and reported as such, which is why this cost
a third of that one. Verified live: **99 entrypoints**, including
`leave_table`, `get_seat_stack`, `get_seat_all_in`, `get_table_buy_in` and
`get_blind_level_unit`.

### What it cost

**150.69 STRK** (459.93 -> 309.24 on the deployer).

The first attempt was REJECTED AT VALIDATION without spending anything:
`Resources bounds ... exceed balance`, wanting ~338 STRK against 259.93. That
number is the declare's resource BOUND, not its price — the declare that
followed cost 150.69. So a redeploy needs roughly twice its own cost sitting
in the account before it will start.

**`scripts/deploy_local.sh` rewrites `.env.local` only.** `.env.production` is
what the hosted build reads and has to be updated by hand, or the deployed
frontend keeps pointing at the previous contract.

## Starknet Sepolia — 2026-09-07 (fused shuffle+open) — SUPERSEDED

The previous deployment. Public, permanent, and readable by anyone at
`sepolia.voyager.online`.

| | class hash | address |
|---|---|---|
| `UltraKeccakZKHonkVerifier` (shuffle) | `0x052273e9c0b297c2aabe7f97fa2d10727a6ba113c44c69d9123eda277a3ea8c1` | `0x00657cdc419389c4232279fca6720d57322e624aa5e871c83f1f643e6cbc93a3` |
| `UltraKeccakZKHonkVerifier` (**shuffle+open**, fused) | `0x02c3c713738112c195b07aabdab09499e3ee01083ee7ab87b943a3040928ccb8` | `0x0744674dec326575b224d6cdc02f422ee15a1b924d417468c408d6312e3c3d53` |
| `UltraKeccakZKHonkVerifier` (deck open, **K=19**) | `0x022c7ee726115333ef86c172dea4d794aaa5eef01ed7922d83a40811b28e28e6` | `0x0348e33de66877c22a738d311e3b1236b2b445ae85f14be77a66e18d0c326272` |
| `SchnorrKeyVerifier` | `0x05c89ad6970fcccd1ae338de0509b189f9a37004470898d451ebb4be92f8537e` | `0x02dc098996d82bc29a0a19977bb2f48cf5c154c4ddd0faef4baf9d7508300fca` |
| `DleqVerifier` | `0x07258c8fea11a1b883e1bf8ec83d7d60898d33d09f6e7fd6e5e2efe06b793329` | `0x06c2ea05ca678a2a08cc4dac8738fe52245a9d3d72f2f445440e82d27e7f366c` |
| `VerifierAdapter` | `0x0005ea1a1e9d87b175564e871c7c6570b8aab28f47066f74b812d6235a9c50be` | `0x0715e1e7ad8b01cf09a67e3b937fc44d435ee8ef37debc8289226a638bdf592b` |
| `PokerGame` | `0x0116a6dac4c4f08b1c856d21a845f90d077089dce03e3aa945bfd7da69c71630` | `0x04d6ff62b16b206990c4b724dd491b0ca0e9ace785a00ba891f6c3c17ccae961` |

**What is new here (docs/PROTOCOL.md §6.5).** The deck opening is folded into
the LAST shuffler's proof: one circuit proves the final shuffle AND chunk 0 of
the opening, joined by `hash_out` serving as both the shuffle's output
commitment and the opening's `deck_hash`. It stays at log_n 17 — the same size
as the plain shuffle — so it costs +4.4% and removes an entire ~587M-gas
verification. Also here: `muck` and the dealt button removed, `SHOWDOWN_SECS`
10 → 600, rising blinds, and `DECK_OPEN_K` 16 → 19 with positions derived
in-circuit from `chunk` + `k_total` rather than published one by one.

Three classes were re-used unchanged — the shuffle verifier, `SchnorrKeyVerifier`
and `DleqVerifier` — which is why their class hashes match the 2026-09-06 row
below and only their addresses moved. Four were new: the fused verifier, the
K=19 deck-open verifier, `VerifierAdapter` (it takes five verifier addresses
now) and `PokerGame`.

Verified live after deploying: **94 entrypoints**, `submit_final_shuffle`
present, `muck` and `reveal_draw_card` gone, and `get_shuffle_verifier()`
returns the adapter above.

### What it cost

**391.39 STRK** (880.67 → 489.28 on the deploying account), against an
estimate of 450–480. Four declares plus seven deploys.

Deployed with
`NETWORK=sepolia RPC=https://api.zan.top/public/starknet-sepolia/rpc/v0_10 ./scripts/deploy_local.sh`
from the sncast account `sepolia`
(`0x719eb8a2f1673e9afc94de57c69b69c6c0cfe555711f219c62ddcf953c78cac`).

**The RPC override is not optional.** The script's default,
`https://starknet-sepolia.drpc.org`, answers `starknet_chainId` but times out
on `starknet_getClassHashAt` with *"Request timeout on the free plan"* — so
the account preflight decides the deploying account "is not deployed" and
refuses to start. The account is fine; the endpoint is not.

## Starknet Sepolia — 2026-09-06 (K=16 redeploy) — SUPERSEDED

The previous deployment. Public, permanent, and readable by anyone at
`sepolia.voyager.online`. Unlike the devnet record below, these addresses do
not come back if something is wiped — a redeploy produces new ones.

| | class hash | address |
|---|---|---|
| `UltraKeccakZKHonkVerifier` (shuffle) | `0x052273e9c0b297c2aabe7f97fa2d10727a6ba113c44c69d9123eda277a3ea8c1` | `0x00d45865acfa430f44d626c47faa3a4b4809101ee22a82b82aa64b56f6390216` |
| `UltraKeccakZKHonkVerifier` (deck open, **K=16**) | `0x06b787bfdf874ded92d4b3e96cc445050e310dc920bb7c150e2736241cf99ded` | `0x035ef5c1e0e81001c11e68f86bc5018c5d7530c8b69c399b5f1555aeab07b26e` |
| `SchnorrKeyVerifier` | `0x05c89ad6970fcccd1ae338de0509b189f9a37004470898d451ebb4be92f8537e` | `0x055ffb43ea1027212a8749f2888d6a482fa322cff768437b2c5589bdaabcc28d` |
| `DleqVerifier` | `0x07258c8fea11a1b883e1bf8ec83d7d60898d33d09f6e7fd6e5e2efe06b793329` | `0x055aeac49f052f9abd369f4cf4f4a8d0c44b1cbb85aab0aa38c7297dc6030663` |
| `VerifierAdapter` | `0x02de3b5b72e02327798056f5379517a5d1f580b54e07d439c1fbcb04909a7183` | `0x077ef55a6b9ad68ad6d3c9233100d736c49bbd6e7062337d3c788378b2aebb72` |
| `PokerGame` | `0x049dbee252721c706180cb61ab2999865cd153d780359b41990b52a49e97ee5a` | `0x038387676d4ab0c1738089f026a48e668a1c9a410ee3917ac4b32a9d50a6458d` |

Verified after deploying by playing a whole hand against it: two shuffle
proofs, the deck opened in a SINGLE chunk (19.6 s, where K=5 took three at ~27 s
each), the button drawn, blinds posted, four streets, both hands shown at
showdown, the pot settled and the button rotated. Redeploy plus that hand cost
**372.87 STRK**.

Redeployed 2026-09-06 for **K=16** deck opening (§6.2). Only two classes are
new — the deck-open verifier and `PokerGame`; the shuffle, Schnorr, DLEQ and
adapter classes were already declared and were re-used, which is why their
class hashes are unchanged and only their addresses moved. The superseded
`PokerGame` at `0x06b3845b…` still exists on-chain and still works; it opens
decks in chunks of 5.

| superseded | address |
|---|---|
| `PokerGame` (K=5) | `0x06b3845ba0519a064054b6465aaa115aea929d814afc0719e8425d1bb5f64359` |

Deployed with `NETWORK=sepolia ./scripts/deploy_local.sh` from the sncast
account `sepolia` (`0x719eb8a2f1673e9afc94de57c69b69c6c0cfe555711f219c62ddcf953c78cac`),
itself deployed in
[`0x341b99f5…`](https://sepolia.voyager.online/tx/0x0341b99f5767facadb1636d1add6dae160957a2907b6510b62c1c91143d1b3fe).

The buy-in token is **canonical STRK**
(`0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`), which
sits at the same address on devnet, Sepolia and Mainnet. No mock: sncast builds
release, so `cairo/`'s feature-gated `MockErc20` is not in the artifact, and a
public deployment should not ship a token whose `mint()` is open to anyone.

Verified live after deploying: 95 entrypoints, including the whole blind
structure (`set_blinds`, `reveal_draw_card`, `post_blinds`, `start_next_hand`);
`get_shuffle_verifier()` returns the adapter above; view calls answer.

### What it cost

**516.58 STRK**, against a pre-flight estimate of 516. Declares dominate, and
they scale with contract size:

| | declare |
|---|---|
| shuffle verifier | 126.85 |
| deck-open verifier | 125.97 |
| `PokerGame` (65,770 CASM felts) | 149.69 |
| `SchnorrKeyVerifier` | 61.28 |
| `DleqVerifier` | 38.15 |
| `VerifierAdapter` | 14.34 |

Worth recording because it is the kind of number nobody has to hand: at
Sepolia's L2 gas price that day (`0x703f3d99c`, ~30.1 Gfri), declaring this
stack cost about half a thousand STRK. Budget for a redeploy accordingly — and
note that `PokerGame` alone is ~150 STRK, which is what a constructor change
costs.

`pool` is the deploying account. There is no STRK20 privacy pool wired in, and
`privacy_invoke` is the only entrypoint that reads it — nothing in the poker
flow touches it. It is constructor-fixed, so pointing it at a real pool means
redeploying `PokerGame`.

## Local devnet — 2026-09-05 (redeployed with the blind structure)

Deployed by `scripts/deploy_local.sh` against `starknet-devnet --seed 0`, and
exercised end to end by `scripts/smoke_local.mjs` with **real proofs
throughout**. Devnet state does not survive a restart, so these addresses are
reproducible rather than permanent: re-run the script and they come back
(the class hashes are deterministic; the addresses depend on the deployer's
nonce).

| | class hash | address |
|---|---|---|
| `UltraKeccakZKHonkVerifier` (shuffle) | `0x052273e9c0b297c2aabe7f97fa2d10727a6ba113c44c69d9123eda277a3ea8c1` | `0x04f58e4b28bb32d92a2537bf74dcd8e081261d5e3fe2670a61a381455b8e0a17` |
| `UltraKeccakZKHonkVerifier` (deck open) | `0x02823287183c4ef5f5b0a7b101b54a211819f55f859d4a6af54d68afde8d0a24` | `0x04b055b1d3bfa76873d9f226713d90d0800535f0cc7c23e0d4cab8794efb7499` |
| `SchnorrKeyVerifier` | `0x05c89ad6970fcccd1ae338de0509b189f9a37004470898d451ebb4be92f8537e` | `0x044a29c1bfbacb187f57460608bd9dd650a0e0a4047acc53fc6311cfb40ff718` |
| `DleqVerifier` | `0x07258c8fea11a1b883e1bf8ec83d7d60898d33d09f6e7fd6e5e2efe06b793329` | `0x060a9a683b23bccbccdd79d8f0d76fba87b5324a38e4e71384e655020d6ffa2a` |
| `VerifierAdapter` | `0x02de3b5b72e02327798056f5379517a5d1f580b54e07d439c1fbcb04909a7183` | `0x053f082e2e920266430a0146311e7f53b14c5bb159927c881e960402d4472242` |
| `PokerGame` | `0x06bc2936945e78b985245484faa2d04dd11b71394575cdec2cbfa707bbacb81e` | `0x029a0ccc64e65c5e5d04166a4fdc61af4dc57098c2f724104993a17514b5e9cb` |

Note the two Honk verifiers are the same contract NAME and different class
hashes: they differ only in their VK constants. The deploy script fails if they
ever come out equal, because that means one package was built stale.

The buy-in token is devnet's **predeployed STRK**
(`0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d`), not a
mock — sncast builds with the release profile, so `cairo/`'s feature-gated
`MockErc20` is not in the artifact, and a deployment should not contain a token
whose `mint()` is open to anyone. Devnet's predeployed accounts already hold
STRK.

`pool` is set to the deploying account. There is no STRK20 privacy pool on
devnet, and `privacy_invoke` is the only entrypoint that reads it — nothing in
the poker flow touches it.

### What the smoke test proved on-chain

Not "it deployed" — it ran:

- key registration with real Schnorr PoKs, accepted by the deployed verifier
- `begin_shuffle` with the joint key summed and checked on Grumpkin by the real
  `VerifierAdapter`
- the full shuffle chain, 2 real Honk proofs (~20 s each to prove, 3,053 felts
  each), each accepted on-chain
- `open_deck` in **3** chunks with real Honk proofs (~13 s each) — a two-seat
  table is now 3·2+5 = 11 positions, because the blind structure gives every
  seat a high-card draw — the last chunk padded `10,10,10,10,10` exactly as the
  contract derives it
- the stored ciphertexts compared against the final deck, position by position
- **the button drawn from that deck**: one card per seat at positions 9 and 10,
  each read with a real aggregate Chaum–Pedersen DLEQ over both seats' shares,
  accepted by the deployed `DleqVerifier` in ~3 s. Seat 0 drew `5h`, seat 1
  drew `Jd`, and the contract gave the button to seat 1 — the highest card,
  decided by the deck and by nobody at the table
- `post_blinds` from that button: heads-up the button posted the small blind
  (10) and the other seat the big (20), pot 30, action to the small blind —
  which is the hold'em rule, and the one implementations most often get
  backwards

That last pair is the point of running this at all. A mock verifier will accept
any DLEQ; only the deployed one proves that the card deciding the blinds really
is the card the committed deck holds at that position.

Mainnet: not deployed, and not advisable yet — PROTOCOL.md §8 and §9 still
record open liveness and trust gaps.

## Inherited from the starter kit (not this project's contract)

The starter kit this repo was scaffolded from ships a separate demo
contract, `StrkInvokeHelper` (an echo-only `privacy_invoke` helper), already
deployed by its author:

- class hash: `0x2a4482a13cb7f70dce6f7ba99c4ee6ce404379abeddd9b831b6bf24eb71e137`
- address (mainnet): `0x78ae662e0cc6d1ab2cfeaf2a51ba8783d88e31886f88a794d142f95a6f8735b`

That address belongs to the starter kit, not to this project — don't reuse
it as if it were `PokerGame`. Kept here only as a working reference for how
a minimal `privacy_invoke` helper deploys and behaves.
