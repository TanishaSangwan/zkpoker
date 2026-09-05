// Felt/u256/u384 plumbing shared by every prover in this directory.
//
// Three encodings are in play and they are NOT interchangeable:
//
//   u256 low/high   two felts, 128 bits each -- how Cairo passes curve
//                   coordinates through PokerGame's entrypoints.
//   u384 96-bit     four felts -- how Garaga represents a field element
//                   inside a verifier, and what its Poseidon challenge
//                   transcripts hash over.
//   plain felt252   a single value.
//
// The Schnorr and DLEQ challenges hash over the 96-bit limb form, so getting
// this wrong produces a challenge the on-chain verifier will not reproduce
// and the proof is rejected with no useful error.

import { hash } from 'starknet';

const MASK_96 = (1n << 96n) - 1n;
const MASK_128 = (1n << 128n) - 1n;

/** Garaga u384: four 96-bit limbs, little-endian. */
export function limbs96(v: bigint): bigint[] {
  return [0, 1, 2, 3].map((i) => (v >> (96n * BigInt(i))) & MASK_96);
}

/** Cairo u256 as the pair of felts an entrypoint receives. */
export function u256Parts(v: bigint): [bigint, bigint] {
  return [v & MASK_128, v >> 128n];
}

export function fromU256Parts(low: bigint, high: bigint): bigint {
  return (high << 128n) | low;
}

/**
 * Starknet's Poseidon over a span of felts.
 *
 * This is `core::poseidon::poseidon_hash_span` in Cairo and
 * `poseidon_hash_many` in scripts/*.py. All three agree; the equivalence is
 * exercised end to end by cairo-verifier/tests/test_dleq_fixture.cairo, whose
 * fixture this module generates and whose challenge check the Cairo verifier
 * recomputes independently.
 */
export function poseidonSpan(values: bigint[]): bigint {
  return BigInt(hash.computePoseidonHashOnElements(values.map((v) => '0x' + v.toString(16))));
}

/** For calldata: starknet.js wants decimal or hex strings, not bigints. */
export const feltStr = (v: bigint): string => '0x' + v.toString(16);
export const feltStrs = (vs: bigint[]): string[] => vs.map(feltStr);
