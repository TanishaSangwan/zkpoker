// Regenerates everything under public/ that is derived.
//
// None of it is checked in: ~12 MB of bundle and wasm that any machine can
// rebuild in seconds from sources that ARE checked in. Run this, then
// `node run.mjs`.
//
// Requires nargo 1.0.0-beta.16 on PATH to compile the circuit -- NOT the
// project's beta.22 pin. See README.md for why, and remember to switch
// back afterwards (`noirup --version 1.0.0-beta.22`).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync } from 'node:fs';

const R = (p) => new URL(p, import.meta.url).pathname;
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });

const CIRCUIT = R('../../circuits/shuffle_verifier/example_proof/beta16_build');
const BB = R('node_modules/@aztec/bb.js/dest/browser/barretenberg_wasm');
const ESBUILD = R('node_modules/.bin/esbuild');

mkdirSync(R('public/wasm'), { recursive: true });

const nargo = execFileSync('nargo', ['--version']).toString();
if (!nargo.includes('1.0.0-beta.16')) {
  console.error(`\nWRONG NARGO. Need 1.0.0-beta.16, found:\n${nargo}`);
  console.error('The deployed verifier was generated from a beta.16 VK; a');
  console.error('beta.22 circuit produces a proof it rejects. See README.md.');
  process.exit(1);
}
if (!existsSync(`${CIRCUIT}/target/shuffle.json`)) run('nargo', ['compile'], CIRCUIT);
cpSync(`${CIRCUIT}/target/shuffle.json`, R('public/shuffle.json'));

run('node', [R('toml2json.mjs'), `${CIRCUIT}/Prover.toml`, R('public/inputs.json')]);

const bundle = (entry, out) =>
  run(ESBUILD, [entry, '--bundle', '--format=esm', `--outfile=${out}`, '--target=es2022']);

bundle(R('src/prove.js'), R('public/prove.js'));
// bb.js spawns these through `new Worker(new URL('./x.worker.js',
// import.meta.url))`, so they have to sit next to the bundle under the
// exact names it asks for.
bundle(`${BB}/barretenberg_wasm_main/factory/browser/main.worker.js`, R('public/main.worker.js'));
bundle(`${BB}/barretenberg_wasm_thread/factory/browser/thread.worker.js`, R('public/thread.worker.js'));

// bb's wasm ships only in the node dest; the browser dest expects it to be
// served. `wasmPath` in src/prove.js points here.
cpSync(R('node_modules/@aztec/bb.js/dest/node/barretenberg_wasm/barretenberg-threads.wasm.gz'),
       R('public/wasm/barretenberg-threads.wasm.gz'));

// noir_js's two wasm-bindgen modules. The WEB builds, not the nodejs ones
// -- the nodejs wasm expects a different import module name and fails with
// `__wbindgen_placeholder__: module is not an object or function`.
cpSync(R('node_modules/@noir-lang/acvm_js/web/acvm_js_bg.wasm'), R('public/acvm_js_bg.wasm'));
cpSync(R('node_modules/@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm'), R('public/noirc_abi_wasm_bg.wasm'));

console.log('\npublic/ rebuilt. Now: node run.mjs');
