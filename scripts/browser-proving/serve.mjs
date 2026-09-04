// Static server with cross-origin isolation.
//
// bb.js proves multithreaded, which needs SharedArrayBuffer, which the
// browser only grants to a cross-origin-isolated page. Without COOP/COEP
// it silently falls back to one thread -- so these two headers are the
// difference between measuring the real thing and measuring a
// single-threaded strawman.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('./public/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.gz': 'application/gzip',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(req.url.split('?')[0]));
  const file = join(ROOT, path === '/' ? 'index.html' : path);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      // The .gz files are pre-compressed payloads bb.js ungzips itself,
      // not transport encoding -- do not let the browser transparently
      // decode them.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(process.env.PORT ?? 8099, () => console.log('listening'));
