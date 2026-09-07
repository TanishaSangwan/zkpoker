"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import uni from "../uni.module.css";
import styles from "./poker.module.css";
import SelectWallet from "../components/client/WalletHandle/SelectWallet";
import PokerPanel from "./PokerPanel";
import { StrkCoin, BtcCoin, EthCoin, ZecCoin } from "../components/TokenIcons";

// A toned-down version of the home page's scattered token ambience -- edges
// only, so the blurred coins sit in the margins rather than behind the
// dense stack of cards below the hero. Fewer of them than the home page,
// for the same reason.
type BgToken = { Coin: (p: { size?: number }) => React.ReactElement; pos: CSSProperties; size: number; blur: number; opacity: number };
const BG_TOKENS: BgToken[] = [
  { Coin: StrkCoin, pos: { top: '8%', left: '4%' }, size: 100, blur: 5, opacity: 0.4 },
  { Coin: EthCoin, pos: { top: '30%', left: '9%' }, size: 72, blur: 4, opacity: 0.38 },
  { Coin: BtcCoin, pos: { top: '58%', left: '5%' }, size: 88, blur: 5, opacity: 0.36 },
  { Coin: EthCoin, pos: { top: '10%', right: '5%' }, size: 92, blur: 5, opacity: 0.4 },
  { Coin: StrkCoin, pos: { top: '34%', right: '8%' }, size: 76, blur: 4, opacity: 0.38 },
  { Coin: ZecCoin, pos: { top: '60%', right: '4%' }, size: 96, blur: 5, opacity: 0.36 },
];

// The hero's paragraph-of-facts got replaced by four short claims -- what
// used to take a sentence each now takes three words, with a dot coloured
// to the same accent the rest of the page uses for that kind of state
// (green = a property of the protocol, purple = where it runs / who sees it).
const HERO_PILLS: { text: string; color: 'green' | 'pink' }[] = [
  { text: 'No trusted dealer', color: 'green' },
  { text: 'Provably fair shuffle', color: 'green' },
  { text: 'Hole cards stay yours', color: 'pink' },
  { text: 'Runs in your browser', color: 'pink' },
];

export default function PokerPageClient() {
  return (
    <div className={styles.pokerPage}>
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
        <div className={styles.heroGlow} aria-hidden />
        <div className={styles.heroEyebrow}>Zero Trust · Pure Math</div>
        <h1 className={styles.heroTitle}>PokerGame</h1>
        <p className={styles.heroTagline}>Shuffle like no one&apos;s watching. Because no one can.</p>
        <p className={styles.heroSub}>Every card dealt, proven and revealed — with no dealer to trust.</p>
        <ul className={styles.heroPills}>
          {HERO_PILLS.map((p) => (
            <li key={p.text} className={styles.heroPill}>
              <span className={styles.heroPillDot} style={{ color: `var(--${p.color})` }} />
              {p.text}
            </li>
          ))}
        </ul>
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
