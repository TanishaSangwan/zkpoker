// Does the relay transport survive the relay going away?
//
// It did not, and the failure was invisible in a way that matters now. The
// relay used to be assumed local -- it either ran for the whole session or
// was never there -- so a mid-session drop was not a case anyone handled:
//
//   * the streamed-fetch branch was started as `void this.readStream(...)`
//     and RETHREW on error, so a drop became an unhandled rejection and the
//     stream stayed dead;
//   * the EventSource branch had no `onerror`, so it just went quiet.
//
// Either way shares stop arriving, nobody can combine one, and the hand
// cannot finish -- while the UI still says the relay is fine. That was
// tolerable when the relay was on localhost. It is not now: the relay is
// meant to be remote (a player's box, a free tier that idles out, a tunnel),
// where drops are ordinary rather than exceptional.
//
//   node scripts/check_relay_reconnect.mjs
//
// Exercises the NODE path (streamed fetch). The browser path is the same
// state machine behind EventSource.onerror; check_browser_client.mjs is
// where a browser-side version would belong.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'node_modules/.cache/zkpoker-relay-check');
const fail = (m) => { console.error(`\nFAIL: ${m}`); process.exit(1); };
const ok = (m) => console.log(`ok    ${m}`);

mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, 'entry.ts'),
  `export { RelayTransport } from ${JSON.stringify(join(root, 'src/lib/relayTransport.ts'))};`);
await build({
  entryPoints: [join(outdir, 'entry.ts')], bundle: true, format: 'esm', platform: 'node',
  outfile: join(outdir, 't.mjs'), logLevel: 'error', alias: { '@': join(root, 'src') },
});
const { RelayTransport } = await import(pathToFileURL(join(outdir, 't.mjs')).href + `?v=${Date.now()}`);

const PORT = Number(process.env.RELAY_PORT ?? 3213);
const URL_ = `http://127.0.0.1:${PORT}`;
const TABLE = '0xRECONNECTCHECK';

const startRelay = () => spawn('node', [join(root, 'scripts/relay.mjs')], {
  env: { ...process.env, RELAY_PORT: String(PORT) }, stdio: 'ignore', detached: true,
});
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUp = async () => {
  for (let i = 0; i < 200; i++) { try { await fetch(URL_); return true; } catch { await settle(50); } }
  return false;
};
const waitDown = async () => {
  for (let i = 0; i < 200; i++) { try { await fetch(URL_); await settle(50); } catch { return true; } }
  return false;
};

let unhandled = 0;
process.on('unhandledRejection', (e) => {
  unhandled += 1;
  console.error(`  unhandled rejection: ${String(e).slice(0, 90)}`);
});

let relay = startRelay();
if (!(await waitUp())) fail('the relay would not start');

const seen = [];
const statuses = [];
const t = new RelayTransport(TABLE, URL_, { onStatus: (s) => statuses.push(s) });
t.subscribe((e) => seen.push(e.body?.n));
const send = (n) => t.publish({
  tableId: TABLE, position: 0, from: 0, kind: 'share', to: null, body: { n },
});

await settle(600);
await send(1);
await settle(500);
if (!seen.includes(1)) fail('the first message never arrived, so nothing else here means anything');
ok('connected and delivering');

process.kill(-relay.pid, 'SIGKILL');
if (!(await waitDown())) fail('the relay did not actually go down');
ok('relay killed mid-stream');
await settle(1500);

relay = startRelay();
if (!(await waitUp())) fail('the relay would not restart');
// Long enough to cover the backoff ladder (0.5s doubling to a 10s ceiling).
await settle(6000);

await send(2);
await settle(1500);
const cleanup = () => { try { process.kill(-relay.pid, 'SIGKILL'); } catch {} };

if (!seen.includes(2)) {
  console.error(`  received: [${seen}]  statuses: ${statuses.join(' -> ') || '(none)'}`);
  t.close(); cleanup();
  fail('the transport never reconnected -- a dropped relay is a dead table');
}
ok(`reconnected and delivering again (statuses: ${statuses.join(' -> ')})`);

if (unhandled !== 0) { t.close(); cleanup(); fail(`${unhandled} unhandled rejection(s)`); }
ok('no unhandled rejections');

t.close();
await settle(300);
cleanup();
console.log('\nRelay reconnect check passed: a drop is survivable and reported.');
