// Does the shipped app actually prove a shuffle in a browser?
//
// scripts/browser-proving/ answered that for a hand-rolled esbuild bundle.
// This answers it for what players get: the Next production build, its
// COOP/COEP headers, its bundling of bb.js and the noir wasm, and the
// artifacts scripts/build_client_circuits.mjs stages into public/circuits/.
// Those are different enough to break independently -- a bundler that
// rewrites import.meta.url, or a missing header, and proving silently halves
// in speed or stops working.
//
//   npm run build && node scripts/check_browser_client.mjs
//
// Exits non-zero on: missing cross-origin isolation, a circuit that will not
// load, or a proof whose public inputs are not what was asked for.
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const PORT = process.env.PORT ?? '3111';
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium';
const base = `http://127.0.0.1:${PORT}`;

const fail = (m) => { console.error(`FAIL: ${m}`); process.exitCode = 1; };
const ok = (m) => console.log(`ok    ${m}`);

// `next start` via the local binary, not npx: spawn() does not get the
// shell's PATH resolution and an npx that cannot be found simply never
// prints, which looks identical to a server that never came up.
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', PORT], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (b) => process.stderr.write(`  next: ${b}`));
const cleanup = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', cleanup);

// Poll the socket rather than parsing startup text. Next's ready banner has
// changed wording across versions, and a regex that stops matching hangs the
// check for its whole timeout with no clue why.
let up = false;
for (let i = 0; i < 120; i++) {
  try { await fetch(base); up = true; break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}
if (!up) { fail('next start never accepted a connection'); cleanup(); process.exit(1); }
ok(`next start is up on ${base}`);

const res = await fetch(`${base}/poker`);
const coop = res.headers.get('cross-origin-opener-policy');
const coep = res.headers.get('cross-origin-embedder-policy');
if (coop !== 'same-origin') fail(`Cross-Origin-Opener-Policy is ${coop}, expected same-origin`);
else ok('COOP: same-origin');
if (coep !== 'require-corp') fail(`Cross-Origin-Embedder-Policy is ${coep}, expected require-corp`);
else ok('COEP: require-corp');

for (const name of ['shuffle.json', 'deck_open.json']) {
  const r = await fetch(`${base}/circuits/${name}`);
  if (!r.ok) fail(`/circuits/${name} -> ${r.status}; run scripts/build_client_circuits.mjs`);
  else ok(`/circuits/${name} is served`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--js-flags=--max-old-space-size=4096',
    // HARNESS ONLY, and it does not weaken anything the app ships.
    //
    // bb.js downloads the SRS from https://crs.aztec.network at proving time
    // (the URL is hardcoded in its browser CRS path -- there is no option to
    // point it elsewhere). Headless Chromium here does not trust that host's
    // CA even though curl on the same machine does, so without this the check
    // dies at downloadG1Data with ERR_CERT_AUTHORITY_INVALID and tells you
    // nothing about the code. A real browser fetches it normally and caches it
    // in IndexedDB. See the CRS note in docs/PROTOCOL.md §9.4.
    '--ignore-certificate-errors',
  ],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.error(`  console: ${m.text()}`); });

await page.goto(`${base}/poker`, { waitUntil: 'networkidle2', timeout: 60_000 });

const isolated = await page.evaluate(() => self.crossOriginIsolated);
if (!isolated) fail('/poker is NOT cross-origin isolated -- proving would fall back to one thread');
else ok(`cross-origin isolated, ${await page.evaluate(() => navigator.hardwareConcurrency)} threads available`);

// Prove a real shuffle through the app's OWN bundle -- not a copy. If Next's
// bundling broke bb.js's worker URLs or the wasm paths, this is where it
// shows. /poker/selftest is a real page (a deployment check, per §9.0), so
// this drives it rather than injecting a parallel implementation.
await page.goto(`${base}/poker/selftest`, { waitUntil: 'networkidle2', timeout: 60_000 });

const isolatedSelfTest = await page.evaluate(() => self.crossOriginIsolated);
if (!isolatedSelfTest) fail('/poker/selftest is not cross-origin isolated');

await page.click('#run-selftest');
const result = await page.waitForFunction(
  () => window.__zkpokerSelfTest?.result ?? null,
  { timeout: 300_000, polling: 500 },
).then((h) => h.jsonValue());

const KNOWN_BLOCKER = /cannot consume the initial deck under this toolchain/;

if (!result || !result.ok) {
  // Distinguish the blocker docs/PROTOCOL.md §9.2 already records from a NEW
  // breakage. Both fail the check -- proving genuinely does not work end to
  // end -- but a run that just re-reports a known, documented defect should
  // say so, or the next person spends an hour rediscovering it.
  if (result?.error && KNOWN_BLOCKER.test(result.error)) {
    fail('KNOWN BLOCKER (PROTOCOL.md §9.2): beta.16 acvm rejects the identity point in a_0, so ' +
         'the first shuffle of the chain cannot be witness-solved. Everything up to witness ' +
         'generation -- headers, isolation, threads, circuit load, wasm -- worked.');
  } else {
    fail(`in-app proving failed: ${result?.error ?? 'no result'}`);
  }
} else {
  if (!result.a0Matches) fail('a_0 does not hash to INITIAL_DECK_COMMITMENT in the browser');
  else ok('a_0 hashes to the pinned INITIAL_DECK_COMMITMENT in-browser');
  ok(`shuffle proved in-app: witness ${result.witnessMs} ms, proof ${result.proveMs} ms, ` +
     `calldata ${result.calldataMs} ms (total ${result.totalMs} ms on ${result.threads} threads)`);
  ok(`${result.calldataFelts} felts of Starknet calldata, new commitment ${result.commitmentOut}`);
  if (!result.openMs) fail('the deck opening did not run');
  else ok(`deck opened in-app: ${result.openMs} ms, ${result.openCalldataFelts} felts, ` +
          `positions ${result.openPositions}`);
}

await browser.close();
cleanup();
console.log(process.exitCode ? '\nFAILED' : '\nBrowser client OK.');
