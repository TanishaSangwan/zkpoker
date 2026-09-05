// Generates a deck-opening proof, and by default opens the deck that the
// SHUFFLE circuit actually produced.
//
// That pairing is the point. The opening proof's `deck_hash` must be the
// commitment the shuffle chain left on-chain, so proving an opening against a
// deck this repo shuffled -- rather than against a standalone fixture --
// exercises the join between the two circuits, which is where a layout or
// encoding skew would hide (docs/PROTOCOL.md §7.2).
//
//   node scripts/prove_deck_open.mjs <deck.json> <out-dir>
//
// <deck.json> is { deckOut: [208 decimal strings] } as produced by the
// shuffle-side fixtures. Writes proof.bin / vk.bin / public_inputs.bin, which
// `garaga calldata` turns into something the deployed verifier can be fed.
//
// Toolchain: the beta.16 build, same reasoning as the shuffle side -- a
// beta.22 proof is rejected by the deployed verifier.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, Barretenberg, BackendType } from '@aztec/bb.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CIRCUIT = join(root, 'circuits/deck_open_verifier/example_proof/beta16_build/target/deck_open.json');

const deckPath = process.argv[2];
const outDir = process.argv[3] ?? join(root, 'circuits/deck_open_verifier/example_proof');
mkdirSync(outDir, { recursive: true });

const fields = JSON.parse(readFileSync(deckPath, 'utf8')).deckOut.map((v) => BigInt(v));
if (fields.length !== 208) throw new Error(`expected 208 deck fields, got ${fields.length}`);

// Poseidon2 over BN254 -- the circuit's own hash, which Cairo cannot compute.
const toBuf = (v) => { const b = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const api = await Barretenberg.new({ backend: BackendType.Wasm, threads: 1 });
const { hash } = await api.poseidon2Hash({ inputs: fields.map(toBuf) });
await api.destroy();
let deckHash = 0n;
for (const b of hash) deckHash = (deckHash << 8n) | BigInt(b);

// Chunk 0 of the canonical order: seat 0's two hole cards, seat 1's two, then
// the first community slot. K is fixed at 5 by the circuit, which is why the
// contract opens in chunks and pads the last one.
const positions = [0, 1, 2, 3, 4];
const hex = (v) => '0x' + v.toString(16);
const cards = positions.flatMap((p) => fields.slice(4 * p, 4 * p + 4));

const circuit = JSON.parse(readFileSync(CIRCUIT, 'utf8'));
const { witness } = await new Noir(circuit).execute({
  deck_hash: hex(deckHash),
  positions: positions.map(String),
  cards: cards.map(hex),
  deck: fields.map(hex),
});

const backend = new UltraHonkBackend(circuit.bytecode, { threads: 8 });
const opts = { keccakZK: true };
const t0 = performance.now();
const proof = await backend.generateProof(witness, opts);
const proveMs = Math.round(performance.now() - t0);
const vk = await backend.getVerificationKey(opts);
if (!(await backend.verifyProof(proof, opts))) { console.error('FAIL: bb rejected its own proof'); process.exit(1); }
await backend.destroy();

writeFileSync(join(outDir, 'proof.bin'), Buffer.from(proof.proof));
writeFileSync(join(outDir, 'vk.bin'), Buffer.from(vk));
writeFileSync(join(outDir, 'public_inputs.bin'), Buffer.concat(proof.publicInputs.map((h) => {
  const b = Buffer.alloc(32); let v = BigInt(h);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
})));

console.log(`deck_hash      ${hex(deckHash)}`);
console.log(`positions      ${positions.join(', ')}`);
console.log(`public inputs  ${proof.publicInputs.length}`);
console.log(`proof          ${proof.proof.length} bytes in ${proveMs} ms`);
console.log(`vk             ${vk.length} bytes`);
