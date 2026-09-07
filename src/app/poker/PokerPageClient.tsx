"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import uni from "../uni.module.css";
import styles from "./poker.module.css";
import SelectWallet from "../components/client/WalletHandle/SelectWallet";
import PokerPanel from "./PokerPanel";
import { StrkCoin, BtcCoin, EthCoin, ZecCoin } from "../components/TokenIcons";

// A toned-down version of the home page's scattered token ambience -- edges
// only, so it sits behind the page's white cards rather than fighting them.
// Fewer coins than the home page: this page is content-dense below the
// hero, where the home page is mostly empty space.
type BgToken = { Coin: (p: { size?: number }) => React.ReactElement; pos: CSSProperties; size: number; blur: number; opacity: number };
const BG_TOKENS: BgToken[] = [
  { Coin: StrkCoin, pos: { top: '8%', left: '4%' }, size: 100, blur: 5, opacity: 0.4 },
  { Coin: EthCoin, pos: { top: '30%', left: '9%' }, size: 72, blur: 4, opacity: 0.38 },
  { Coin: BtcCoin, pos: { top: '58%', left: '5%' }, size: 88, blur: 5, opacity: 0.36 },
  { Coin: EthCoin, pos: { top: '10%', right: '5%' }, size: 92, blur: 5, opacity: 0.4 },
  { Coin: StrkCoin, pos: { top: '34%', right: '8%' }, size: 76, blur: 4, opacity: 0.38 },
  { Coin: ZecCoin, pos: { top: '60%', right: '4%' }, size: 96, blur: 5, opacity: 0.36 },
];

export default function PokerPageClient() {
  return (
    <div className={uni.page}>
      <div className={uni.aurora} aria-hidden>
        {BG_TOKENS.map((t, i) => (
          <span key={i} className={uni.tok} style={{ ...t.pos, filter: `blur(${t.blur}px)`, opacity: t.opacity }}>
            <t.Coin size={t.size} />
          </span>
        ))}
      </div>

      <nav className={styles.nav}>
        <div className={styles.navLinks}>
          <Link href="/" className={uni.brand} aria-label="STRK20 home">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/tokens/strk20.png" alt="STRK20" className={uni.brandImg} />
          </Link>
          <span className={styles.navLink} aria-hidden>/</span>
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
