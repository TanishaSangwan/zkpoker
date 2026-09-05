// Schnorr proof of knowledge on Grumpkin -- the rogue-key defence.
//
// Without this, the last party to register picks
//   y_last = X - SUM(everyone else)
// for an X whose secret they know. The joint key becomes theirs alone, they
// read every hole card at the table, and every shuffle proof still verifies,
// because nothing about the shuffle is wrong (docs/PROTOCOL.md §3).
//
// Port of scripts/schnorr_keygen.py. That script is the fixture source for
// the deployed SchnorrKeyVerifier's Cairo tests, so agreeing with it is
// agreeing with the contract. scripts/check_client_crypto.mjs regenerates its
// pinned vector through this module and fails on any difference.

import { G, N, Point, add, mul, mulG, toWire } from './grumpkin';
import { limbs96, poseidonSpan, u256Parts } from './felt';
import { randomScalar } from './grumpkin';

let garaga: typeof import('garaga') | null = null;

/** Loads garaga's wasm once. Await before calling `calldataFor`. */
export async function initProver(): Promise<void> {
  if (garaga) return;
  const mod = await import('garaga');
  await mod.init();
  garaga = mod;
}

/** Garaga curve id for Grumpkin -- matches SchnorrKeyVerifier's GRUMPKIN. */
const GRUMPKIN = 5;

export type KeyPair = { secret: bigint; pk: { x: bigint; y: bigint } };

export type SchnorrProof = {
  pk: { x: bigint; y: bigint };
  rx: bigint;
  s: bigint;
  e: bigint;
  /**
   * Serde(SchnorrSignatureWithHint) -- 29 felts: rx as four u384 limbs, s and
   * e as u256 low/high pairs, then a length-prefixed 20-felt MSM hint. This is
   * the `proof` argument, byte-shaped by Garaga rather than by us.
   */
  calldata: bigint[];
  /** [pk_x.low, pk_x.high, pk_y.low, pk_y.high] -- 4 felts. */
  publicInputs: bigint[];
};

/**
 * e = Poseidon(rx as four 96-bit limbs, pk.x low/high, pk.y low/high).
 *
 * The verifier recomputes this and refuses a proof whose e does not match.
 * Without that check the scheme is trivially forgeable: pick any s and e and
 * set R = sG - eP.
 */
export function challenge(rx: bigint, pk: { x: bigint; y: bigint }): bigint {
  const [pkxLo, pkxHi] = u256Parts(pk.x);
  const [pkyLo, pkyHi] = u256Parts(pk.y);
  return poseidonSpan([...limbs96(rx), pkxLo, pkxHi, pkyLo, pkyHi]);
}

/**
 * BIP340: force an even-y public key by negating the secret when y is odd.
 *
 * Garaga's verifier requires it, so a key with odd y is simply rejected
 * on-chain. Normalising here means a caller never has to know that.
 */
export function normaliseEvenY(secret: bigint): KeyPair {
  let s = ((secret % N) + N) % N;
  if (s === 0n) throw new Error('schnorr: secret must be non-zero mod n');
  let pk = mulG(s);
  if (pk === null) throw new Error('schnorr: secret must be non-zero mod n');
  if (pk.y % 2n !== 0n) {
    s = (N - s) % N;
    pk = mulG(s)!;
  }
  return { secret: s, pk: { x: pk.x, y: pk.y } };
}

/** A fresh, normalised key share for a seat. */
export function generateKey(): KeyPair {
  return normaliseEvenY(randomScalar());
}

export function prove(secret: bigint, nonce?: bigint): SchnorrProof {
  const { secret: x, pk } = normaliseEvenY(secret);

  // R needs even y too -- the verifier checks the parity of the point it
  // recomputes -- so the nonce is normalised the same way.
  let k = ((nonce ?? randomScalar()) % N + N) % N;
  if (k === 0n) throw new Error('schnorr: nonce must be non-zero mod n');
  let R = mulG(k);
  if (R === null) throw new Error('schnorr: nonce must be non-zero mod n');
  if (R.y % 2n !== 0n) {
    k = (N - k) % N;
    R = mulG(k)!;
  }

  const e = challenge(R.x, pk);
  const s = (k + e * x) % N;

  // Self-check the exact equation the contract runs: sG - eP == R, with the
  // even-y condition. A proof that fails here would cost a transaction to
  // find out on-chain.
  const lhs = add(mulG(s), mul(N - (e % N), { x: pk.x, y: pk.y }));
  if (lhs === null || lhs.x !== R.x || lhs.y % 2n !== 0n) {
    throw new Error('schnorr: proof failed its own verification -- refusing to publish');
  }

  if (!garaga) throw new Error('schnorr: call initProver() before prove()');
  const calldata = (garaga.schnorr_calldata_builder(
    R.x as any, s as any, e as any, pk.x as any, pk.y as any, false, GRUMPKIN,
  ) as unknown as bigint[]).map((v) => BigInt(v as any));
  if (calldata.length !== 29) {
    throw new Error(`schnorr: expected 29 calldata felts, got ${calldata.length}`);
  }
  const publicInputs = [...u256Parts(pk.x), ...u256Parts(pk.y)];

  return { pk, rx: R.x, s, e, calldata, publicInputs };
}

/**
 * Calldata for `register_shuffle_key(pk_x, pk_y, rx, s, e)`.
 *
 * Shape follows the Cairo entrypoint's u256 arguments; starknet.js's CallData
 * compiler splits them, so this returns the bigints and lets the ABI decide.
 */
export function registerArgs(proof: SchnorrProof) {
  return { pk_x: proof.pk.x, pk_y: proof.pk.y, key_proof: proof.calldata };
}

/** Sum of key shares -- the joint key the contract recomputes on-chain. */
export function jointKey(shares: { x: bigint; y: bigint }[]): Point {
  let acc: Point = null;
  for (const s of shares) acc = add(acc, { x: s.x, y: s.y });
  return acc;
}

export { toWire };
