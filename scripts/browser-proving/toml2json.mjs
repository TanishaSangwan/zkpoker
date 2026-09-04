// Prover.toml -> inputs.json for @noir-lang/noir_js.
//
// Deliberately tiny rather than a TOML dependency: the file is flat
// `key = "0x.."` / `key = [ .. ]` and nothing else, and a parser we can
// read in full is worth more here than one that handles TOML we never
// write.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, dst] = process.argv;
const out = {};
for (const line of readFileSync(src, 'utf8').split('\n')) {
  const m = line.match(/^(\w+)\s*=\s*(.*)$/);
  if (!m) continue;
  const [, key, raw] = m;
  out[key] = raw.trim().startsWith('[')
    ? JSON.parse(raw.replace(/'/g, '"')).map(String)
    : String(JSON.parse(raw.replace(/'/g, '"')));
}
writeFileSync(dst, JSON.stringify(out));
console.log(`${src} -> ${dst}: ${Object.keys(out).length} inputs`);
