# Deployments

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

Sepolia/mainnet: not deployed. Record here when they are.

## Inherited from the starter kit (not this project's contract)

The starter kit this repo was scaffolded from ships a separate demo
contract, `StrkInvokeHelper` (an echo-only `privacy_invoke` helper), already
deployed by its author:

- class hash: `0x2a4482a13cb7f70dce6f7ba99c4ee6ce404379abeddd9b831b6bf24eb71e137`
- address (mainnet): `0x78ae662e0cc6d1ab2cfeaf2a51ba8783d88e31886f88a794d142f95a6f8735b`

That address belongs to the starter kit, not to this project — don't reuse
it as if it were `PokerGame`. Kept here only as a working reference for how
a minimal `privacy_invoke` helper deploys and behaves.
