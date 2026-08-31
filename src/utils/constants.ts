import { ProviderInterface, RpcProvider } from "starknet";

// ─── Example config — swap these for your own token / pool / helper ─────────

// DEMO VALUE: the ERC-20 this starter shields. Replace with the token your app
// moves privately (STRK on Starknet here).
export const addrSTRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

// Frontend RPC providers, indexed. The STRK20 privacy pool lives on Mainnet (0)
// and Sepolia (2); index 1 is a spare public testnet endpoint. NEXT_PUBLIC_PROVIDER_URL
// is your Alchemy key (see .env.example).
export const myFrontendProviders: ProviderInterface[] = [
    new RpcProvider({ nodeUrl: "https://starknet-mainnet.g.alchemy.com/starknet/version/rpc/v0_10/" + process.env.NEXT_PUBLIC_PROVIDER_URL }),
    new RpcProvider({ nodeUrl: "https://starknet-testnet.public.blastapi.io/rpc/v0_7" }),
    new RpcProvider({ nodeUrl: "https://starknet-sepolia.g.alchemy.com/starknet/version/rpc/v0_10/" + process.env.NEXT_PUBLIC_PROVIDER_URL })];

// ─── Example anonymizer (echo helper) ───────────────────────────────────────
// DEMO CONTRACT: StrkInvokeHelper (cairo/src/lib.cairo) just round-trips STRK
// through an open note to exercise the privacy_invoke flow end to end. Replace
// with your real anonymizer that performs an actual protocol action.

// DEMO VALUE: echo helper deployed on Mainnet.
export const Strk20EchoHelperAddress = "0x78ae662e0cc6d1ab2cfeaf2a51ba8783d88e31886f88a794d142f95a6f8735b";

// Echo helper on Sepolia — set NEXT_PUBLIC_STRK20_ECHO_HELPER_SEPOLIA to enable the
// Echo action there. "0x0" = not deployed (the action stays disabled). Deploy a fresh
// instance from the Echo tab, then paste the address into .env.local.
export const Strk20EchoHelperSepolia = process.env.NEXT_PUBLIC_STRK20_ECHO_HELPER_SEPOLIA ?? "0x0";

// Declared class hash of the echo helper (Mainnet + Sepolia). Deploying a fresh
// instance (no constructor args) needs only this class hash + a signed UDC deploy.
// See cairo/address.md.
export const Strk20EchoHelperClassHash = "0x2a4482a13cb7f70dce6f7ba99c4ee6ce404379abeddd9b831b6bf24eb71e137";

// Resolve the echo helper for a frontend provider index (0 = Mainnet, 2 = Sepolia).
// Returns "0x0" when no helper is deployed on that network.
export function echoHelperForIndex(index: number): string {
    if (index === 0) return Strk20EchoHelperAddress;
    if (index === 2) return Strk20EchoHelperSepolia;
    return "0x0";
}

// Frontend provider indices where the STRK20 privacy pool is available, mapped to a
// display name. Used to gate the WalletAccountV6 STRK20 actions.
export const Strk20Networks: Record<number, string> = { 0: "MAINNET", 2: "SEPOLIA" };

// ─── PokerGame (cairo/src/lib.cairo) ────────────────────────────────────────
// This project's own contract. NOT deployed anywhere yet — see
// cairo/address.md. Both env vars default to "0x0" (undeployed); the /poker
// page shows a clear "not deployed on this network" state instead of a
// broken/silently-failing one whenever the resolved address is zero.
export const PokerGameMainnet = process.env.NEXT_PUBLIC_POKERGAME_MAINNET ?? "0x0";
export const PokerGameSepolia = process.env.NEXT_PUBLIC_POKERGAME_SEPOLIA ?? "0x0";

// Resolve PokerGame's address for a frontend provider index (0 = Mainnet, 2 =
// Sepolia — same indices as echoHelperForIndex above). Returns "0x0" when
// nothing is configured for that network.
export function pokerGameAddressForIndex(index: number): string {
  if (index === 0) return PokerGameMainnet;
  if (index === 2) return PokerGameSepolia;
  return "0x0";
}

// DEMO VALUE: the token /poker's "Create table" form pre-fills as the buy-in
// token. PokerGame.bet() moves this token via plain approve/transfer_from
// (see docs/DESIGN.md's privacy table — bet amounts are intentionally
// public), so it must be a real ERC20 the connected wallet can approve, not
// necessarily the STRK20-shielded asset. Swap for whatever token you're
// actually testing with.
export const defaultPokerToken = addrSTRK;
