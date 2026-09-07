'use client';

// The zkpoker table client.
//
// Replaces the V1 panel, which drove commit_deal / reveal_seed and a
// seed-based Fisher-Yates shuffle. That contract path still exists in
// lib.cairo but PROTOCOL.md §10 lists it under "to be deleted"; nothing here
// touches it, and src/app/poker/fairness.ts (the seed replayer) is gone with
// it. The fairness story is no longer "check the dealer's seed" -- it is
// "every seat shuffled and proved it".

import { useCallback, useEffect, useMemo, useState } from 'react';
import { hash } from 'starknet';
import Link from 'next/link';
import styles from './poker.module.css';
import uni from '../uni.module.css';
import * as constants from '@/utils/constants';
import { useStoreWallet } from '../components/Wallet/walletContext';
import { useFrontendProvider } from '../components/client/provider/providerContext';
import SelectWallet from '../components/client/WalletHandle/SelectWallet';
import ConnectDevnet from '../components/client/WalletHandle/ConnectDevnet';
import ConnectLocalKey from '../components/client/WalletHandle/ConnectLocalKey';
import { useLocalAccount } from '../components/client/provider/localAccountContext';
import { useTableState } from './useTableState';
import { asU256, decodeError, erc20ApproveCall, erc20Balances, executeAndWait, fmtAmount, pgCall, pokerGameReader, shortHex, strkToBase, toFelt } from './contract';
import Felt from './components/Felt';
import ActivityLog from './components/ActivityLog';
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
  // a local signer gives a plain starknet.js Account built from a raw private
  // key -- one of devnet's predeployed accounts (ConnectDevnet) or a pasted
  // testnet key (ConnectLocalKey), both via localAccountContext. Neither
  // store knows about the other, so if this component only read one of them --
  // as an earlier version of this rewrite did -- connecting to devnet appeared
  // to work and then every action said "connect a wallet first".
  //
  // The local account wins when both are present: if you have deliberately
  // connected one, that is the one you meant to act as.
  const walletAccount = useStoreWallet((s) => s.account);
  const walletAddress = useStoreWallet((s) => s.address);
  const localAccount = useLocalAccount((s) => s.account);
  const localAddress = useLocalAccount((s) => s.address);
  const localConnected = useLocalAccount((s) => s.connected);
  const localProviderIndex = useLocalAccount((s) => s.providerIndex);
  const providerIndex = useFrontendProvider((s) => s.currentFrontendProviderIndex);
  const setProviderIndex = useFrontendProvider((s) => s.setCurrentFrontendProviderIndex);
  // A locally-signed Account is bound to the RpcProvider it was built against,
  // and nothing about it says so. Switching the network selector must therefore
  // drop it rather than sign the next call against the wrong chain -- which is
  // not a hypothetical, because devnet reports the same chain id as Sepolia.
  const localUsable = localConnected && localProviderIndex === providerIndex;
  const account = (localUsable ? localAccount : walletAccount) as typeof walletAccount;
  const address = localUsable ? localAddress : walletAddress;
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
  // The locally cached deck, KEYED BY TABLE.
  //
  // It used to be a bare `Ciphertext[] | null` that nothing reset when the
  // table id changed. A tab that shuffled at one table and then opened
  // another carried the first table's deck into the second: shuffle turn 0
  // was immune (it starts from the canonical a_0, which is the same
  // everywhere), but any later seat proved a shuffle of the WRONG deck
  // against the new table's commitment. The circuit binds its input deck to
  // that commitment, so the witness failed before a transaction existed --
  // no revert, no error on chain, just a seat that could not shuffle.
  //
  // Scoped rather than cleared in an effect: an effect runs after render, so
  // there is a window where the stale deck is still readable. Deriving it
  // means there is no such window.
  const [deckCache, setDeckCache] = useState<{ tableId: string; cards: Ciphertext[] } | null>(null);
  const deck = deckCache && tableId && deckCache.tableId === tableId ? deckCache.cards : null;
  const setDeck = useCallback(
    (cards: Ciphertext[] | null) => {
      setDeckCache(cards && tableId ? { tableId, cards } : null);
    },
    [tableId],
  );
  const [error, setError] = useState<string | null>(null);

  // Polls faster once the showdown clock is running.
  //
  // Six seconds is fine for a hand that is waiting on people, and it used to be
  // far too slow for the showdown: the deadline was ten seconds PER SEAT, so a
  // seat could learn it was on turn with four left, and its co-signers -- who
  // only joined a reveal once it was that seat's turn -- learned even later.
  // Every seat at the table showed one card and was mucked before the second.
  // The clock is 600s for the whole table now and there is no turn order, so
  // this is far less load-bearing than it was; it still helps a showdown feel
  // live rather than polled.
  //
  // ── and slower on a public chain ──────────────────────────────────────
  // One "refresh" is not one request: useTableState reads the table, every
  // seat, every community card and the shuffle chain, which is ~60
  // starknet_calls for a two-seat table. Two tabs at 1.5s is therefore ~80
  // requests a second, which a free public endpoint answers with
  //
  //   15: You reached Public endpoint rate limit
  //
  // and the page reports as a failed read. The devnet numbers are kept for
  // devnet, where blocks are instant and the node is on localhost; against a
  // real chain, polling faster than blocks arrive buys nothing anyway.
  const localChain = providerIndex === constants.DEVNET_PROVIDER_INDEX;
  const idleMs = localChain ? 6000 : 12000;
  const liveMs = localChain ? 1500 : 3000;
  const [pollMs, setPollMs] = useState(idleMs);
  const { state: table, refresh, loading, error: readError } = useTableState({
    address: contract, provider, tableId, intervalMs: pollMs,
  });

  useEffect(() => {
    const live = !!table?.showdownStarted && !table?.settled;
    setPollMs(live ? liveMs : idleMs);
  }, [table?.showdownStarted, table?.settled, liveMs, idleMs]);

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
  // Seeded with canonical STRK, NOT defaultDevnetToken.
  //
  // The effect below reads the table's real token from the contract, but it
  // runs AFTER render -- so anything clicked in that window used the seed.
  // The old seed was NEXT_PUBLIC_DEVNET_TOKEN ?? "0x0", which on any
  // deployment that does not set that variable is literally the zero address:
  // the approve in sitDown's multicall went to 0x0 and the whole transaction
  // failed with "Requested contract address 0x0 is not deployed", pointing at
  // nothing. STRK sits at the same address on devnet, Sepolia and mainnet, so
  // it is a seed that is right far more often than it is wrong -- and sitDown
  // now refuses a zero token outright rather than building a call to it.
  const [tableToken, setTableToken] = useState<string>(constants.defaultPokerToken);

  useEffect(() => {
    if (!tableId || yourSeat === null) { setMyCards([null, null]); return; }
    setMyCards([0, 1].map((slot) => {
      const o = loadHoleOpening({
        chainId: String(providerIndex), contract, tableId,
        hand: table?.handNumber ?? 0, seat: yourSeat, slot,
      });
      return o ? o.card : null;
    }));
    // handNumber in the deps: the cards CHANGE when the hand does, and
    // without it the panel kept showing the previous hand's until something
    // else happened to re-render it.
  }, [tableId, yourSeat, providerIndex, contract, table?.seats, table?.handNumber]);
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

  // What you can still bet with, and what the game may still take.
  //
  // There is no chip stack in this contract: `bet` does `transfer_from` at
  // the moment you bet, so the WALLET is the stack -- and separately the game
  // can only move what has been approved. Neither number was anywhere on the
  // page, which makes "how much have I got left?" unanswerable from the
  // table, and makes an exhausted allowance look like a broken bet button.
  const [funds, setFunds] = useState<{ balance: bigint; allowance: bigint } | null>(null);
  useEffect(() => {
    if (!address || !provider || !deployed || !tableToken || BigInt(tableToken) === 0n) {
      setFunds(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const f = await erc20Balances(tableToken, address, contract, provider);
        if (live) setFunds(f);
      } catch {
        if (live) setFunds(null);
      }
    })();
    return () => { live = false; };
    // table.pot moves whenever money does, which is exactly when these change.
  }, [address, provider, deployed, tableToken, contract, table?.pot, table?.handNumber]);

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
          {/* There is no chip stack: `bet` pulls from the wallet at bet time,
              so the wallet IS the stack. And the game can only move what has
              been approved, so a spent allowance stops betting with an error
              that comes from inside the token and names nothing. Both belong
              in front of the player, not in a block explorer. */}
          {funds ? (
            <div className={styles.sectionHint}>
              your balance <strong>{fmtAmount(funds.balance)}</strong>
              {' · approved for this table '}
              <strong>{fmtAmount(funds.allowance)}</strong>
              {funds.allowance === 0n
                ? ' — approve a stake before betting'
                : funds.allowance < funds.balance / 100n
                  ? ' — nearly used up; approve more before it stops your bets'
                  : ''}
            </div>
          ) : null}
        </div>
        {providerIndex === constants.DEVNET_PROVIDER_INDEX ? <ConnectDevnet /> : <ConnectLocalKey />}
        <div className={styles.tableIdRow}>
          <input className={styles.input} value={tableIdInput}
            onChange={(e) => setTableIdInput(e.target.value)} placeholder="table id" />
          <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={!deployed}
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
          {/* Betting/actions above the log -- what you can DO right now
              outranks a record of what already happened. */}
          <PhasePanel
            table={table} yourSeat={yourSeat} identity={identity}
            account={account} provider={provider} contract={contract}
            deck={deck} setDeck={setDeck} refresh={refresh}
          />
          <ActivityLog />
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
  const [stake, setStake] = useState('200'); // STRK

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
      // A zero token means the table's token has not been read back yet, or
      // this is not a table. Either way, approving to 0x0 produces a revert
      // whose message names no cause.
      if (!token || BigInt(token) === 0n) {
        throw new Error("The table's buy-in token is not known yet — give it a second and try again.");
      }
      const calls = [];
      const approving = strkToBase(stake);
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
          <label className={styles.label}>stake you are approving (STRK)</label>
          <input className={styles.input} value={stake} onChange={(e) => setStake(e.target.value)} />
          {amountProblem(stake) ? <span className={styles.fieldHint}>{amountProblem(stake)}</span> : null}
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
        <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={busy || !account || firstFreeSeat === null} onClick={sitDown}>
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
  const [buyIn, setBuyIn] = useState('200'); // STRK
  const [maxSeats, setMaxSeats] = useState('3');
  // A conventional 1/2 of the buy-in's hundredth, i.e. a 50-big-blind stack.
  // Editable, because the right stakes for a table are the table's business.
  const [smallBlind, setSmallBlind] = useState('10'); // STRK
  const [bigBlind, setBigBlind] = useState('20'); // STRK
  // Hands per rung of the rising ladder. Empty or 0 means fixed blinds, which
  // is what the two fields above are for -- the two structures are exclusive,
  // and the contract refuses a schedule of 0.
  // Explicit, because the two are mutually exclusive and ONE OF THEM IS A
  // ONE-WAY DOOR: set_blind_schedule is only accepted while hand_number == 0
  // (deliberately -- otherwise a dealer could watch a hand and re-time the
  // rungs against whoever is winning), so a table created with fixed blinds
  // can never be given a ladder afterwards. Inferring the mode from whether
  // an optional field happened to be filled in made that irreversible choice
  // silently, by default, and every table created so far got fixed blinds
  // without anyone choosing them.
  const [blindMode, setBlindMode] = useState<'fixed' | 'rising'>('fixed');
  const [levelHands, setLevelHands] = useState('10');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      // One transaction, two calls. set_blinds has to land before the shuffle
      // starts -- the stakes are fixed before a single card exists, so they
      // cannot be tuned to a deal -- and bundling it with create_table means
      // there is no window in which a table exists without its structure.
      const calls = [
        pgCall(contract, 'create_table', {
          table_id: tableId, token,
          buy_in: strkToBase(buyIn).toString(),
          max_seats: maxSeats,
        }),
      ];
      // A ladder replaces the fixed pair rather than adding to it: with a
      // schedule set the stored small/big are never read, so writing them
      // would only leave two numbers on chain that describe nothing.
      const ladder = blindMode === 'rising' ? Number(levelHands || '0') : 0;
      if (blindMode === 'rising' && ladder <= 0) {
        throw new Error('Rising blinds need a positive number of hands per level.');
      }
      if (ladder > 0) {
        calls.push(pgCall(contract, 'set_blind_schedule', {
          table_id: tableId,
          hands_per_level: String(ladder),
          // One rung-point = 1 STRK, so the ladder runs 10/20 STRK up to
          // 300/600 STRK. The rungs are bare integers in the contract, and
          // without this multiplier the top of the whole ladder would be 600
          // wei -- 6e-16 STRK -- which is dust against a hand of gas.
          unit: (10n ** 18n).toString(),
        }));
      } else if (strkToBase(bigBlind) > 0n) {
        calls.push(pgCall(contract, 'set_blinds', {
          table_id: tableId,
          small_blind: strkToBase(smallBlind).toString(),
          big_blind: strkToBase(bigBlind).toString(),
        }));
      }
      await executeAndWait(account, provider, calls);
      refresh();
    } catch (e) { setErr(decodeError(e)); } finally { setBusy(false); }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>No table {shortHex(tableId)} yet</div>
        <div className={styles.sectionHint}>Create it. You become the host — which opens the shuffle and sets the stakes, and nothing else. The button is a rule, not a gift: lowest occupied seat, then one to the left every hand.</div>
      </div>
      <div className={styles.grid3}>
        <Field label="buy-in token" value={token} onChange={setToken} />
        <Field label="buy-in (STRK)" value={buyIn} onChange={setBuyIn} hint={amountProblem(buyIn)} />
        <Field label="max seats" value={maxSeats} onChange={setMaxSeats} />
        {blindMode === 'fixed' ? (
          <>
            <Field label="small blind (STRK)" value={smallBlind} onChange={setSmallBlind} hint={amountProblem(smallBlind)} />
            <Field label="big blind (STRK)" value={bigBlind} onChange={setBigBlind} hint={amountProblem(bigBlind)} />
          </>
        ) : (
          <Field label="hands per blind level" value={levelHands} onChange={setLevelHands} />
        )}
      </div>
      <div className={styles.actionsRow}>
        <div className={styles.modeToggle} style={{ marginBottom: 0 }}>
          <button type="button" className={`${styles.modeBtn} ${blindMode === 'fixed' ? styles.modeBtnActive : ''}`}
            onClick={() => setBlindMode('fixed')}>
            Fixed blinds
          </button>
          <button type="button" className={`${styles.modeBtn} ${blindMode === 'rising' ? styles.modeBtnActive : ''}`}
            onClick={() => setBlindMode('rising')}>
            Rising blinds
          </button>
        </div>
        <span className={styles.fieldHint}>
          {blindMode === 'rising'
            ? 'Ladder is fixed in the contract — 10/20, 20/40, 30/60, 50/100, 100/200, 200/400, 300/600 STRK, then held. You choose the pace, not the price.'
            : 'The same small/big every hand, and the only mode that can express a real stake — the amount is yours to choose.'}{' '}
          <strong>Decide now:</strong> a schedule is only accepted before the first hand, so a
          table created with fixed blinds can never be switched to rising.
        </span>
      </div>
      <div className={styles.actionsRow}>
        <button className={`${uni.btn} ${uni.btnPrimary}`} disabled={busy || !account} onClick={create}>
          {busy ? 'Creating…' : 'Create table'}
        </button>
        <span className={styles.fieldHint}>
          Every seat shuffles, so a bigger table means a longer chain: k = n proofs before the
          first card, roughly {5} s each in this browser. The button starts on the lowest occupied
          seat and moves one seat each hand — no card is drawn for it, which saves a decryption
          round and an on-chain proof per seat. Set both blinds to 0 for a table without a
          structure. Fill in <b>hands per level</b> instead to climb the ladder — 10/20, 20/40,
          30/60, 50/100, 100/200, 200/400, 300/600, holding at the top — which overrides the two
          fixed amounts and can only be set before the table&apos;s first hand.
        </span>
      </div>
      {err ? <pre className={uni.receiptNote}>{err}</pre> : null}
    </div>
  );
}

function Field(
  { label, value, onChange, hint }:
  { label: string; value: string; onChange: (v: string) => void; hint?: string },
) {
  return (
    <div className={styles.field}>
      <label className={styles.label}>{label}</label>
      <input className={styles.input} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className={styles.fieldHint}>{hint}</span> : null}
    </div>
  );
}

/**
 * Nothing when the amount is fine; the reason when it is not.
 *
 * This used to echo the base units under every field -- and that is the
 * 19-digit integer the STRK inputs exist to get rid of, so it read as noise
 * on every box. The label says STRK; a field that is behaving needs no
 * commentary. What IS worth interrupting for is an amount that will not
 * parse, because the alternative is a transaction built from a
 * misunderstanding.
 */
function amountProblem(v: string): string {
  try { strkToBase(v); return ''; } catch (e) { return (e as Error).message; }
}

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
          showdown, and a seat that does not show before the clock runs out forfeits.
        </div>
      ) : null}
    </div>
  );
}

const RANKS = '23456789TJQKA';
const SUITS = ['♣', '♦', '♥', '♠'];
const cardName = (c: number) => `${RANKS[c % 13]}${SUITS[Math.floor(c / 13)]}`;
