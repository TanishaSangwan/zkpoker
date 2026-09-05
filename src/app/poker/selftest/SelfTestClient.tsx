'use client';

// Can THIS deployment prove a shuffle?
//
// Not test scaffolding -- a deployment check. docs/PROTOCOL.md §9.0 makes
// cross-origin isolation a requirement rather than a nicety: without
// COOP/COEP the browser withholds SharedArrayBuffer, bb.js silently drops to
// one thread, and every shuffle proof goes from ~4.8 s to ~9.9 s. Six times
// per hand, per player, invisibly. Nothing errors, so nothing tells you.
//
// This page runs the real thing through the real modules and reports what it
// finds, including the numbers, so a host can be checked before players are
// pointed at it. scripts/check_browser_client.mjs drives this page headlessly
// and fails CI on a regression.

import { useCallback, useEffect, useState } from 'react';
import styles from '../poker.module.css';
import uni from '../../uni.module.css';
import { INITIAL_DECK_COMMITMENT, commitment, initialDeck } from '@/lib/deck';
import { proveShuffle, provingEnvironment } from '@/lib/shuffle';
import { useProvingEnvironment } from '../useProvingEnvironment';
import { jointKey, normaliseEvenY } from '@/lib/schnorr';
import { proveOpenChunk } from '@/lib/deckOpen';

type Result = {
  ok: boolean;
  crossOriginIsolated: boolean;
  threads: number;
  a0Matches?: boolean;
  witnessMs?: number;
  proveMs?: number;
  calldataMs?: number;
  totalMs?: number;
  calldataFelts?: number;
  commitmentOut?: string;
  openMs?: number;
  openCalldataFelts?: number;
  openPositions?: string;
  error?: string;
};

export default function SelfTestClient() {
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState<string>('');

  const run = useCallback(async () => {
    setRunning(true); setResult(null); setStage('starting');
    const env = provingEnvironment();
    try {
      const a0 = initialDeck();

      // Checks the browser's Poseidon2 against a value the CIRCUIT produced
      // (circuits/deck_init), not against this code. If bb.js ever changes its
      // hash, every commitment this client computes would be rejected by the
      // circuit -- and this is where that gets caught.
      setStage('hashing a_0');
      const a0Matches = (await commitment(a0)) === INITIAL_DECK_COMMITMENT;

      // Two arbitrary key shares; the joint key only has to be a real point.
      const keys = [
        0x2b7e151628aed2a6abf7158809cf4f3cn,
        0x8e73b0f7da0e6452c810f32b809079e5n,
      ].map(normaliseEvenY);
      const Y = jointKey(keys.map((k) => k.pk));

      const t0 = performance.now();
      const r = await proveShuffle({
        deckIn: a0, jointKey: Y, commitmentIn: INITIAL_DECK_COMMITMENT,
        onProgress: setStage,
      });
      // Then open the deck that shuffle just produced -- the real sequence, and
      // the join between the two circuits. An opening proof binds ciphertexts
      // to the committed deck; without it, whoever posts the deck could
      // fabricate one outright (PROTOCOL.md §7).
      setStage('opening the deck');
      const t1 = performance.now();
      const opened = await proveOpenChunk({
        deck: r.deckOut,
        deckHash: r.commitmentOut,
        maxSeats: 2,
        chunk: 0,
        onProgress: (st) => setStage(`opening: ${st}`),
      });
      const openMs = Math.round(performance.now() - t1);

      setResult({
        ok: a0Matches,
        openMs,
        openCalldataFelts: opened.calldata.length,
        openPositions: opened.positions.join(', '),
        crossOriginIsolated: env.crossOriginIsolated,
        threads: env.threads,
        a0Matches,
        ...r.timings,
        totalMs: Math.round(performance.now() - t0),
        calldataFelts: r.calldata.length,
        commitmentOut: '0x' + r.commitmentOut.toString(16),
      });
    } catch (e: any) {
      setResult({
        ok: false, crossOriginIsolated: env.crossOriginIsolated, threads: env.threads,
        error: String(e?.stack ?? e),
      });
    } finally {
      setRunning(false); setStage('');
    }
  }, []);

  // Exposed so a headless driver (scripts/check_browser_client.mjs) can read
  // the outcome. In an effect, not during render -- assigning to window while
  // rendering is a side effect React is entitled to run twice or discard.
  useEffect(() => {
    (window as any).__zkpokerSelfTest = { run, result };
  }, [run, result]);

  const { env, ready: envReady } = useProvingEnvironment();

  return (
    <div className={uni.page}>
      <div className={styles.wrap}>
        <header className={styles.hero}>
          <h1 className={styles.heroTitle}>Proving self-test</h1>
          <p className={styles.heroSub}>
            Generates one real shuffle proof in this browser, through the same modules the table
            uses. Run it against any host before pointing players at it.
          </p>
        </header>

        <div className={styles.section}>
          <div className={styles.stateGrid}>
            <Item label="cross-origin isolated" value={!envReady ? '…' : env.crossOriginIsolated ? 'yes' : 'NO'} />
            <Item label="threads" value={!envReady ? '…' : String(env.threads)} />
            <Item label="SharedArrayBuffer" value={!envReady ? '…' : typeof SharedArrayBuffer !== 'undefined' ? 'yes' : 'no'} />
          </div>
          {envReady && !env.crossOriginIsolated ? (
            <div className={styles.caution}>
              Not cross-origin isolated. Proving still works, single-threaded, at roughly twice the
              wall time. Serve this app with <code>Cross-Origin-Opener-Policy: same-origin</code> and{' '}
              <code>Cross-Origin-Embedder-Policy: require-corp</code> — <code>next.config.js</code>{' '}
              sets both, so a proxy or CDN is stripping them.
            </div>
          ) : null}
          <div className={styles.actionsRow}>
            <button className={uni.btn} onClick={run} disabled={running} id="run-selftest">
              {running ? `Proving… ${stage}` : 'Run self-test'}
            </button>
          </div>
        </div>

        {result ? (
          <div className={`${uni.receipt} ${result.ok ? uni.receiptOk : uni.receiptError}`}>
            <div className={uni.receiptHead}>
              <span className={uni.receiptIcon}>{result.ok ? '✓' : '!'}</span>
              <span>{result.ok ? 'This deployment can prove' : 'Proving failed'}</span>
            </div>
            {result.error ? (
              <pre className={uni.receiptNote}>{result.error}</pre>
            ) : (
              <div className={uni.receiptRows}>
                <Row label="a_0 matches the pinned commitment" value={result.a0Matches ? 'yes' : 'NO'} />
                <Row label="witness" value={`${result.witnessMs} ms`} />
                <Row label="proof" value={`${result.proveMs} ms`} />
                <Row label="Starknet calldata" value={`${result.calldataMs} ms · ${result.calldataFelts} felts`} />
                <Row label="total" value={`${result.totalMs} ms on ${result.threads} thread${result.threads === 1 ? '' : 's'}`} />
                <Row label="new commitment" value={result.commitmentOut ?? ''} />
                <Row label="deck opening" value={`${result.openMs} ms · ${result.openCalldataFelts} felts`} />
                <Row label="opened positions" value={result.openPositions ?? ''} />
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stateItem}>
      <div className={styles.stateLabel}>{label}</div>
      <div className={styles.stateValue}>{value}</div>
    </div>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={uni.receiptRow}>
      <span className={uni.receiptLabel}>{label}</span>
      <span className={uni.receiptValue}>{value}</span>
    </div>
  );
}
