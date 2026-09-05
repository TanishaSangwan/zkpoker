// Shuffle proving, in the player's browser.
//
// This is the one place docs/PROTOCOL.md §1 cannot be relaxed. The witness
// contains the permutation, and the permutation is the secret the whole
// protocol protects: a_0 is canonical and public, so anyone who learns the
// composed permutation reads every hole card without decrypting anything
// (§9.1). Handing the witness to a server hands them the table.
//
// Measured in headless Chromium at ~5.2 s per shuffle on 6 threads and 9.9 s
// on one (§9.0). The 2.1x is cross-origin isolation: multithreaded bb.js
// needs SharedArrayBuffer, which browsers grant only to a page served with
// COOP/COEP. next.config.js sets them. A deployment that drops those headers
// does not break, it just doubles every player's wait -- which is why
// `provingEnvironment()` reports it rather than leaving it invisible.
//
// TOOLCHAIN: bb.js 3.0.0-nightly.20251104 against a nargo 1.0.0-beta.16
// circuit build. That is the pairing Garaga 1.1.0 requires and therefore the
// pairing the DEPLOYED verifier was generated from. A beta.22 build produces
// a proof the on-chain verifier rejects (public_inputs_offset 5 vs 1), so
// both are pinned exactly in package.json and the circuit JSON served from
// public/circuits/ is the beta.16 one.

import type { Point } from './grumpkin';
import { Ciphertext, commitment, deckToFields, shuffle as shuffleDeck, shuffleCircuitInputs } from './deck';
import { u256Parts } from './felt';

/** Where the beta.16 artifacts are served from. See scripts/build_client_circuits.mjs. */
const CIRCUIT_URL = '/circuits/shuffle.json';
const WASM_PATH = '/circuits/wasm/barretenberg.wasm.gz';

export type ProvingEnvironment = {
  crossOriginIsolated: boolean;
  threads: number;
  /** False means proving will be ~2.1x slower and nothing else is wrong. */
  multithreaded: boolean;
};

/**
 * Only meaningful in the browser.
 *
 * On the server there is no `self.crossOriginIsolated` and no
 * `navigator.hardwareConcurrency`, so this reports the pessimistic answer. Do
 * NOT call it during render: React would hydrate the server's "1 thread, not
 * isolated" into markup the client immediately contradicts, which is a
 * hydration mismatch (React #418). Call it from an effect -- `useProvingEnvironment`
 * below does exactly that.
 */
export function provingEnvironment(): ProvingEnvironment {
  const isolated = typeof self !== 'undefined' && self.crossOriginIsolated === true;
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 1 : 1;
  return { crossOriginIsolated: isolated, threads: isolated ? hw : 1, multithreaded: isolated };
}

let circuitPromise: Promise<any> | null = null;
function circuit(): Promise<any> {
  circuitPromise ??= fetch(CIRCUIT_URL).then((r) => {
    if (!r.ok) throw new Error(`shuffle: ${CIRCUIT_URL} missing (${r.status}) -- run scripts/build_client_circuits.mjs`);
    return r.json();
  });
  return circuitPromise;
}

export type ShuffleResult = {
  /** The deck to hand to the next player in the chain. Secret until published. */
  deckOut: Ciphertext[];
  /** Poseidon2(deckOut) -- the `new_commitment` argument of submit_shuffle. */
  commitmentOut: bigint;
  /** Garaga calldata: the whole `proof` argument, hints included. */
  calldata: bigint[];
  timings: { witnessMs: number; proveMs: number; calldataMs: number };
};

export type ShuffleProgress = (stage: 'permuting' | 'witness' | 'proving' | 'calldata' | 'done') => void;

/**
 * Permute, re-randomise, prove, and package the calldata for `submit_shuffle`.
 *
 * `commitmentIn` MUST be what the contract currently stores as the chain head
 * -- read it back from `get_shuffle_commitment`, never assume it. The contract
 * checks the proof against its own stored value, so a proof built on a stale
 * head is rejected on-chain rather than mis-chaining.
 */
export async function proveShuffle(args: {
  deckIn: Ciphertext[];
  jointKey: Point;
  commitmentIn: bigint;
  onProgress?: ShuffleProgress;
  /**
   * The compiled circuit, if the caller already has it.
   *
   * Defaults to fetching CIRCUIT_URL, which is a browser-relative path and
   * therefore meaningless off the page -- scripts/smoke_local.mjs runs this
   * exact function against a real chain from Node and passes the JSON in.
   */
  circuitJson?: any;
  /**
   * Where bb.js should fetch its wasm. Pass `null` off-page: WASM_PATH is a
   * browser-relative URL, and in Node bb.js treats it as a filesystem path and
   * fails on it, whereas with no path at all it resolves its own bundled copy.
   */
  wasmPath?: string | null;
}): Promise<ShuffleResult> {
  const { deckIn, jointKey, commitmentIn, onProgress } = args;
  const say = onProgress ?? (() => {});

  say('permuting');
  const witness = shuffleDeck(deckIn, jointKey);

  // Cross-check the input commitment locally. If this disagrees, the deck we
  // were handed is not the deck the chain committed to -- the previous player
  // published something else -- and the proof would be unsatisfiable anyway.
  const recomputedIn = await commitment(deckIn);
  if (recomputedIn !== commitmentIn) {
    throw new Error(
      `shuffle: the deck given does not hash to the chain head. ` +
        `Expected 0x${commitmentIn.toString(16)}, got 0x${recomputedIn.toString(16)}. ` +
        `Re-fetch the previous player's deck before shuffling.`,
    );
  }
  const commitmentOut = await commitment(witness.deckOut);

  const inputs = shuffleCircuitInputs({ jointKey, deckIn, witness, hashIn: commitmentIn, hashOut: commitmentOut });

  const [{ Noir }, { UltraHonkBackend }, garaga, circuitJson] = await Promise.all([
    import('@noir-lang/noir_js'),
    import('@aztec/bb.js'),
    import('garaga').then(async (m) => { await m.init(); return m; }),
    args.circuitJson ?? circuit(),
  ]);

  say('witness');
  const t0 = performance.now();
  const noir = new Noir(circuitJson);
  let solved: Uint8Array;
  try {
    ({ witness: solved } = await noir.execute(inputs as any));
  } catch (e) {
    throw explainWitnessFailure(e, commitmentIn);
  }
  const witnessMs = Math.round(performance.now() - t0);

  say('proving');
  const env = provingEnvironment();
  // wasmPath rather than the bundled default: bb.js resolves its wasm through
  // import.meta.url, which the bundler rewrites. Given a path it appends
  // "-threads" itself when multithreaded, so both files sit under /circuits/wasm/.
    const wasmPath = args.wasmPath === undefined ? WASM_PATH : args.wasmPath;
  const backend = new UltraHonkBackend(
    circuitJson.bytecode,
    wasmPath === null ? { threads: env.threads } : { threads: env.threads, wasmPath },
  );
  // keccakZK matches the deployed verifier's verify_ultra_keccak_zk_honk_proof.
  // Any other flavour verifies in bb here and is rejected on-chain.
  const opts = { keccakZK: true };

  const t1 = performance.now();
  const proof = await backend.generateProof(solved, opts);
  const proveMs = Math.round(performance.now() - t1);

  say('calldata');
  const t2 = performance.now();
  const vk = await backend.getVerificationKey(opts);
  const calldata = stripSpanLength(
    (garaga.getZKHonkCallData(proof.proof, flattenPublicInputs(proof.publicInputs), vk) as bigint[])
      .map((v) => BigInt(v as any)),
  );
  const calldataMs = Math.round(performance.now() - t2);
  await backend.destroy();

  // The contract compares the proof's public inputs against its own stored
  // joint key and chain head, so a mismatch here is caught on-chain. Catching
  // it locally costs nothing and names the problem.
  assertPublicInputs(proof.publicInputs, { jointKey, commitmentIn, commitmentOut });

  say('done');
  return { deckOut: witness.deckOut, commitmentOut, calldata, timings: { witnessMs, proveMs, calldataMs } };
}

/**
 * Turn acvm's blackbox errors into something a human can act on.
 *
 * The one that matters is the identity point. a_0 -- the canonical starting
 * deck -- is (identity, M_i) with the identity encoded (0, 0), and the deck is
 * four bare fields per card with no room for Noir's `is_infinite` flag. The
 * shuffle circuit therefore rebuilds it as `EmbeddedCurvePoint::new(0, 0)`,
 * whose `is_infinite` is false, and then adds r*G to it.
 *
 * nargo/acvm 1.0.0-beta.22 solves that. acvm 1.0.0-beta.16 -- the toolchain
 * the DEPLOYED verifier requires -- rejects it outright. So the FIRST link of
 * every shuffle chain, the only one whose input contains identity points,
 * cannot be witness-solved against the deployed verifier's toolchain.
 *
 * This was not caught earlier because the beta.16 fixture that browser proving
 * was measured against (circuits/shuffle_verifier/example_proof/beta16_build/
 * Prover.toml) is a MID-CHAIN shuffle: its deck_in contains no zeros at all.
 *
 * There is no client-side fix. a_0's encoding is pinned by
 * INITIAL_DECK_COMMITMENT in the contract, and the circuit is what reads it,
 * so closing this means changing the circuit (construct the point with an
 * explicit `is_infinite` rather than `new`), recompiling under beta.16, and
 * regenerating and redeploying the verifier.
 */
function explainWitnessFailure(e: unknown, commitmentIn: bigint): Error {
  const msg = String((e as any)?.message ?? e);
  // acvm reports the offending point as two 64-char hex words; the identity
  // is the all-zero pair. Matching that exactly avoids claiming this
  // diagnosis for an unrelated off-curve point, which would be worse than
  // saying nothing.
  const identityRejected =
    /embedded_curve_add/.test(msg) && /is not on curve/.test(msg) && /\(0{64},\s*0{64}\)/.test(msg);
  if (identityRejected) {
    return new Error(
      'The shuffle circuit cannot consume the initial deck under this toolchain.\n\n' +
        'acvm 1.0.0-beta.16 rejects the identity point (0, 0) that a_0 encodes, while ' +
        'nargo 1.0.0-beta.22 accepts it. beta.16 is the pairing the deployed verifier was ' +
        'generated from, so the first shuffle of every chain is blocked until the circuit ' +
        'constructs that point with an explicit is_infinite flag and the verifier is ' +
        'regenerated. Later links in the chain are unaffected -- their input decks contain ' +
        'no identity points.\n\nUnderlying error: ' + msg,
    );
  }
  return new Error(
    `Witness generation failed against chain head 0x${commitmentIn.toString(16)}: ${msg}`,
  );
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

/** bb.js hands public inputs back as 0x-prefixed field strings; garaga wants bytes. */
function flattenPublicInputs(publicInputs: string[]): Uint8Array {
  const out = new Uint8Array(publicInputs.length * 32);
  publicInputs.forEach((hex, i) => {
    let v = BigInt(hex);
    for (let b = 31; b >= 0; b--) { out[i * 32 + b] = Number(v & 0xffn); v >>= 8n; }
  });
  return out;
}

function assertPublicInputs(
  publicInputs: string[],
  expected: { jointKey: Point; commitmentIn: bigint; commitmentOut: bigint },
) {
  const want = [expected.jointKey!.x, expected.jointKey!.y, expected.commitmentIn, expected.commitmentOut];
  if (publicInputs.length !== want.length) {
    throw new Error(`shuffle: circuit returned ${publicInputs.length} public inputs, expected ${want.length}`);
  }
  publicInputs.forEach((hex, i) => {
    if (BigInt(hex) !== want[i]) {
      throw new Error(`shuffle: public input ${i} is 0x${BigInt(hex).toString(16)}, expected 0x${want[i].toString(16)}`);
    }
  });
}

/**
 * Arguments for `submit_shuffle(table_id, new_commitment, deck, proof)`.
 *
 * The deck goes on-chain as calldata. That is not incidental: it is what stops
 * a shuffler advancing its own turn while withholding the deck the next seat
 * needs, which used to get the NEXT seat convicted and forfeited
 * (docs/PROTOCOL.md §9.3). Publishing it is safe -- re-randomisation is
 * exactly what makes the output ciphertexts reveal nothing about the
 * permutation, and reading a card still needs every party's decryption share.
 */
export function submitShuffleArgs(tableId: string, result: ShuffleResult) {
  const [low, high] = u256Parts(result.commitmentOut);
  return {
    table_id: tableId,
    new_commitment: { low, high },
    deck: deckToU256(result.deckOut),
    proof: result.calldata,
  };
}

/** The 208 u256 the contract expects: four per card, (c1.x, c1.y, c2.x, c2.y). */
export function deckToU256(deck: Ciphertext[]): { low: bigint; high: bigint }[] {
  return deckToFields(deck).map((f) => {
    const [low, high] = u256Parts(f);
    return { low, high };
  });
}
