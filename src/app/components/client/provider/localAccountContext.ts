"use client";
import { create } from "zustand";
import type { Account } from "starknet";

// A locally-signed account — a plain starknet.js `Account` built from a raw
// private key, deliberately separate from walletContext.ts's
// `myWalletAccount` (a WalletAccountV6, only ever produced by
// SelectWallet.tsx's real-wallet connect flow). A plain `Account` doesn't
// implement WalletAccountV6's STRK20-specific methods
// (strk20InvokeTransaction, strk20Balances, ...); only PokerGame's own
// entrypoints are driven through this. Keeping it as its own store means the
// original starter-kit page (`/`, WalletAccountV6Tag.tsx) and its shared
// walletContext.ts stay completely untouched; only PokerPanel.tsx reads this
// one, alongside walletContext.ts's own state, to decide which account
// actually signs a PokerGame call.
//
// Two producers: ConnectDevnet.tsx picks one of `starknet-devnet`'s
// predeployed accounts, ConnectLocalKey.tsx takes a pasted testnet key. Both
// exist because one browser extension cannot sit in two seats at once, and a
// table needs at least two players.
//
// ── Why providerIndex is part of the state ──────────────────────────────
// An `Account` is bound at construction to the RpcProvider it was built
// against, and that binding is invisible from the outside: an Account built
// against devnet will happily *try* to sign a Sepolia call and fail somewhere
// deep in estimation, or worse, succeed against the wrong chain. Recording
// which provider it belongs to lets PokerPanel ignore it the moment the
// selected network no longer matches, instead of trusting a stale signer.
interface LocalAccountState {
  account: Account | undefined;
  address: string;
  connected: boolean;
  // Index into constants.myFrontendProviders that `account` was built against.
  // -1 when nothing is connected.
  providerIndex: number;
  setLocalAccount: (account: Account, address: string, providerIndex: number) => void;
  disconnectLocal: () => void;
}

export const useLocalAccount = create<LocalAccountState>()((set) => ({
  account: undefined,
  address: "",
  connected: false,
  providerIndex: -1,
  setLocalAccount: (account, address, providerIndex) =>
    set({ account, address, providerIndex, connected: true }),
  disconnectLocal: () =>
    set({ account: undefined, address: "", providerIndex: -1, connected: false }),
}));
