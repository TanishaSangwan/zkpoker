// A dumb message relay for share exchange.
//
// docs/PROTOCOL.md §4 phase 2 has each party send its decryption shares
// off-chain. src/lib/shares.ts defined the `Transport` seam for that but
// shipped only a BroadcastChannel implementation, which spans tabs of ONE
// browser -- enough to demo a table, useless for two people. This is the
// missing piece: it lets a browser and a terminal process exchange shares.
//
//   node scripts/relay.mjs            # listens on 3100
//   RELAY_PORT=4000 node scripts/relay.mjs
//
// ── What it is trusted with: nothing ────────────────────────────────────
//
// It fans bytes out to whoever is listening on a table and understands none
// of them. That is not laziness, it is the security argument:
//
//   * every hole-card share is ECIES-encrypted to the recipient's REGISTERED
//     public key before it is handed over (shares.ts `seal`), so a relay that
//     reads everything still cannot read a card;
//   * every share carries a DLEQ proof the recipient checks against the
//     sender's registered key, so a relay that rewrites a share is caught by
//     the recipient, not merely suspected;
//   * a relay that DROPS messages is a liveness failure, and that is what the
//     on-chain accusation path exists for -- accuse_share names the silent
//     party and claim_share_timeout convicts them.
//
// So this can be run by anyone, including a player. It is transport, not a
// participant. Do not add anything to it that would make that untrue.
//
// SSE + POST rather than WebSockets, deliberately: no dependency, and
// EventSource is native in the browser and streamable via fetch in Node.
import { createServer } from 'node:http';

const PORT = Number(process.env.RELAY_PORT ?? 3100);

/** table id -> set of SSE response streams */
const rooms = new Map();

// table id -> recent frames, replayed to a client when it connects.
//
// Without this the relay only ever delivers LIVE: a share published before its
// recipient attached is simply lost, and the recipient waits forever for a
// message that was already sent. That is indistinguishable from a party
// refusing to send -- it would send an honest player to the accusation path
// over a race. Bounded, so a long-lived relay cannot be made to grow without
// limit.
const history = new Map();
const HISTORY_PER_TABLE = 200;

const cors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  // The app is served cross-origin-isolated (COEP: require-corp), which
  // refuses cross-origin subresources that do not opt in. Without this the
  // browser's EventSource fails with nothing useful in the console.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
};

const server = createServer((req, res) => {
  cors(res);
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/events') {
    const table = url.searchParams.get('table');
    if (!table) { res.writeHead(400); res.end('table required'); return; }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    if (!rooms.has(table)) rooms.set(table, new Set());
    rooms.get(table).add(res);
    console.log(`+ listener on ${table} (${rooms.get(table).size} total)`);

    // Replay what was already said, unless the subscriber asked not to.
    //
    // Replay is right for SHARES: they are addressed, idempotent, and a miss
    // is unrecoverable while a duplicate is harmless. It is wrong for the
    // round-based aggregate messages, where a stale commitment from an
    // ABANDONED attempt at the same position is indistinguishable from a
    // current one and trips the session's own equivocation check. So the
    // choice belongs to the client -- the relay still understands nothing, it
    // just answers the question it was asked.
    const wantsHistory = url.searchParams.get('replay') !== '0';
    if (wantsHistory) {
      const past = history.get(table) ?? [];
      for (const frame of past) { try { res.write(frame); } catch {} }
      if (past.length) console.log(`  replayed ${past.length} frame(s) to the new listener`);
    } else {
      console.log('  live-only listener, no replay');
    }

    // Proxies and browsers drop an idle event stream; a comment line every 20s
    // keeps it open without meaning anything to the protocol.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 20_000);
    req.on('close', () => {
      clearInterval(beat);
      rooms.get(table)?.delete(res);
      console.log(`- listener left ${table} (${rooms.get(table)?.size ?? 0} left)`);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/publish') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      // A relay is a fine place to run out of memory if it trusts its input.
      if (body.length > 4_000_000) { req.destroy(); }
    });
    req.on('end', () => {
      let table;
      try { table = JSON.parse(body).tableId; } catch { res.writeHead(400); res.end('bad json'); return; }
      if (!table) { res.writeHead(400); res.end('tableId required'); return; }
      const listeners = rooms.get(table) ?? new Set();
      // Echoed verbatim. The relay does not parse, validate or reorder --
      // every check that matters happens at the recipient.
      const frame = `data: ${body.replace(/\n/g, '')}\n\n`;
      if (!history.has(table)) history.set(table, []);
      const past = history.get(table);
      past.push(frame);
      while (past.length > HISTORY_PER_TABLE) past.shift();
      let sent = 0;
      for (const l of listeners) { try { l.write(frame); sent++; } catch {} }
      console.log(`  relayed ${body.length}B on ${table} -> ${sent} listener(s)`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, listeners: sent }));
    });
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, tables: [...rooms.keys()].map((t) => ({ table: t, listeners: rooms.get(t).size })) }));
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`share relay on http://127.0.0.1:${PORT}`);
  console.log('  GET  /events?table=<id>   SSE stream');
  console.log('  POST /publish             {tableId, ...envelope}');
  console.log('\nIt understands none of what it carries. See the header for why that is safe.');
});
