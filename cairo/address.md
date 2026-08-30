# Deployments

`PokerGame` (this project's contract, `cairo/src/lib.cairo`) is not deployed
anywhere yet. Record class hash / addresses here once it is.

## Inherited from the starter kit (not this project's contract)

The starter kit this repo was scaffolded from ships a separate demo
contract, `StrkInvokeHelper` (an echo-only `privacy_invoke` helper), already
deployed by its author:

- class hash: `0x2a4482a13cb7f70dce6f7ba99c4ee6ce404379abeddd9b831b6bf24eb71e137`
- address (mainnet): `0x78ae662e0cc6d1ab2cfeaf2a51ba8783d88e31886f88a794d142f95a6f8735b`

That address belongs to the starter kit, not to this project — don't reuse
it as if it were `PokerGame`. Kept here only as a working reference for how
a minimal `privacy_invoke` helper deploys and behaves.
