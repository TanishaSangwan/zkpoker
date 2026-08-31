// Contract-call wiring for PokerGame (cairo/src/lib.cairo) — kept separate
// from PokerPanel.tsx so "how to call the contract" and "how to render the
// UI" don't tangle. Every export here is a pure function: build a Call
// (or a felt/hash), or run+wait for a batch of Calls. No React state.

import {
  CallData,
  Contract,
  hash,
  shortString,
  type AccountInterface,
  type Call,
  type ProviderInterface,
  type RawArgs,
} from "starknet";
import { pokerGameAbi } from "@/utils/pokerGameAbi";
import { erc20Abi } from "@/utils/erc20Abi";

const pgCallData = new CallData(pokerGameAbi as any);
const erc20CallData = new CallData(erc20Abi as any);

// Read-only PokerGame view — call e.g. `reader.get_table_dealer(tableId)`.
// Loosely typed (`any`) like the rest of this starter's wallet/receipt
// handling (see WalletAccountV6Tag.tsx) rather than fighting the ABI's
// `as const` literal type through starknet.js's generic Contract class.
export function pokerGameReader(address: string, provider: ProviderInterface): any {
  return new Contract({ abi: pokerGameAbi as any, address, providerOrAccount: provider });
}

export function pgCall(address: string, entrypoint: string, args: RawArgs): Call {
  return { contractAddress: address, entrypoint, calldata: pgCallData.compile(entrypoint, args) };
}

export function erc20ApproveCall(tokenAddress: string, spender: string, amount: bigint): Call {
  return {
    contractAddress: tokenAddress,
    entrypoint: "approve",
    calldata: erc20CallData.compile("approve", { spender, amount }),
  };
}

export function erc20Reader(address: string, provider: ProviderInterface): any {
  return new Contract({ abi: erc20Abi as any, address, providerOrAccount: provider });
}

// Street ordinals — matches SHOWDOWN_STREET / advance_street in lib.cairo.
// A table that never calls advance_street stays at index 0 (PreFlop).
export const STREET_NAMES = ["PreFlop", "Flop", "Turn", "River", "Showdown"] as const;
export const SHOWDOWN_STREET = 4;

// commit_deal's `seed_hash` argument MUST equal
// core::poseidon::poseidon_hash_span(array![seed].span()) — see that fn's
// doc comment in lib.cairo. Verified during this project's session to match
// starknet.js's computePoseidonHashOnElements for both the single-element
// case this needs and the two-element case shuffle-related code uses
// elsewhere (cross-checked against cairo/src/poseidon_vector_check.cairo's
// own Cairo-side vector) — not just assumed compatible.
export function seedHashOf(seedFelt: string): string {
  return hash.computePoseidonHashOnElements([seedFelt]);
}

// Execute a batch of calls through the connected account, then wait for
// confirmation via `provider` — NOT account.provider, which is fixed at
// wallet-connect time and can point at the wrong network (same reasoning
// as WalletAccountV6Tag.tsx's own `submit` helper).
export async function executeAndWait(
  account: AccountInterface,
  provider: ProviderInterface,
  calls: Call[],
): Promise<{ txHash: string; receipt: any }> {
  const { transaction_hash } = await account.execute(calls);
  const receipt = await provider.waitForTransaction(transaction_hash, { retries: 400, retryInterval: 3000 });
  return { txHash: transaction_hash, receipt };
}

// ─── felt / card notation helpers ───────────────────────────────────────

// Best-effort text -> felt: hex ("0x..."), plain decimal, or (falling back)
// a short string (<=31 chars, Cairo felt252 short-string encoding — same
// convention as the Cairo tests' TABLE_1/NOTE_A/etc. constants) via
// starknet.js's own encoder.
export function toFelt(input: string): string {
  const s = input.trim();
  if (!s) throw new Error("Value is required.");
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  if (/^-?\d+$/.test(s)) return s;
  // Short string: reuse starknet.js's own encoder so this matches exactly
  // how e.g. `'TABLE_1'` compiles to a felt252 in Cairo.
  return shortString.encodeShortString(s);
}

// Card encoding matches cairo/src/poker_hand.cairo and scripts/deal_verify.py
// exactly: card = suit*13 + rank, rank 0-12 ('2'..'A'), suit 0-3 (no ranking
// meaning — just "same or different" for flushes).
const RANKS = "23456789TJQKA";
const SUITS = "cdhs";

export function cardToName(card: number): string {
  const rank = card % 13;
  const suit = Math.floor(card / 13);
  return `${RANKS[rank]}${SUITS[suit]}`;
}

// Parses "As", "Th", "2c", or a plain 0-51 integer. Throws with a clear
// message on anything else — this feeds settle_table_by_hand, so a silent
// wrong card here would submit a bogus hand instead of erroring locally.
export function parseCard(input: string): number {
  const s = input.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < 0 || n > 51) throw new Error(`Card index ${n} out of range (0-51).`);
    return n;
  }
  if (s.length === 2) {
    const rank = RANKS.indexOf(s[0].toUpperCase());
    const suit = SUITS.indexOf(s[1].toLowerCase());
    if (rank !== -1 && suit !== -1) return suit * 13 + rank;
  }
  throw new Error(`Could not parse card "${input}" — use rank+suit (e.g. "As", "Th", "2c") or an index 0-51.`);
}

// Parses a comma/space-separated list of cards ("As, Kd, 2c" or "51,17,29").
export function parseCardList(input: string): number[] {
  return input
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parseCard);
}

// ─── hole-card note encoding (round 10) ─────────────────────────────────
//
// docs/DESIGN.md describes hole cards as "STRK20 encrypted notes... created
// via the pool's normal CreateEncNote action" — but a note only carries a
// (token, amount) pair, not arbitrary data, and no installed skill
// reference (strk20-privacy, strk20-privacy-sdk, strk20-wallet-api,
// strk20-anonymizer-contracts) shows a worked example of encoding
// non-monetary data into one. This packing is THIS PROJECT'S OWN
// convention, invented here because none exists to source — not a
// documented STRK20 pattern. Flag it as such if you build on it.
//
// card1*52 + card2, range 0..2703 — trivially fits any note's `amount`.
// Order matters for encode/decode round-tripping, but NOT for what the
// contract accepts: settle_table_by_hand checks a seat's two hole cards as
// an unordered pair (see its doc comment in lib.cairo), so decoding in
// either order is fine for that purpose.
export function packHoleCards(card1: number, card2: number): bigint {
  return BigInt(card1) * 52n + BigInt(card2);
}
export function unpackHoleCards(packed: bigint): [number, number] {
  const card1 = Number(packed / 52n);
  const card2 = Number(packed % 52n);
  return [card1, card2];
}
