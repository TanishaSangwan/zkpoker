"use client";

import { useMemo, useState } from "react";
import { num } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import styles from "./poker.module.css";
import uni from "../uni.module.css";
import * as constants from "@/utils/constants";
import { useStoreWallet } from "../components/Wallet/walletContext";
import { useFrontendProvider } from "../components/client/provider/providerContext";
import SelectWallet from "../components/client/WalletHandle/SelectWallet";
import {
  STREET_NAMES,
  cardToName,
  erc20ApproveCall,
  executeAndWait,
  parseCardList,
  pgCall,
  pokerGameReader,
  seedHashOf,
  toFelt,
} from "./pokerActions";

// ─── shared result-card plumbing (mirrors WalletAccountV6Tag.tsx's, kept
// local to this file since the two pages' CSS modules differ) ────────────

type ResultRow = { label: string; value: string };
type ActionResult = { status: "pending" | "ok" | "error"; title: string; rows?: ResultRow[]; note?: string };

function errorResult(err: unknown): ActionResult {
  const msg = (err as any)?.message ?? (err as any)?.toString?.() ?? String(err);
  return { status: "error", title: "Action failed", note: msg };
}

function shortHex(h: string): string {
  try {
    const hex = num.toHex(h);
    return hex.length <= 13 ? hex : `${hex.slice(0, 7)}...${hex.slice(-4)}`;
  } catch {
    return h;
  }
}

// Plain async helper (NOT a hook — calls no hooks itself) shared by every
// action button below: connect/deployed guards, pending/ok/error states,
// and a best-effort table-state refresh on success. Each call site passes
// its own `setResult` from a `useState` declared directly in the component
// body — deliberately not wrapped in a local per-section hook, which would
// violate the Rules of Hooks (a function named `useX` defined and called
// from inside another component's render body).
async function runAction(
  setResult: (r: ActionResult | null) => void,
  label: string,
  myWalletAccount: unknown,
  deployed: boolean,
  fn: () => Promise<{ txHash: string }>,
  onSuccess?: () => void,
) {
  if (!myWalletAccount) {
    setResult({ status: "error", title: "Connect a wallet first." });
    return;
  }
  if (!deployed) {
    setResult({ status: "error", title: "PokerGame not deployed on this network." });
    return;
  }
  setResult({ status: "pending", title: `${label}…` });
  try {
    const { txHash } = await fn();
    setResult({ status: "ok", title: `${label} confirmed`, rows: [{ label: "Transaction", value: txHash }] });
    onSuccess?.();
  } catch (e) {
    setResult(errorResult(e));
  }
}

function ResultCard({ r, explorerTxUrl }: { r: ActionResult; explorerTxUrl: (h: string) => string }) {
  return (
    <div
      className={`${uni.receipt} ${r.status === "error" ? uni.receiptError : r.status === "pending" ? uni.receiptPending : uni.receiptOk}`}
    >
      <div className={uni.receiptHead}>
        <span className={uni.receiptIcon}>{r.status === "ok" ? "✓" : r.status === "error" ? "!" : "⋯"}</span>
        <span>{r.title}</span>
      </div>
      {r.rows?.length ? (
        <div className={uni.receiptRows}>
          {r.rows.map((row) => (
            <div key={row.label} className={uni.receiptRow}>
              <span className={uni.receiptLabel}>{row.label}</span>
              {row.label === "Transaction" ? (
                <a className={uni.receiptLink} href={explorerTxUrl(row.value)} target="_blank" rel="noreferrer">
                  {shortHex(row.value)} ↗
                </a>
              ) : (
                <span className={uni.receiptValue}>{row.value}</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {r.note ? <pre className={uni.receiptNote}>{r.note}</pre> : null}
    </div>
  );
}

// ─── main panel ──────────────────────────────────────────────────────────

type TableState = {
  dealer: string;
  pot: bigint;
  street: number;
  settled: boolean;
  maxSeats: number;
  seedHash: string;
  revealedSeed: string;
  createdAt: bigint;
  poolFromContract: string;
};

export default function PokerPanel() {
  const myFrontendProviderIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const myWalletAccount = useStoreWallet((s) => s.myWalletAccount);
  const connectedAddress = useStoreWallet((s) => s.address);
  const isConnected = useStoreWallet((s) => s.isConnected);

  const networkName = constants.Strk20Networks[myFrontendProviderIndex];
  const isStrk20Network = networkName !== undefined;
  const pokerGameAddr = constants.pokerGameAddressForIndex(myFrontendProviderIndex);
  const deployed = (() => {
    try {
      return num.toBigInt(pokerGameAddr) !== 0n;
    } catch {
      return false;
    }
  })();
  const provider = constants.myFrontendProviders[myFrontendProviderIndex];
  const reader = useMemo(() => (deployed ? pokerGameReader(pokerGameAddr, provider) : null), [deployed, pokerGameAddr, provider]);

  const explorerTxUrl = (h: string) =>
    myFrontendProviderIndex === 0 ? `https://voyager.online/tx/${h}` : `https://sepolia.voyager.online/tx/${h}`;

  // ── table state ──────────────────────────────────────────────────────
  const [tableIdText, setTableIdText] = useState("TABLE_1");
  const [loadedTableId, setLoadedTableId] = useState<string | null>(null);
  const [tableState, setTableState] = useState<TableState | null>(null);
  const [loadResult, setLoadResult] = useState<ActionResult | null>(null);

  async function loadTable() {
    setLoadResult(null);
    if (!reader) {
      setLoadResult({ status: "error", title: "PokerGame not deployed on this network." });
      return;
    }
    let tableId: string;
    try {
      tableId = toFelt(tableIdText);
    } catch (e) {
      setLoadResult(errorResult(e));
      return;
    }
    setLoadResult({ status: "pending", title: "Loading table…" });
    try {
      const [dealer, pot, street, settled, maxSeats, seedHash, revealedSeed, createdAt, poolFromContract] =
        await Promise.all([
          reader.get_table_dealer(tableId),
          reader.get_pot(tableId),
          reader.get_table_street(tableId),
          reader.get_table_settled(tableId),
          reader.get_table_max_seats(tableId),
          reader.get_seed_hash(tableId),
          reader.get_revealed_seed(tableId),
          reader.get_table_created_at(tableId),
          reader.get_pool(),
        ]);
      setLoadedTableId(tableId);
      setTableState({
        dealer: num.toHex(dealer),
        pot: BigInt(pot),
        street: Number(street),
        settled: Boolean(settled),
        maxSeats: Number(maxSeats),
        seedHash: num.toHex(seedHash),
        revealedSeed: num.toHex(revealedSeed),
        createdAt: BigInt(createdAt),
        poolFromContract: num.toHex(poolFromContract),
      });
      setLoadResult(null);
    } catch (e) {
      setLoadResult(errorResult(e));
    }
  }

  const tableExists = tableState !== null && tableState.dealer !== "0x0";
  const isDealer =
    isConnected &&
    tableExists &&
    connectedAddress &&
    (() => {
      try {
        return num.toBigInt(connectedAddress) === num.toBigInt(tableState!.dealer);
      } catch {
        return false;
      }
    })();

  // ── Create table ──────────────────────────────────────────────────────
  const [createResult, setCreateResult] = useState<ActionResult | null>(null);
  const [ctToken, setCtToken] = useState(constants.defaultPokerToken);
  const [ctBuyIn, setCtBuyIn] = useState("0");
  const [ctMaxSeats, setCtMaxSeats] = useState("6");
  async function handleCreateTable() {
    await runAction(setCreateResult, "Create table", myWalletAccount, deployed, async () => {
      const tableId = toFelt(tableIdText);
      const call = pgCall(pokerGameAddr, "create_table", {
        table_id: tableId,
        token: toFelt(ctToken),
        buy_in: BigInt(ctBuyIn || "0"),
        max_seats: Number(ctMaxSeats),
      });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Join table ────────────────────────────────────────────────────────
  const [joinResult, setJoinResult] = useState<ActionResult | null>(null);
  const [jtSeat, setJtSeat] = useState("0");
  const [jtNoteId, setJtNoteId] = useState("");
  async function handleJoinTable() {
    await runAction(setJoinResult, "Join table", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "join_table", {
        table_id: toFelt(tableIdText),
        seat: jtSeat,
        hole_card_note_id: toFelt(jtNoteId),
      });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Betting ───────────────────────────────────────────────────────────
  const [betResult, setBetResult] = useState<ActionResult | null>(null);
  const [foldResult, setFoldResult] = useState<ActionResult | null>(null);
  const [betSeat, setBetSeat] = useState("0");
  const [betAmount, setBetAmount] = useState("0");
  async function handleBet() {
    await runAction(setBetResult, "Bet", myWalletAccount, deployed, async () => {
      const tableId = toFelt(tableIdText);
      const amount = BigInt(betAmount || "0");
      // Approve + bet in ONE multicall. PokerGame has no get_table_token
      // view, so this can't be read back from chain state — it's whatever
      // the "Token (this table's)" field below has in it (shares ctToken
      // with the Create Table section above; re-enter it here if you
      // didn't create this table yourself in this session).
      const tokenAddr = toFelt(ctToken);
      const calls = [
        erc20ApproveCall(tokenAddr, pokerGameAddr, amount),
        pgCall(pokerGameAddr, "bet", { table_id: tableId, seat: betSeat, amount }),
      ];
      const { txHash } = await executeAndWait(myWalletAccount!, provider, calls);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Dealer actions ────────────────────────────────────────────────────
  const [commitResult, setCommitResult] = useState<ActionResult | null>(null);
  const [markDealtResult, setMarkDealtResult] = useState<ActionResult | null>(null);
  const [revealResult, setRevealResult] = useState<ActionResult | null>(null);
  const [advanceResult, setAdvanceResult] = useState<ActionResult | null>(null);
  const [seedText, setSeedText] = useState("");
  const computedHash = (() => {
    if (!seedText.trim()) return "";
    try {
      return seedHashOf(toFelt(seedText));
    } catch {
      return "";
    }
  })();
  async function handleCommitDeal() {
    await runAction(setCommitResult, "Commit deal", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "commit_deal", {
        table_id: toFelt(tableIdText),
        seed_hash: seedHashOf(toFelt(seedText)),
      });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  async function handleMarkDealt() {
    await runAction(setMarkDealtResult, "Mark dealt", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "mark_dealt", { table_id: toFelt(tableIdText) });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  async function handleRevealSeed() {
    await runAction(setRevealResult, "Reveal seed", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "reveal_seed", { table_id: toFelt(tableIdText), seed: toFelt(seedText) });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  async function handleAdvanceStreet() {
    await runAction(setAdvanceResult, "Advance street", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "advance_street", { table_id: toFelt(tableIdText) });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Fold / reclaim ────────────────────────────────────────────────────
  const [foldSeat, setFoldSeat] = useState("0");
  async function handleFold() {
    await runAction(setFoldResult, "Fold", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "fold", { table_id: toFelt(tableIdText), seat: foldSeat });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  const [reclaimResult, setReclaimResult] = useState<ActionResult | null>(null);
  const [reclaimSeat, setReclaimSeat] = useState("0");
  async function handleReclaim() {
    await runAction(setReclaimResult, "Reclaim stalled bet", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "reclaim_stalled_bet", { table_id: toFelt(tableIdText), seat: reclaimSeat });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Settle (trusted winner list) ─────────────────────────────────────
  const [settleResult, setSettleResult] = useState<ActionResult | null>(null);
  const [settleWinners, setSettleWinners] = useState("0");
  const [settleNoteIds, setSettleNoteIds] = useState("");
  async function handleSettleTable() {
    await runAction(setSettleResult, "Settle table", myWalletAccount, deployed, async () => {
      const winners = settleWinners.split(",").map((s) => s.trim()).filter(Boolean);
      const noteIds = settleNoteIds.split(",").map((s) => toFelt(s.trim())).filter(Boolean);
      const call = pgCall(pokerGameAddr, "settle_table", {
        table_id: toFelt(tableIdText),
        winners,
        payout_note_ids: noteIds,
      });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Settle by hand (on-chain showdown) ───────────────────────────────
  const [settleHandResult, setSettleHandResult] = useState<ActionResult | null>(null);
  const [sbhSeats, setSbhSeats] = useState("0,1");
  const [sbhHoleCards, setSbhHoleCards] = useState("As,Kh\n2c,3d");
  const [sbhCommunity, setSbhCommunity] = useState("Qh,Tc,5h,3d,Ac");
  const [sbhNoteIds, setSbhNoteIds] = useState("");
  async function handleSettleByHand() {
    await runAction(setSettleHandResult, "Settle table by hand", myWalletAccount, deployed, async () => {
      const seats = sbhSeats.split(",").map((s) => s.trim()).filter(Boolean);
      const holeLines = sbhHoleCards.split("\n").map((l) => l.trim()).filter(Boolean);
      const holeCards = holeLines.map((line) => {
        const cards = parseCardList(line);
        if (cards.length !== 2) throw new Error(`Each hole-card line needs exactly 2 cards, got "${line}".`);
        return [cards[0], cards[1]] as [number, number];
      });
      const community = parseCardList(sbhCommunity);
      if (community.length !== 5) throw new Error(`Community needs exactly 5 cards, got ${community.length}.`);
      const noteIds = sbhNoteIds.split(",").map((s) => toFelt(s.trim())).filter(Boolean);
      if (seats.length !== holeCards.length || seats.length !== noteIds.length) {
        throw new Error("seats / hole-card lines / payout note ids must all be the same length.");
      }
      const call = pgCall(pokerGameAddr, "settle_table_by_hand", {
        table_id: toFelt(tableIdText),
        seats,
        hole_cards: holeCards,
        community_cards: community,
        payout_note_ids: noteIds,
      });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Reserve a payout note (round 9 — resolves the note_id design gap
  // described in docs/DESIGN.md "Buy-in, betting, payout flow": a payout
  // must be routed into an OPEN note, which the winner has to create and
  // register with PokerGame *before* the dealer settles, since
  // settle_table/settle_table_by_hand require payout_note_ids[i] to
  // already be registered in note_id_owner.) ─────────────────────────────
  const [openNoteResult, setOpenNoteResult] = useState<ActionResult | null>(null);
  const [openNoteToken, setOpenNoteToken] = useState(constants.defaultPokerToken);
  async function handleCreateOpenNote() {
    setOpenNoteResult(null);
    if (!myWalletAccount || !connectedAddress) {
      setOpenNoteResult({ status: "error", title: "Connect a wallet first." });
      return;
    }
    if (!isStrk20Network) {
      setOpenNoteResult({ status: "error", title: "This needs the STRK20 pool (Mainnet or Sepolia)." });
      return;
    }
    // Standalone CreateOpenNote (phase 5) — no paired invoke. Valid on its
    // own per the STRK20 phase table (a transaction may stop at any
    // phase); an open note's amount is 0 until something later fills it,
    // so this doesn't need any funding action alongside it.
    const actions: WALLET_API.STRK20_ACTION[] = [
      { type: "transfer", token: toFelt(openNoteToken), amount: "OPEN", recipient: connectedAddress },
    ];
    setOpenNoteResult({ status: "pending", title: "Confirm in your wallet…" });
    try {
      const r = await myWalletAccount.strk20InvokeTransaction(actions);
      const txH = r.transaction_hash;
      setOpenNoteResult({ status: "pending", title: "Waiting for confirmation…", rows: [{ label: "Transaction", value: txH }] });
      await provider.waitForTransaction(txH, { retries: 400, retryInterval: 3000 });
      setOpenNoteResult({
        status: "ok",
        title: "Open note created",
        rows: [{ label: "Transaction", value: txH }],
        note:
          "This dApp can't read your wallet's private viewing-key material, so it can't compute or list the " +
          "note_id this created — that's deliberate (STRK20 keeps that inside the wallet). Check your wallet's " +
          "own activity/notes view for it, then paste it below to register it with PokerGame.",
      });
    } catch (e) {
      setOpenNoteResult(errorResult(e));
    }
  }

  const [registerNoteResult, setRegisterNoteResult] = useState<ActionResult | null>(null);
  const [reserveNoteId, setReserveNoteId] = useState("");
  async function handleRegisterPayoutNote() {
    await runAction(setRegisterNoteResult, "Register payout note", myWalletAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "register_payout_note", { note_id: toFelt(reserveNoteId) });
      const { txHash } = await executeAndWait(myWalletAccount!, provider, [call]);
      return { txHash };
    });
  }

  // ── Claim payout (STRK20 privacy_invoke) ─────────────────────────────
  // Resolved design (round 9): the note_id used here must be the SAME one
  // already registered above and given to the dealer for payout_note_ids
  // — it already exists, so this is a bare "invoke" with no paired
  // "transfer OPEN" (that placeholder only resolves a note opened in this
  // SAME transaction, which isn't what we want here).
  const [claimResult, setClaimResult] = useState<ActionResult | null>(null);
  const [claimNoteId, setClaimNoteId] = useState("");
  const [claimToken, setClaimToken] = useState(constants.defaultPokerToken);
  async function handleClaim() {
    setClaimResult(null);
    if (!myWalletAccount || !connectedAddress) {
      setClaimResult({ status: "error", title: "Connect a wallet first." });
      return;
    }
    if (!isStrk20Network) {
      setClaimResult({ status: "error", title: "Claiming needs the STRK20 pool (Mainnet or Sepolia)." });
      return;
    }
    if (!claimNoteId.trim()) {
      setClaimResult({ status: "error", title: "Enter the note_id you registered above." });
      return;
    }
    const actions: WALLET_API.STRK20_ACTION[] = [
      {
        type: "invoke",
        contract: pokerGameAddr,
        calldata: [num.toHex(toFelt(claimToken)), "${poolAddress}", num.toHex(toFelt(claimNoteId))],
      },
    ];
    setClaimResult({ status: "pending", title: "Confirm in your wallet…" });
    try {
      const r = await myWalletAccount.strk20InvokeTransaction(actions);
      const txH = r.transaction_hash;
      setClaimResult({ status: "pending", title: "Waiting for confirmation…", rows: [{ label: "Transaction", value: txH }] });
      await provider.waitForTransaction(txH, { retries: 400, retryInterval: 3000 });
      setClaimResult({ status: "ok", title: "Claim transaction confirmed", rows: [{ label: "Transaction", value: txH }] });
    } catch (e) {
      setClaimResult(errorResult(e));
    }
  }

  // ── render ────────────────────────────────────────────────────────────
  const disabledReason = !isConnected ? "Connect a wallet." : !deployed ? `PokerGame not deployed on ${networkName ?? "this network"}.` : "";

  return (
    <div className={styles.wrap}>
      {!deployed && (
        <div className={styles.banner}>
          <b>PokerGame isn&apos;t deployed on {networkName ?? "this network"} yet.</b> Set{" "}
          <span className={styles.bannerCode}>
            NEXT_PUBLIC_POKERGAME_{networkName ?? "SEPOLIA"}
          </span>{" "}
          in <span className={styles.bannerCode}>.env.local</span> once it is (see cairo/address.md) — every
          action below is wired and ready, it just has nowhere to send a transaction yet.
        </div>
      )}

      {!isConnected && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Connect a wallet to get started</div>
          <div className={styles.actionsRow}>
            <SelectWallet variant="ctaBig" />
          </div>
        </div>
      )}

      {/* ── Table lookup / state ── */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Table</span>
          {tableExists && (
            <span className={`${styles.chip} ${isDealer ? styles.chipDealer : styles.chipMuted}`}>
              {isDealer ? "You are the dealer" : "Viewing"}
            </span>
          )}
        </div>
        <p className={styles.sectionHint}>
          table_id can be a short name (e.g. &quot;TABLE_1&quot;, encoded as a Cairo short string, exactly like
          the tests) or a raw felt/hex.
        </p>
        <div className={styles.tableIdRow}>
          <div className={styles.field}>
            <span className={styles.label}>table_id</span>
            <input className={styles.input} value={tableIdText} onChange={(e) => setTableIdText(e.target.value)} />
          </div>
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={loadTable} disabled={!deployed}>
            Load
          </button>
        </div>
        {loadResult ? <ResultCard r={loadResult} explorerTxUrl={explorerTxUrl} /> : null}
        {tableState && (
          <div className={styles.stateGrid} style={{ marginTop: 14 }}>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Dealer</span>
              <span className={styles.stateValue}>{tableExists ? shortHex(tableState.dealer) : "— (no table)"}</span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Pot</span>
              <span className={styles.stateValue}>{tableState.pot.toString()}</span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Street</span>
              <span className={styles.stateValue}>
                {STREET_NAMES[tableState.street] ?? tableState.street} ({tableState.street}/4)
              </span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Settled</span>
              <span className={styles.stateValue}>{tableState.settled ? "yes" : "no"}</span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Max seats</span>
              <span className={styles.stateValue}>{tableState.maxSeats}</span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Seed committed</span>
              <span className={styles.stateValue}>{tableState.seedHash !== "0x0" ? shortHex(tableState.seedHash) : "no"}</span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Seed revealed</span>
              <span className={styles.stateValue}>{tableState.revealedSeed !== "0x0" ? shortHex(tableState.revealedSeed) : "no"}</span>
            </div>
            <div className={styles.stateItem}>
              <span className={styles.stateLabel}>Contract's pool</span>
              <span className={styles.stateValue}>{shortHex(tableState.poolFromContract)}</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Create table ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Create table</div>
        <p className={styles.sectionHint}>
          Anyone can open a table — the caller becomes its dealer (create_table's own doc comment in lib.cairo).
          max_seats fixes the seat index space (0..max_seats-1) and is capped at 23.
        </p>
        <div className={styles.grid3}>
          <div className={styles.field}>
            <span className={styles.label}>Token</span>
            <input className={styles.input} value={ctToken} onChange={(e) => setCtToken(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Buy-in (raw units)</span>
            <input className={styles.input} value={ctBuyIn} onChange={(e) => setCtBuyIn(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Max seats</span>
            <input className={styles.input} type="number" min={1} max={23} value={ctMaxSeats} onChange={(e) => setCtMaxSeats(e.target.value)} />
          </div>
        </div>
        <div className={styles.actionsRow}>
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleCreateTable} disabled={!isConnected || !deployed}>
            Create table
          </button>
        </div>
        {createResult ? <ResultCard r={createResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Join table ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Join table</div>
        <p className={styles.sectionHint}>
          hole_card_note_id is the STRK20 encrypted note this seat&apos;s hole cards will be dealt into — normally
          produced by the privacy SDK&apos;s CreateEncNote action (phase 5) before this call. That step isn&apos;t
          wired into this UI (needs the pool live + the dealer coordinating the actual card encryption off-chain) —
          enter whatever note_id your own tooling already generated.
        </p>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <span className={styles.label}>Seat (0-based)</span>
            <input className={styles.input} type="number" min={0} value={jtSeat} onChange={(e) => setJtSeat(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>hole_card_note_id</span>
            <input className={styles.input} value={jtNoteId} onChange={(e) => setJtNoteId(e.target.value)} placeholder="0x... or a short name" />
          </div>
        </div>
        <div className={styles.actionsRow}>
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleJoinTable} disabled={!isConnected || !deployed}>
            Join table
          </button>
        </div>
        {joinResult ? <ResultCard r={joinResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Betting ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Betting</div>
        <p className={styles.sectionHint}>
          bet() pulls real funds via a plain ERC20 transfer_from (bet amounts are intentionally public — see
          docs/DESIGN.md) — this button batches approve + bet into one multicall. It reverts with a clear message
          if you haven&apos;t loaded a table above yet (there&apos;s no get_table_token view to read the token
          from — enter it manually below).
        </p>
        <div className={styles.grid3}>
          <div className={styles.field}>
            <span className={styles.label}>Seat</span>
            <input className={styles.input} type="number" min={0} value={betSeat} onChange={(e) => setBetSeat(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Amount (raw units)</span>
            <input className={styles.input} value={betAmount} onChange={(e) => setBetAmount(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Token (this table's)</span>
            <input className={styles.input} value={ctToken} onChange={(e) => setCtToken(e.target.value)} />
          </div>
        </div>
        <div className={styles.actionsRow}>
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleBet} disabled={!isConnected || !deployed}>
            Approve + Bet
          </button>
        </div>
        {betResult ? <ResultCard r={betResult} explorerTxUrl={explorerTxUrl} /> : null}

        <div className={styles.grid2} style={{ marginTop: 16 }}>
          <div className={styles.field}>
            <span className={styles.label}>Seat</span>
            <input className={styles.input} type="number" min={0} value={foldSeat} onChange={(e) => setFoldSeat(e.target.value)} />
          </div>
          <div className={styles.field} style={{ justifyContent: "flex-end" }}>
            <button className={uni.btn} onClick={handleFold} disabled={!isConnected || !deployed}>
              Fold
            </button>
          </div>
        </div>
        {foldResult ? <ResultCard r={foldResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Dealer actions ── */}
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Dealer actions</span>
          {tableExists && !isDealer && <span className={`${styles.chip} ${styles.chipMuted}`}>Not the dealer for this table</span>}
        </div>
        <p className={styles.sectionHint}>
          commit_deal / reveal_seed use the same seed below. The hash shown is computed client-side with
          starknet.js&apos;s Poseidon — verified during development to match Cairo&apos;s
          core::poseidon::poseidon_hash_span exactly for a single-element span, which is what commit_deal requires.
        </p>
        <div className={styles.field}>
          <span className={styles.label}>Seed</span>
          <input className={styles.input} value={seedText} onChange={(e) => setSeedText(e.target.value)} placeholder="a secret only the dealer knows until showdown" />
          {computedHash && <span className={styles.fieldHint}>seed_hash = {computedHash}</span>}
        </div>
        <div className={styles.actionsRow}>
          <button className={uni.btn} onClick={handleCommitDeal} disabled={!isDealer || !deployed}>
            Commit deal
          </button>
          <button className={uni.btn} onClick={handleMarkDealt} disabled={!isDealer || !deployed}>
            Mark dealt
          </button>
          <button className={uni.btn} onClick={handleRevealSeed} disabled={!isDealer || !deployed}>
            Reveal seed
          </button>
          <button className={uni.btn} onClick={handleAdvanceStreet} disabled={!isDealer || !deployed}>
            Advance street
          </button>
        </div>
        {commitResult ? <ResultCard r={commitResult} explorerTxUrl={explorerTxUrl} /> : null}
        {markDealtResult ? <ResultCard r={markDealtResult} explorerTxUrl={explorerTxUrl} /> : null}
        {revealResult ? <ResultCard r={revealResult} explorerTxUrl={explorerTxUrl} /> : null}
        {advanceResult ? <ResultCard r={advanceResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Settle ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Settle — trusted winner list</div>
        <p className={styles.sectionHint}>
          settle_table(winners, payout_note_ids): dealer-supplied winner list, split evenly (remainder to the
          first winner). Comma-separated, same length.
        </p>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <span className={styles.label}>Winner seats</span>
            <input className={styles.input} value={settleWinners} onChange={(e) => setSettleWinners(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Payout note_ids</span>
            <input className={styles.input} value={settleNoteIds} onChange={(e) => setSettleNoteIds(e.target.value)} />
          </div>
        </div>
        <div className={styles.actionsRow}>
          <button className={uni.btn} onClick={handleSettleTable} disabled={!isDealer || !deployed}>
            Settle table
          </button>
        </div>
        {settleResult ? <ResultCard r={settleResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionTitle}>Settle — on-chain showdown</div>
        <p className={styles.sectionHint}>
          settle_table_by_hand: computes the winner from actual cards instead of trusting a claim. Requires
          reveal_seed to have run and Showdown street (4/4) — every card must match its position in
          shuffle::shuffled_deck(revealed_seed) or this reverts with CARD_MISMATCH (round 8 — see docs/DESIGN.md).
          Cards: rank+suit (&quot;As&quot;, &quot;Th&quot;, &quot;2c&quot;) or an index 0-51.
        </p>
        <div className={styles.field}>
          <span className={styles.label}>Seats (comma-separated, in order)</span>
          <input className={styles.input} value={sbhSeats} onChange={(e) => setSbhSeats(e.target.value)} />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Hole cards (one seat per line — &quot;As,Kh&quot;)</span>
          <textarea className={styles.textarea} value={sbhHoleCards} onChange={(e) => setSbhHoleCards(e.target.value)} />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Community (exactly 5)</span>
          <input className={styles.input} value={sbhCommunity} onChange={(e) => setSbhCommunity(e.target.value)} />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>Payout note_ids (comma-separated, same order as seats)</span>
          <input className={styles.input} value={sbhNoteIds} onChange={(e) => setSbhNoteIds(e.target.value)} />
        </div>
        <div className={styles.actionsRow}>
          <button className={uni.btn} onClick={handleSettleByHand} disabled={!isDealer || !deployed}>
            Settle by hand
          </button>
        </div>
        {settleHandResult ? <ResultCard r={settleHandResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Reclaim ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Reclaim a stalled bet</div>
        <p className={styles.sectionHint}>
          Any seat can reclaim exactly what it personally contributed once SETTLE_TIMEOUT_SECS (24h) has passed
          since create_table and the table hasn&apos;t settled — protects against an abandoned dealer.
        </p>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <span className={styles.label}>Seat</span>
            <input className={styles.input} type="number" min={0} value={reclaimSeat} onChange={(e) => setReclaimSeat(e.target.value)} />
          </div>
          <div className={styles.field} style={{ justifyContent: "flex-end" }}>
            <button className={uni.btn} onClick={handleReclaim} disabled={!isConnected || !deployed}>
              Reclaim
            </button>
          </div>
        </div>
        {reclaimResult ? <ResultCard r={reclaimResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Reserve a payout note (round 9) ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Reserve a payout note</div>
        <p className={styles.sectionHint}>
          Do this <i>before</i> the dealer settles, if you might win: settle_table/settle_table_by_hand need
          payout_note_ids[i] already registered to you (register_payout_note, round 9). A hole-card note can&apos;t
          be reused for this — it&apos;s an encrypted note, and only an open note can later be filled by
          privacy_invoke (notes-and-nullifiers.md: open vs. encrypted is fixed at creation).
        </p>
        <div className={styles.field}>
          <span className={styles.label}>Token</span>
          <input className={styles.input} value={openNoteToken} onChange={(e) => setOpenNoteToken(e.target.value)} />
        </div>
        <div className={styles.actionsRow}>
          <button className={uni.btn} onClick={handleCreateOpenNote} disabled={!isConnected || !isStrk20Network}>
            1. Create open note
          </button>
        </div>
        {openNoteResult ? <ResultCard r={openNoteResult} explorerTxUrl={explorerTxUrl} /> : null}

        <div className={styles.grid2} style={{ marginTop: 16 }}>
          <div className={styles.field}>
            <span className={styles.label}>note_id (from your wallet's activity view, after step 1)</span>
            <input className={styles.input} value={reserveNoteId} onChange={(e) => setReserveNoteId(e.target.value)} />
          </div>
          <div className={styles.field} style={{ justifyContent: "flex-end" }}>
            <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleRegisterPayoutNote} disabled={!isConnected || !deployed}>
              2. Register with PokerGame
            </button>
          </div>
        </div>
        <div className={styles.caution}>
          This dApp can&apos;t compute or list your open note&apos;s id itself — that needs your wallet&apos;s
          private viewing-key material, which stays inside the wallet by design (see docs/DESIGN.md). Read it from
          your wallet&apos;s own UI after step 1, then give the same value to your table&apos;s dealer for
          payout_note_ids.
        </div>
        {registerNoteResult ? <ResultCard r={registerNoteResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Claim payout ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Claim a payout</div>
        <p className={styles.sectionHint}>
          Once settled, and using the SAME note_id you registered above: a bare &quot;invoke&quot; action naming
          PokerGame (no paired &quot;transfer OPEN&quot; — the note already exists, this isn&apos;t
          <span className={styles.bannerCode}>${"{"}openNoteIds[0]{"}"}</span>). The pool calls privacy_invoke,
          which reads pending_payout[note_id] and fills the note with what&apos;s owed.
        </p>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <span className={styles.label}>Token</span>
            <input className={styles.input} value={claimToken} onChange={(e) => setClaimToken(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>note_id (the one you registered)</span>
            <input className={styles.input} value={claimNoteId} onChange={(e) => setClaimNoteId(e.target.value)} />
          </div>
        </div>
        <div className={styles.actionsRow}>
          <button className={uni.btn} onClick={handleClaim} disabled={!isConnected || !isStrk20Network}>
            Claim
          </button>
        </div>
        {claimResult ? <ResultCard r={claimResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {disabledReason && <p className={styles.sectionHint} style={{ textAlign: "center" }}>{disabledReason}</p>}
    </div>
  );
}
