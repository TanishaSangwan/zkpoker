# Deployments

## Local devnet — 2026-09-05

Deployed by `scripts/deploy_local.sh` against `starknet-devnet --seed 0`, and
exercised end to end by `scripts/smoke_local.mjs` with **real proofs
throughout**. Devnet state does not survive a restart, so these addresses are
reproducible rather than permanent: re-run the script and they come back
(the class hashes are deterministic; the addresses depend on the deployer's
nonce).

| | class hash | address |
|---|---|---|
| `UltraKeccakZKHonkVerifier` (shuffle) | `0x052273e9c0b297c2aabe7f97fa2d10727a6ba113c44c69d9123eda277a3ea8c1` | `0x01835f5674feb2239599bbb968d4531772985987a8f0e656abc020481a4d60e2` |
| `UltraKeccakZKHonkVerifier` (deck open) | `0x02823287183c4ef5f5b0a7b101b54a211819f55f859d4a6af54d68afde8d0a24` | `0x079fcd5ffde872316f726027155044881af9f921749da4ccc42e0dcf12a58906` |
| `SchnorrKeyVerifier` | `0x05c89ad6970fcccd1ae338de0509b189f9a37004470898d451ebb4be92f8537e` | `0x020e8c95928ec4cac72f2f50c4b5a3a644f943493ba38a1b18156f8b45a2f424` |
| `DleqVerifier` | `0x07258c8fea11a1b883e1bf8ec83d7d60898d33d09f6e7fd6e5e2efe06b793329` | `0x02384abcb6a0679baa97ffe979f6e5257e5262e3b1744c758760f86b4cf6292b` |
| `VerifierAdapter` | `0x02de3b5b72e02327798056f5379517a5d1f580b54e07d439c1fbcb04909a7183` | `0x0744cc07af7afa1844d4297cfce53d070e8314d82dd7b41cfde0ee6574bb7d9b` |
| `PokerGame` | `0x00e5572be1df8277a96790fbdd876a491cb010b664c5eb465c2924e46102b518` | `0x023c7cc4dd6d24d706de2375ab44e17f7ca5b347f436fff94dcc8525db9d1937` |

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
- the full shuffle chain, 2 real Honk proofs (18.2 s and 20.3 s to prove,
  3,053 felts each), each accepted on-chain
- `open_deck` in 2 chunks with real Honk proofs (~12 s each), the second chunk
  padded `5,6,7,8,8` exactly as the contract derives it
- the stored ciphertexts compared against the final deck, position by position

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
