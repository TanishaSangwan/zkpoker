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
// Block-range constants for the backwards scan below. The first window is
// small because the deck is published moments before it is read, in the same
// hand; the cap on total lookback keeps a table that will never be found from
// walking a public chain to genesis one request at a time.
const FIRST_WINDOW = 2_000;
const MAX_WINDOW = 100_000;
const MAX_LOOKBACK = 1_000_000;

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

  // ── Why this walks backwards instead of scanning from genesis ──────────
  // It used to ask for [0, latest], which is correct on a devnet a few
  // hundred blocks old and silently WRONG on a public chain: a node given a
  // range that wide answers with an empty page rather than an error. On
  // Sepolia that returned zero events in under a second, findDeckPublishedTx
  // returned null, and the deck could never be read back -- the table simply
  // stopped at "opening" with nothing to explain it. The same query over the
  // last thousand blocks found the event in 412ms.
  //
  // So: scan backwards from the head in windows, newest first. The event we
  // want is the most recent one, which is nearly always in the first window,
  // and the windows double so that an old table still costs a handful of
  // requests rather than one per thousand blocks.
  const head = (await provider.getBlockLatestAccepted()).block_number;
  const floor = Math.max(0, args.fromBlock ?? head - MAX_LOOKBACK);

  let to = head;
  let span = FIRST_WINDOW;
  for (;;) {
    const from = Math.max(floor, to - span + 1);
    let token: string | undefined;
    let latest: string | null = null;
    do {
      const page: any = await provider.getEvents({
        address: contract,
        keys: [[key], [tableKey]],
        from_block: { block_number: from },
        to_block: { block_number: to },
        chunk_size: 100,
        continuation_token: token,
      });
      // Within a window the last event is the most recent one.
      for (const e of page.events ?? []) latest = e.transaction_hash;
      token = page.continuation_token;
    } while (token);
    if (latest) return latest;
    if (from <= floor) return null;
    to = from - 1;
    span = Math.min(span * 2, MAX_WINDOW);
  }
}
