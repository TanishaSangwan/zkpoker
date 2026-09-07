// Stage barretenberg's CRS into public/crs/ so the browser never fetches it
// from crs.aztec.network.
//
// bb.js hardcodes that host (dest/browser/crs/net_crs.js) and the browser
// build's CachedNetCrs ignores the `crsPath` option, so public/crs-sw.js
// intercepts the requests and serves these files instead. See its header for
// why: a real player hit ERR_CERT_AUTHORITY_INVALID on that host while curl
// on the same machine validated the chain fine.
//
//   node scripts/stage_crs.mjs
//
// SIZES. bb asks for `circuitSize + 1` G1 points and a fixed 2^16 + 1
// grumpkin points (barretenberg/index.js). Our largest circuit is 2^17
// (shuffle and shuffle_open both report log_circuit_size 17), so 2^18 G1
// points is double what is needed and 2^17 grumpkin points is double again.
// g2.dat is 128 bytes whole.
//
// A slice that is too SMALL is worse than none: crs-sw.js deliberately falls
// back to the network rather than return a short range, because bb would
// accept the short read and prove against the wrong reference string.
import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'public/crs');
const HOST = 'https://crs.aztec.network';

const want = [
  ['g1.dat', 2 ** 18 * 64],
  ['grumpkin_g1.dat', 2 ** 17 * 64],
  ['g2.dat', null], // whole file
];

await mkdir(OUT, { recursive: true });
for (const [name, bytes] of want) {
  const dest = join(OUT, name);
  try {
    const s = await stat(dest);
    if (bytes === null ? s.size > 0 : s.size >= bytes) {
      console.log(`ok       ${name} (${s.size} bytes, already staged)`);
      continue;
    }
  } catch { /* not there yet */ }
  const headers = bytes === null ? {} : { Range: `bytes=0-${bytes - 1}` };
  const res = await fetch(`${HOST}/${name}`, { headers });
  if (!res.ok && res.status !== 206) throw new Error(`${name}: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  const s = await stat(dest);
  console.log(`staged   ${name} (${s.size} bytes)`);
}
console.log('\nCRS staged. public/crs-sw.js serves these in place of crs.aztec.network.');
