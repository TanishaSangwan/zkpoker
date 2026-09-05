// Contract wiring for the CURRENT PokerGame -- the mental-poker one.
//
// This replaces pokerActions.ts, which drove the V1 commit-reveal contract
// (commit_deal / reveal_seed / seed-based Fisher-Yates). Those entrypoints
// still exist in lib.cairo but PROTOCOL.md §10 lists them under "to be
// deleted", and nothing here calls them.
//
// Everything is a pure function: build a Call, or read state. No React.

import {
  CallData,
  Contract,
  num,
  shortString,
  type AccountInterface,
  type Call,
  type ProviderInterface,
  type RawArgs,
} from 'starknet';
import { pokerGameAbi } from '@/utils/pokerGameAbi';
import { erc20Abi } from '@/utils/erc20Abi';

const pgCallData = new CallData(pokerGameAbi as any);
const erc20CallData = new CallData(erc20Abi as any);

export function pokerGameReader(address: string, provider: ProviderInterface): any {
  return new Contract({ abi: pokerGameAbi as any, address, providerOrAccount: provider });
}

export function pgCall(address: string, entrypoint: string, args: RawArgs): Call {
  return { contractAddress: address, entrypoint, calldata: pgCallData.compile(entrypoint, args) };
}

export function erc20ApproveCall(tokenAddress: string, spender: string, amount: bigint): Call {
  return {
    contractAddress: tokenAddress,
    entrypoint: 'approve',
    calldata: erc20CallData.compile('approve', { spender, amount }),
  };
}

/**
 * Execute through the connected account, then wait on `provider`.
 *
 * NOT account.provider -- that is fixed at wallet-connect time and can point
 * at a different network than the one the UI is reading.
 */
export async function executeAndWait(
  account: AccountInterface,
  provider: ProviderInterface,
  calls: Call[],
): Promise<{ txHash: string; receipt: any }> {
  const { transaction_hash } = await account.execute(calls);
  const receipt = await provider.waitForTransaction(transaction_hash, { retries: 400, retryInterval: 3000 });
  return { txHash: transaction_hash, receipt };
}

// ─── streets and phases ──────────────────────────────────────────────────

export const STREET_NAMES = ['Pre-flop', 'Flop', 'Turn', 'River', 'Showdown'] as const;
export const SHOWDOWN_STREET = 4;

/**
 * The phase the table is in, derived from contract state alone.
 *
 * Ordering matters: `voided` and `settled` are terminal and must be checked
 * before anything else, or a settled table would render as "betting" forever.
 */
export type Phase =
  | 'no-table' | 'seating' | 'keys' | 'shuffling' | 'opening'
  | 'dealing' | 'betting' | 'showdown' | 'settled' | 'voided';

export function phaseOf(t: {
  exists: boolean; voided: boolean; settled: boolean;
  shuffleStarted: boolean; shuffleComplete: boolean; deckOpened: boolean;
  street: number; seatedCount: number; keysRegistered: number;
}): Phase {
  if (!t.exists) return 'no-table';
  if (t.voided) return 'voided';
  if (t.settled) return 'settled';
  if (!t.shuffleStarted) return t.keysRegistered < t.seatedCount || t.seatedCount < 2 ? (t.seatedCount < 2 ? 'seating' : 'keys') : 'keys';
  if (!t.shuffleComplete) return 'shuffling';
  if (!t.deckOpened) return 'opening';
  if (t.street === SHOWDOWN_STREET) return 'showdown';
  return 'betting';
}

// ─── felt helpers ────────────────────────────────────────────────────────

/** Text -> felt: hex, decimal, or a Cairo short string (<= 31 chars). */
export function toFelt(input: string): string {
  const s = input.trim();
  if (!s) throw new Error('Value is required.');
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  if (/^-?\d+$/.test(s)) return s;
  return shortString.encodeShortString(s);
}

export function shortHex(h: string | bigint): string {
  try {
    const hex = num.toHex(typeof h === 'bigint' ? '0x' + h.toString(16) : h);
    return hex.length <= 13 ? hex : `${hex.slice(0, 7)}…${hex.slice(-4)}`;
  } catch {
    return String(h);
  }
}

/**
 * Decode a Cairo assertion string out of a failed transaction.
 *
 * Worth the effort: the contract's error felts are the most useful diagnostic
 * a player gets ('NOT_YOUR_TURN', 'SEAT_FOLDED', 'BAD_JOINT_KEY'), and raw
 * they render as a 76-digit number. Also catches the Garaga assertion strings
 * a malformed proof produces -- see cairo-verifier/tests/test_client_vectors.
 */
export function decodeError(err: unknown): string {
  const raw = (err as any)?.message ?? String(err);
  return raw.replace(/0x[0-9a-fA-F]{2,62}\b/g, (hex: string) => {
    try {
      const text = shortString.decodeShortString(hex);
      return /^[\x20-\x7e]{2,31}$/.test(text) ? `${text} (${hex})` : hex;
    } catch {
      return hex;
    }
  });
}

// ─── u256 <-> bigint at the ABI boundary ─────────────────────────────────

export const asU256 = (v: bigint) => ({ low: v & ((1n << 128n) - 1n), high: v >> 128n });

/** starknet.js returns u256 as bigint already, but Cairo structs come back as objects. */
export function readU256(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (v && typeof v === 'object' && 'low' in v) return (BigInt(v.high) << 128n) | BigInt(v.low);
  return BigInt(v ?? 0);
}
