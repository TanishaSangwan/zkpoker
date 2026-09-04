// Shuffle-proof generation, in the browser, end to end.
//
// docs/PROTOCOL.md section 9 rests entirely on this: a player has to
// build their own shuffle proof client-side, because handing the witness
// to anyone else hands them the permutation, and the permutation is the
// secret the whole protocol is protecting. Until now the only numbers we
// had were server-side WASM (7.2s), which is not the same machine, the
// same memory limit, or the same engine.
//
// The toolchain here is NOT the project's usual pin. It is nargo
// 1.0.0-beta.16 + @aztec/bb.js@3.0.0-nightly.20251104, the pairing garaga
// 1.1.0 requires and therefore the pairing the DEPLOYED verifier was
// generated from. Proving the beta.22 build instead would produce a proof
// the on-chain verifier rejects, which would make the measurement
// meaningless -- see circuits/shuffle_verifier/README.md.
import { UltraHonkBackend } from '@aztec/bb.js';
import { Noir } from '@noir-lang/noir_js';

const mark = {};
const t = (name, fn) => async (...a) => {
  const start = performance.now();
  const out = await fn(...a);
  mark[name] = Math.round(performance.now() - start);
  return out;
};

const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

async function proveOnce(circuit, witness, threads) {
  const backend = new UltraHonkBackend(circuit.bytecode, {
    threads,
    // wasmPath rather than the bundled default: bb.js resolves its wasm
    // through import.meta.url, which a bundler rewrites. Given this path
    // it appends "-threads" itself when running multithreaded, so both
    // files live under /wasm/.
    wasmPath: '/wasm/barretenberg.wasm.gz',
  });
  // keccakZK matches the deployed verifier's
  // verify_ultra_keccak_zk_honk_proof. Any other flavour would verify in
  // bb here and be rejected on-chain.
  const opts = { keccakZK: true };

  const t0 = performance.now();
  const proof = await backend.generateProof(witness, opts);
  const proveMs = Math.round(performance.now() - t0);

  const t1 = performance.now();
  const ok = await backend.verifyProof(proof, opts);
  const verifyMs = Math.round(performance.now() - t1);

  const vk = await backend.getVerificationKey(opts);
  await backend.destroy();
  return { proveMs, verifyMs, ok, proof, vk: hex(vk) };
}

async function main() {
  const log = [];
  const say = (m) => { log.push(m); console.log(m); };

  say(`ua: ${navigator.userAgent}`);
  say(`hardwareConcurrency: ${navigator.hardwareConcurrency}`);
  say(`crossOriginIsolated: ${self.crossOriginIsolated}`);
  say(`SharedArrayBuffer: ${typeof SharedArrayBuffer !== 'undefined'}`);
  if (performance.memory) {
    say(`jsHeapLimit: ${(performance.memory.jsHeapSizeLimit / 2 ** 20).toFixed(0)} MiB`);
  }

  const [circuit, inputs] = await Promise.all([
    fetch('./shuffle.json').then((r) => r.json()),
    fetch('./inputs.json').then((r) => r.json()),
  ]);

  // Witness generation is part of the client's job, not a preliminary to
  // it -- so it is measured, not skipped by loading nargo's witness.
  const noir = new Noir(circuit);
  const tw = performance.now();
  const { witness } = await noir.execute(inputs);
  const witnessMs = Math.round(performance.now() - tw);
  say(`witness: ${witness.length} bytes in ${witnessMs} ms`);

  const threads = navigator.hardwareConcurrency;
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const r = await proveOnce(circuit, witness, threads);
    say(`run ${i + 1}: prove ${r.proveMs} ms, verify ${r.verifyMs} ms, ok=${r.ok}`);
    runs.push(r);
  }

  // What a page served WITHOUT cross-origin isolation gets. Most static
  // hosts do not set COOP/COEP, so this is not a hypothetical -- it is
  // what a player sees if the deployment forgets two headers.
  const single = await proveOnce(circuit, witness, 1);
  say(`single-threaded: prove ${single.proveMs} ms`);

  const last = runs[runs.length - 1];
  return {
    ok: runs.every((r) => r.ok) && single.ok,
    witnessMs,
    proveMs: runs.map((r) => r.proveMs),
    verifyMs: runs.map((r) => r.verifyMs),
    singleThreadedProveMs: single.proveMs,
    proofBytes: last.proof.proof.length,
    publicInputs: last.proof.publicInputs,
    vk: last.vk,
    vkStableAcrossRuns: runs.every((r) => r.vk === last.vk),
    log,
    threads,
    crossOriginIsolated: self.crossOriginIsolated,
  };
}

window.__run = () => main().then(
  (r) => { window.__result = r; },
  (e) => { window.__result = { ok: false, error: String(e && e.stack || e) }; },
);
