'use client';

// The table: seats around a felt, community cards in the middle.
//
// Purely presentational -- it renders TableState and nothing else. Every
// judgement about what a player may do lives in PhasePanel; this only shows
// what is true.

import styles from '../poker.module.css';
import { cardToGlyph } from '@/lib/grumpkin';
import type { SeatState, TableState } from '../useTableState';
import { STREET_NAMES, baseToStrk , fmtAmount } from '../contract';

function Card({ card }: { card: number }) {
  const { rank, suit, red } = cardToGlyph(card);
  return (
    <div className={styles.cardFace} style={red ? { color: '#c0392b' } : undefined} title={`${rank}${suit}`}>
      {rank}
      {suit}
    </div>
  );
}

/** Seat positions around an ellipse, seat 0 at the bottom (the player's side). */
function seatStyle(index: number, total: number): React.CSSProperties {
  const angle = Math.PI / 2 + (2 * Math.PI * index) / Math.max(total, 1);
  return {
    left: `${50 + 42 * Math.cos(angle)}%`,
    top: `${50 + 40 * Math.sin(angle)}%`,
  };
}

function Seat({
  seat, total, you, onTurn, dealer, button, blind, known,
}: {
  seat: SeatState; total: number; you: boolean; onTurn: boolean; dealer: boolean;
  /** Holds the dealer button -- who posts which blind is measured from here. */
  button: boolean;
  /** This seat's forced bet this hand, if any. */
  blind: 'SB' | 'BB' | null;
  /** Cards this client knows locally for THIS seat -- only ever its own. */
  known?: (number | null)[];
}) {
  const cls = [
    styles.seat,
    !seat.occupied ? styles.seatEmpty : '',
    you ? styles.seatYou : '',
    seat.occupied && seat.folded ? styles.seatFolded : '',
    onTurn ? styles.seatTurn : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} style={seatStyle(seat.seat, total)}>
      {!seat.occupied ? (
        <>seat {seat.seat}<br />empty</>
      ) : (
        <>
          <div className={styles.seatAddr}>{you ? 'you' : `${seat.owner.slice(0, 6)}…${seat.owner.slice(-4)}`}</div>
          <div className={styles.seatChips}>{fmtAmount(seat.contributed)}</div>
          {/* Winnings are NOT in the pot and not in `contributed`. award()
              moves the pot into pending_payout keyed by the seat's payout
              note and zeroes the pot, so between hands a winner's money is
              real, on-chain, and was previously invisible everywhere on this
              page -- the pot cleared and nothing said where it went. */}
          {seat.pendingPayout > 0n ? (
            <div className={styles.seatWon} title="won and banked to this seat's payout note, not yet withdrawn">
              won {fmtAmount(seat.pendingPayout)}
            </div>
          ) : null}
          <div className={styles.seatBadges}>
            {/* Two different things that both used to be "D". The creator
                runs begin_shuffle; the button decides the blinds and moves
                every hand. Conflating them made the blinds look arbitrary. */}
            {dealer ? <span className={styles.seatBadge} style={{ background: '#7a5cff' }} title="created the table">host</span> : null}
            {button ? <span className={styles.seatBadge} style={{ background: '#fff', color: '#222' }} title="dealer button">BTN</span> : null}
            {blind ? <span className={styles.seatBadge} style={{ background: '#2d8a4e' }} title={blind === 'SB' ? 'small blind' : 'big blind'}>{blind}</span> : null}
            {seat.folded ? <span className={styles.seatBadge} style={{ background: '#8a8a8a' }}>folded</span> : null}
            {seat.forfeited ? <span className={styles.seatBadge} style={{ background: '#8a8a8a' }} title="did not show before the showdown clock ran out">forfeit</span> : null}
            {!seat.keyRegistered ? <span className={styles.seatBadge} style={{ background: '#c0392b' }}>no key</span> : null}
            {onTurn && !seat.folded ? <span className={styles.seatBadge} style={{ background: '#f5c542', color: '#222' }}>turn</span> : null}
          </div>
          {/* Hole cards.
              Face-up in two cases and no others: the card has been REVEALED
              on-chain, so everyone can see it, or it is THIS client's own seat
              and it worked the card out locally. `known` is only ever passed
              for the viewer's own seat -- a client cannot compute anyone
              else's, since that needs a share it never receives. */}
          <div className={styles.feltCards} style={{ marginTop: 4 }}>
            {[0, 1].map((slot) => {
              const revealed = seat.holeRevealed[slot];
              const mine = you ? known?.[slot] : null;
              if (revealed) return <Card key={slot} card={seat.holeCards[slot]} />;
              if (mine != null) {
                return (
                  <div key={slot} title="known only to you -- not yet shown on-chain">
                    <Card card={mine} />
                  </div>
                );
              }
              return (
                <div
                  key={slot}
                  className={styles.cardBack}
                  style={seat.holeCommitted[slot] ? undefined : { opacity: 0.25 }}
                  title={seat.holeCommitted[slot] ? 'shares committed, not revealed' : 'no shares committed yet'}
                />
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

export default function Felt({
  table, yourSeat, yourCards,
}: {
  table: TableState; yourSeat: number | null;
  /** The viewer's own hole cards, recovered locally. Never anyone else's. */
  yourCards?: (number | null)[];
}) {
  const dealerSeat = table.seats.find((s) => s.owner.toLowerCase() === table.dealer.toLowerCase())?.seat ?? -1;

  // Who posts what, computed the same way the contract does: the seat left of
  // the button posts the small blind and the next one the big -- except
  // heads-up, where the button IS the small blind. Rendered rather than read
  // back because the contract stores contributions, not roles.
  const nextOccupied = (from: number) => {
    for (let step = 1; step <= table.maxSeats; step++) {
      const cand = (from + step) % table.maxSeats;
      if (table.seats[cand]?.occupied) return cand;
    }
    return from;
  };
  let smallSeat = -1, bigSeat = -1;
  if (table.buttonSet && table.bigBlind > 0n) {
    const next = nextOccupied(table.button);
    if (table.seated.length <= 2) { smallSeat = table.button; bigSeat = next; }
    else { smallSeat = next; bigSeat = nextOccupied(next); }
  }

  return (
    <div className={styles.felt}>
      <div className={styles.feltCenter}>
        <div className={styles.feltPot}>pot {fmtAmount(table.pot)}</div>
        <div className={styles.feltStreet}>
          {table.voided ? 'voided'
            : table.settled ? 'settled'
            : STREET_NAMES[table.street] ?? `street ${table.street}`}
        </div>
        {table.bigBlind > 0n ? (
          <div className={styles.feltSub}>
            blinds {fmtAmount(table.smallBlind)}/{fmtAmount(table.bigBlind)}
            {table.blindLevelHands > 0 ? ` · level ${table.blindLevel + 1}` : ''}
            {table.handNumber > 0 ? ` · hand ${table.handNumber + 1}` : ''}
          </div>
        ) : null}
        <div className={styles.feltCards}>
          {table.community.map((c, i) =>
            c.revealed ? <Card key={i} card={c.card} /> : <div key={i} className={styles.cardBack} />,
          )}
        </div>
      </div>

      {table.seats.map((s) => (
        <Seat
          key={s.seat}
          seat={s}
          total={table.maxSeats}
          you={yourSeat === s.seat}
          onTurn={!table.roundComplete && table.actionTurn === s.seat && table.phase === 'betting'}
          dealer={s.seat === dealerSeat}
          button={table.buttonSet && s.seat === table.button}
          blind={s.seat === smallSeat ? 'SB' : s.seat === bigSeat ? 'BB' : null}
          known={yourSeat === s.seat ? yourCards : undefined}
        />
      ))}
    </div>
  );
}
