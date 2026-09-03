#!/usr/bin/env node
// Off-chain dealer bot for PokerGame (cairo/src/lib.cairo) — the "dealer"
// role should never be a player, and a human dealer shouldn't be able to
// advance a street or settle a hand just because they feel like it. This
// script is the fix: a single, fixed, non-player identity that is the ONLY
// caller of every dealer-only entrypoint, driven by real on-chain state
// instead of a person clicking a button.
//
// What this closes: `advance_street` currently has no bet-matching check
// (see lib.cairo's own doc comment) — anyone who happens to BE the dealer
// can call it whenever. Since only this bot's fixed address is ever the
// dealer (it's the only thing that ever calls create_table), and this bot
// enforces "every active seat has matched the street's bet" itself before
// calling advance_street, that gap is closed in practice for any table
// this bot runs — without touching the contract. The contract still has no
// enforcement of its own; a table created any other way is unprotected.
//
// What this does NOT close: V1's commit-reveal dealing still means
// whoever generates the seed and computes shuffled_deck(seed) to build
// each player's encrypted hole-card note SEES every hole card — same
// trust position a human dealer has today. Moving that role to fixed,
// public, auditable code removes the COLLUSION incentive (this bot has no
// stake in any hand) but does not remove the trust requirement itself —
// only V2's per-player shuffle + decryption shares (still unbuilt, see
// docs/V2-MENTAL-POKER.md §4.4-4.6) removes that. Don't oversell this: it
// is a real improvement over "a player is the dealer", not a V2 proof of
// no-trusted-party.
//
// Usage:
//   node scripts/dealer_bot.mjs create <table_id> <token> <buy_in> <max_seats>
//   node scripts/dealer_bot.mjs watch <table_id>
//
// Env vars (defaults target this project's local devnet setup):
//   DEALER_BOT_RPC       default http://127.0.0.1:5050
//   DEALER_BOT_ADDRESS   the bot's own account address (must be funded)
//   DEALER_BOT_PK        the bot's own private key
//   POKERGAME_ADDRESS    required — the deployed PokerGame address
//
// Deliberately a standalone Node script, not part of the Next.js build —
// this runs as a background service, not in anyone's browser.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { Account, CallData, Contract, RpcProvider, hash, num } from "starknet";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.DEALER_BOT_RPC ?? "http://127.0.0.1:5050";
const BOT_ADDRESS = process.env.DEALER_BOT_ADDRESS;
const BOT_PK = process.env.DEALER_BOT_PK;
const PG_ADDRESS = process.env.POKERGAME_ADDRESS;

if (!BOT_ADDRESS || !BOT_PK || !PG_ADDRESS) {
  console.error("Set DEALER_BOT_ADDRESS, DEALER_BOT_PK, and POKERGAME_ADDRESS.");
  process.exit(1);
}

const SHOWDOWN_STREET = 4;
const POLL_MS = 3000;
// How long the bot waits for further action before treating a street as
// "everyone who's going to act, has" when contributions are already even —
// real poker also needs an explicit "check" signal this contract doesn't
// have (see advance_street's own doc comment: no all-called-or-folded
// check exists on-chain). This is the bot's own policy layered on top, not
// something the contract enforces.
const SETTLE_GRACE_MS = 8000;

const provider = new RpcProvider({ nodeUrl: RPC_URL });
const account = new Account({ provider, address: BOT_ADDRESS, signer: BOT_PK });

const artifactPath = path.join(__dirname, "..", "cairo", "target", "dev", "zkpoker_PokerGame.contract_class.json");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const abi = artifact.abi;
const pgCallData = new CallData(abi);
const pg = new Contract({ abi, address: PG_ADDRESS, providerOrAccount: account });

function pgCall(entrypoint, args) {
  return { contractAddress: PG_ADDRESS, entrypoint, calldata: pgCallData.compile(entrypoint, args) };
}

async function submit(label, calls) {
  console.log(`[bot] ${label} ...`);
  const { transaction_hash } = await account.execute(calls);
  await provider.waitForTransaction(transaction_hash, { retries: 200, retryInterval: 1000 });
  console.log(`[bot] ${label} confirmed: ${transaction_hash}`);
  return transaction_hash;
}

// ─── shuffle.cairo port — same algorithm as src/app/poker/fairness.ts,
// verified there against cairo/src/shuffle_vector_check.cairo's pinned
// vector. Duplicated (not imported) because this is a standalone Node
// script with no build step, not part of the Next.js app.
function drawIndex(seed, step, bound) {
  const h = hash.computePoseidonHashOnElements([seed, step.toString()]);
  return Number(BigInt(h) % BigInt(bound));
}
function shuffledDeckFromSeed(seedFelt) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let idx = 51; idx >= 1; idx--) {
    const j = drawIndex(seedFelt, idx, idx + 1);
    [deck[idx], deck[j]] = [deck[j], deck[idx]];
  }
  return deck;
}

// A fresh seed per hand, drawn before any betting or dealing happens and
// committed immediately (see cmdCreate) — nobody, including the bot
// operator, can choose it after seeing how a hand plays out, which is
// exactly the property a self-interested human dealer wouldn't have.
function randomSeed() {
  const bytes = crypto.randomBytes(30); // stays well under the STARK prime
  return "0x" + bytes.toString("hex");
}

async function cmdCreate(tableId, token, buyIn, maxSeats) {
  const seed = randomSeed();
  const seedHash = hash.computePoseidonHashOnElements([seed]);
  await submit("create_table", [
    pgCall("create_table", { table_id: tableId, token, buy_in: BigInt(buyIn), max_seats: Number(maxSeats) }),
  ]);
  await submit("commit_deal (bot-drawn seed, committed before any betting)", [
    pgCall("commit_deal", { table_id: tableId, seed_hash: seedHash }),
  ]);
  console.log(`[bot] table ${tableId} created, seed committed. Seed kept in memory for this run only: ${seed}`);
  return seed;
}

async function readTable(tableId) {
  const [dealer, pot, street, settled, maxSeats, seedHash, revealedSeed] = await Promise.all([
    pg.get_table_dealer(tableId),
    pg.get_pot(tableId),
    pg.get_table_street(tableId),
    pg.get_table_settled(tableId),
    pg.get_table_max_seats(tableId),
    pg.get_seed_hash(tableId),
    pg.get_revealed_seed(tableId),
  ]);
  return {
    dealer: num.toHex(dealer),
    pot: BigInt(pot),
    street: Number(street),
    settled: Boolean(settled),
    maxSeats: Number(maxSeats),
    seedHash: num.toHex(seedHash),
    revealedSeed: num.toHex(revealedSeed),
  };
}

async function readSeats(tableId, maxSeats) {
  const seats = await Promise.all(
    Array.from({ length: maxSeats }, (_, seat) => seat).map(async (seat) => {
      const [owner, contributed, noteId] = await Promise.all([
        pg.get_seat_owner(tableId, seat),
        pg.get_seat_contributed(tableId, seat),
        pg.get_seat_note(tableId, seat),
      ]);
      return { seat, owner: num.toHex(owner), contributed: BigInt(contributed), noteId: num.toHex(noteId) };
    }),
  );
  return seats;
}

// Folds have no getter — the contract only exposes them as events (see
// lib.cairo's Fold event, `#[key] table_id`, `seat` in the data). Real
// selector match, not a shape guess — without this, a folded seat's
// contribution stays frozen at whatever it was, and maybeAdvanceStreet's
// "all active seats matched" check would never see it as inactive and
// could stall forever waiting for a seat that already left the hand.
const FOLD_SELECTOR = num.toHex(hash.starknetKeccak("Fold"));

async function readFoldedSeats(tableId) {
  const folded = new Set();
  let continuationToken;
  do {
    const res = await provider.getEvents({
      address: PG_ADDRESS,
      from_block: { block_number: 0 },
      to_block: "latest",
      chunk_size: 100,
      continuation_token: continuationToken,
    });
    for (const ev of res.events) {
      if (
        ev.keys.length === 2 &&
        num.toHex(ev.keys[0]) === FOLD_SELECTOR &&
        num.toBigInt(ev.keys[1]) === num.toBigInt(tableId) &&
        ev.data.length === 1
      ) {
        folded.add(Number(num.toBigInt(ev.data[0])));
      }
    }
    continuationToken = res.continuation_token;
  } while (continuationToken);
  return folded;
}

async function maybeAdvanceStreet(tableId, table, seats, folded) {
  if (table.settled || table.street >= SHOWDOWN_STREET) return false;
  const active = seats.filter((s) => s.owner !== "0x0" && !folded.has(s.seat));
  if (active.length === 0) return false; // nobody's joined yet — wait

  // Everyone but one folded: no more action to wait for. Checked via an
  // actual fold event having happened (folded.size > 0), NOT just
  // "one active seat" — a table with exactly one seat joined and nobody
  // else ever sitting down would otherwise match "one active seat" too,
  // and get force-advanced before a second player ever arrives. Real
  // poker awards the pot immediately without a showdown here; this
  // contract has no "win uncontested" entrypoint, so the bot's fallback is
  // to advance straight to Showdown itself and settle_table_by_hand
  // normally — the lone remaining seat's own hole cards trivially score
  // highest against nobody.
  if (active.length === 1 && folded.size > 0) {
    await submit(`advance_street (uncontested — ${active.length} active seat left, fast-forwarding to Showdown)`, [
      pgCall("advance_street", { table_id: tableId }),
    ]);
    return true;
  }
  if (active.length < 2) return false; // still waiting for a second player

  const contributions = active.map((s) => s.contributed);
  const allMatched = contributions.every((c) => c === contributions[0]);
  if (allMatched && contributions[0] > 0n) {
    await submit(`advance_street (all ${active.length} active seats matched at ${contributions[0]})`, [
      pgCall("advance_street", { table_id: tableId }),
    ]);
    return true;
  }
  return false;
}

async function maybeSettle(tableId, table, seats, seed, folded) {
  if (table.settled) return true;
  if (table.street < SHOWDOWN_STREET) return false;
  if (!seed) {
    console.log("[bot] at showdown but this bot process doesn't hold the seed for this table (not the process that created it) — cannot settle.");
    return false;
  }

  if (table.revealedSeed === "0x0") {
    await submit("reveal_seed", [pgCall("reveal_seed", { table_id: tableId, seed })]);
  }

  const deck = shuffledDeckFromSeed(seed);
  // Folded seats are out of the hand entirely — they don't get scored and
  // don't appear in settle_table_by_hand's arrays.
  const active = seats.filter((s) => s.owner !== "0x0" && !folded.has(s.seat));
  const seatNums = active.map((s) => s.seat.toString());
  const holeCards = active.map((s) => [deck[2 * s.seat], deck[2 * s.seat + 1]]);
  const community = [0, 1, 2, 3, 4].map((k) => deck[2 * table.maxSeats + k]);
  // DEVNET-DEMO SIMPLIFICATION: reuses each seat's hole-card note as its
  // payout note. That's fine for PokerGame's own note_id_owner check
  // (join_table already registered it to this seat's owner) but is NOT
  // what a real deployment should do — docs/DESIGN.md's "Buy-in, betting,
  // payout flow" says payout notes must be OPEN notes (register_payout_note),
  // since an encrypted note can't be filled by privacy_invoke. Real
  // players still need to register_payout_note themselves before a live
  // hand settles for real.
  const payoutNoteIds = active.map((s) => s.noteId);

  await submit(`settle_table_by_hand (${active.length} active seats, community=${community.join(",")})`, [
    pgCall("settle_table_by_hand", {
      table_id: tableId,
      seats: seatNums,
      hole_cards: holeCards,
      community_cards: community,
      payout_note_ids: payoutNoteIds,
    }),
  ]);
  return true;
}

async function cmdWatch(tableId, seed) {
  console.log(`[bot] watching table ${tableId} as ${BOT_ADDRESS}`);
  for (;;) {
    try {
      const table = await readTable(tableId);
      if (num.toBigInt(table.dealer) !== num.toBigInt(BOT_ADDRESS)) {
        console.log(`[bot] not the dealer for table ${tableId} (dealer=${table.dealer}) — refusing to act on it.`);
        return;
      }
      const seats = await readSeats(tableId, table.maxSeats);
      if (table.settled) {
        console.log("[bot] table settled — done.");
        return;
      }
      const folded = await readFoldedSeats(tableId);
      const settled = await maybeSettle(tableId, table, seats, seed, folded);
      if (!settled) {
        await maybeAdvanceStreet(tableId, table, seats, folded);
      }
    } catch (e) {
      console.error("[bot] poll error (continuing):", e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const [, , cmd, ...args] = process.argv;
if (cmd === "create") {
  const [tableId, token, buyIn, maxSeats] = args;
  const seed = await cmdCreate(tableId, token, buyIn, maxSeats);
  await cmdWatch(tableId, seed);
} else if (cmd === "watch") {
  const [tableId] = args;
  await cmdWatch(tableId, null);
} else {
  console.error("Usage:\n  node scripts/dealer_bot.mjs create <table_id> <token> <buy_in> <max_seats>\n  node scripts/dealer_bot.mjs watch <table_id>");
  process.exit(1);
}
