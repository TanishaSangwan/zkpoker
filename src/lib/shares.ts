// Share exchange: the off-chain half of threshold decryption.
//
// Opening a card needs a decryption share from EVERY party (docs/PROTOCOL.md
// §8 -- n-of-n, and §8.2 settled that no threshold replaces it). Those shares
// travel off-chain, because putting them all on-chain would publish hole cards
// mid-hand. This module moves them and enforces the parts that are not
// optional.
//
// ── What this transport does NOT guarantee ──────────────────────────────
// Delivery. A party can simply not send, and no transport fixes that -- an
// n-of-n share can never be produced by anybody else. That is not a gap being
// papered over here, it is the case the ON-CHAIN accusation path exists to
// handle: accuse_share names the silent party, answer_accusation clears them
// by posting the share with a DLEQ against their own key, and
// claim_share_timeout convicts and forfeits their stake (§8.1). So the
// transport is allowed to be best-effort; the recourse is not.
//
// ── What it does guarantee ──────────────────────────────────────────────
// Confidentiality of hole-card shares, and the three-round discipline the
// aggregate DLEQ requires. Both are enforced here rather than left to callers,
// because both fail silently.

import { Point, add, fromWire, mul, mulG, randomScalar, toWire } from './grumpkin';
import { PartyContribution, challenge, commitNonce, respond } from './dleq';
import { poseidonSpan } from './felt';
import { limbs96 } from './felt';

// ─── transport ───────────────────────────────────────────────────────────

export type Envelope = {
  tableId: string;
  /** Deck position this is about. */
  position: number;
  /** Seat that sent it. */
  from: number;
  kind: 'nonce-commit' | 'nonce-reveal' | 'response' | 'share';
  /** Seat this is addressed to, or null for a broadcast (community cards). */
  to: number | null;
  /**
   * Which run of the multi-round aggregate this belongs to.
   *
   * Without it, two attempts at the same position -- a retry after a failure,
   * or a stale tab -- are indistinguishable from one party equivocating on its
   * nonce, and the session correctly (but wrongly) rejects the second as an
   * attack. Absent on `share` envelopes, which are not round-based.
   */
  session?: string;
  /**
   * True for messages that must NOT be replayed to later subscribers.
   *
   * The round-based aggregate messages are re-announced until their round
   * advances, which is how clients that join at different times find each
   * other. Left replayable, that flood evicts the SHARES out of a bounded
   * history -- and a share is the one thing that cannot be re-derived by a
   * recipient waiting for it. Set by the publisher, so the relay honours a
   * flag rather than having to understand what it carries.
   */
  ephemeral?: boolean;
  /** Plaintext for broadcasts; ECIES ciphertext when `to` is set. */
  body: unknown;
};

export interface Transport {
  publish(e: Envelope): void | Promise<void>;
  subscribe(handler: (e: Envelope) => void): () => void;
}

/**
 * Same-origin BroadcastChannel transport.
 *
 * Honest about its scope: this carries messages between TABS OF ONE BROWSER.
 * It is what makes a multi-seat table demonstrable on one machine, and it is
 * not a deployment. A real table needs a relay or WebRTC; the interface above
 * is the seam, and nothing else in this module knows the difference -- every
 * hole-card share is encrypted to the recipient's registered key before it is
 * handed over, so a relay that could read messages still could not read cards.
 */
export class BroadcastTransport implements Transport {
  private ch: BroadcastChannel;
  constructor(tableId: string) {
    this.ch = new BroadcastChannel(`zkpoker:${tableId}`);
  }
  publish(e: Envelope) {
    this.ch.postMessage(JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}n` : v)));
  }
  subscribe(handler: (e: Envelope) => void) {
    const onMsg = (ev: MessageEvent) => {
      handler(JSON.parse(ev.data, (_, v) =>
        typeof v === 'string' && /^0x[0-9a-f]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
      ));
    };
    this.ch.addEventListener('message', onMsg);
    return () => this.ch.removeEventListener('message', onMsg);
  }
  close() { this.ch.close(); }
}

// ─── encryption to a registered key ──────────────────────────────────────
//
// ECIES over Grumpkin, reusing the key each seat already registered on-chain.
// No extra key exchange, no extra trust: the recipient's public key was
// published with a Schnorr proof of knowledge, so encrypting to it reaches
// exactly the party that proved they hold the secret.

async function deriveKey(shared: Point): Promise<CryptoKey> {
  if (shared === null) throw new Error('shares: degenerate ECDH result');
  // Both coordinates, not just x: -S shares S's x and is a different point.
  const material = new Uint8Array([...limbs96(shared.x), ...limbs96(shared.y)].flatMap(toBytes12));
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const toBytes12 = (v: bigint): number[] => {
  const out: number[] = [];
  let x = v;
  for (let i = 11; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
};

export type Sealed = { eph: { x: bigint; y: bigint }; iv: string; ct: string };

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Encrypt to a seat's registered public key. */
export async function seal(recipientPk: Point, plaintext: unknown): Promise<Sealed> {
  const eph = randomScalar();
  const key = await deriveKey(mul(eph, recipientPk));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(
    JSON.stringify(plaintext, (_, v) => (typeof v === 'bigint' ? `0x${v.toString(16)}n` : v)),
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { eph: toWire(mulG(eph)), iv: b64(iv), ct: b64(ct) };
}

/** Decrypt with this seat's own secret. */
export async function unseal<T>(secret: bigint, sealed: Sealed): Promise<T> {
  const eph = fromWire(BigInt(sealed.eph.x), BigInt(sealed.eph.y));
  const key = await deriveKey(mul(secret, eph));
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(sealed.iv) },
    key,
    unb64(sealed.ct),
  );
  return JSON.parse(new TextDecoder().decode(pt), (_, v) =>
    typeof v === 'string' && /^0x[0-9a-f]+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as T;
}

// ─── the three-round aggregate ───────────────────────────────────────────

type Round = {
  commitments: Map<number, bigint>;
  nonces: Map<number, { r1: Point; r2: Point }>;
  responses: Map<number, bigint>;
};

/**
 * Drives one card's aggregate decryption across the parties.
 *
 * The rounds exist because the aggregate challenge e depends on
 * R1 = SUM(R1_i). Whoever reveals their nonce point last could otherwise grind
 * it against everyone else's and forge the aggregate -- the classic naive
 * multisignature break (Wagner; the original MuSig flaw). scripts/dleq_prove.py
 * models only the honest case and says so; this is where the discipline
 * actually lives.
 *
 *   1. everyone publishes Poseidon(R1_i, R2_i)
 *   2. once EVERY commitment is in, everyone reveals (R1_i, R2_i)
 *   3. e is computed from the sums; everyone publishes s_i
 *
 * `acceptReveal` refuses a reveal that arrives before the round is complete,
 * and refuses one that does not match its commitment. Both are the attack.
 */
export class AggregateSession {
  readonly expected: Set<number>;
  private round: Round = { commitments: new Map(), nonces: new Map(), responses: new Map() };

  constructor(
    readonly tableId: string,
    readonly position: number,
    /** The base point H = the ciphertext's c1 for this position. */
    readonly h: Point,
    /** Seat -> that seat's registered public key. */
    readonly keys: Map<number, Point>,
  ) {
    this.expected = new Set(keys.keys());
  }

  get phase(): 'committing' | 'revealing' | 'responding' | 'complete' {
    if (this.round.commitments.size < this.expected.size) return 'committing';
    if (this.round.nonces.size < this.expected.size) return 'revealing';
    if (this.round.responses.size < this.expected.size) return 'responding';
    return 'complete';
  }

  /** Seats that have not yet delivered whatever the current round needs. */
  get outstanding(): number[] {
    const have =
      this.phase === 'committing' ? this.round.commitments
      : this.phase === 'revealing' ? this.round.nonces
      : this.round.responses;
    return [...this.expected].filter((s) => !have.has(s)).sort((a, b) => a - b);
  }

  /** Whether this seat's contribution for a given round is already recorded. */
  has(seat: number, what: 'commitment' | 'reveal' | 'response'): boolean {
    if (what === 'commitment') return this.round.commitments.has(seat);
    if (what === 'reveal') return this.round.nonces.has(seat);
    return this.round.responses.has(seat);
  }

  acceptCommitment(seat: number, commitment: bigint) {
    this.require(seat);
    const prior = this.round.commitments.get(seat);
    // A byte-identical repeat is a duplicate delivery, not a protocol
    // violation -- transports retry and relays replay. Two DIFFERENT
    // commitments from one seat is equivocation and stays fatal.
    if (prior !== undefined) {
      if (prior !== commitment) {
        throw new Error(`shares: seat ${seat} sent two different nonce commitments`);
      }
      return;
    }
    if (this.phase !== 'committing') throw new Error('shares: commitment after the commit round closed');
    this.round.commitments.set(seat, commitment);
  }

  acceptReveal(seat: number, r1: Point, r2: Point) {
    this.require(seat);
    if (this.round.commitments.size < this.expected.size) {
      // The whole point of the commit round. A reveal accepted early lets the
      // last party choose their nonce after seeing everyone else's.
      throw new Error('shares: reveal before every nonce commitment is in');
    }
    const expected = this.round.commitments.get(seat);
    if (commitNonce(r1, r2).commitment !== expected) {
      throw new Error(`shares: seat ${seat}'s reveal does not match its commitment`);
    }
    this.round.nonces.set(seat, { r1, r2 });
  }

  /** The aggregate challenge. Only defined once every nonce is revealed. */
  aggregateChallenge(jointKey: Point, shares: Map<number, Point>): bigint {
    if (this.round.nonces.size < this.expected.size) {
      throw new Error('shares: challenge computed before every nonce was revealed');
    }
    const sum = (pts: Point[]) => pts.reduce<Point>((a, p) => add(a, p), null);
    const D = sum([...this.expected].map((s) => this.need(shares, s, 'share')));
    const R1 = sum([...this.round.nonces.values()].map((n) => n.r1));
    const R2 = sum([...this.round.nonces.values()].map((n) => n.r2));
    return challenge(jointKey, this.h, D, R1, R2);
  }

  acceptResponse(seat: number, s: bigint) {
    this.require(seat);
    this.round.responses.set(seat, s);
  }

  /** Assemble the contributions `dleq.aggregate` needs. */
  contributions(shares: Map<number, Point>): PartyContribution[] {
    if (this.phase !== 'complete') throw new Error(`shares: still ${this.phase}`);
    return [...this.expected].sort((a, b) => a - b).map((seat) => ({
      pk: this.need(this.keys, seat, 'key'),
      d: this.need(shares, seat, 'share'),
      r1: this.round.nonces.get(seat)!.r1,
      r2: this.round.nonces.get(seat)!.r2,
      s: this.round.responses.get(seat)!,
    }));
  }

  private require(seat: number) {
    if (!this.expected.has(seat)) throw new Error(`shares: seat ${seat} is not a party to this table`);
  }
  private need<T>(m: Map<number, T>, seat: number, what: string): T {
    const v = m.get(seat);
    if (v === undefined) throw new Error(`shares: missing ${what} for seat ${seat}`);
    return v;
  }
}

/** This party's own contribution to one position. */
export function myContribution(secret: bigint, h: Point) {
  const k = randomScalar();
  const r1 = mulG(k);
  const r2 = mul(k, h);
  return {
    /** d_i = x_i * c1 -- the decryption share itself. */
    d: mul(secret, h),
    r1,
    r2,
    commitment: commitNonce(r1, r2).commitment,
    /** Call only after the aggregate challenge is known. */
    respond: (e: bigint) => respond(secret, k, e),
  };
}

export { poseidonSpan };
