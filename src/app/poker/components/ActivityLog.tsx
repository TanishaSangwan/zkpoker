'use client';

// Renders once, near the top of the page (see PokerPanel.tsx) -- everything
// PhasePanel and RevealPanel report funnels here via useActivityLog, newest
// first, in a fixed-height scrolling list rather than one that grows the
// page. See activityLog.ts for why.

import styles from '../poker.module.css';
import { useActivityLog, type LogEntry } from '../activityLog';

function kindClass(kind: LogEntry['kind']): string {
  return kind === 'ok' ? styles.logRowOk : kind === 'error' ? styles.logRowError : styles.logRowInfo;
}

export default function ActivityLog() {
  const entries = useActivityLog((s) => s.entries);

  // Nothing has happened yet -- no empty box taking up space before the
  // first action.
  if (entries.length === 0) return null;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>Activity</div>
        <div className={styles.sectionHint}>What just happened, newest first.</div>
      </div>
      <div className={styles.logList}>
        {entries.map((e) => (
          <div key={e.id} className={`${styles.logRow} ${kindClass(e.kind)}`}>
            <span className={styles.logDot} aria-hidden />
            <div className={styles.logBody}>
              <div className={styles.logText}>{e.text}</div>
              {e.detail ? <div className={styles.logDetail}>{e.detail}</div> : null}
            </div>
            <span className={styles.logTime}>
              {new Date(e.ts).toLocaleTimeString(undefined, { hour12: false })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
