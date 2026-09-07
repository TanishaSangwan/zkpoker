// Serve barretenberg's CRS from this origin instead of crs.aztec.network.
//
// bb.js hardcodes `fetch('https://crs.aztec.network/g1.dat', ...)` in
// dest/browser/crs/net_crs.js. There is a `crsPath` option threaded through
// Barretenberg's constructor, but the BROWSER build's `CachedNetCrs.new`
// takes only `numPoints` and ignores it, so there is no configuration route
// to a different source -- a service worker is the only interception point.
//
// Why bother: that fetch is a hard third-party dependency in the middle of
// proving, and it failed for a real player with
//
//   GET https://crs.aztec.network/g1.dat net::ERR_CERT_AUTHORITY_INVALID
//
// while curl on the same machine validated the chain fine (3 certs, in date,
// Amazon RSA 2048 M04). So the browser's trust store rejected what the OS
// accepted -- unfixable from here, and not something to ask players to debug.
// Serving the points ourselves removes the dependency entirely: no cert to
// trust, no 6.4 GB host to be up, and it is faster.
//
// The Node path never hit this, which is why every devnet test passed: bb.js
// in Node uses a disk-cached CRS through OpenSSL's trust store.
const HOST = 'crs.aztec.network';
const FILES = new Set(['g1.dat', 'g2.dat', 'grumpkin_g1.dat']);

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  let url;
  try { url = new URL(event.request.url); } catch { return; }
  if (url.hostname !== HOST) return;
  event.respondWith(serve(event.request, url));
});

async function serve(request, url) {
  const name = url.pathname.replace(/^\/+/, '');
  // Anything else on that host is not ours to answer.
  if (!FILES.has(name)) return fetch(request);

  const staged = await fetch(`/crs/${name}`, { cache: 'force-cache' });
  if (!staged.ok) return fetch(request);
  const buf = await staged.arrayBuffer();

  const range = request.headers.get('Range');
  if (!range) {
    return new Response(buf, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' },
    });
  }

  const m = /bytes=(\d+)-(\d*)/.exec(range);
  if (!m) return fetch(request);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : buf.byteLength - 1;

  // A circuit larger than what was staged. Falling back to the network is the
  // honest answer -- a SHORT slice would be worse than a failure, because bb
  // would accept it and produce a proof against the wrong reference string.
  if (start >= buf.byteLength || end >= buf.byteLength) {
    console.warn(
      `[crs-sw] ${name}: asked for bytes ${start}-${end} but only ${buf.byteLength} are staged. ` +
      `Falling back to the network. Re-run scripts/stage_crs.mjs with a larger slice.`,
    );
    return fetch(request);
  }

  const slice = buf.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    headers: {
      'content-type': 'application/octet-stream',
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${buf.byteLength}`,
    },
  });
}
