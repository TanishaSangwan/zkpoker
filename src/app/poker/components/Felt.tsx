'use client';

// The table: seats around a felt, community cards in the middle.
//
// Purely presentational -- it renders TableState and nothing else. Every
// judgement about what a player may do lives in PhasePanel; this only shows
// what is true.

import styles from '../poker.module.css';
import { cardToGlyph } from '@/lib/grumpkin';
import type { SeatState, TableState } from '../useTableState';
import { STREET_NAMES } from '../contract';

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
  seat, total, you, onTurn, dealer, known,
}: {
  seat: SeatState; total: number; you: boolean; onTurn: boolean; dealer: boolean;
  /** Cards this client knows locally for THIS seat -- only ever its own. */
  known?: (number | null)[];
}) {
  const cls = [
    styles.seat,
    !seat.occupied ? styles.seatEmpty : '',
    you ? styles.seatYou : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cls} style={{ ...seatStyle(seat.seat, total), ...(onTurn ? { boxShadow: '0 0 0 2px #f5c542' } : {}) }}>
      {!seat.occupied ? (
        <>seat {seat.seat}<br />empty</>
      ) : (
        <>
          <div className={styles.seatAddr}>{you ? 'you' : `${seat.owner.slice(0, 6)}…${seat.owner.slice(-4)}`}</div>
          <div className={styles.seatChips}>{seat.contributed.toString()}</div>
          <div className={styles.seatBadges}>
            {dealer ? <span className={styles.seatBadge} style={{ background: '#7a5cff' }}>D</span> : null}
            {seat.folded ? <span className={styles.seatBadge} style={{ background: '#8a8a8a' }}>folded</span> : null}
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

  return (
    <div className={styles.felt}>
      <div className={styles.feltCenter}>
        <div className={styles.feltPot}>pot {table.pot.toString()}</div>
        <div className={styles.feltStreet}>
          {table.voided ? 'voided' : table.settled ? 'settled' : STREET_NAMES[table.street] ?? `street ${table.street}`}
        </div>
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
          known={yourSeat === s.seat ? yourCards : undefined}
        />
      ))}
    </div>
  );
}
