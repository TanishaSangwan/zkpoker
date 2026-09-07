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

// Starknet refuses a transaction that RESERVES more L2 gas than this, whatever
// it goes on to spend:
//
//   Max gas amount is too high: GasAmount(1224841560),
//   maximum allowed gas amount: 1210000000
//
// Verifying a Honk proof on chain sits just under that ceiling, and the
// estimator's safety margin pushes its bound over it -- so `open_deck` at
// K = 16 is rejected before it runs, despite consuming less than the cap (see
// PROTOCOL.md 6.2: the gas ceiling binds before the public-input one).
//
// Clamped rather than lowered blindly: the bound is a ceiling on what MAY be
// spent, not a prediction, so trimming it costs nothing while real consumption
// stays underneath. A proof that genuinely needs more than the cap then fails
// as out-of-gas, which is the honest signal that the circuit has outgrown a
// single transaction.
const L2_GAS_CAP = 1_209_000_000n;

// Only the two entrypoints that verify a SNARK come anywhere near the cap.
// Estimating costs a round trip, and making every check and bet pay for one
// would be felt on a public chain, where this page already waits on blocks.
const PROOF_ENTRYPOINTS = new Set(['submit_shuffle', 'open_deck']);

/**
 * Resource bounds for `calls`, or undefined to let the account estimate.
 *
 * Undefined on any failure on purpose: an estimate is an optimisation here,
 * and a wallet that estimates for itself must keep working.
 */
async function clampedBounds(account: AccountInterface, calls: Call[]): Promise<any> {
  if (!calls.some((c) => PROOF_ENTRYPOINTS.has(c.entrypoint))) return undefined;
  try {
    const est: any = await account.estimateInvokeFee(calls);
    const src = est?.resourceBounds ?? est?.resource_bounds;
    if (!src?.l2_gas) return undefined;
    const want = BigInt(src.l2_gas.max_amount);
    if (want <= L2_GAS_CAP) return undefined;
    // BigInts, not the decimal strings the estimator hands back. When bounds
    // are supplied rather than estimated, starknet.js hashes them directly and
    // shifts the values, so a string throws "Cannot mix BigInt and other
    // types" from deep inside the signer.
    return {
      resourceBounds: {
        l1_gas: {
          max_amount: BigInt(src.l1_gas.max_amount),
          max_price_per_unit: BigInt(src.l1_gas.max_price_per_unit),
        },
        l1_data_gas: {
          max_amount: BigInt(src.l1_data_gas.max_amount),
          max_price_per_unit: BigInt(src.l1_data_gas.max_price_per_unit),
        },
        l2_gas: {
          max_amount: L2_GAS_CAP,
          max_price_per_unit: BigInt(src.l2_gas.max_price_per_unit),
        },
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Execute through the connected account, then wait on `provider`.
 *
 * NOT account.provider -- that is fixed at wallet-connect time and can point
 * at a different network than the one the UI is reading.
 */
// One transaction at a time per account.
//
// ── Why this is not optional on a public chain ──────────────────────────
// This page deliberately races: every client starts a reveal for every seat's
// draw card, and whoever lands first wins. Across clients that is right. From
// ONE client it means several sends fired in the same tick,
// alongside two commit_hole_shares -- five transactions from one account at
// once. Each fetches the pending nonce independently, they all get the same
// number, and exactly one survives.
//
// A devnet hides this completely: the nonce advances in milliseconds, so the
// sends are effectively serial already. Sepolia takes ~20s to accept a
// transaction, so every concurrent send after the first is dead on arrival --
// which is exactly how a table stalled with all three DLEQ aggregates
// finished off-chain and only one of the three draws on it.
//
// Keyed by address, not per-account-object: two components holding different
// handles on the same account still share one nonce.
const inFlight = new Map<string, Promise<unknown>>();

export async function executeAndWait(
  account: AccountInterface,
  provider: ProviderInterface,
  calls: Call[],
): Promise<{ txHash: string; receipt: any }> {
  const key = String(account.address).toLowerCase();
  const prev = inFlight.get(key) ?? Promise.resolve();
  // settle(), not then(): a failed predecessor must not cancel what follows.
  const mine = prev
    .then(() => undefined, () => undefined)
    .then(() => sendOne(account, provider, calls));
  inFlight.set(key, mine.then(() => undefined, () => undefined));
  return mine;
}

async function sendOne(
  account: AccountInterface,
  provider: ProviderInterface,
  calls: Call[],
): Promise<{ txHash: string; receipt: any }> {
  const details = await clampedBounds(account, calls);
  const { transaction_hash } = await account.execute(calls, details);
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
  | 'posting' | 'dealing' | 'betting' | 'showdown' | 'settled' | 'voided';

export function phaseOf(t: {
  exists: boolean; voided: boolean; settled: boolean;
  shuffleStarted: boolean; shuffleComplete: boolean; deckOpened: boolean;
  street: number; seatedCount: number; keysRegistered: number;
  /** The blind structure, and how far through it the table is. */
  bigBlind?: bigint; buttonSet?: boolean; blindsPosted?: boolean;
}): Phase {
  if (!t.exists) return 'no-table';
  if (t.voided) return 'voided';
  if (t.settled) return 'settled';
  if (!t.shuffleStarted) return t.keysRegistered < t.seatedCount || t.seatedCount < 2 ? (t.seatedCount < 2 ? 'seating' : 'keys') : 'keys';
  if (!t.shuffleComplete) return 'shuffling';
  if (!t.deckOpened) return 'opening';
  if (t.street === SHOWDOWN_STREET) return 'showdown';
  // A table with a blind structure is not in its betting round until the
  // forced bets are up. Skipping these two states offered check/call/raise
  // while the contract would still refuse every one of them with
  // BLINDS_NOT_POSTED -- buttons that could only ever fail, on a table that
  // looked ready and was not.
  if ((t.bigBlind ?? 0n) > 0n && t.street === 0 && !t.blindsPosted) return 'posting';
  return 'betting';
}

// ─── amounts ─────────────────────────────────────────────────────────────

/**
 * STRK typed by a human -> the base units the contract takes.
 *
 * Every amount in PokerGame is a raw u128 in the token's smallest unit, and
 * STRK has 18 decimals. Asking people to type `10000000000000000000` was not
 * a small annoyance: the first tables were created with blinds of 10 and 20
 * WEI -- 1e-17 STRK -- against a hand of gas costing ~86 STRK, because "10"
 * is a perfectly reasonable thing to type and silently meant nothing.
 *
 * So the field is STRK now and this does the multiply. Throws rather than
 * guessing, because a mis-parse here becomes an on-chain amount.
 */
export function strkToBase(v: string): bigint {
  const t = v.trim();
  if (!t) return 0n;
  if (!/^\d*\.?\d*$/.test(t) || t === '.') {
    throw new Error(`"${v}" is not an amount. Use STRK, e.g. 10 or 0.5.`);
  }
  const [whole, frac = ''] = t.split('.');
  if (frac.length > 18) {
    throw new Error(`STRK has 18 decimal places; "${v}" has ${frac.length}.`);
  }
  return BigInt(whole || '0') * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
}

/**
 * Base units -> a string a person can read at a glance.
 *
 * `baseToStrk` is exact and round-trips, which is what the call sites that
 * build transactions need. This one is for DISPLAY, and the two differ
 * because exactness reads terribly at both ends of the range:
 *
 *   * a table created before amounts were STRK-denominated holds blinds of
 *     10 and 20 WEI, and rendering those exactly gives
 *     "0.00000000000000001" -- seventeen zeroes, which is less legible than
 *     the raw integer it replaced;
 *   * a normal pot of 30 STRK should just say "30".
 *
 * So: anything below 0.0001 STRK is shown in base units and LABELLED as
 * such, rather than as a decimal nobody can count. Above that, up to four
 * decimal places with trailing zeros trimmed. The exact value is always one
 * hover away in the field hints, and the chain only ever sees baseToStrk.
 */
export function fmtAmount(v: bigint): string {
  if (v === 0n) return '0 STRK';
  const E = 10n ** 18n;
  if (v < E / 10_000n) return `${v} wei`;
  const whole = v / E;
  const frac = (v % E).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} STRK`;
}

/** Base units -> STRK, for showing what will actually be sent. */
export function baseToStrk(v: bigint): string {
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
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
