"use client";

import { useEffect, useMemo, useState } from "react";
import { num, type AccountInterface } from "starknet";
import type { WALLET_API } from "@starknet-io/types-js";
import styles from "./poker.module.css";
import uni from "../uni.module.css";
import * as constants from "@/utils/constants";
import { useStoreWallet } from "../components/Wallet/walletContext";
import { useFrontendProvider } from "../components/client/provider/providerContext";
import { useDevnetAccount } from "../components/client/provider/devnetAccountContext";
import SelectWallet from "../components/client/WalletHandle/SelectWallet";
import ConnectDevnet from "../components/client/WalletHandle/ConnectDevnet";
import {
  SHOWDOWN_STREET,
  STREET_NAMES,
  cardToName,
  erc20ApproveCall,
  executeAndWait,
  packHoleCards,
  parseCardList,
  pgCall,
  pokerGameReader,
  seedHashOf,
  toFelt,
} from "./pokerActions";
import { communityPosition, seatHolePositions, shuffledDeckFromSeed } from "./fairness";

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
              {row.label === "Transaction" && explorerTxUrl(row.value) ? (
                <a className={uni.receiptLink} href={explorerTxUrl(row.value)} target="_blank" rel="noreferrer">
                  {shortHex(row.value)} ↗
                </a>
              ) : (
                <span className={uni.receiptValue}>
                  {row.label === "Transaction" ? shortHex(row.value) : row.value}
                </span>
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

  // A local devnet account (see ConnectDevnet.tsx) is a second, independent
  // way to sign PokerGame calls — no browser wallet extension needed. It
  // takes priority once connected (an explicit "use devnet" choice), and it
  // can drive every PokerGame entrypoint that just needs `.execute()` — the
  // STRK20-gated sections below (Deal hole cards, Reserve/Claim payout)
  // still require a real wallet's strk20InvokeTransaction, which a plain
  // devnet Account doesn't implement and devnet has no pool to talk to
  // anyway; those keep reading `myWalletAccount`/`connectedAddress` directly.
  const devnetAccount = useDevnetAccount((s) => s.account);
  const devnetAddress = useDevnetAccount((s) => s.address);
  const devnetConnected = useDevnetAccount((s) => s.connected);
  const activeAccount: AccountInterface | undefined = devnetConnected ? devnetAccount : myWalletAccount;
  const activeAddress = devnetConnected ? devnetAddress : connectedAddress;
  const activeConnected = devnetConnected || isConnected;

  // "Play": a guided visual table, sensible defaults, no raw-felt typing —
  // for trying the game with no prior context. "Verify": every raw
  // entrypoint/read this page has always had, plus a fairness-check panel
  // that independently recomputes a revealed deal — for someone who wants
  // to check the contract's claims directly rather than trust the UI.
  // Persisted locally purely as a per-browser convenience.
  const [mode, setMode] = useState<"play" | "verify">("play");
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pokerUiMode");
      if (saved === "play" || saved === "verify") setMode(saved);
    } catch {
      /* private browsing / storage blocked — default stands */
    }
  }, []);
  function setModeAndPersist(m: "play" | "verify") {
    setMode(m);
    try {
      localStorage.setItem("pokerUiMode", m);
    } catch {
      /* ignore */
    }
  }

  const networkName = constants.Strk20Networks[myFrontendProviderIndex];
  const isStrk20Network = networkName !== undefined;
  const networkLabel = constants.NetworkLabels[myFrontendProviderIndex] ?? "this network";
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

  // No block explorer exists for a local devnet — ResultCard falls back to
  // plain (unlinked) text whenever this returns "".
  const explorerTxUrl = (h: string) =>
    myFrontendProviderIndex === constants.DEVNET_PROVIDER_INDEX
      ? ""
      : myFrontendProviderIndex === 0
        ? `https://voyager.online/tx/${h}`
        : `https://sepolia.voyager.online/tx/${h}`;

  // ── table state ──────────────────────────────────────────────────────
  const [tableIdText, setTableIdText] = useState("TABLE_1");
  const [loadedTableId, setLoadedTableId] = useState<string | null>(null);
  const [tableState, setTableState] = useState<TableState | null>(null);
  const [loadResult, setLoadResult] = useState<ActionResult | null>(null);
  const [seatState, setSeatState] = useState<{ seat: number; owner: string; contributed: bigint }[] | null>(null);

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
      // Per-seat state, for the visual table (Play mode) — who's sitting
      // where and how much they've put in. Not part of the original admin
      // panel's reads; used only to render the seat ring.
      const maxSeatsNum = Number(maxSeats);
      const seats = await Promise.all(
        Array.from({ length: maxSeatsNum }, (_, seat) => seat).map(async (seat) => {
          const [owner, contributed] = await Promise.all([
            reader.get_seat_owner(tableId, seat),
            reader.get_seat_contributed(tableId, seat),
          ]);
          return { seat, owner: num.toHex(owner), contributed: BigInt(contributed) };
        }),
      );
      setSeatState(seats);
      setLoadResult(null);
    } catch (e) {
      setLoadResult(errorResult(e));
    }
  }

  const tableExists = tableState !== null && tableState.dealer !== "0x0";
  const isDealer =
    activeConnected &&
    tableExists &&
    activeAddress &&
    (() => {
      try {
        return num.toBigInt(activeAddress) === num.toBigInt(tableState!.dealer);
      } catch {
        return false;
      }
    })();

  // Which loaded seat (if any) is you, and the first open one if you don't
  // have one yet — drives the visual table's "sit down" prompt and action
  // bar (Play mode). addrEq guards every compare the same way isDealer does
  // above: an unparseable address (e.g. "0x0") just means "not a match".
  function addrEq(a: string, b: string): boolean {
    try {
      return num.toBigInt(a) === num.toBigInt(b);
    } catch {
      return false;
    }
  }
  const mySeat =
    activeConnected && activeAddress && seatState
      ? seatState.find((s) => s.owner !== "0x0" && addrEq(s.owner, activeAddress))?.seat
      : undefined;
  const firstOpenSeat = seatState?.find((s) => s.owner === "0x0")?.seat;

  // ── Create table ──────────────────────────────────────────────────────
  const [createResult, setCreateResult] = useState<ActionResult | null>(null);
  const [ctToken, setCtToken] = useState(constants.defaultPokerToken);
  const [ctBuyIn, setCtBuyIn] = useState("0");
  const [ctMaxSeats, setCtMaxSeats] = useState("6");
  // Devnet has no real STRK deployment — swap the Token field's default to
  // the devnet MockErc20 once devnet connects, but only if the field is
  // still untouched (don't clobber something the user typed).
  useEffect(() => {
    if (devnetConnected && ctToken === constants.defaultPokerToken && constants.defaultDevnetToken !== "0x0") {
      setCtToken(constants.defaultDevnetToken);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devnetConnected]);
  async function handleCreateTable() {
    await runAction(setCreateResult, "Create table", activeAccount, deployed, async () => {
      const tableId = toFelt(tableIdText);
      const call = pgCall(pokerGameAddr, "create_table", {
        table_id: tableId,
        token: toFelt(ctToken),
        buy_in: BigInt(ctBuyIn || "0"),
        max_seats: Number(ctMaxSeats),
      });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Deal hole cards (round 10 — see pokerActions.ts's packHoleCards doc
  // comment for the encoding: THIS PROJECT'S OWN convention for carrying
  // two card values in a note's amount, not a documented STRK20 pattern —
  // none exists in any installed skill reference to source one from. ────
  const [dealResult, setDealResult] = useState<ActionResult | null>(null);
  const [dealToken, setDealToken] = useState(constants.defaultPokerToken);
  const [dealRecipient, setDealRecipient] = useState("");
  const [dealCards, setDealCards] = useState("");
  async function handleDealHoleCards() {
    setDealResult(null);
    if (!myWalletAccount || !connectedAddress) {
      setDealResult({ status: "error", title: "Connect a wallet first." });
      return;
    }
    if (!isStrk20Network) {
      setDealResult({ status: "error", title: "This needs the STRK20 pool (Mainnet or Sepolia)." });
      return;
    }
    let packed: bigint;
    let recipient: string;
    let token: string;
    try {
      const cards = parseCardList(dealCards);
      if (cards.length !== 2) throw new Error(`Enter exactly 2 cards, got ${cards.length}.`);
      packed = packHoleCards(cards[0], cards[1]);
      recipient = toFelt(dealRecipient);
      token = toFelt(dealToken);
    } catch (e) {
      setDealResult(errorResult(e));
      return;
    }
    // Deposit brings `packed` units of the real table token into the
    // dealer's own private temp balance (phase 3, "+amount"), immediately
    // spent by the transfer that creates the recipient's encrypted note
    // (phase 5, "-amount") — nets to zero within this one transaction,
    // satisfying STRK20's per-token balance invariant. Requires the dealer
    // to actually hold `packed` units (at most 2703, in the token's
    // smallest unit — dust) of this token in their own regular balance.
    const actions: WALLET_API.STRK20_ACTION[] = [
      { type: "deposit", token, amount: num.toHex(packed) },
      { type: "transfer", token, amount: num.toHex(packed), recipient },
    ];
    setDealResult({ status: "pending", title: "Confirm in your wallet…" });
    try {
      const r = await myWalletAccount.strk20InvokeTransaction(actions);
      const txH = r.transaction_hash;
      setDealResult({ status: "pending", title: "Waiting for confirmation…", rows: [{ label: "Transaction", value: txH }] });
      await provider.waitForTransaction(txH, { retries: 400, retryInterval: 3000 });
      setDealResult({
        status: "ok",
        title: "Hole cards dealt",
        rows: [
          { label: "Transaction", value: txH },
          { label: "Packed amount", value: packed.toString() },
        ],
        note:
          "The recipient should check their own wallet's activity/notes view for the note_id this landed at " +
          "(same limitation as payout notes above — this dApp can't compute or list it from here), then call " +
          "join_table below with (seat, that note_id) to record it on-chain.",
      });
    } catch (e) {
      setDealResult(errorResult(e));
    }
  }

  // ── Join table ────────────────────────────────────────────────────────
  const [joinResult, setJoinResult] = useState<ActionResult | null>(null);
  const [jtSeat, setJtSeat] = useState("0");
  const [jtNoteId, setJtNoteId] = useState("");
  async function handleJoinTable() {
    await runAction(setJoinResult, "Join table", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "join_table", {
        table_id: toFelt(tableIdText),
        seat: jtSeat,
        hole_card_note_id: toFelt(jtNoteId),
      });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Betting ───────────────────────────────────────────────────────────
  const [betResult, setBetResult] = useState<ActionResult | null>(null);
  const [foldResult, setFoldResult] = useState<ActionResult | null>(null);
  const [betSeat, setBetSeat] = useState("0");
  const [betAmount, setBetAmount] = useState("0");
  // seatOverride: Play mode's action bar drives this for "your" seat
  // directly, rather than going through setBetSeat + a synchronous call —
  // React state updates aren't visible to a function invoked in the same
  // tick, so that pattern would read the stale seat.
  async function handleBet(seatOverride?: string) {
    await runAction(setBetResult, "Bet", activeAccount, deployed, async () => {
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
        pgCall(pokerGameAddr, "bet", { table_id: tableId, seat: seatOverride ?? betSeat, amount }),
      ];
      const { txHash } = await executeAndWait(activeAccount!, provider, calls);
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
  async function handleCommitDeal(seedOverride?: string) {
    await runAction(setCommitResult, "Commit deal", activeAccount, deployed, async () => {
      const seed = seedOverride ?? seedText;
      const call = pgCall(pokerGameAddr, "commit_deal", {
        table_id: toFelt(tableIdText),
        seed_hash: seedHashOf(toFelt(seed)),
      });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  async function handleMarkDealt() {
    await runAction(setMarkDealtResult, "Mark dealt", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "mark_dealt", { table_id: toFelt(tableIdText) });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  async function handleRevealSeed(seedOverride?: string) {
    await runAction(setRevealResult, "Reveal seed", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "reveal_seed", {
        table_id: toFelt(tableIdText),
        seed: toFelt(seedOverride ?? seedText),
      });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  async function handleAdvanceStreet() {
    await runAction(setAdvanceResult, "Advance street", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "advance_street", { table_id: toFelt(tableIdText) });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Fold / reclaim ────────────────────────────────────────────────────
  const [foldSeat, setFoldSeat] = useState("0");
  async function handleFold(seatOverride?: string) {
    await runAction(setFoldResult, "Fold", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "fold", { table_id: toFelt(tableIdText), seat: seatOverride ?? foldSeat });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }
  const [reclaimResult, setReclaimResult] = useState<ActionResult | null>(null);
  const [reclaimSeat, setReclaimSeat] = useState("0");
  async function handleReclaim() {
    await runAction(setReclaimResult, "Reclaim stalled bet", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "reclaim_stalled_bet", { table_id: toFelt(tableIdText), seat: reclaimSeat });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => { if (loadedTableId) loadTable(); });
  }

  // ── Play mode: quick actions ──────────────────────────────────────────
  // Everything below wraps the SAME entrypoints/state above with sensible
  // defaults and no raw-felt typing, for the visual table view. Nothing new
  // is added to the contract surface.
  const [quickStartResult, setQuickStartResult] = useState<ActionResult | null>(null);

  // A random felt, good enough for a devnet/test hole_card_note_id where
  // there's no real STRK20 note behind it — NOT a substitute for the real
  // "Deal hole cards" flow above, which is what actually needs to happen
  // before join_table on a real network.
  function randomFelt(): string {
    return num.toHex(BigInt(Date.now()) * 1_000_000n + BigInt(Math.floor(Math.random() * 1_000_000)));
  }

  async function handleQuickStart() {
    await runAction(setQuickStartResult, "Create table & sit down", activeAccount, deployed, async () => {
      const tableId = toFelt(tableIdText);
      const calls = [
        pgCall(pokerGameAddr, "create_table", {
          table_id: tableId,
          token: toFelt(ctToken),
          buy_in: BigInt(ctBuyIn || "0"),
          max_seats: Number(ctMaxSeats),
        }),
        pgCall(pokerGameAddr, "join_table", {
          table_id: tableId,
          seat: "0",
          hole_card_note_id: jtNoteId.trim() ? toFelt(jtNoteId) : randomFelt(),
        }),
      ];
      const { txHash } = await executeAndWait(activeAccount!, provider, calls);
      return { txHash };
    }, () => loadTable());
  }

  async function handleQuickJoin(seat: number) {
    await runAction(setJoinResult, "Join table", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "join_table", {
        table_id: toFelt(tableIdText),
        seat: seat.toString(),
        hole_card_note_id: randomFelt(),
      });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
      return { txHash };
    }, () => loadTable());
  }

  // One click: generate a seed nobody's seen yet, commit its hash, and
  // remember the seed locally so "Reveal" (below) is also one click. The
  // Verify-mode Seed field (seedText) is kept in sync so an expert can see
  // exactly what got committed, not a hidden value.
  const [autoSeed, setAutoSeed] = useState<string | null>(null);
  async function handleQuickCommit() {
    const seed = randomFelt();
    setAutoSeed(seed);
    setSeedText(seed);
    await handleCommitDeal(seed);
  }
  async function handleQuickReveal() {
    if (!autoSeed) return;
    await handleRevealSeed(autoSeed);
  }

  // ── Settle (trusted winner list) ─────────────────────────────────────
  const [settleResult, setSettleResult] = useState<ActionResult | null>(null);
  const [settleWinners, setSettleWinners] = useState("0");
  const [settleNoteIds, setSettleNoteIds] = useState("");
  async function handleSettleTable() {
    await runAction(setSettleResult, "Settle table", activeAccount, deployed, async () => {
      const winners = settleWinners.split(",").map((s) => s.trim()).filter(Boolean);
      const noteIds = settleNoteIds.split(",").map((s) => toFelt(s.trim())).filter(Boolean);
      const call = pgCall(pokerGameAddr, "settle_table", {
        table_id: toFelt(tableIdText),
        winners,
        payout_note_ids: noteIds,
      });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
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
    await runAction(setSettleHandResult, "Settle table by hand", activeAccount, deployed, async () => {
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
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
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
    await runAction(setRegisterNoteResult, "Register payout note", activeAccount, deployed, async () => {
      const call = pgCall(pokerGameAddr, "register_payout_note", { note_id: toFelt(reserveNoteId) });
      const { txHash } = await executeAndWait(activeAccount!, provider, [call]);
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
  const disabledReason = !activeConnected ? "Connect a wallet." : !deployed ? `PokerGame not deployed on ${networkLabel}.` : "";

  return (
    <div className={styles.wrap}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Network</div>
        <p className={styles.sectionHint}>
          {networkLabel}
          {isStrk20Network ? "" : " — no STRK20 pool here, so the STRK20-gated sections below stay disabled."}
          {" "}Switch by connecting a real wallet on Mainnet/Sepolia, or use a local{" "}
          <span className={styles.bannerCode}>starknet-devnet</span> account below.
        </p>
        <ConnectDevnet />
      </div>

      <div className={styles.modeToggle}>
        <button
          className={`${styles.modeBtn} ${mode === "play" ? styles.modeBtnActive : ""}`}
          onClick={() => setModeAndPersist("play")}
        >
          Play
        </button>
        <button
          className={`${styles.modeBtn} ${mode === "verify" ? styles.modeBtnActive : ""}`}
          onClick={() => setModeAndPersist("verify")}
        >
          Verify
        </button>
      </div>

      {!deployed && (
        <div className={styles.banner}>
          <b>PokerGame isn&apos;t deployed on {networkLabel} yet.</b> Set{" "}
          <span className={styles.bannerCode}>
            NEXT_PUBLIC_POKERGAME_{networkLabel}
          </span>{" "}
          in <span className={styles.bannerCode}>.env.local</span> once it is (see cairo/address.md) — every
          action below is wired and ready, it just has nowhere to send a transaction yet.
        </div>
      )}

      {!activeConnected && (
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

      {/* ── Play mode: visual table ── */}
      {mode === "play" && (
        <>
          {!tableExists ? (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Get started</div>
              <p className={styles.sectionHint}>
                One click: creates a table (buy-in 0, 6 seats) and sits you down at seat 0 as its dealer. Or type
                an existing table_id above, hit Load, then use the sit-down prompt that appears below.
              </p>
              <div className={styles.actionsRow}>
                <button
                  className={`${uni.btn} ${uni.btnGreen}`}
                  onClick={handleQuickStart}
                  disabled={!activeConnected || !deployed}
                >
                  Create table &amp; sit down
                </button>
              </div>
              {quickStartResult ? <ResultCard r={quickStartResult} explorerTxUrl={explorerTxUrl} /> : null}
            </div>
          ) : (
            <div className={styles.section}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionTitle}>At the table</span>
                <span className={`${styles.chip} ${styles.chipMuted}`}>table_id: {tableIdText}</span>
              </div>

              <div className={styles.felt}>
                <div className={styles.feltCenter}>
                  <div className={styles.feltPot}>Pot: {tableState!.pot.toString()}</div>
                  <div className={styles.feltStreet}>
                    {STREET_NAMES[tableState!.street] ?? tableState!.street}
                    {tableState!.settled ? " · settled" : ""}
                  </div>
                  <div className={styles.feltCards}>
                    {Array.from({ length: 5 }).map((_, i) => (
                      <div
                        key={i}
                        className={styles.cardBack}
                        title="Community cards stay hidden until showdown in this contract — see Verify mode's Fairness check once revealed."
                      />
                    ))}
                  </div>
                </div>
                {seatState?.map((s) => {
                  const empty = s.owner === "0x0";
                  const angle = (2 * Math.PI * s.seat) / tableState!.maxSeats - Math.PI / 2;
                  const left = `${50 + 42 * Math.cos(angle)}%`;
                  const top = `${50 + 40 * Math.sin(angle)}%`;
                  const seatIsDealer = !empty && addrEq(s.owner, tableState!.dealer);
                  const seatIsYou = mySeat === s.seat;
                  return (
                    <div
                      key={s.seat}
                      className={`${styles.seat} ${empty ? styles.seatEmpty : ""} ${seatIsYou ? styles.seatYou : ""}`}
                      style={{ left, top }}
                    >
                      <div>Seat {s.seat}</div>
                      {empty ? <div>open</div> : <div className={styles.seatAddr}>{shortHex(s.owner)}</div>}
                      {!empty && <div className={styles.seatChips}>{s.contributed.toString()}</div>}
                      {(seatIsDealer || seatIsYou) && (
                        <div className={styles.seatBadges}>
                          {seatIsDealer && <span className={styles.seatBadge}>DEALER</span>}
                          {seatIsYou && <span className={styles.seatBadge}>YOU</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {mySeat === undefined && firstOpenSeat !== undefined && (
                <div className={styles.actionsRow}>
                  <button
                    className={`${uni.btn} ${uni.btnGreen}`}
                    onClick={() => handleQuickJoin(firstOpenSeat)}
                    disabled={!activeConnected || !deployed}
                  >
                    Sit down at seat {firstOpenSeat}
                  </button>
                </div>
              )}
              {mySeat === undefined && firstOpenSeat === undefined && seatState && (
                <p className={styles.sectionHint}>Table&apos;s full — every seat is taken.</p>
              )}

              {mySeat !== undefined && (
                <div className={styles.actionBar} style={{ marginTop: 14 }}>
                  <input
                    className={styles.input}
                    style={{ maxWidth: 120 }}
                    value={betAmount}
                    onChange={(e) => setBetAmount(e.target.value)}
                  />
                  {[10, 25, 50].map((v) => (
                    <button key={v} className={styles.chipBtn} onClick={() => setBetAmount(v.toString())}>
                      +{v}
                    </button>
                  ))}
                  <button
                    className={`${uni.btn} ${uni.btnGreen}`}
                    onClick={() => handleBet(String(mySeat))}
                    disabled={!deployed}
                  >
                    Bet
                  </button>
                  <button className={uni.btn} onClick={() => handleFold(String(mySeat))} disabled={!deployed}>
                    Fold
                  </button>
                </div>
              )}
              {betResult ? <ResultCard r={betResult} explorerTxUrl={explorerTxUrl} /> : null}
              {foldResult ? <ResultCard r={foldResult} explorerTxUrl={explorerTxUrl} /> : null}
              {joinResult ? <ResultCard r={joinResult} explorerTxUrl={explorerTxUrl} /> : null}

              {isDealer && (
                <div style={{ marginTop: 16 }}>
                  <div className={styles.sectionTitle} style={{ fontSize: 13 }}>
                    Dealer
                  </div>
                  <p className={styles.sectionHint}>
                    Commit a fresh seed now, advance streets as betting rounds finish, reveal that same seed at
                    showdown. Check the math behind this yourself in Verify mode&apos;s Fairness check.
                  </p>
                  <div className={styles.actionsRow}>
                    <button
                      className={uni.btn}
                      onClick={handleQuickCommit}
                      disabled={!deployed || tableState!.seedHash !== "0x0"}
                    >
                      Commit deal (random seed)
                    </button>
                    <button
                      className={uni.btn}
                      onClick={handleAdvanceStreet}
                      disabled={!deployed || tableState!.street >= SHOWDOWN_STREET}
                    >
                      Advance street
                    </button>
                    <button
                      className={uni.btn}
                      onClick={handleQuickReveal}
                      disabled={!deployed || !autoSeed || tableState!.revealedSeed !== "0x0"}
                    >
                      Reveal seed
                    </button>
                  </div>
                  {commitResult ? <ResultCard r={commitResult} explorerTxUrl={explorerTxUrl} /> : null}
                  {advanceResult ? <ResultCard r={advanceResult} explorerTxUrl={explorerTxUrl} /> : null}
                  {revealResult ? <ResultCard r={revealResult} explorerTxUrl={explorerTxUrl} /> : null}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Verify mode: fairness check ── */}
      {mode === "verify" && tableState && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Fairness check</div>
          <p className={styles.sectionHint}>
            Recomputes this table&apos;s deal in your browser from the revealed seed — the same check
            scripts/deal_verify.py does from a terminal, and the exact algorithm cairo/src/shuffle.cairo runs
            on-chain (this port is checked against cairo/src/shuffle_vector_check.cairo&apos;s own pinned vector,
            not assumed equivalent). Every value below comes from the contract reads above, or is computed from
            them right here — nothing is trusted from the UI itself.
          </p>
          {tableState.revealedSeed === "0x0" ? (
            <p className={styles.sectionHint}>Seed not revealed yet — nothing to check until reveal_seed runs.</p>
          ) : (
            (() => {
              const computedHashFromSeed = seedHashOf(tableState.revealedSeed);
              const matches = computedHashFromSeed === tableState.seedHash;
              const deck = shuffledDeckFromSeed(tableState.revealedSeed);
              const maxSeats = tableState.maxSeats;
              function deckPositionLabel(pos: number): string | null {
                for (let s = 0; s < maxSeats; s++) {
                  const [a, b] = seatHolePositions(s);
                  if (pos === a || pos === b) return `Seat ${s}`;
                }
                for (let k = 0; k < 5; k++) {
                  if (pos === communityPosition(k, maxSeats)) return `Community ${k + 1}`;
                }
                return null;
              }
              return (
                <>
                  <div className={styles.stateGrid}>
                    <div className={styles.stateItem}>
                      <span className={styles.stateLabel}>seed_hash (on-chain)</span>
                      <span className={styles.stateValue}>{shortHex(tableState.seedHash)}</span>
                    </div>
                    <div className={styles.stateItem}>
                      <span className={styles.stateLabel}>poseidon(revealed_seed) — computed here</span>
                      <span className={styles.stateValue}>{shortHex(computedHashFromSeed)}</span>
                    </div>
                    <div className={styles.stateItem}>
                      <span className={styles.stateLabel}>Match</span>
                      <span className={styles.stateValue}>{matches ? "✓ matches" : "✗ MISMATCH"}</span>
                    </div>
                  </div>
                  <p className={styles.sectionHint} style={{ marginTop: 12 }}>
                    Full recomputed deck (deck position → card). Highlighted cells are exactly what
                    settle_table_by_hand requires each seat&apos;s hole cards / each community card to equal.
                  </p>
                  <div className={styles.deckGrid}>
                    {deck.map((card, pos) => {
                      const label = deckPositionLabel(pos);
                      return (
                        <div
                          key={pos}
                          className={`${styles.deckCell} ${
                            label?.startsWith("Seat") ? styles.deckCellSelf : ""
                          } ${label?.startsWith("Community") ? styles.deckCellCommunity : ""}`}
                        >
                          <div className={styles.deckPos}>#{pos}</div>
                          <div className={styles.deckCard}>{cardToName(card)}</div>
                          {label && <div className={styles.deckWho}>{label}</div>}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()
          )}
        </div>
      )}

      {mode === "verify" && (
        <>
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
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleCreateTable} disabled={!activeConnected || !deployed}>
            Create table
          </button>
        </div>
        {createResult ? <ResultCard r={createResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Deal hole cards (round 10) ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Deal hole cards</div>
        <p className={styles.sectionHint}>
          Dealer action, before the recipient joins. Packs two cards into a note&apos;s amount (see
          pokerActions.ts&apos;s packHoleCards — this project&apos;s own convention, not a documented STRK20
          pattern) and sends it as a real (dust-sized) private transfer in the table&apos;s own token: a Deposit
          brings that many units into your temp balance, then a Transfer spends them into the recipient&apos;s
          encrypted note — nets to zero, satisfying the balance invariant. You need to actually hold that many
          units (at most 2703, smallest unit) of the token.
        </p>
        <div className={styles.grid3}>
          <div className={styles.field}>
            <span className={styles.label}>Token</span>
            <input className={styles.input} value={dealToken} onChange={(e) => setDealToken(e.target.value)} />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Recipient address</span>
            <input className={styles.input} value={dealRecipient} onChange={(e) => setDealRecipient(e.target.value)} placeholder="0x..." />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Two hole cards</span>
            <input className={styles.input} value={dealCards} onChange={(e) => setDealCards(e.target.value)} placeholder="As,Kh" />
          </div>
        </div>
        <div className={styles.actionsRow}>
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleDealHoleCards} disabled={!isConnected || !isStrk20Network}>
            Deal
          </button>
        </div>
        <div className={styles.caution}>
          Not independently verified: whether a real wallet&apos;s UI actually lets the recipient look up the
          note_id this landed at (same class of assumption as &quot;Reserve a payout note&quot; below). Also
          unverified: whether the pool accepts a Deposit+Transfer pair for a dust amount without issue — nothing
          here has touched a live pool.
        </div>
        {dealResult ? <ResultCard r={dealResult} explorerTxUrl={explorerTxUrl} /> : null}
      </div>

      {/* ── Join table ── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Join table</div>
        <p className={styles.sectionHint}>
          hole_card_note_id is the note recorded above, once dealt — the recipient reads its actual note_id from
          their own wallet (this dApp can&apos;t compute or list it) and joins with it here. Seat reservation and
          note recording happen together, after dealing, not before — see the section above.
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
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleJoinTable} disabled={!activeConnected || !deployed}>
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
          <button className={`${uni.btn} ${uni.btnGreen}`} onClick={() => handleBet()} disabled={!activeConnected || !deployed}>
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
            <button className={uni.btn} onClick={() => handleFold()} disabled={!activeConnected || !deployed}>
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
          <button className={uni.btn} onClick={() => handleCommitDeal()} disabled={!isDealer || !deployed}>
            Commit deal
          </button>
          <button className={uni.btn} onClick={handleMarkDealt} disabled={!isDealer || !deployed}>
            Mark dealt
          </button>
          <button className={uni.btn} onClick={() => handleRevealSeed()} disabled={!isDealer || !deployed}>
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
            <button className={uni.btn} onClick={handleReclaim} disabled={!activeConnected || !deployed}>
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
            <button className={`${uni.btn} ${uni.btnGreen}`} onClick={handleRegisterPayoutNote} disabled={!activeConnected || !deployed}>
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
        </>
      )}

      {disabledReason && <p className={styles.sectionHint} style={{ textAlign: "center" }}>{disabledReason}</p>}
    </div>
  );
}
