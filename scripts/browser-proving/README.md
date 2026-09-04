# Browser proving — measured

`docs/PROTOCOL.md` §9 rests entirely on this. A player has to build their own
shuffle proof **client-side**: handing the witness to anyone else hands them the
permutation, and the permutation is the secret the whole protocol protects. Until
now the only numbers were server-side WASM, on a different machine, with a
different memory limit and a different engine. This is the real thing.

## Result

Headless Chromium 149, 6 threads, cross-origin isolated, 4 GB JS heap:

| | ms |
|---|---|
| Witness generation | 375 |
| Proving, 6 threads (3 runs) | 4466 · 4797 · 5279 |
| **Client-side total** | **~5.2 s** |
| Verifying in-browser (not needed in practice — the chain does it) | ~780 |
| Proving, 1 thread | 9870 |

Proof: 9,408 bytes, 4 public inputs, self-verifies.

**The result that matters is not the timing.** It is
`vkMatchesDeployedVerifier: true` — the verification key the browser derives is
byte-identical (1,888 bytes) to `../../circuits/shuffle_verifier/example_proof/vk.bin`,
the key Garaga generated the **deployed** verifier from. The browser is proving
against the contract that is actually on chain, not merely producing something
bb.js is willing to verify for itself. The four public inputs come back exactly
as `Prover.toml` set them, and the proof is the same 9,408 bytes as the
devnet-verified `proof.bin`.

**Cross-origin isolation is worth 2.1×.** Multithreaded proving needs
`SharedArrayBuffer`, which the browser only grants a cross-origin-isolated page.
Without the `COOP`/`COEP` headers in `serve.mjs`, bb.js silently falls back to one
thread and proving goes 4.8 s → 9.9 s. Most static hosts do not set those headers
by default; a deployment that forgets them does not break, it just doubles every
player's wait.

## Toolchain — deliberately NOT the project pin

`nargo 1.0.0-beta.16` + `@aztec/bb.js@3.0.0-nightly.20251104`.

That is the pairing Garaga 1.1.0 requires and therefore the pairing the deployed
verifier was generated from. Proving the project's normal beta.22 build would
produce a proof the on-chain verifier **rejects** — the VK layout differs
(`public_inputs_offset` 5 vs 1), which is the same incompatibility
`../../circuits/shuffle_verifier/README.md` documents at length. Measuring that
would have measured nothing.

`build.mjs` refuses to run under any other nargo. **Switch back afterwards:**

```sh
noirup --version 1.0.0-beta.16   # to build
noirup --version 1.0.0-beta.22   # the project pin, restore when done
```

## Running it

```sh
npm install
noirup --version 1.0.0-beta.16
node build.mjs      # regenerates public/ (~12 MB, all derived, all gitignored)
node run.mjs        # headless; HEADLESS=0 to watch it
noirup --version 1.0.0-beta.22
```

`run.mjs` exits non-zero if any proof fails to verify or if the VK stops matching
the deployed verifier's.

## Layout

| | |
|---|---|
| `src/prove.js` | the harness — witness, prove ×3, verify, VK export, single-threaded comparison |
| `serve.mjs` | static server that sets COOP/COEP; without them there is no `SharedArrayBuffer` and no threads |
| `run.mjs` | drives Chromium, compares the VK against the deployed verifier's |
| `build.mjs` | regenerates `public/` |
| `toml2json.mjs` | `Prover.toml` → `inputs.json` for noir_js |

## Things that cost time, written down so they cost nobody else any

- **Bundling bb.js breaks threading** unless the workers are emitted separately.
  It spawns them via `new Worker(new URL('./thread.worker.js', import.meta.url))`,
  so they must be bundled as their own entry points and land next to the main
  bundle under exactly those names. An IIFE bundle has no `import.meta` at all.
- **bb's wasm is not in the browser dest.** It ships only under `dest/node/`.
  Pass `wasmPath` and serve it yourself; bb.js appends `-threads` to the filename
  on its own when multithreaded.
- **noir_js needs the `web/` wasm, not `nodejs/`.** The nodejs build fails as
  `__wbindgen_placeholder__: module is not an object or function`, because the
  web glue instantiates it with different import names.
- **Serve `.gz` as `application/gzip` with no transport encoding.** bb.js
  ungzips the payload itself; letting the browser transparently decode it hands
  bb a file it cannot parse.
