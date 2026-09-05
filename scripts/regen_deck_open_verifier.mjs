// Regenerates the deployed DECK-OPEN verifier's proving artifacts.
//
// Run after ANY change to the circuit: the VK is derived from the circuit, so
// a changed circuit means the deployed verifier no longer accepts proofs from
// it. Produces vk.bin / proof.bin / public_inputs.bin, which
// `garaga gen` and `garaga calldata` then turn into the Cairo verifier.
//
// Toolchain is NOT the project pin, deliberately: nargo 1.0.0-beta.16 +
// @aztec/bb.js@3.0.0-nightly.20251104 is the pairing Garaga 1.1.0 requires
// (its Honk VK parser hardcodes public_inputs_offset == 1; beta.22 emits 5).
//
//   noirup --version 1.0.0-beta.16
//   nargo compile --program-dir circuits/deck_open_verifier/example_proof/beta16_build
//   node scripts/regen_deck_open_verifier.mjs <prover.toml>
//   noirup --version 1.0.0-beta.22      # PUT IT BACK
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(root, 'circuits/deck_open_verifier/example_proof/beta16_build');
const OUT = join(root, 'circuits/deck_open_verifier/example_proof');
const proverToml = process.argv[2] ?? join(BUILD, 'Prover.toml');

// Minimal TOML reader for the flat shape Prover.toml uses here: quoted
// scalars and arrays of quoted scalars or bare integers. Not a general parser;
// it does not need to be, and a dependency for this would be worse.
function readProverToml(path) {
  const text = readFileSync(path, 'utf8');
  const out = {};
  const re = /^(\w+)\s*=\s*(\[[^\]]*\]|"[^"]*"|\S+)\s*$/gms;
  for (const [, key, raw] of text.matchAll(re)) {
    out[key] = raw.startsWith('[')
      ? raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^"|"$/g, '')).filter((v) => v !== '')
      : raw.replace(/^"|"$/g, '');
  }
  return out;
}

const circuit = JSON.parse(readFileSync(join(BUILD, 'target/deck_open.json'), 'utf8'));
const inputs = readProverToml(proverToml);
console.log(`inputs from ${proverToml}`);

const { witness } = await new Noir(circuit).execute(inputs);
console.log(`witness solved: ${witness.length} bytes`);

const backend = new UltraHonkBackend(circuit.bytecode, { threads: 8 });
// keccakZK is what the deployed verifier's verify_ultra_keccak_zk_honk_proof
// expects; any other flavour verifies locally and is rejected on-chain.
const opts = { keccakZK: true };
const proof = await backend.generateProof(witness, opts);
const vk = await backend.getVerificationKey(opts);
const verified = await backend.verifyProof(proof, opts);
await backend.destroy();

if (!verified) { console.error('FAIL: bb rejected its own proof'); process.exit(1); }

writeFileSync(join(OUT, 'proof.bin'), Buffer.from(proof.proof));
writeFileSync(join(OUT, 'vk.bin'), Buffer.from(vk));
// garaga calldata wants RAW BINARY public inputs -- 32 bytes big-endian per
// field -- not the JSON array bb.js hands back.
const pub = Buffer.concat(proof.publicInputs.map((h) => {
  const b = Buffer.alloc(32);
  let v = BigInt(h);
  for (let i = 31; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}));
writeFileSync(join(OUT, 'public_inputs.bin'), pub);

console.log(`proof  ${proof.proof.length} bytes`);
console.log(`vk     ${vk.length} bytes`);
console.log(`public ${proof.publicInputs.length} fields: ${proof.publicInputs.join(', ')}`);
console.log('\nNow:');
console.log('  garaga gen --system ultra_keccak_zk_honk --vk circuits/deck_open_verifier/example_proof/vk.bin --project-name deck_open_verifier');
