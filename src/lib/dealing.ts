// Share exchange, and when the aggregate may safely be built.
//
// ── The constraint that shapes this file ────────────────────────────────
//
// `reveal_hole_card` takes ONE share and ONE proof, checked against the
// table's JOINT key. So a hole reveal needs an aggregate DLEQ, and an
// aggregate DLEQ needs a challenge over D = Σ d_i that every co-signer must
// know in order to produce its s_i.
//
// But `open_deck` publishes every in-play ciphertext BEFORE dealing, hole
// positions included. So c2 is on-chain, and anyone who learns D for seat S's
// hole position computes c2 − D and reads S's card. Handing D to the
// co-signers at dealing time would therefore hand them the hole cards — a
// complete break of the one property this protocol exists to provide.
//
// Three ways out, and only one is taken here:
//
//   1. Reveal D at dealing time so everyone can compute the challenge.
//      Rejected: it IS the break described above.
//   2. Have S send only the challenge `e`, keeping D secret. This is blind
//      Schnorr signing: the co-signers sign a value they cannot check.
//      Rejected. It is not obviously broken for one signature, but a party
//      that will blind-sign under a long-term key across many concurrent
//      sessions is exactly the ROS setting (Benhamouda et al.), and a forgery
//      here means claiming a different card at showdown — stealing pots. Not
//      a risk to take silently for a convenience.
//   3. Build the aggregate at SHOWDOWN, when the card is being revealed
//      anyway and D is no longer secret. Taken.
//
// The cost of (3) is honest and worth stating: it diverges from
// docs/PROTOCOL.md §4 phase 4's "no new proof is generated here", and it makes
// a showdown depend on the other parties still being reachable. A player who
// cannot assemble the aggregate cannot show, and mucking forfeits. §9.5
// records this.
//
// Community cards are unaffected: their shares are public by design, so the
// aggregate is built as soon as the shares are in.

import { Point, add, mul, mulG, randomScalar } from './grumpkin';
import * as dleq from './dleq';
import { AggregateSession, Envelope, Transport, myContribution, seal, unseal } from './shares';
import { combineShares } from './reveal';

export type PartyKey = { seat: number; pk: Point };

export type ShareMessage = {
  /** d_i = x_i * H, this party's decryption share for the position. */
  d: { x: bigint; y: bigint };
  /** The individual DLEQ proving d_i used the same secret as pk_i. */
  s: bigint;
  e: bigint;
};

/** This party's share for one position, with the proof that binds it. */
export function shareFor(secret: bigint, h: Point): ShareMessage {
  // Synchronous on purpose (a share is pure arithmetic plus a hint), so the
  // caller must have awaited initProver() first. `runAggregate` and the UI's
  // action wrapper both do.
  const proof = dleq.prove(secret, h);
  if (proof.d === null) throw new Error('dealing: degenerate share');
  return { d: { x: proof.d.x, y: proof.d.y }, s: proof.s, e: proof.e };
}

/**
 * Check a share that arrived from another party.
 *
 * Never skip this. A share is what determines a card, so an unverified one is
 * a card someone else chose — and for a hole card the recipient is the only
 * party who can catch it, because nobody else ever sees these shares.
 */
export function acceptShare(args: {
  from: PartyKey;
  h: Point;
  msg: ShareMessage;
}): Point {
  const d: Point = { x: args.msg.d.x, y: args.msg.d.y };
  const ok = dleq.verify({ pk: args.from.pk, h: args.h, d, s: args.msg.s, e: args.msg.e });
  if (!ok) {
    throw new Error(
      `dealing: seat ${args.from.seat} sent a share that does not verify against its registered ` +
        `key. Do not use it — accuse the seat instead.`,
    );
  }
  return d;
}

// ─── the three-round aggregate ──────────────────────────────────────────

export type AggregateResult = { share: Point; proof: dleq.DleqProof };

/**
 * Run commit → reveal → respond across the parties for one position.
 *
 * `shares` must already be verified individually. `jointKey` is the table's,
 * read from the contract rather than summed locally, so the aggregate is built
 * against the same key the contract will check it against.
 *
 * The rounds are not ceremony. The challenge depends on R1 = Σ R1_i, so a party
 * revealing its nonce point last could otherwise grind it against everyone
 * else's — the classic naive-multisignature break. `AggregateSession` refuses a
 * reveal that arrives before every commitment is in.
 */
export async function runAggregate(args: {
  transport: Transport;
  tableId: string;
  position: number;
  h: Point;
  jointKey: Point;
  keys: Map<number, Point>;
  shares: Map<number, Point>;
  mySeat: number;
  mySecret: bigint;
  timeoutMs?: number;
  /** How long a non-proposer waits for the proposer before starting itself. */
  proposerGraceMs?: number;
  onProgress?: (phase: string, outstanding: number[]) => void;
}): Promise<AggregateResult> {
  const { transport, tableId, position, h, jointKey, keys, shares, mySeat, mySecret } = args;
  const say = args.onProgress ?? (() => {});
  // Idempotent, and cheap after the first call. Here as well as at the UI
  // layer because this is a library entry point -- a caller that is not the
  // panel should not have to know that garaga needs waking up first.
  await dleq.initProver();
  const state = new AggregateSession(tableId, position, h, keys);

  const mine = myContribution(mySecret, h);

  // ── Which run of the protocol is this? ────────────────────────────────
  //
  // The equivocation check -- two different nonce commitments from one seat is
  // an attack -- cannot tell a second ATTEMPT from a second COMMITMENT unless
  // runs are named. So they are, and the lowest-numbered seat names them:
  // it proposes a fresh id, everyone else adopts the id they see from it.
  // Deterministic, so there is no tie to break and no round trip to agree.
  //
  // Anything from another run is ignored rather than rejected -- a stale tab
  // is not a cheat.
  const proposer = Math.min(...keys.keys());
  let session: string | null = null;
  if (mySeat === proposer) {
    session = [...crypto.getRandomValues(new Uint8Array(8))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Round traffic is ephemeral: it is re-announced until the round advances,
  // so replaying it to later subscribers is both useless and harmful (see
  // Envelope.ephemeral).
  const send = (kind: Envelope['kind'], body: unknown) =>
    transport.publish({
      tableId, position, from: mySeat, kind, to: null, body,
      // '' means "this run is unsessioned" -- carried as absent on the wire.
      session: session ? session : undefined,
      ephemeral: true,
    });

  // Reveals that arrived before this client had every commitment.
  //
  // Holding them is not politeness, it is the commit round's security
  // property: a reveal accepted early lets the last party choose its nonce
  // after seeing everyone else's, which is the classic naive-multisignature
  // break. AggregateSession refuses such a reveal by throwing -- correct as a
  // rule, fatal as a reaction, because in runAggregate that throw rejects the
  // whole run.
  //
  // And arriving early is NORMAL, not an attack: a client that joins a
  // position seconds late -- a reload, a slow share gather -- meets parties
  // who are already past committing. So the reveal is parked and replayed the
  // moment the commit round closes. The property is kept (nothing is accepted
  // early) and the run survives. A reveal that then fails to match its
  // commitment is still fatal, which is the case that actually is an attack.
  const parked = new Map<number, { r1: Point; r2: Point }>();

  const done = new Promise<AggregateResult>((resolve, reject) => {
    const stop = transport.subscribe((e) => {
      if (e.tableId !== tableId || e.position !== position || e.from === mySeat) return;
      // A seat that is not a party to this table is NOISE, not a cheat.
      //
      // AggregateSession.require() throws on an unknown seat, which is right
      // for a local API misuse and catastrophic for a network message: the
      // throw lands in the catch below, which rejects the whole run. The
      // caller retries, the stray arrives again, and the position never
      // resolves -- an infinite loop that looks exactly like a stalled table.
      //
      // Worse than a bug: the transport is a dumb relay that anyone can post
      // to, so before this filter ANY outsider could stall every reveal at
      // every table by publishing one envelope with a seat number nobody
      // holds. No stake, no key, no cost. Found by a leftover tab from an
      // older four-seat table publishing as seat 3 into a three-seat one --
      // the channel is named by table id, so two tables that share a name
      // share a channel.
      //
      // Filtered here rather than made non-fatal in the session, because
      // equivocation BY A PARTY -- two different nonce commitments from one
      // seat -- must stay fatal. That is the commit round's entire purpose.
      if (!keys.has(e.from)) return;
      try {
        // Adopt the proposer's run; ignore every other.
        //
        // An UNSESSIONED message from the proposer is accepted and adopted as
        // an unsessioned run (session = ''). Requiring a session id here
        // deadlocked the table in silence against any client that does not
        // send one -- an older build, or a different implementation -- because
        // the message was ignored forever and nothing ever reported why. A
        // missing id costs the stale-run filtering; it must not cost the
        // protocol.
        if (session === null) {
          if (e.from !== proposer) return;
          session = e.session ?? '';
          // Only now can this seat commit: until the proposer speaks there is
          // no run to join.
          session_started();
        }
        if (session && e.session && e.session !== session) return;
        const body = e.body as any;
        if (e.kind === 'nonce-commit') state.acceptCommitment(e.from, BigInt(body.commitment));
        else if (e.kind === 'nonce-reveal') parked.set(e.from, { r1: pt(body.r1), r2: pt(body.r2) });
        else if (e.kind === 'response') state.acceptResponse(e.from, BigInt(body.s));
        else return;

        // Whatever is now admissible, in order. Throws only on a reveal that
        // genuinely does not open its commitment.
        if (state.phase !== 'committing') {
          for (const [seat, r] of [...parked]) {
            parked.delete(seat);
            if (!state.has(seat, 'reveal')) state.acceptReveal(seat, r.r1, r.r2);
          }
        }

        say(state.phase, state.outstanding);

        // Advance as soon as the previous round completes. Each of these is
        // idempotent from the receiver's side -- a duplicate send is dropped
        // by the session's own checks.
        advanceMe();

        if (state.phase === 'complete') {
          stop();
          clearTimeout(timer);
          clearAnnounce();
          const proof = dleq.aggregate(state.contributions(shares), h);
          resolve({ share: combineShares([...shares.values()]), proof });
        }
      } catch (err) {
        stop();
        clearTimeout(timer);
        clearAnnounce();
        reject(err);
      }
    });

    const timer = setTimeout(() => {
      stop();
      clearAnnounce();
      reject(
        new Error(
          `dealing: timed out waiting on seat(s) ${state.outstanding.join(', ')} during the ` +
            `${state.phase} round for position ${position}. Accuse them on-chain rather than ` +
            `waiting — a share nobody can produce ends the hand either way.`,
        ),
      );
    }, args.timeoutMs ?? 120_000);

    // Round 1, once there is a run to attach it to. The proposer starts
    // immediately; everyone else starts on hearing from it.
    /**
     * Do whatever this seat owes for the round it is now in -- and RECORD IT
     * LOCALLY as well as sending it.
     *
     * Recording is the part that is easy to miss and fatal to omit: an earlier
     * version sent its own nonce reveal but never told its own session about
     * it, so `outstanding` listed this very seat forever and the round could
     * not complete no matter what anyone else did. The symptom was a timeout
     * naming yourself.
     */
    function advanceMe() {
      if (state.phase === 'revealing' && !state.has(mySeat, 'reveal')) {
        state.acceptReveal(mySeat, mine.r1, mine.r2);
        send('nonce-reveal', { r1: wire(mine.r1), r2: wire(mine.r2) });
      }
      if (state.phase === 'responding' && !state.has(mySeat, 'response')) {
        const e2 = state.aggregateChallenge(jointKey, shares);
        const s2 = mine.respond(e2);
        state.acceptResponse(mySeat, s2);
        send('response', { s: s2.toString() });
      }
    }

    function session_started() {
      state.acceptCommitment(mySeat, mine.commitment);
      send('nonce-commit', { commitment: mine.commitment.toString() });
      advanceMe();
    }
    if (mySeat === proposer) session_started();

    // If the proposer never speaks, start anyway rather than waiting out the
    // full timeout in silence.
    //
    // A non-proposer that only ever reacts is hostage to one specific seat
    // being present and running compatible code. After a short grace period
    // this seat opens an unsessioned run itself; the proposer, if it appears,
    // adopts nothing but its own and the duplicate-commitment rule keeps the
    // two from being mistaken for equivocation.
    const graceMs = Number(args.proposerGraceMs ?? 8000);
    const grace = setTimeout(() => {
      if (session === null && state.phase === 'committing') {
        session = '';
        session_started();
      }
    }, graceMs);

    // Re-announce whatever this seat owes for the CURRENT round, until the
    // round moves on.
    //
    // Clients do not join at the same instant. A person clicks a button
    // seconds after the other side started, and the aggregate rounds
    // deliberately run on a live-only stream (a replayed commitment from an
    // abandoned run is indistinguishable from equivocation), so a message
    // sent before the other party was listening is simply gone -- and both
    // sides then wait forever for something that was genuinely sent. That is
    // the same silent, symmetric deadlock twice over, so it is fixed
    // generally rather than by asking humans to click in step.
    //
    // Safe to repeat: a byte-identical commitment is treated as a duplicate
    // delivery rather than equivocation, and reveals and responses are
    // deterministic for a given round.
    const announce = setInterval(() => {
      if (state.phase === 'complete') return;
      if (mySeat !== proposer && session === null) return; // nothing to say yet
      // The commitment goes out on EVERY tick, not only while this seat is
      // still in the commit round.
      //
      // Re-announcing just the current round deadlocked any table where the
      // clients did not join together. Two seats reach the reveal round and
      // stop repeating their commitments; a third joins a moment later, hears
      // only reveals, and can never close its own commit round -- so it never
      // reveals, and the first two wait on it forever. All three are then
      // waiting, which is precisely what it looked like from the table.
      //
      // Safe to repeat, and repeating is the point: a byte-identical
      // commitment is a duplicate delivery, not equivocation.
      send('nonce-commit', { commitment: mine.commitment.toString() });
      advanceMe();
    }, 2000);
    const clearAnnounce = () => { clearInterval(announce); clearTimeout(grace); };
  });

  return done;
}

const wire = (p: Point) => (p === null ? { x: '0', y: '0' } : { x: p.x.toString(), y: p.y.toString() });
const pt = (o: any): Point => (BigInt(o.x) === 0n && BigInt(o.y) === 0n ? null : { x: BigInt(o.x), y: BigInt(o.y) });

// ─── delivering a hole share privately ──────────────────────────────────

/**
 * Send this party's share for seat `to`'s hole position, encrypted to that
 * seat's registered key.
 *
 * Encrypted rather than merely addressed: the transport is best-effort and
 * possibly relayed, and a relay that could read this could read hole cards.
 * The recipient's key was published with a Schnorr proof of knowledge, so
 * encrypting to it reaches exactly the party that proved it holds the secret.
 */
export async function sendHoleShare(args: {
  transport: Transport;
  tableId: string;
  position: number;
  from: number;
  to: number;
  recipientPk: Point;
  msg: ShareMessage;
}): Promise<void> {
  const body = await seal(args.recipientPk, {
    d: { x: args.msg.d.x.toString(), y: args.msg.d.y.toString() },
    s: args.msg.s.toString(),
    e: args.msg.e.toString(),
  });
  await args.transport.publish({
    tableId: args.tableId,
    position: args.position,
    from: args.from,
    kind: 'share',
    to: args.to,
    body,
  });
}

export async function openHoleShare(secret: bigint, body: unknown): Promise<ShareMessage> {
  const raw = await unseal<any>(secret, body as any);
  return { d: { x: BigInt(raw.d.x), y: BigInt(raw.d.y) }, s: BigInt(raw.s), e: BigInt(raw.e) };
}

export { combineShares, myContribution, randomScalar, add, mul, mulG };
