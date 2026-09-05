// Regenerates src/utils/pokerGameAbi.ts from the compiled contract class.
//
// The previous copy was hand-pasted and drifted a whole protocol behind the
// contract: it still carried commit_deal/reveal_seed and had none of
// register_shuffle_key, begin_shuffle, submit_shuffle, open_deck, the reveal
// path or the accusation path. A stale ABI does not fail loudly -- calldata
// is compiled from it, so the UI simply builds the wrong transaction.
//
//   node scripts/gen_abi.mjs            # write
//   node scripts/gen_abi.mjs --check    # exit 1 if the file is stale (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = [
  ['pokerGameAbi', 'cairo/target/dev/zkpoker_PokerGame.contract_class.json', 'src/utils/pokerGameAbi.ts',
   "cairo/src/lib.cairo's PokerGame"],
];

const header = (src, what) => `// GENERATED FILE -- do not edit by hand.
//
// ABI for ${what}, extracted from
// ${src} by scripts/gen_abi.mjs.
// Regenerate with \`scarb build\` in cairo/ then \`node scripts/gen_abi.mjs\`.
// \`node scripts/gen_abi.mjs --check\` fails if this file has drifted from the
// compiled contract -- which is how the previous hand-maintained copy ended up
// an entire protocol version behind without anything complaining.
`;

const check = process.argv.includes('--check');
let stale = false;

for (const [name, srcRel, outRel, what] of SOURCES) {
  const cls = JSON.parse(readFileSync(join(root, srcRel), 'utf8'));
  const body = `${header(srcRel, what)}export const ${name} = ${JSON.stringify(cls.abi, null, 2)} as const;\n`;
  const outPath = join(root, outRel);
  let current = null;
  try { current = readFileSync(outPath, 'utf8'); } catch {}
  if (current === body) { console.log(`ok       ${outRel}`); continue; }
  if (check) { console.error(`STALE    ${outRel}`); stale = true; continue; }
  writeFileSync(outPath, body);
  console.log(`written  ${outRel} (${cls.abi.length} entries)`);
}

process.exit(stale ? 1 : 0);
