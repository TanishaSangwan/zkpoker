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
import ConnectDevnet from '../components/client/WalletHandle/ConnectDevnet';
import { useDevnetAccount } from '../components/client/provider/devnetAccountContext';
import { useTableState } from './useTableState';
import { asU256, decodeError, erc20ApproveCall, executeAndWait, pgCall, pokerGameReader, shortHex, toFelt } from './contract';
import Felt from './components/Felt';
import PhasePanel from './components/PhasePanel';
import RevealPanel from './components/RevealPanel';
import { loadOrCreateSeatKey, seatKeyIsPersisted, type SeatIdentity } from '@/lib/identity';
import type { Ciphertext } from '@/lib/deck';
import { useProvingEnvironment } from './useProvingEnvironment';

export default function PokerPanel() {
  // Two possible signers, and PokerPanel is where they are reconciled.
  //
  // A real wallet gives a WalletAccountV6 through walletContext; a local
  // devnet gives a plain starknet.js Account built from one of devnet's
  // predeployed private keys (ConnectDevnet -> devnetAccountContext). Neither
  // store knows about the other, so if this component only read one of them --
  // as an earlier version of this rewrite did -- connecting to devnet appeared
  // to work and then every action said "connect a wallet first".
  //
  // Devnet wins when both are present: if you have deliberately connected a
  // local sandbox account, that is the one you meant to act as.
  const walletAccount = useStoreWallet((s) => s.account);
  const walletAddress = useStoreWallet((s) => s.address);
  const devnetAccount = useDevnetAccount((s) => s.account);
  const devnetAddress = useDevnetAccount((s) => s.address);
  const devnetConnected = useDevnetAccount((s) => s.connected);
  const account = (devnetConnected ? devnetAccount : walletAccount) as typeof walletAccount;
  const address = devnetConnected ? devnetAddress : walletAddress;
  const providerIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const setProviderIndex = useFrontendProvider((s) => s.setCurrentFrontendProviderIndex);
  const provider = constants.myFrontendProviders[providerIndex];
  const contract = constants.pokerGameAddressForIndex(providerIndex);
  const deployed = !!contract && BigInt(contract) !== 0n;

  // Networks with a non-zero PokerGame address in the env.
  const networksWithDeployment = useMemo(
    () =>
      Object.keys(constants.NetworkLabels)
        .map(Number)
        .filter((i) => {
          const a = constants.pokerGameAddressForIndex(i);
          try { return !!a && BigInt(a) !== 0n; } catch { return false; }
        }),
    [],
  );

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

  // Nothing that depends on client-only state may drive the FIRST render.
  //
  // The wallet, the devnet account and the selected network all live in
  // zustand stores. The server has none of them, so a first render that reads
  // them disagrees with the server's HTML and React discards the hydration --
  // which showed up as `disabled={true}` on the client against `null` from the
  // server on the Open button. It is reported as a warning and it is not
  // cosmetic: a tree React refuses to patch up can leave handlers attached to
  // markup that no longer matches.
  //
  // So the first paint matches the server exactly, and everything
  // network-dependent waits one tick. Same reasoning as
  // useProvingEnvironment, which had the same problem for the same reason.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  // The table's own buy-in token, read from the contract rather than assumed.
  // A client has to approve exactly this ERC20 before joining or betting;
  // approving a different one produces a join that reverts inside the token
  // with nothing in the error pointing at the cause.
  const [tableToken, setTableToken] = useState<string>(constants.defaultDevnetToken);
  useEffect(() => {
    if (!tableId || !deployed || !provider) return;
    (async () => {
      try {
        const t = await pokerGameReader(contract, provider).get_table_token(tableId);
        if (BigInt(t) !== 0n) setTableToken('0x' + BigInt(t).toString(16));
      } catch {
        // Leaves the editable default in place rather than blocking the join.
      }
    })();
  }, [tableId, deployed, provider, contract]);

  // Until mounted, render markup that CANNOT differ from the server's.
  //
  // Guarding individual attributes was not enough -- React still found a
  // mismatch, and chasing props one at a time is a losing game when the whole
  // subtree depends on state the server does not have (wallet, devnet account,
  // selected network, localStorage). One deterministic skeleton makes the
  // server's HTML and the client's first render identical by construction, so
  // there is nothing to reconcile; the real UI appears a tick later.
  //
  // The cost is a brief placeholder. The alternative is a tree React refuses
  // to patch, which can leave handlers bound to markup that no longer matches.
  if (!mounted) {
    return (
      <div className={styles.wrap}>
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <div className={styles.sectionTitle}>Table</div>
            <div className={styles.sectionHint}>connecting…</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {/* Which networks actually have a deployment configured. Worth showing
          rather than leaving implicit: the provider defaults to Sepolia, so a
          local devnet deployment is live and invisible until you switch, and
          the old banner's advice ("set the Sepolia variable") was actively
          wrong in exactly that case. */}
      {networksWithDeployment.length > 0 ? (
        <div className={styles.modeToggle}>
          {networksWithDeployment.map((i) => (
            <button
              key={i}
              className={`${styles.modeBtn} ${i === providerIndex ? styles.modeBtnActive : ''}`}
              onClick={() => setProviderIndex(i)}
            >
              {constants.NetworkLabels[i] ?? `provider ${i}`}
            </button>
          ))}
        </div>
      ) : null}

      {!deployed ? (
        <div className={styles.banner}>
          <strong>
            PokerGame is not deployed on {constants.NetworkLabels[providerIndex] ?? `provider ${providerIndex}`}.
          </strong>{' '}
          {networksWithDeployment.length > 0 ? (
            <>
              It <em>is</em> deployed on{' '}
              {networksWithDeployment.map((i) => constants.NetworkLabels[i] ?? `provider ${i}`).join(', ')} —
              switch above.
            </>
          ) : (
            <>
              Set{' '}
              <code className={styles.bannerCode}>
                NEXT_PUBLIC_POKERGAME_{constants.NetworkLabels[providerIndex] ?? 'DEVNET'}
              </code>{' '}
              in <code className={styles.bannerCode}>.env.local</code> and restart the dev server —
              Next inlines <code className={styles.bannerCode}>NEXT_PUBLIC_*</code> at build time, so
              a running server keeps the old value. For a local devnet:{' '}
              <code className={styles.bannerCode}>npm run deploy:local</code>.
            </>
          )}
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
        <ConnectDevnet />
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
            table={table} yourSeat={yourSeat} contract={contract} token={tableToken}
            account={account} provider={provider} refresh={refresh}
          />
          <PhasePanel
            table={table} yourSeat={yourSeat} identity={identity}
            account={account} provider={provider} contract={contract}
            deck={deck} setDeck={setDeck} refresh={refresh}
          />
          <RevealPanel
            table={table} yourSeat={yourSeat} identity={identity}
            account={account} provider={provider} contract={contract}
            chainId={String(providerIndex)} refresh={refresh}
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
  const { table, yourSeat, contract, account, provider, refresh, token } = p;
  const [seat, setSeat] = useState('0');
  const [noteId, setNoteId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (yourSeat !== null || table.shuffleStarted) return null;

  const [allowance, setAllowance] = useState('1000000');

  const join = async () => {
    setBusy(true); setErr(null);
    try {
      // join_table escrows the buy-in and bet() moves tokens with
      // transfer_from, so the token has to be approved first -- without it the
      // join reverts inside the ERC20 with an error that says nothing about
      // poker.
      //
      // Batched into ONE multicall: an approve that lands while the join fails
      // leaves a dangling allowance the player has to notice and clean up.
      //
      // The allowance deliberately covers more than the buy-in, so betting
      // works without a second approval per raise. That is a real tradeoff --
      // a larger allowance is a larger amount this contract could pull -- so
      // it is a visible field rather than a hidden constant.
      const calls = [];
      const approving = BigInt(allowance || '0');
      if (approving > 0n) calls.push(erc20ApproveCall(token, contract, approving));
      calls.push(pgCall(contract, 'join_table', {
        table_id: table.tableId,
        seat,
        hole_card_note_id: noteId.trim() || seat,
      }));
      await executeAndWait(account, provider, calls);
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
          <label className={styles.label}>token allowance</label>
          <input className={styles.input} value={allowance} onChange={(e) => setAllowance(e.target.value)} />
          <div className={styles.fieldHint}>
            Approved to PokerGame in the same transaction as the join. Must cover the buy-in plus
            whatever you intend to bet.
          </div>
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
