/** @type {import('next').NextConfig} */

// Cross-origin isolation is a DEPLOYMENT REQUIREMENT, not a nicety.
//
// Shuffle proving runs in the player's browser (docs/PROTOCOL.md §1 -- the
// witness holds the permutation, and handing that to a server hands over the
// table). Multithreaded bb.js needs SharedArrayBuffer, and browsers grant
// that only to a cross-origin-isolated page. Measured in §9.0: with these
// headers a shuffle proof takes ~4.8 s on 6 threads, without them bb silently
// falls back to one thread and it takes 9.9 s. Nothing breaks -- every player
// just waits twice as long, invisibly, six times per hand.
//
// The cost is that COEP blocks any cross-origin subresource that does not
// opt in. Everything this app proves with is served from public/circuits/,
// same-origin, so that is not a constraint here; a third-party script or font
// added later would need `crossorigin` + CORP headers from its host.
const crossOriginIsolation = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
];

const nextConfig = {
  reactStrictMode: false,

  async headers() {
    return [{ source: '/:path*', headers: crossOriginIsolation }];
  },

  // bb.js and the noir wasm-bindgen modules are ESM with top-level await and
  // worker entry points; they must not be traced into the server bundle.
  serverExternalPackages: ['@aztec/bb.js', '@noir-lang/noir_js', 'garaga'],

  webpack: (config, { isServer }) => {
    if (!isServer) {
      // These packages are browser-only. Without this webpack tries to
      // polyfill node builtins they reference on paths never taken.
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    }
    // bb.js ships .wasm.gz it fetches at runtime by URL, and garaga ships a
    // .wasm it inlines; neither should be parsed as a webpack module.
    config.experiments = { ...config.experiments, asyncWebAssembly: true, topLevelAwait: true };
    return config;
  },
};

module.exports = nextConfig;
