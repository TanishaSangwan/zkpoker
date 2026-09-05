# Deployments

## Starknet Sepolia — 2026-09-06 (K=16 redeploy)

The real deployment. Public, permanent, and readable by anyone at
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
