// Drives a real Chromium at the harness and reports what it measured.
//
//   node run.mjs            headless (default)
//   HEADLESS=0 node run.mjs  visible window, for watching it work
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import puppeteer from 'puppeteer-core';

const PORT = process.env.PORT ?? 8099;
const server = spawn(process.execPath, ['serve.mjs'], {
  env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => server.stdout.on('data', r));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/chromium',
  headless: process.env.HEADLESS !== '0',
  args: ['--no-sandbox', '--enable-features=SharedArrayBuffer'],
});

try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(`  [page] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`  [page error] ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) console.log(`  [404] ${r.url()}`); });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  await page.evaluate(() => window.__run());
  const result = await page.waitForFunction(() => window.__result, { timeout: 900_000, polling: 500 })
    .then((h) => h.jsonValue());

  // The decisive correctness check. A proof is only worth measuring if
  // the DEPLOYED contract would accept it, and the contract was generated
  // by garaga from one specific verification key. If the browser's VK is
  // byte-identical to that one, the browser is proving the same statement
  // against the same verifier -- not merely producing something bb.js is
  // willing to verify for itself.
  const reference = (await readFile(
    new URL('../../circuits/shuffle_verifier/example_proof/vk.bin', import.meta.url),
  )).toString('hex');
  result.vkMatchesDeployedVerifier = result.vk === reference;
  result.vkBytes = reference.length / 2;
  delete result.vk;

  console.log('\n' + JSON.stringify(result, null, 2));
  process.exitCode = result.ok && result.vkMatchesDeployedVerifier ? 0 : 1;
} finally {
  await browser.close();
  server.kill();
}
