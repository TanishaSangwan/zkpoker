"use client";
import { create } from "zustand";
import type { Account } from "starknet";

// A locally-connected `starknet-devnet` account — deliberately separate from
// walletContext.ts's `myWalletAccount` (a WalletAccountV6, only ever produced
// by SelectWallet.tsx's real-wallet connect flow). A plain devnet `Account`
// (built from one of `starknet-devnet`'s predeployed private keys, see
// ConnectDevnet.tsx) doesn't implement WalletAccountV6's STRK20-specific
// methods (strk20InvokeTransaction, strk20Balances, ...) — there's no real
// STRK20 pool on devnet for those to talk to anyway. Keeping this as its own
// store means the original starter-kit page (`/`, WalletAccountV6Tag.tsx)
// and its shared walletContext.ts stay completely untouched; only
// PokerPanel.tsx reads this one, alongside walletContext.ts's own state, to
// decide which account actually signs a PokerGame call.
interface DevnetAccountState {
  account: Account | undefined;
  address: string;
  connected: boolean;
  setDevnetAccount: (account: Account, address: string) => void;
  disconnectDevnet: () => void;
}

export const useDevnetAccount = create<DevnetAccountState>()((set) => ({
  account: undefined,
  address: "",
  connected: false,
  setDevnetAccount: (account, address) => set({ account, address, connected: true }),
  disconnectDevnet: () => set({ account: undefined, address: "", connected: false }),
}));
