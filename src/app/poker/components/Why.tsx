'use client';

// A collapsed-by-default explanation. Buttons here are self-explanatory
// (their label says what they do); the paragraph next to them is almost
// always the protocol-level justification for why it's safe/required, not
// something a player needs read before acting. Collapsing it behind "Why?"
// keeps the action itself the first thing seen, while keeping the reasoning
// one click away for anyone who wants to verify it.

import styles from '../poker.module.css';

export default function Why({ children }: { children: React.ReactNode }) {
  return (
    <details className={styles.why}>
      <summary className={styles.whySummary}>Why?</summary>
      <p className={styles.fieldHint}>{children}</p>
    </details>
  );
}
