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

const bigintReplacer = (_: string, v: unknown) =>
  typeof v === 'bigint' ? `0x${v.toString(16)}n` : v;
const bigintReviver = (_: string, v: unknown) =>
  typeof v === 'string' && /^0x[0-9a-f]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v;

export class RelayTransport implements Transport {
  private handlers = new Set<(e: Envelope) => void>();
  private source: EventSource | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly tableId: string,
    private readonly baseUrl: string,
  ) {}

  private get streamUrl() {
    return `${this.baseUrl.replace(/\/$/, '')}/events?table=${encodeURIComponent(this.tableId)}`;
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
    for (const h of this.handlers) {
      try { h(envelope); } catch { /* a failing handler is that handler's problem */ }
    }
  }

  private ensureStream() {
    if (this.source || this.abort) return;

    // EventSource in the browser; a streamed fetch elsewhere.
    //
    // It is not a browser-only class by accident of taste -- this transport
    // exists so a browser and a TERMINAL process can exchange shares, and
    // `EventSource` is not a global in every Node build. Without this branch
    // the relay works in one direction only, which is worse than not working:
    // the terminal side sends its shares and then waits forever for replies it
    // cannot receive.
    if (typeof EventSource !== 'undefined') {
      this.source = new EventSource(this.streamUrl);
      this.source.onmessage = (ev) => this.dispatch(ev.data);
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
    } catch (e) {
      if (!signal.aborted) throw e;
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
    return () => {
      this.handlers.delete(handler);
      // Keep the stream open while anyone is still listening: reopening an
      // SSE connection per subscriber would lose messages in the gap.
      if (this.handlers.size === 0) { this.stop(); }
    };
  }

  private stop() {
    this.source?.close();
    this.source = null;
    this.abort?.abort();
    this.abort = null;
  }

  close() { this.stop(); this.handlers.clear(); }
}

/**
 * The transport this deployment should use.
 *
 * A relay URL means a real game between separate clients; without one, the
 * BroadcastChannel fallback still demonstrates a table across tabs of one
 * browser. Chosen here rather than at each call site so there is one answer.
 */
export function relayUrl(): string | null {
  return shareRelayUrl && shareRelayUrl !== '0' ? shareRelayUrl : null;
}
