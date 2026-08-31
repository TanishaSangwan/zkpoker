"use client";

import Link from "next/link";
import uni from "../uni.module.css";
import styles from "./poker.module.css";
import SelectWallet from "../components/client/WalletHandle/SelectWallet";
import PokerPanel from "./PokerPanel";

export default function PokerPageClient() {
  return (
    <div className={uni.page}>
      <nav className={styles.nav}>
        <div className={styles.navLinks}>
          <Link href="/" className={styles.navLink}>
            STRK20 demo
          </Link>
          <span className={`${styles.navLink} ${styles.navLinkActive}`}>PokerGame</span>
        </div>
        <SelectWallet variant="nav" />
      </nav>

      <header className={styles.hero}>
        <h1 className={styles.heroTitle}>PokerGame</h1>
        <p className={styles.heroSub}>
          Drives cairo/src/lib.cairo's PokerGame contract directly — table
          lifecycle, betting, commit-reveal fairness, and on-chain showdown.
          See the banner below if it isn't deployed on your network yet.
        </p>
      </header>

      <main>
        <PokerPanel />
      </main>

      <footer className={uni.footer}>
        <a href="https://github.com/PhilippeR26/Starknet-WalletAccount" target="_blank" rel="noreferrer">
          Repo
        </a>
        <span className={uni.footerDot}>·</span>
        <span>Powered by Starknet.js v10.4.0</span>
      </footer>
    </div>
  );
}
