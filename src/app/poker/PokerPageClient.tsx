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
          Mental poker on Starknet, with no trusted dealer. Every seat shuffles
          the deck and proves it did so honestly; every card needs a decryption
          share from <em>every</em> player. Key generation, shuffling and proving
          all happen in this browser — the permutation is the secret the protocol
          protects, so it never leaves your machine.
        </p>
      </header>

      <main>
        <PokerPanel />
      </main>

      <footer className={uni.footer}>
        <span>Starknet.js v10.4.0</span>
        <span className={uni.footerDot}>·</span>
        <span>Noir + UltraHonk via bb.js</span>
        <span className={uni.footerDot}>·</span>
        <span>Garaga 1.1.0 on Grumpkin</span>
      </footer>
    </div>
  );
}
