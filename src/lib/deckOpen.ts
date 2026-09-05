// Deck opening: proving what the committed deck holds at the in-play slots.
//
// Why this exists at all is docs/PROTOCOL.md §7. The shuffle circuit commits
// to its decks with Poseidon2 over BN254; Cairo's Poseidon is over the STARK
// field, so the contract can never recompute one from the other. It only ever
// COMPARES two u256. Without a second proof binding ciphertexts to that
// commitment, whoever posts the deck could fabricate it outright -- anyone can
// encrypt any card under the public joint key -- and every later decryption
// would succeed and yield exactly the cards they picked.
//
// Opening reveals nothing. The ciphertexts are already public in the deck and
// the card values come only from DLEQ decryption later, so all in-play
// positions are opened once, straight after the shuffle chain, and revealed
// progressively afterwards (§7.3). One opening per hand, not one per reveal --
// which matters because an opening proof costs 772M L2 gas, barely under a
// shuffle's 811M.
//
// ── Chunking ────────────────────────────────────────────────────────────
// The circuit's K is fixed at 5, so the verifier's public-input count is
// fixed too. A table has 2*max_seats + 5 in-play positions, which is not a
// multiple of 5, so the contract takes it in chunks of 5 and PADS the final
// chunk by repeating the last real position. This module reproduces that
// padding exactly; anything else produces a proof whose public inputs do not
// match what the contract builds, and it is rejected with BAD_OPENING.

import { Ciphertext, deckToFields } from './deck';
import { u256Parts } from './felt';

/** MUST equal DECK_OPEN_K in cairo/src/lib.cairo and K in circuits/deck_open. */
export const DECK_OPEN_K = 5;

const CIRCUIT_URL = '/circuits/deck_open.json';
const WASM_PATH = '/circuits/wasm/barretenberg.wasm.gz';

/** In-play positions in the contract's canonical order: holes, then community. */
export function inPlayPositions(maxSeats: number): number[] {
  const holes = Array.from({ length: 2 * maxSeats }, (_, i) => i);
  const community = Array.from({ length: 5 }, (_, k) => 2 * maxSeats + k);
  return [...holes, ...community];
}

export function chunkCount(maxSeats: number): number {
  const total = 2 * maxSeats + 5;
  return Math.ceil(total / DECK_OPEN_K);
}

/**
 * The 5 positions for one chunk, padded the way the contract pads.
 *
 * `raw < k_total ? raw : k_total - 1` -- a short final chunk repeats the last
 * in-play position rather than running past it. The circuit proves the repeat
 * like any other slot and the contract rewrites an identical value.
 */
export function chunkPositions(maxSeats: number, chunk: number): number[] {
  const total = 2 * maxSeats + 5;
  return Array.from({ length: DECK_OPEN_K }, (_, i) => {
    const raw = DECK_OPEN_K * chunk + i;
    return raw < total ? raw : total - 1;
  });
}

let circuitPromise: Promise<any> | null = null;
function circuit(): Promise<any> {
  circuitPromise ??= fetch(CIRCUIT_URL).then((r) => {
    if (!r.ok) {
      throw new Error(
        `deckOpen: ${CIRCUIT_URL} is not served (${r.status}). The deck-open circuit has no ` +
          `nargo 1.0.0-beta.16 build staged -- see scripts/build_client_circuits.mjs.`,
      );
    }
    return r.json();
  });
  return circuitPromise;
}

export type OpenChunkResult = {
  chunk: number;
  positions: number[];
  /** Flat u256 list, 4 per position: c1.x, c1.y, c2.x, c2.y. */
  ciphertexts: bigint[];
  calldata: bigint[];
  timings: { witnessMs: number; proveMs: number; calldataMs: number };
};

/**
 * Prove one chunk of the opening.
 *
 * `deck` must be the FINAL deck of the shuffle chain -- the one whose
 * commitment the contract stores. Whoever holds it can run this; it needs no
 * secret, only the deck, which is why any party can carry the opening.
 */
export async function proveOpenChunk(args: {
  deck: Ciphertext[];
  deckHash: bigint;
  maxSeats: number;
  chunk: number;
  onProgress?: (stage: string) => void;
  /** The compiled circuit, if the caller has it -- see proveShuffle's note. */
  circuitJson?: any;
  /**
   * Where bb.js should fetch its wasm. Pass `null` off-page: WASM_PATH is a
   * browser-relative URL, and in Node bb.js treats it as a filesystem path and
   * fails on it, whereas with no path at all it resolves its own bundled copy.
   */
  wasmPath?: string | null;
}): Promise<OpenChunkResult> {
  const { deck, deckHash, maxSeats, chunk } = args;
  const say = args.onProgress ?? (() => {});
  const positions = chunkPositions(maxSeats, chunk);
  const fields = deckToFields(deck);

  const cards = positions.flatMap((p) => fields.slice(4 * p, 4 * p + 4));
  const hex = (v: bigint) => '0x' + v.toString(16);

  const [{ Noir }, { UltraHonkBackend }, garaga, circuitJson] = await Promise.all([
    import('@noir-lang/noir_js'),
    import('@aztec/bb.js'),
    import('garaga').then(async (m) => { await m.init(); return m; }),
    args.circuitJson ?? circuit(),
  ]);

  say('witness');
  const t0 = performance.now();
  const noir = new Noir(circuitJson);
  const { witness } = await noir.execute({
    deck_hash: hex(deckHash),
    positions: positions.map((p) => p.toString()),
    cards: cards.map(hex),
    deck: fields.map(hex),
  } as any);
  const witnessMs = Math.round(performance.now() - t0);

  say('proving');
  // Guard `self`, not just `navigator`: Node 24 defines `navigator` but not
  // `self`, so a `navigator`-only check passes and then throws on the next
  // property access. shuffle.ts's provingEnvironment() has the same shape for
  // the same reason.
  const isolated = typeof self !== 'undefined' && self.crossOriginIsolated === true;
  const threads = isolated ? navigator.hardwareConcurrency || 1 : 1;
  const resolvedWasm = args.wasmPath === undefined ? WASM_PATH : args.wasmPath;
  const backend = new UltraHonkBackend(
    circuitJson.bytecode,
    resolvedWasm === null ? { threads } : { threads, wasmPath: resolvedWasm },
  );
  const opts = { keccakZK: true };
  const t1 = performance.now();
  const proof = await backend.generateProof(witness, opts);
  const proveMs = Math.round(performance.now() - t1);

  say('calldata');
  const t2 = performance.now();
  const vk = await backend.getVerificationKey(opts);
  const calldata = stripSpanLength(
    (garaga.getZKHonkCallData(proof.proof, publicInputBytes(proof.publicInputs), vk) as bigint[])
      .map((v) => BigInt(v as any)),
  );
  const calldataMs = Math.round(performance.now() - t2);
  await backend.destroy();

  say('done');
  return { chunk, positions, ciphertexts: cards, calldata, timings: { witnessMs, proveMs, calldataMs } };
}

/**
 * Garaga's calldata, with its leading length stripped.
 *
 * `getZKHonkCallData` returns a full Starknet calldata array -- the span's
 * length FIRST, then its contents. starknet.js's ABI compiler adds that length
 * itself when it serialises a `Span<felt252>` argument, so passing the raw
 * array through gives the verifier two prefixes and it fails with
 * `deserialization failed` from inside the Honk verifier. (The `garaga
 * calldata --format array` CLI emits the contents WITHOUT the prefix, which is
 * why the checked-in fixtures are one felt shorter than this returns.)
 *
 * Only a real transaction surfaces this: bb and the browser check both verify
 * the proof happily, because neither goes near the ABI encoder. It was found
 * against a live devnet deployment.
 *
 * The length is asserted rather than assumed, so a future garaga that stops
 * prefixing fails loudly here instead of silently truncating a proof.
 */
function stripSpanLength(calldata: bigint[]): bigint[] {
  if (calldata.length < 2) throw new Error('garaga returned an unusably short calldata array');
  const declared = calldata[0];
  if (declared !== BigInt(calldata.length - 1)) {
    throw new Error(
      `garaga calldata does not start with its own length (first felt ${declared}, ` +
        `${calldata.length - 1} elements follow). The prefix convention changed -- do not strip blindly.`,
    );
  }
  return calldata.slice(1);
}

function publicInputBytes(publicInputs: string[]): Uint8Array {
  const out = new Uint8Array(publicInputs.length * 32);
  publicInputs.forEach((h, i) => {
    let v = BigInt(h);
    for (let b = 31; b >= 0; b--) { out[i * 32 + b] = Number(v & 0xffn); v >>= 8n; }
  });
  return out;
}

/** Arguments for `open_deck(table_id, chunk, ciphertexts, proof)`. */
export function openDeckArgs(tableId: string, r: OpenChunkResult) {
  return {
    table_id: tableId,
    chunk: r.chunk,
    ciphertexts: r.ciphertexts.map((v) => {
      const [low, high] = u256Parts(v);
      return { low, high };
    }),
    proof: r.calldata.map((v) => '0x' + v.toString(16)),
  };
}
