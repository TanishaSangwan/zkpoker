// Do typed STRK amounts become the right base units?
//
// Every amount PokerGame takes is a raw u128 in the token's smallest unit and
// STRK has 18 decimals, so the client multiplies. This is the seam where a
// mistake becomes an on-chain amount -- and it has already gone wrong once in
// the other direction: the first Sepolia tables were created with blinds of 10
// and 20 WEI, because "10" is a reasonable thing to type and silently meant
// 1e-17 STRK against a hand of gas costing ~86 STRK.
//
//   node scripts/check_amount_units.mjs
//
// Covers the ordinary cases, the ones that should be REFUSED rather than
// guessed at (scientific notation, negatives, more than 18 decimal places),
// and a round trip, since the UI both parses and formats.

import { build } from '/home/x/Documents/zkpoker/node_modules/esbuild/lib/main.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root='/home/x/Documents/zkpoker', out=`${root}/node_modules/.cache/zkpoker-units`;
mkdirSync(out,{recursive:true});
writeFileSync(`${out}/e.ts`, `export { strkToBase, baseToStrk } from ${JSON.stringify(root+'/src/app/poker/contract.ts')};`);
await build({entryPoints:[`${out}/e.ts`],bundle:true,format:'esm',platform:'node',outfile:`${out}/t.mjs`,logLevel:'error',alias:{'@':`${root}/src`}});
const { strkToBase, baseToStrk } = await import(pathToFileURL(`${out}/t.mjs`).href+`?v=${Date.now()}`);

const E = 10n**18n;
const ok = [
  ['10', 10n*E], ['20', 20n*E], ['200', 200n*E], ['0', 0n], ['', 0n],
  ['0.5', 5n*10n**17n], ['1.000000000000000001', E+1n],
  ['0.000000000000000001', 1n], ['1234.5', 1234n*E + 5n*10n**17n],
  ['  10  ', 10n*E], ['.5', 5n*10n**17n], ['10.', 10n*E],
];
let bad = 0;
for (const [inp, want] of ok) {
  let got; try { got = strkToBase(inp); } catch (e) { got = `THREW ${e.message}`; }
  const pass = got === want;
  if (!pass) bad++;
  console.log(`${pass?'ok  ':'FAIL'} strkToBase(${JSON.stringify(inp)}) = ${got}${pass?'':`  want ${want}`}`);
}
for (const inp of ['abc', '1e18', '-5', '.', '1.2.3', '0.0000000000000000001']) {
  let threw = false; try { strkToBase(inp); } catch { threw = true; }
  if (!threw) bad++;
  console.log(`${threw?'ok  ':'FAIL'} rejects ${JSON.stringify(inp)}`);
}
for (const [v, want] of [[10n*E,'10'],[0n,'0'],[E+1n,'1.000000000000000001'],[5n*10n**17n,'0.5'],[1n,'0.000000000000000001']]) {
  const got = baseToStrk(v); const pass = got === want; if (!pass) bad++;
  console.log(`${pass?'ok  ':'FAIL'} baseToStrk(${v}) = ${got}${pass?'':`  want ${want}`}`);
}
// round trip
for (const s of ['10','0.5','1234.567','0.000000000000000001']) {
  const rt = baseToStrk(strkToBase(s)); const pass = rt === s; if (!pass) bad++;
  console.log(`${pass?'ok  ':'FAIL'} round-trip ${s} -> ${rt}`);
}
console.log(bad === 0 ? '\nPASS: all units cases' : `\nFAIL: ${bad} case(s)`);
process.exit(bad === 0 ? 0 : 1);
