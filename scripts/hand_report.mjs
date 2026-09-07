// Cost/time meter for one hand on a public chain.
//
//   node handmeter.mjs baseline
//   node handmeter.mjs report [TABLE_LABEL]
//
// Two independent measurements, deliberately:
//   * balance diffs across the three accounts -- the exact, total, ground
//     truth, including transactions this script never sees (approve, etc.);
//   * a per-transaction breakdown from PokerGame's own events, which explains
//     WHERE the money and the seconds went.
// If the two disagree, the balance diff is right and the breakdown is missing
// a transaction.
import { RpcProvider, hash } from 'starknet';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RPC = process.env.RPC ?? 'https://api.cartridge.gg/x/starknet/sepolia';
const GAME = '0x038387676d4ab0c1738089f026a48e668a1c9a410ee3917ac4b32a9d50a6458d';
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const STATE = path.join(process.env.STATE_DIR ?? '.', 'hand-baseline.json');
const provider = new RpcProvider({ nodeUrl: RPC });

const accountsFile = path.join(os.homedir(), '.starknet_accounts', 'starknet_open_zeppelin_accounts.json');
const accts = JSON.parse(fs.readFileSync(accountsFile, 'utf8'))['alpha-sepolia'];
const NAMES = ['sepolia', 'sep2', 'sep3'];
const ADDR = Object.fromEntries(NAMES.map((n) => [n, accts[n].address]));
const whose = (a) => NAMES.find((n) => BigInt(ADDR[n]) === BigInt(a)) ?? `${a.slice(0, 8)}…`;

// Balance at a specific block, so a baseline can be taken RETROACTIVELY --
// the hand is usually already underway before anyone thinks to measure it.
async function balance(addr, block) {
  const r = await provider.callContract(
    { contractAddress: STRK, entrypoint: 'balance_of', calldata: [addr] },
    block === undefined ? 'latest' : block,
  );
  return BigInt(r[0]);
}

// The earliest PokerGame event in the recent past -- i.e. where this hand
// started, so the baseline can be placed just before it.
async function findStart(lookback) {
  const h = await provider.getBlockLatestAccepted();
  const from = h.block_number - lookback;
  let ctoken, first = null, n = 0;
  do {
    const page = await provider.getEvents({
      address: GAME, from_block: { block_number: from }, to_block: { block_number: h.block_number },
      chunk_size: 1000, ...(ctoken ? { continuation_token: ctoken } : {}),
    });
    for (const e of page.events) { n++; if (first === null || e.block_number < first) first = e.block_number; }
    ctoken = page.continuation_token;
  } while (ctoken);
  return { head: h.block_number, from, first, n };
}

if (process.argv[2] === 'find-start') {
  const r = await findStart(Number(process.argv[3] ?? 600));
  console.log(`head ${r.head}, scanned from ${r.from}`);
  console.log(`${r.n} PokerGame events, earliest at block ${r.first}`);
  process.exit(0);
}
const strk = (v) => (Number(v) / 1e18).toFixed(4);

// Entrypoints this contract exposes, by selector, so a transaction can say
// what it actually did rather than showing a bare hash.
const ENTRYPOINTS = [
  'create_table','set_blinds','join_table','register_shuffle_key','begin_shuffle','submit_shuffle',
  'open_deck','post_blinds','bet','check','fold','advance_street',
  'commit_hole_shares','reveal_hole_card','reveal_community_card','settle_from_reveals',
  'accuse_share','answer_accusation','claim_share_timeout','claim_showdown_timeout',
  'dispute_deck','claim_shuffle_timeout','approve','set_blind_schedule',
  'start_next_hand','reclaim_stalled_bet',
];
const SELECTORS = new Map(ENTRYPOINTS.map((e) => [BigInt(hash.getSelectorFromName(e)), e]));

function callNames(cd) {
  const named = (sel) => SELECTORS.get(BigInt(sel)) ?? `0x${BigInt(sel).toString(16).slice(0, 8)}…`;
  try {
    const n = Number(cd[0]);
    const out = [];
    let i = 1;
    for (let k = 0; k < n; k++) {
      out.push(named(cd[i + 1]));
      i += 3 + Number(cd[i + 2]);
    }
    // Repeats collapse: eight reveal_hole_card calls in one transaction are
    // one action, not eight lines of noise.
    const uniq = [...new Set(out)];
    return uniq.map((u) => {
      const c = out.filter((x) => x === u).length;
      return c > 1 ? `${u}x${c}` : u;
    }).join('+');
  } catch {
    return cd.length > 2 ? named(cd[2]) : '?';
  }
}

if (process.argv[2] === 'baseline') {
  // An explicit block number rebases the baseline into the past.
  const at = process.argv[3] !== undefined
    ? Number(process.argv[3])
    : (await provider.getBlockLatestAccepted()).block_number;
  const balances = {};
  for (const n of NAMES) balances[n] = (await balance(ADDR[n], at)).toString();
  const wall = process.argv[3] !== undefined
    ? (await provider.getBlockWithTxHashes(at)).timestamp * 1000
    : Date.now();
  fs.writeFileSync(STATE, JSON.stringify({ block: at, wall, balances, addr: ADDR }, null, 2));
  console.log(`baseline at block ${at}, ${new Date(wall).toISOString()}`);
  for (const n of NAMES) console.log(`  ${n.padEnd(8)} ${strk(BigInt(balances[n]))} STRK`);
  process.exit(0);
}

// ── report ──────────────────────────────────────────────────────────────
const base = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const head = await provider.getBlockLatestAccepted();

// Every PokerGame event since the baseline, in order, deduped to transactions.
const seen = [];
let ctoken;
do {
  const page = await provider.getEvents({
    address: GAME,
    from_block: { block_number: base.block },
    to_block: { block_number: head.block_number },
    chunk_size: 1000,
    ...(ctoken ? { continuation_token: ctoken } : {}),
  });
  for (const e of page.events) if (!seen.includes(e.transaction_hash)) seen.push(e.transaction_hash);
  ctoken = page.continuation_token;
} while (ctoken);

const blockTime = new Map();
async function timeOf(bn) {
  if (!blockTime.has(bn)) blockTime.set(bn, (await provider.getBlockWithTxHashes(bn)).timestamp);
  return blockTime.get(bn);
}

const rows = [];
for (const h of seen) {
  const r = await provider.getTransactionReceipt(h);
  const tx = await provider.getTransactionByHash(h);
  // Cairo-1 invoke calldata: [n_calls, (to, selector, len, ...args) * n].
  // Every call is decoded, not just the first: this page batches approve with
  // join_table, and both hole cards are revealed in one multicall, so reading
  // calldata[2] alone reports a transaction as "approve" and loses the part
  // that actually mattered.
  const name = callNames(tx.calldata ?? []);
  const fee = BigInt(r.actual_fee?.amount ?? r.actual_fee ?? 0);
  const bn = r.block_number;
  rows.push({ h, name, fee, bn, sender: tx.sender_address ?? '0x0', ts: await timeOf(bn) });
}
rows.sort((a, b) => a.bn - b.bn || a.ts - b.ts);

const label = process.argv[3] ?? '';
console.log(`\n=== hand report ${label} ===`);
console.log(`blocks ${base.block} → ${head.block_number}   rpc ${RPC}\n`);
console.log('  #  entrypoint                        seat      fee (STRK)   block     +s');
let prev = null, feeSum = 0n;
rows.forEach((r, i) => {
  const gap = prev === null ? '' : String(r.ts - prev);
  prev = r.ts;
  feeSum += r.fee;
  console.log(
    `  ${String(i + 1).padStart(2)}  ${r.name.padEnd(32)} ${whose(r.sender).padEnd(9)} ` +
    `${strk(r.fee).padStart(10)}   ${String(r.bn).padStart(7)}  ${gap.padStart(4)}`,
  );
});

const span = rows.length ? rows[rows.length - 1].ts - rows[0].ts : 0;
console.log(`\n  ${rows.length} transactions, ${strk(feeSum)} STRK in fees`);
console.log(`  on-chain span: ${span}s (${(span / 60).toFixed(1)} min), first to last block timestamp`);
console.log(`  wall clock since baseline: ${((Date.now() - base.wall) / 1000 / 60).toFixed(1)} min`);

console.log('\n  balance change (the ground truth, fees + blinds + buy-ins):');
let net = 0n;
for (const n of NAMES) {
  const before = BigInt(base.balances[n]);
  const after = await balance(base.addr[n]);
  const d = after - before;
  net += d;
  console.log(`    ${n.padEnd(8)} ${strk(before).padStart(11)} → ${strk(after).padStart(11)}   ${(d < 0n ? '' : '+') + strk(d)}`);
}
console.log(`    ${'net'.padEnd(8)} ${' '.repeat(11)}   ${' '.repeat(11)}   ${(net < 0n ? '' : '+') + strk(net)}  (fees burned; transfers between seats cancel)`);
