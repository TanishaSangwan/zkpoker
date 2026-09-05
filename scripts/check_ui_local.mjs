// Does the UI actually read a live deployment?
//
// scripts/check_browser_client.mjs proves the browser can PROVE;
// scripts/smoke_local.mjs proves the contracts accept those proofs. Neither
// touches the table view, so this is the piece that catches a UI wired to the
// wrong network, a state hook reading the wrong getters, or a phase derived
// wrongly -- none of which would fail any other check.
//
// Needs, in order:
//   starknet-devnet --seed 0 --host 127.0.0.1 --port 5050 &
//   npm run deploy:local
//   TABLE_ID=TABLE_1 npm run smoke:local     # leaves a real table behind
//   npm run dev
//   npm run check:ui
//   TABLE=DUEL3 npm run check:ui             # any existing table
//
// The table has to exist on the CURRENT deployment. A redeploy gives
// PokerGame a fresh address and therefore no tables, so a check that hardcoded
// one reported a UI failure when the only thing wrong was its own fixture.
//
// Two things here are not incidental and are the reason this took three tries:
// a DOM click on an unhydrated React button "succeeds" and runs no handler,
// and React tracks input values on the node itself, so assigning `.value`
// directly is invisible to onChange. Both look exactly like broken UI.

import puppeteer from 'puppeteer-core';

const TABLE = process.env.TABLE ?? 'TABLE_1';
const b = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors'] });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto('http://localhost:3000/poker', { waitUntil: 'networkidle2', timeout: 60000 });

// Wait for hydration before clicking: a DOM click on an unhydrated button
// "succeeds" and runs no handler, which looks exactly like a broken switcher.
await p.waitForFunction(
  () => [...document.querySelectorAll('button')].some((x) => x.textContent.trim() === 'Refresh'),
  { timeout: 30000 },
);
await new Promise((r) => setTimeout(r, 2500));

// Switch to DEVNET, then open the table the smoke test left behind.
const clicked = await p.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'DEVNET');
  if (b) { b.click(); return true; } return false;
});
console.log('devnet button clicked:', clicked);
await new Promise((r) => setTimeout(r, 1500));

// React tracks input value on the DOM node, so assigning .value directly is
// ignored -- the native setter has to be used for onChange to see it.
await p.evaluate(() => {
  const i = document.querySelector('input');
  if (i) {
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, TABLE);
    i.dispatchEvent(new Event('input', { bubbles: true }));
  }
  [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Open')?.click();
}, TABLE);
await new Promise((r) => setTimeout(r, 9000));

const text = await p.evaluate(() => document.body.innerText);
const has = (s) => text.includes(s);
console.log('--- rendered signals');
for (const s of ['DEVNET', 'Dealing', 'pot', 'seat 0', 'Opening the deck', 'Betting',
                 'Withheld shares', 'not deployed', 'Take a seat', 'Shuffle chain']) {
  console.log(`  ${has(s) ? 'yes' : ' no'}  ${s}`);
}
console.log('--- page errors:', errs.length ? errs.slice(0, 3) : 'none');
console.log('--- excerpt');
console.log(text.split('\n').filter(Boolean).slice(0, 28).join('\n'));
await b.close();

// A real check, not a printout. These are the signals that distinguish "the
// table view rendered a live deployment" from "the page loaded".
const required = ['DEVNET', 'pot', 'Dealing', 'Withheld shares'];
const forbidden = ['not deployed'];
const missing = required.filter((s) => !text.includes(s));
const present = forbidden.filter((s) => text.includes(s));
if (errs.length) console.error(`FAIL: ${errs.length} page error(s)`);
if (missing.length) console.error(`FAIL: missing ${missing.join(', ')}`);
if (present.length) console.error(`FAIL: still showing ${present.join(', ')}`);
const bad = errs.length || missing.length || present.length;
console.log(bad ? '\nUI check FAILED' : '\nUI check OK: the table view is reading the live deployment.');
process.exit(bad ? 1 : 0);