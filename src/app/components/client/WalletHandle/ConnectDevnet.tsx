"use client";

import { useState } from "react";
import { Account, RpcProvider } from "starknet";
import * as constants from "@/utils/constants";
import { useFrontendProvider } from "../provider/providerContext";
import { useDevnetAccount } from "../provider/devnetAccountContext";
import styles from "../../../poker/poker.module.css";
import uni from "../../../uni.module.css";

// One of `starknet_devnet_getPredeployedAccounts`'s rows — see
// https://0xspaceshard.github.io/starknet-devnet/docs/predeployed. Only the
// fields this component actually uses are declared.
type DevnetPredeployedAccount = {
  address: string;
  private_key: string;
  initial_balance?: string;
};

// Not a real network connect — no browser wallet extension is involved.
// `starknet-devnet --seed <n>` predeploys a fixed set of funded accounts and
// exposes them (address + private key, in the clear — it's a local sandbox,
// not a real network) via the devnet-only JSON-RPC method
// `devnet_getPredeployedAccounts`. Picking one and building a plain
// starknet.js `Account` from it is the standard way to drive a devnet
// without a wallet extension configured for a custom localhost network.
//
// Deliberately its own component/store (devnetAccountContext.ts) rather than
// touching SelectWallet.tsx or walletContext.ts — those are shared with the
// original starter-kit page at `/`, which stays untouched (see README).
export default function ConnectDevnet() {
  const setCurrentFrontendProviderIndex = useFrontendProvider((s) => s.setCurrentFrontendProviderIndex);
  const devnetConnected = useDevnetAccount((s) => s.connected);
  const devnetAddress = useDevnetAccount((s) => s.address);
  const setDevnetAccount = useDevnetAccount((s) => s.setDevnetAccount);
  const disconnectDevnet = useDevnetAccount((s) => s.disconnectDevnet);

  const [accounts, setAccounts] = useState<DevnetPredeployedAccount[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function fetchAccounts() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch(constants.devnetRpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "devnet_getPredeployedAccounts", params: {} }),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message ?? "devnet RPC error");
      const list: DevnetPredeployedAccount[] = body.result ?? [];
      if (!list.length) throw new Error("devnet returned no predeployed accounts.");
      setAccounts(list);
    } catch (e: any) {
      setAccounts(null);
      setError(
        `Could not reach starknet-devnet at ${constants.devnetRpcUrl} (${e?.message ?? e}). ` +
          `Is \`starknet-devnet\` running there?`,
      );
    } finally {
      setLoading(false);
    }
  }

  function connectAccount(acc: DevnetPredeployedAccount) {
    const provider = new RpcProvider({ nodeUrl: constants.devnetRpcUrl });
    const account = new Account({ provider, address: acc.address, signer: acc.private_key });
    setDevnetAccount(account, acc.address);
    setCurrentFrontendProviderIndex(constants.DEVNET_PROVIDER_INDEX);
    setAccounts(null);
  }

  if (devnetConnected) {
    return (
      <div>
        <div className={styles.actionsRow} style={{ alignItems: "center" }}>
          <span className={styles.chip}>
            Devnet: {devnetAddress.slice(0, 6)}…{devnetAddress.slice(-4)}
          </span>
          <button className={uni.btn} onClick={disconnectDevnet}>
            Disconnect devnet
          </button>
        </div>
        {constants.defaultDevnetToken !== "0x0" && (
          <p className={styles.sectionHint}>
            Devnet token (paste into the Token fields below): <code>{constants.defaultDevnetToken}</code>
          </p>
        )}
      </div>
    );
  }

  if (accounts) {
    return (
      <div className={styles.field}>
        <span className={styles.label}>Pick a predeployed devnet account</span>
        <select
          className={styles.select}
          defaultValue=""
          onChange={(e) => {
            const acc = accounts.find((a) => a.address === e.target.value);
            if (acc) connectAccount(acc);
          }}
        >
          <option value="" disabled>
            {accounts.length} account(s) found — choose one
          </option>
          {accounts.map((a) => (
            <option key={a.address} value={a.address}>
              {a.address}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div>
      <button className={uni.btn} onClick={fetchAccounts} disabled={loading}>
        {loading ? "Looking for devnet…" : "Use local devnet account"}
      </button>
      {error ? <pre className={uni.receiptNote}>{error}</pre> : null}
    </div>
  );
}
