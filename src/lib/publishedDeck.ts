// Reading the deck a shuffler published on-chain.
//
// docs/PROTOCOL.md §9.3: the deck is now part of submit_shuffle's calldata, so
// a shuffler cannot advance its own turn while withholding the deck the next
// seat needs. This is the reader for that.
//
// ── Why the hash check is not optional ──────────────────────────────────
// The deck lives in the transaction's calldata, and reaching it means looking
// past an account's __execute__ wrapper, whose layout varies by account
// implementation and transaction version. Rather than trust that parse, every
// candidate is checked against `get_published_deck_hash` -- Starknet's own
// Poseidon over the deck felts, computed BY THE CONTRACT when the deck was
// submitted. A mis-parse fails loudly instead of handing back a plausible
// wrong deck, which in this protocol would surface much later as an
// unsatisfiable circuit.
//
// The off-chain transport (src/lib/shares.ts) is still the fast path -- the
// previous player can hand the deck over directly. This is the guarantee
// underneath it, and the reason withholding no longer works.

import type { ProviderInterface } from 'starknet';
import { hash } from 'starknet';
import { Ciphertext, fieldsToDeck } from './deck';
import { fromU256Parts, toFeltHex } from './felt';

const DECK_FIELDS = 208;
const DECK_U256_FELTS = DECK_FIELDS * 2; // each u256 crosses as low, high

/** Starknet-Poseidon over the deck felts, exactly as the contract computes it. */
export function publishedDeckHash(fields: bigint[]): bigint {
  if (fields.length !== DECK_FIELDS) throw new Error(`publishedDeck: expected ${DECK_FIELDS} fields`);
  const felts: string[] = [];
  for (const f of fields) {
    const low = f & ((1n << 128n) - 1n);
    const high = f >> 128n;
    felts.push('0x' + low.toString(16), '0x' + high.toString(16));
  }
  return BigInt(hash.computePoseidonHashOnElements(felts));
}

/**
 * Recover the deck published by the most recent `submit_shuffle`.
 *
 * `expectedHash` comes from `get_published_deck_hash(table_id)`. Returns null
 * when no candidate in the transaction matches it — which means either nothing
 * has been published yet or this is not the right transaction, and in both
 * cases inventing a deck would be worse than saying so.
 */
export async function readPublishedDeck(args: {
  provider: ProviderInterface;
  txHash: string;
  expectedHash: bigint;
}): Promise<Ciphertext[] | null> {
  const { provider, txHash, expectedHash } = args;
  if (expectedHash === 0n) return null;

  const tx: any = await provider.getTransactionByHash(txHash);
  const calldata: string[] = tx?.calldata ?? tx?.transaction?.calldata ?? [];
  if (calldata.length < DECK_U256_FELTS) return null;

  const words = calldata.map((v) => BigInt(v));

  // Scan for the run of 416 felts that hashes to what the contract recorded.
  // The deck is preceded by its own length (208), so anchor on that first and
  // fall back to a full scan — an account wrapper can put it anywhere.
  const anchors: number[] = [];
  words.forEach((w, i) => { if (w === BigInt(DECK_FIELDS)) anchors.push(i + 1); });
  for (let i = 0; i + DECK_U256_FELTS <= words.length; i++) if (!anchors.includes(i)) anchors.push(i);

  for (const start of anchors) {
    if (start + DECK_U256_FELTS > words.length) continue;
    const fields: bigint[] = [];
    for (let k = 0; k < DECK_FIELDS; k++) {
      fields.push(fromU256Parts(words[start + 2 * k], words[start + 2 * k + 1]));
    }
    try {
      if (publishedDeckHash(fields) !== expectedHash) continue;
      return fieldsToDeck(fields);
    } catch {
      // Off-curve or malformed: not the deck, keep looking.
    }
  }
  return null;
}

/**
 * The transaction that published the current chain head, via the
 * `DeckPublished` event.
 *
 * Events are used only to LOCATE the transaction; the deck itself comes from
 * the calldata and is checked against the contract's stored hash, so an RPC
 * that lags or reorders events cannot substitute a deck.
 */
export async function findDeckPublishedTx(args: {
  provider: ProviderInterface;
  contract: string;
  tableId: string;
  fromBlock?: number;
}): Promise<string | null> {
  const { provider, contract, tableId } = args;
  const key = hash.getSelectorFromName('DeckPublished');
  // Normalised, because this goes to the node RAW rather than through
  // calldata compilation: starknet_getEvents rejects a decimal key filter.
  const tableKey = toFeltHex(tableId);
  let token: string | undefined;
  let latest: string | null = null;
  do {
    const page: any = await provider.getEvents({
      address: contract,
      keys: [[key], [tableKey]],
      from_block: args.fromBlock ? { block_number: args.fromBlock } : { block_number: 0 },
      to_block: 'latest',
      chunk_size: 100,
      continuation_token: token,
    });
    for (const e of page.events ?? []) latest = e.transaction_hash;
    token = page.continuation_token;
  } while (token);
  return latest;
}
