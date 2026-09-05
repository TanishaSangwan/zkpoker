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
import { hash } from 'starknet';
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
import { loadHoleOpening } from '@/lib/reveal';
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

  // This client's own hole cards, recovered locally at dealing time. Lifted
  // here because both the felt and the hand panel show them, and reading
  // localStorage in two places invites them to disagree.
  const [myCards, setMyCards] = useState<(number | null)[]>([null, null]);

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
    if (!tableId || yourSeat === null) { setMyCards([null, null]); return; }
    setMyCards([0, 1].map((slot) => {
      const o = loadHoleOpening({
        chainId: String(providerIndex), contract, tableId, seat: yourSeat, slot,
      });
      return o ? o.card : null;
    }));
  }, [tableId, yourSeat, providerIndex, contract, table?.seats]);
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
          <Felt table={table} yourSeat={yourSeat} yourCards={myCards} />
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
          <YourHand table={table} yourSeat={yourSeat} cards={myCards} />
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The ONLY thing a player actually decides when sitting down.
  //
  // Everything else that used to be a field here -- which seat, what payout
  // note id -- has one right answer and no information behind it, so asking
  // was busywork. How much of your money this contract may move is the
  // opposite: it is the whole risk of sitting down, so it stays a visible
  // number rather than a constant buried in the code.
  const [stake, setStake] = useState('1000000');

  // First free seat. There is nothing to choose: seats are interchangeable
  // (position in the shuffle chain follows seat order, and every seat shuffles
  // anyway), and picking one by hand only creates a way to collide with
  // someone who took it a second earlier.
  const firstFreeSeat = useMemo(() => {
    const taken = new Set(table.seats.filter((s: any) => s.occupied).map((s: any) => s.seat));
    for (let i = 0; i < table.maxSeats; i++) if (!taken.has(i)) return i;
    return null;
  }, [table.seats, table.maxSeats]);

  /**
   * A payout note id unique to (account, table, seat).
   *
   * `note_id_owner` is a GLOBAL map and the first claimer owns an id forever,
   * across every table. Defaulting to the seat index -- as this did -- meant
   * seat 1 of one table claimed id 1 permanently and the next account to sit
   * in any seat 1 anywhere got NOTE_ID_TAKEN.
   */
  const noteFor = (seat: number) =>
    hash.computePoseidonHashOnElements([account?.address ?? '0x0', table.tableId, String(seat)]);

  if (yourSeat !== null || table.shuffleStarted) return null;

  const sitDown = async () => {
    if (firstFreeSeat === null) { setErr('every seat is taken'); return; }
    setBusy(true); setErr(null);
    try {
      // approve + join in ONE multicall: an approve that lands while the join
      // fails leaves a dangling allowance the player has to notice and undo.
      const calls = [];
      const approving = BigInt(stake || '0');
      if (approving > 0n) calls.push(erc20ApproveCall(token, contract, approving));
      calls.push(pgCall(contract, 'join_table', {
        table_id: table.tableId,
        seat: String(firstFreeSeat),
        hole_card_note_id: noteFor(firstFreeSeat),
      }));
      await executeAndWait(account, provider, calls);
      refresh();
    } catch (e) { setErr(decodeError(e)); } finally { setBusy(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Sit down</div>
        <div className={styles.sectionHint}>
          Takes the first free seat, derives a payout note, and approves your stake — one
          transaction. Your key is registered automatically once you are seated.
        </div>
      </div>
      <div className={styles.grid2}>
        <div className={styles.field}>
          <label className={styles.label}>stake you are approving</label>
          <input className={styles.input} value={stake} onChange={(e) => setStake(e.target.value)} />
          <div className={styles.fieldHint}>
            The most this contract may move from your balance — buy-in plus whatever you intend to
            bet. Shown rather than hidden, because it is the only real decision in sitting down.
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>seat</label>
          <div className={styles.stateValue}>
            {firstFreeSeat === null ? 'table full' : `seat ${firstFreeSeat} (first free)`}
          </div>
        </div>
      </div>
      <div className={styles.actionsRow}>
        <button className={uni.btn} disabled={busy || !account || firstFreeSeat === null} onClick={sitDown}>
          {busy ? 'Sitting down…' : 'Sit down'}
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
function YourHand({ table, yourSeat, cards }: any) {
  if (yourSeat === null) return null;
  const seat = table.seats[yourSeat];

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Your hand</div>
        <div className={styles.sectionHint}>
          Recovered on this device from every party&apos;s share. Nobody else can compute it —
          opening it needs your share, and yours never leaves this browser.
        </div>
      </div>
      <div className={styles.stateGrid}>
        {[0, 1].map((slot) => (
          <div key={slot} className={styles.stateItem}>
            <div className={styles.stateLabel}>slot {slot}</div>
            <div className={styles.stateValue}>
              {seat.holeRevealed[slot]
                ? `${cardName(seat.holeCards[slot])} — shown on-chain`
                : cards?.[slot] != null
                  ? `${cardName(cards[slot])} — known only to you`
                  : seat.holeCommitted[slot]
                    ? 'committed, but this browser has no opening stored'
                    : 'not dealt yet'}
            </div>
          </div>
        ))}
      </div>
      {!seat.holeRevealed[0] && cards?.[0] == null && seat.holeCommitted[0] ? (
        <div className={styles.caution}>
          This seat committed to a hand but this browser holds no opening for it — dealt in a
          different browser, or storage was cleared. Without the opening you cannot show at
          showdown, and mucking forfeits.
        </div>
      ) : null}
    </div>
  );
}

const RANKS = '23456789TJQKA';
const SUITS = ['♣', '♦', '♥', '♠'];
const cardName = (c: number) => `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`;
