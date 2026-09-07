// `Transport` over an HTTP relay, so share exchange can cross processes.
//
// BroadcastTransport (src/lib/shares.ts) spans tabs of one browser, which
// demonstrates a table and cannot host a game between two people. This is the
// same interface over scripts/relay.mjs: SSE in, POST out.
//
// The relay is trusted with nothing. Hole-card shares are ECIES-encrypted to
// the recipient's registered key before they reach it, every share carries a
// DLEQ the recipient verifies against the sender's registered key, and a relay
// that simply drops messages is the liveness case the on-chain accusation path
// handles. See the header of scripts/relay.mjs.

import { shareRelayUrl } from '@/utils/constants';
import type { Envelope, Transport } from './shares';

/**
 * Connection state, reported so a caller can say so.
 *
 * A relay that is merely down must not look like a relay that is working:
 * the whole failure mode this transport exists to avoid is silent -- buttons
 * respond, messages go nowhere, and both players wait for shares that were
 * genuinely sent.
 */
export type RelayStatus = 'connecting' | 'open' | 'retrying';

const bigintReplacer = (_: string, v: unknown) =>
  typeof v === 'bigint' ? `0x${v.toString(16)}n` : v;
const bigintReviver = (_: string, v: unknown) =>
  typeof v === 'string' && /^0x[0-9a-f]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;

export class RelayTransport implements Transport {
  private handlers = new Set<(e: Envelope) => void>();
  private source: EventSource | null = null;
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private status: RelayStatus = 'connecting';

  /**
   * Envelopes already received, re-delivered to handlers that subscribe later.
   *
   * The relay replays its history ONCE, when a stream connects. Whatever
   * handler happens to be attached at that moment sees it -- and a handler
   * that only cares about one message kind drops the rest on the floor. A
   * later subscriber then waits forever for something that did arrive,
   * seconds before it started listening.
   *
   * That is exactly how this failed: an effect subscribed early to watch for
   * aggregate rounds, the relay replayed the shares to it, that handler
   * ignored them as the wrong kind, and the share-gathering subscription that
   * came later never saw them. From the outside it looked like the other
   * player had sent nothing.
   *
   * Bounded, and only kept when replay is enabled -- a live-only stream must
   * not resurrect round messages for the same reason the relay does not.
   */
  private received: Envelope[] = [];
  private static readonly RECEIVED_CAP = 400;

  /**
   * `replay: false` for a stream that must only carry what happens from now
   * on. The multi-round aggregate needs that: a replayed commitment from an
   * abandoned attempt at the same position arrives mid-round and is
   * indistinguishable from a party equivocating, which is a fatal error by
   * design. Share collection wants the opposite -- a missed share cannot be
   * recovered, a duplicate is harmless -- so it keeps replay on.
   */
  constructor(
    private readonly tableId: string,
    private readonly baseUrl: string,
    private readonly opts: { replay?: boolean; onStatus?: (s: RelayStatus) => void } = {},
  ) {}

  private get streamUrl() {
    const replay = this.opts.replay === false ? '&replay=0' : '';
    return `${this.baseUrl.replace(/\/$/, '')}/events?table=${encodeURIComponent(this.tableId)}${replay}`;
  }

  /** A relay frame, dispatched to every subscriber. */
  private dispatch(data: string) {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(data, bigintReviver) as Envelope;
    } catch {
      // A relay carries whatever it is given, including from a client that is
      // broken or hostile. A malformed frame is dropped, not thrown -- one bad
      // message must not take down a table's exchange.
      return;
    }
    if (envelope.tableId !== this.tableId) return;
    if (this.opts.replay !== false && !envelope.ephemeral) {
      this.received.push(envelope);
      while (this.received.length > RelayTransport.RECEIVED_CAP) this.received.shift();
    }
    for (const h of this.handlers) {
      try { h(envelope); } catch { /* a failing handler is that handler's problem */ }
    }
  }

  private setStatus(next: RelayStatus) {
    if (this.status === next) return;
    this.status = next;
    try { this.opts.onStatus?.(next); } catch { /* the caller's problem */ }
  }

  /** A stream that just came up: report it and forget the retry history. */
  private markOpen() {
    this.attempt = 0;
    this.setStatus('open');
  }

  /** Drop the current stream without ending the transport. */
  private teardownStream() {
    this.source?.close();
    this.source = null;
    this.abort?.abort();
    this.abort = null;
  }

  /**
   * Reconnect, backing off, until close().
   *
   * This is not defensive padding. The relay used to be assumed local, where
   * it either runs for the whole session or was never there; a drop was not a
   * case worth handling. It is a REMOTE service now -- a player's box, a free
   * tier that idles out, a tunnel whose hostname rotates -- so drops are
   * ordinary, and a dropped stream that stays dropped strands the table:
   * shares stop arriving, nobody can combine one, and the hand cannot finish.
   *
   * What it replaced was worse than nothing: the fetch branch rethrew out of
   * a `void`-called async method, so a drop surfaced as an unhandled
   * rejection and the stream stayed dead. The EventSource branch had no
   * `onerror` at all, so it went quiet.
   */
  private scheduleReconnect() {
    if (this.closed || this.retryTimer !== null) return;
    this.setStatus('retrying');
    this.teardownStream();
    // 0.5s doubling to a 10s ceiling, jittered so a table full of clients
    // that lost the same relay does not return in lockstep.
    const wait = Math.min(500 * 2 ** this.attempt, 10_000) + Math.floor(Math.random() * 250);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.closed) return;
      this.ensureStream();
    }, wait);
  }

  private ensureStream() {
    if (this.closed || this.source || this.abort) return;

    // EventSource in the browser; a streamed fetch elsewhere.
    //
    // It is not a browser-only class by accident of taste -- this transport
    // exists so a browser and a TERMINAL process can exchange shares, and
    // `EventSource` is not a global in every Node build. Without this branch
    // the relay works in one direction only, which is worse than not working:
    // the terminal side sends its shares and then waits forever for replies it
    // cannot receive.
    if (typeof EventSource !== 'undefined') {
      const es = new EventSource(this.streamUrl);
      this.source = es;
      es.onopen = () => this.markOpen();
      es.onmessage = (ev) => this.dispatch(ev.data);
      es.onerror = () => {
        // EventSource retries on its own while the connection is merely
        // interrupted (readyState CONNECTING) and gives up permanently once
        // it is CLOSED -- which is what a refused connection or a relay that
        // went away produces. Take over only in that second case, so the
        // native retry is not fought with a second one.
        if (es.readyState === 2 /* CLOSED */) this.scheduleReconnect();
        else this.setStatus('retrying');
      };
      return;
    }

    this.abort = new AbortController();
    void this.readStream(this.abort.signal);
  }

  /** Minimal SSE reader: `data:` lines, blank-line separated, comments ignored. */
  private async readStream(signal: AbortSignal) {
    try {
      const res = await fetch(this.streamUrl, { signal });
      if (!res.ok || !res.body) throw new Error(`relay stream failed (${res.status})`);
      this.markOpen();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Only complete frames are consumed; a partial line stays buffered,
        // or a message split across chunks would be silently truncated.
        let cut: number;
        while ((cut = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          if (line.startsWith('data: ')) this.dispatch(line.slice(6));
        }
      }
      // The loop ended without an error, so the relay closed the stream --
      // an idle timeout, a restart, a proxy cutting a long-lived connection.
      // Indistinguishable from a failure as far as the table is concerned:
      // no more shares arrive. Reconnect rather than return quietly.
      if (!signal.aborted) this.scheduleReconnect();
    } catch {
      // Never rethrow: this runs as a floating promise, so throwing here is
      // an unhandled rejection and the stream stays dead either way.
      if (!signal.aborted) this.scheduleReconnect();
    }
  }

  async publish(e: Envelope): Promise<void> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(e, bigintReplacer),
    });
    if (!res.ok) throw new Error(`relay refused the message (${res.status})`);
  }

  subscribe(handler: (e: Envelope) => void): () => void {
    this.ensureStream();
    this.handlers.add(handler);
    // Catch the new handler up on what already arrived -- but NOT synchronously.
    //
    // Callers routinely write `const stop = transport.subscribe(e => { ...
    // uses stop ... })`. Delivering during `subscribe` runs that handler
    // before `stop` is assigned, and every replayed envelope dies in the
    // temporal dead zone: "can't access lexical declaration 'stop' before
    // initialization". The catch-up then silently does nothing, which is
    // exactly the failure it was added to prevent.
    //
    // Deferring by a microtask lets `subscribe` return first, so the handler's
    // own closure is fully initialised before it is called.
    const backlog = [...this.received];
    queueMicrotask(() => {
      if (!this.handlers.has(handler)) return; // unsubscribed in the meantime
      for (const e of backlog) {
        try { handler(e); } catch { /* the handler's problem, not the stream's */ }
      }
    });
    return () => {
      this.handlers.delete(handler);
      // The stream deliberately stays open, even with no handlers left.
      //
      // Closing it on the last unsubscribe seems tidy and is wrong: callers
      // subscribe and unsubscribe around each step, and a React effect
      // re-subscribes whenever its dependencies change, so the connection
      // tore down and reopened constantly -- losing every message sent in the
      // gap. It presented as the other player never sending anything, with
      // the relay log showing a listener connecting and leaving over and
      // over. Only close() closes it.
    };
  }

  private stop() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardownStream();
  }

  /** Permanent: no reconnect is attempted after this. */
  close() {
    this.closed = true;
    this.stop();
    this.handlers.clear();
  }
}

/** Where a viewer-set relay override is kept. Per browser, per device. */
const RELAY_OVERRIDE_KEY = 'zkpoker.relayUrl';

/**
 * The transport this deployment should use.
 *
 * A relay URL means a real game between separate clients; without one, the
 * BroadcastChannel fallback still demonstrates a table across tabs of one
 * browser. Chosen here rather than at each call site so there is one answer.
 *
 * A viewer-set override wins over the build-time default, and that ordering
 * is the point rather than a convenience. `NEXT_PUBLIC_RELAY_URL` is inlined
 * at BUILD time, so without this the relay is frozen into the bundle: every
 * public deployment could only ever talk to whichever relay existed when it
 * was compiled, and standing up a new one -- or a tunnel, whose hostname
 * changes every session -- would mean rebuilding and redeploying the whole
 * app to change one string. Players on different devices need to agree on a
 * relay at run time, so it is set at run time.
 *
 * Storing it per browser is also the right scope: two people at one table
 * must point at the SAME relay, but nothing about that choice belongs to the
 * table, the chain, or anyone else's client.
 */
export function relayUrl(): string | null {
  const override = relayOverride();
  const chosen = override ?? shareRelayUrl;
  return chosen && chosen !== '0' ? chosen : null;
}

/** The viewer's own relay setting, or null if they have not set one. */
export function relayOverride(): string | null {
  try {
    const v = localStorage.getItem(RELAY_OVERRIDE_KEY);
    return v && v.trim() ? v.trim() : null;
  } catch {
    // Private mode, or storage blocked. The build-time default still applies.
    return null;
  }
}

/**
 * Point this browser at a relay. Pass null to go back to the built-in value.
 *
 * Returns the value stored, so a caller can show what actually took effect
 * rather than what it asked for.
 */
export function setRelayOverride(url: string | null): string | null {
  const v = url?.trim() ?? '';
  try {
    if (!v) localStorage.removeItem(RELAY_OVERRIDE_KEY);
    else localStorage.setItem(RELAY_OVERRIDE_KEY, v);
  } catch {
    // Storage blocked: the setting lasts for this page only, which is still
    // better than refusing to accept it.
  }
  return v || null;
}
