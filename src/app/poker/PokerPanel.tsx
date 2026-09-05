'use client';

// The zkpoker table client.
//
// Replaces the V1 panel, which drove commit_deal / reveal_seed and a
// seed-based Fisher-Yates shuffle. That contract path still exists in
// lib.cairo but PROTOCOL.md §10 lists it under "to be deleted"; nothing here
// touches it, and src/app/poker/fairness.ts (the seed replayer) is gone with
// it. The fairness story is no longer "check the dealer's seed" -- it is
// "every seat shuffled and proved it".

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import styles from './poker.module.css';
import uni from '../uni.module.css';
import * as constants from '@/utils/constants';
import { useStoreWallet } from '../components/Wallet/walletContext';
import { useFrontendProvider } from '../components/client/provider/providerContext';
import SelectWallet from '../components/client/WalletHandle/SelectWallet';
import { useTableState } from './useTableState';
import { asU256, decodeError, erc20ApproveCall, executeAndWait, pgCall, shortHex, toFelt } from './contract';
import Felt from './components/Felt';
import PhasePanel from './components/PhasePanel';
import { loadOrCreateSeatKey, seatKeyIsPersisted, type SeatIdentity } from '@/lib/identity';
import type { Ciphertext } from '@/lib/deck';
import { useProvingEnvironment } from './useProvingEnvironment';

export default function PokerPanel() {
  const account = useStoreWallet((s) => s.account);
  const address = useStoreWallet((s) => s.address);
  const providerIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const provider = constants.myFrontendProviders[providerIndex];
  const contract = constants.pokerGameAddressForIndex(providerIndex);
  const deployed = !!contract && BigInt(contract) !== 0n;

  const [tableIdInput, setTableIdInput] = useState('TABLE_1');
  const [tableId, setTableId] = useState<string | null>(null);
  const [identity, setIdentity] = useState<SeatIdentity | null>(null);
  const [deck, setDeck] = useState<Ciphertext[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { state: table, refresh, loading, error: readError } = useTableState({
    address: contract, provider, tableId,
  });

  const yourSeat = useMemo(() => {
    if (!table || !address) return null;
    const s = table.seats.find((x) => x.occupied && BigInt(x.owner) === BigInt(address));
    return s ? s.seat : null;
  }, [table, address]);

  // The seat key is per (chain, contract, table, address) and must survive a
  // reload -- see src/lib/identity.ts. Losing it mid-hand means being unable to
  // answer an accusation, which costs the stake.
  useEffect(() => {
    if (!tableId || !address || !deployed) { setIdentity(null); return; }
    try {
      setIdentity(loadOrCreateSeatKey({
        chainId: String(providerIndex), contract, tableId, address,
      }));
    } catch (e) {
      setError(decodeError(e));
    }
  }, [tableId, address, contract, providerIndex, deployed]);

  const persisted = tableId && address && deployed
    ? seatKeyIsPersisted({ chainId: String(providerIndex), contract, tableId, address })
    : true;

  const { env, ready: envReady } = useProvingEnvironment();

  return (
    <div className={styles.wrap}>
      {!deployed ? (
        <div className={styles.banner}>
          <strong>PokerGame is not deployed on {constants.NetworkLabels[providerIndex] ?? `provider ${providerIndex}`}.</strong>{' '}
          Set <code className={styles.bannerCode}>NEXT_PUBLIC_POKERGAME_{(constants.NetworkLabels[providerIndex] ?? 'DEVNET')}</code>{' '}
          in <code className={styles.bannerCode}>.env.local</code> and reload. Nothing below will work until then.
        </div>
      ) : null}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>Table</div>
          <div className={styles.sectionHint}>
            {contract === '0x0' ? 'no contract' : shortHex(contract)} · {constants.NetworkLabels[providerIndex] ?? providerIndex}
            {' · '}
            {!envReady
              ? 'checking proving environment…'
              : env.multithreaded
                ? `proving on ${env.threads} threads`
                : 'single-threaded proving (no cross-origin isolation)'}
          </div>
        </div>
        <div className={styles.tableIdRow}>
          <input className={styles.input} value={tableIdInput}
            onChange={(e) => setTableIdInput(e.target.value)} placeholder="table id" />
          <button className={uni.btn} disabled={!deployed}
            onClick={() => { try { setTableId(toFelt(tableIdInput)); setError(null); } catch (e) { setError(decodeError(e)); } }}>
            Open
          </button>
          <button className={uni.btn} disabled={!tableId || loading} onClick={() => refresh()}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        {!persisted ? (
          <div className={styles.caution}>
            This browser could not store your seat key (private mode, or storage is blocked).
            It exists only in this tab: <strong>a reload loses it</strong>, and a lost key means you
            cannot produce your decryption shares — which under the accusation path forfeits your
            stake. Do not stake money from this tab.
          </div>
        ) : null}
      </div>

      {readError ? <div className={styles.caution}>Read failed: {readError}</div> : null}
      {error ? <div className={styles.caution}>{error}</div> : null}

      {table && table.exists ? (
        <>
          <Felt table={table} yourSeat={yourSeat} />
          <SeatControls
            table={table} yourSeat={yourSeat} contract={contract}
            account={account} provider={provider} refresh={refresh}
          />
          <PhasePanel
            table={table} yourSeat={yourSeat} identity={identity}
            account={account} provider={provider} contract={contract}
            deck={deck} setDeck={setDeck} refresh={refresh}
          />
          <YourHand table={table} yourSeat={yourSeat} />
        </>
      ) : table && !table.exists ? (
        <CreateTable
          tableId={table.tableId} contract={contract} account={account}
          provider={provider} providerIndex={providerIndex} refresh={refresh}
        />
      ) : (
        <p className={styles.fieldHint}>Enter a table id and press Open.</p>
      )}
    </div>
  );
}

// ─── seat / buy-in ───────────────────────────────────────────────────────

function SeatControls(p: any) {
  const { table, yourSeat, contract, account, provider, refresh } = p;
  const [seat, setSeat] = useState('0');
  const [noteId, setNoteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (yourSeat !== null || table.shuffleStarted) return null;

  const join = async () => {
    setBusy(true); setErr(null);
    try {
      // join_table escrows the buy-in, so the token must be approved first.
      // Batched into one multicall: an approve that lands without the join is
      // a dangling allowance the player has to clean up.
      await executeAndWait(account, provider, [
        pgCall(contract, 'join_table', {
          table_id: table.tableId,
          seat,
          hole_card_note_id: noteId.trim() || seat,
        }),
      ]);
      refresh();
    } catch (e) { setErr(decodeError(e)); } finally { setBusy(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Take a seat</div>
        <div className={styles.sectionHint}>Escrows the buy-in and binds a payout note to the seat.</div>
      </div>
      <div className={styles.grid3}>
        <div className={styles.field}>
          <label className={styles.label}>seat</label>
          <input className={styles.input} value={seat} onChange={(e) => setSeat(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>payout note id</label>
          <input className={styles.input} value={noteId} placeholder="defaults to the seat index"
            onChange={(e) => setNoteId(e.target.value)} />
          <div className={styles.fieldHint}>
            Where winnings go. Can be re-bound later with <code>bind_payout_note</code>.
          </div>
        </div>
      </div>
      <div className={styles.actionsRow}>
        <button className={uni.btn} disabled={busy || !account} onClick={join}>
          {busy ? 'Joining…' : 'Join table'}
        </button>
      </div>
      {err ? <pre className={uni.receiptNote}>{err}</pre> : null}
    </div>
  );
}

function CreateTable(p: any) {
  const { tableId, contract, account, provider, providerIndex, refresh } = p;
  const [token, setToken] = useState(
    providerIndex === 3 ? constants.defaultDevnetToken : constants.defaultPokerToken,
  );
  const [buyIn, setBuyIn] = useState('1000');
  const [maxSeats, setMaxSeats] = useState('3');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      await executeAndWait(account, provider, [
        pgCall(contract, 'create_table', {
          table_id: tableId, token, buy_in: buyIn, max_seats: maxSeats,
        }),
      ]);
      refresh();
    } catch (e) { setErr(decodeError(e)); } finally { setBusy(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>No table {shortHex(tableId)} yet</div>
        <div className={styles.sectionHint}>Create it. You become the dealer — which opens the shuffle and advances streets, and nothing else.</div>
      </div>
      <div className={styles.grid3}>
        <Field label="buy-in token" value={token} onChange={setToken} />
        <Field label="buy-in" value={buyIn} onChange={setBuyIn} />
        <Field label="max seats" value={maxSeats} onChange={setMaxSeats} />
      </div>
      <div className={styles.actionsRow}>
        <button className={uni.btn} disabled={busy || !account} onClick={create}>
          {busy ? 'Creating…' : 'Create table'}
        </button>
        <span className={styles.fieldHint}>
          Every seat shuffles, so a bigger table means a longer chain: k = n proofs before the
          first card, roughly {5} s each in this browser.
        </span>
      </div>
      {err ? <pre className={uni.receiptNote}>{err}</pre> : null}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input className={styles.input} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/**
 * Your own cards.
 *
 * Deliberately separate from the felt: these are private, and mixing them into
 * the shared view is how a screenshot leaks a hand. Until the reveal path is
 * driven from here they show what the CONTRACT has recorded, which is the only
 * thing that can be checked.
 */
function YourHand({ table, yourSeat }: any) {
  if (yourSeat === null) return null;
  const seat = table.seats[yourSeat];
  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Your hand</div>
        <div className={styles.sectionHint}>
          Shares committed at dealing time bind the card — no shopping for a friendlier share set
          after seeing the board.
        </div>
      </div>
      <div className={styles.stateGrid}>
        {[0, 1].map((slot) => (
          <div key={slot} className={styles.stateItem}>
            <div className={styles.stateLabel}>slot {slot}</div>
            <div className={styles.stateValue}>
              {seat.holeRevealed[slot]
                ? cardName(seat.holeCards[slot])
                : seat.holeCommitted[slot]
                  ? 'committed, not revealed'
                  : 'no shares yet'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const RANKS = '23456789TJQKA';
const SUITS = ['♣', '♦', '♥', '♠'];
const cardName = (c: number) => `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`;
