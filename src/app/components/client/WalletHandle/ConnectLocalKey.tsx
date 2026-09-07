"use client";

import { useEffect, useState } from "react";
import { Account } from "starknet";
import * as constants from "@/utils/constants";
import { useFrontendProvider } from "../provider/providerContext";
import { useLocalAccount } from "../provider/localAccountContext";
import styles from "../../../poker/poker.module.css";
import uni from "../../../uni.module.css";

// Sit at a table on a real chain using a key you already control.
//
// ── Why this exists ─────────────────────────────────────────────────────
// A hand needs at least two players, and a browser extension holds exactly
// one connection per profile: two tabs of one browser both see whichever
// account the extension currently has selected, so a wallet cannot fill two
// seats on one machine. ConnectDevnet.tsx solves that on devnet by reading
// the predeployed accounts, but a public chain has no such list. This is the
// same idea for Sepolia: paste the key for an account you funded, in each
// tab, and each tab signs as a different player.
//
// ── Where the key is kept, and why there ────────────────────────────────
// sessionStorage, not localStorage, and the difference is the whole point:
//
//   * localStorage is shared by every tab on the origin, so two seats would
//     overwrite each other's signer -- the exact bug this component exists to
//     avoid;
//   * sessionStorage is per tab AND survives a reload, which matters because
//     losing your signer halfway through a hand strands the table: n-of-n
//     decryption means a seat that cannot act stalls everyone (PROTOCOL.md
//     §8.1), and reloading a stuck tab is the first thing anyone tries.
//
// It dies with the tab, so it is not a place a key quietly accumulates.
//
// ── Scope ───────────────────────────────────────────────────────────────
// Testnet only, enforced below: pasting a private key into a web page is
// acceptable for a throwaway Sepolia account and is never acceptable for one
// holding real value, so Mainnet refuses rather than warns. On Mainnet, or
// for anything you care about, connect a wallet.
const SESSION_KEY = "zkpoker:local-signer:v1";

type Stored = { address: string; privateKey: string; providerIndex: number };

// A single hex value and nothing else -- no leading account name, no trailing
// comment, no second field.
const HEX = /^0x[0-9a-fA-F]+$/;

function readStored(): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Stored;
    if (!v?.address || !v?.privateKey || typeof v.providerIndex !== "number") return null;
    return v;
  } catch {
    return null;
  }
}

function forgetStored() {
  try { window.sessionStorage.removeItem(SESSION_KEY); } catch {}
}

export default function ConnectLocalKey() {
  const providerIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const connected = useLocalAccount((s) => s.connected);
  const connectedAt = useLocalAccount((s) => s.providerIndex);
  const address = useLocalAccount((s) => s.address);
  const setLocalAccount = useLocalAccount((s) => s.setLocalAccount);
  const disconnectLocal = useLocalAccount((s) => s.disconnectLocal);

  const [open, setOpen] = useState(false);
  const [addressInput, setAddressInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const isMainnet = providerIndex === 0;
  const live = connected && connectedAt === providerIndex;

  // Connect, verifying the account is really there before accepting it.
  //
  // The check is not ceremony. A mistyped address, or the right address on the
  // wrong network, otherwise stays invisible until the first transaction --
  // which on this page is somewhere inside key registration, reported as a
  // failed table action rather than as "that account does not exist". Reading
  // the class hash costs one RPC call and turns that into a sentence.
  //
  // Shape is checked BEFORE any of that, and separately, because the two
  // failures need different sentences. Both fields are pasted by hand, and the
  // usual slip is copying a whole line -- `sepolia 0x1234...` -- name and all.
  // starknet.js then rejects it deep inside its own parsing as "invalid BigInt
  // syntax", which names neither the field at fault nor what is wrong with it,
  // and reporting that as "no account deployed at that address" sends you off
  // checking a network that was never the problem.
  async function connect(addr: string, priv: string, quiet: boolean) {
    setError("");
    const address = addr.trim();
    const privateKey = priv.trim();
    const network = constants.NetworkLabels[providerIndex] ?? `provider ${providerIndex}`;

    const malformed = !HEX.test(address)
      ? "The address must be a single 0x… hex value. If you pasted a whole line, drop the account name in front of it."
      : !HEX.test(privateKey)
        ? "The private key must be a single 0x… hex value. If you pasted a whole line, drop the account name in front of it."
        : "";
    if (malformed) {
      if (!quiet) setError(malformed);
      forgetStored();
      return;
    }

    setBusy(true);
    try {
      const provider = constants.myFrontendProviders[providerIndex];
      try {
        await provider.getClassHashAt(address);
      } catch (e: any) {
        throw new Error(
          `No account is deployed at ${address.slice(0, 8)}…${address.slice(-4)} on ${network} ` +
            `(${e?.message ?? e}). Check the address, and that you picked the right network above.`,
        );
      }
      const account = new Account({ provider, address, signer: privateKey });
      setLocalAccount(account, address, providerIndex);
      try {
        window.sessionStorage.setItem(
          SESSION_KEY,
          JSON.stringify({ address, privateKey, providerIndex }),
        );
      } catch {
        // Private mode, or storage blocked. The signer still works for this
        // page view; it just will not survive a reload. Not worth failing the
        // connect over, and PokerPanel already warns about unstorable seats.
      }
      setOpen(false);
      setKeyInput("");
    } catch (e: any) {
      if (!quiet) setError(String(e?.message ?? e));
      // A stored signer that no longer resolves is worse than none: drop it
      // rather than leave a dead Account that fails at signing time.
      forgetStored();
    } finally {
      setBusy(false);
    }
  }

  // Restore this tab's signer after a reload. Only when the stored entry
  // belongs to the network currently selected -- an Account is bound to the
  // provider it was built against, so restoring a devnet signer onto Sepolia
  // would be handing PokerPanel a signer for the wrong chain.
  useEffect(() => {
    if (connected || isMainnet) return;
    const s = readStored();
    if (!s || s.providerIndex !== providerIndex) return;
    void connect(s.address, s.privateKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerIndex, connected, isMainnet]);

  function forget() {
    forgetStored();
    disconnectLocal();
    setOpen(false);
  }

  if (isMainnet) return null;

  if (live) {
    return (
      <div className={styles.actionsRow} style={{ alignItems: "center" }}>
        <span className={styles.chip}>
          {constants.NetworkLabels[providerIndex] ?? "local"} key: {address.slice(0, 6)}…{address.slice(-4)}
        </span>
        <button className={uni.btn} onClick={forget}>
          Disconnect
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <div>
        <button className={uni.btn} onClick={() => setOpen(true)}>
          Use a {constants.NetworkLabels[providerIndex] ?? "local"} private key
        </button>
        <p className={styles.sectionHint}>
          For sitting two seats at one table from one machine — a wallet extension can only
          hold one. Testnet keys only.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <span className={styles.label}>
        Account address on {constants.NetworkLabels[providerIndex] ?? `provider ${providerIndex}`}
      </span>
      <input
        className={styles.input}
        value={addressInput}
        onChange={(e) => setAddressInput(e.target.value)}
        placeholder="0x…"
        spellCheck={false}
      />
      <span className={styles.label}>Private key</span>
      <input
        className={styles.input}
        type="password"
        value={keyInput}
        onChange={(e) => setKeyInput(e.target.value)}
        placeholder="0x…"
        spellCheck={false}
        autoComplete="off"
      />
      <div className={styles.actionsRow}>
        <button
          className={uni.btn}
          disabled={busy || !addressInput.trim() || !keyInput.trim()}
          onClick={() => void connect(addressInput, keyInput, false)}
        >
          {busy ? "Checking…" : "Connect"}
        </button>
        <button className={uni.btn} onClick={() => { setOpen(false); setError(""); }}>
          Cancel
        </button>
      </div>
      <p className={styles.sectionHint}>
        Kept in this tab only (sessionStorage): a reload keeps your seat, closing the tab
        forgets the key. Never paste a key that holds anything you would miss.
      </p>
      {error ? <pre className={uni.receiptNote}>{error}</pre> : null}
    </div>
  );
}
