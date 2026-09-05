// Stages the circuit + wasm artifacts the browser prover needs into public/.
//
// None of it is checked in: ~12 MB of derived files that any machine can
// rebuild from sources that ARE checked in. public/circuits/ is gitignored.
//
//   node scripts/build_client_circuits.mjs
//
// The circuit JSON is the nargo 1.0.0-beta.16 build under
// circuits/shuffle_verifier/example_proof/beta16_build/target/, NOT the
// project's beta.22 pin. That is the pairing Garaga 1.1.0 requires and
// therefore the pairing the deployed verifier was generated from; a beta.22
// build produces a proof the on-chain verifier rejects. If the JSON is
// missing you need beta.16 on PATH to compile it -- and to switch back
// afterwards, because noirup replaces nargo globally:
//
//   noirup --version 1.0.0-beta.16
//   nargo compile --program-dir circuits/shuffle_verifier/example_proof/beta16_build
//   nargo compile --program-dir circuits/deck_open_verifier/example_proof/beta16_build
//   noirup --version 1.0.0-beta.22
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => join(root, ...p);

const OUT = R('public/circuits');
const CIRCUITS = [
  ['shuffle.json', R('circuits/shuffle_verifier/example_proof/beta16_build/target/shuffle.json')],
  ['deck_open.json', R('circuits/deck_open_verifier/example_proof/beta16_build/target/deck_open.json')],
];

for (const [name, path] of CIRCUITS) {
  if (existsSync(path)) continue;
  console.error(`missing ${path}`);
  console.error(`Compile ${name} with nargo 1.0.0-beta.16 -- see the header of this file.`);
  process.exit(1);
}

mkdirSync(join(OUT, 'wasm'), { recursive: true });

const copy = (from, to) => {
  if (!existsSync(from)) { console.error(`missing ${from}`); process.exit(1); }
  cpSync(from, to);
  console.log(`  ${(statSync(to).size / 1024).toFixed(0).padStart(6)} KiB  ${to.slice(root.length + 1)}`);
};

console.log('staging browser proving artifacts:');
for (const [name, path] of CIRCUITS) copy(path, join(OUT, name));

// bb's wasm ships only in the node dest; the browser dest expects it served.
// src/lib/shuffle.ts points `wasmPath` here, and bb appends "-threads" itself
// when running multithreaded, so both files must sit side by side.
//
// Only the -threads build ships in 3.0.0-nightly.20251104; there is no
// unsuffixed barretenberg.wasm.gz. That is fine and it is what
// scripts/browser-proving measured against: `wasmPath` names the UNSUFFIXED
// path and bb appends "-threads" itself, so the file below is the one it
// actually fetches. Do not "fix" the missing file by pointing wasmPath at the
// threads name -- bb would then look for barretenberg-threads-threads.wasm.gz.
const BB = R('node_modules/@aztec/bb.js/dest/node/barretenberg_wasm');
copy(join(BB, 'barretenberg-threads.wasm.gz'), join(OUT, 'wasm/barretenberg-threads.wasm.gz'));

// noir_js's two wasm-bindgen modules. The WEB builds, not the nodejs ones --
// the nodejs wasm expects a different import module name and fails at runtime
// with `__wbindgen_placeholder__: module is not an object or function`, which
// is a genuinely confusing way to learn you copied the wrong directory.
copy(R('node_modules/@noir-lang/acvm_js/web/acvm_js_bg.wasm'), join(OUT, 'acvm_js_bg.wasm'));
copy(R('node_modules/@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm'), join(OUT, 'noirc_abi_wasm_bg.wasm'));

console.log('\ndone. `npm run dev` serves these at /circuits/.');
