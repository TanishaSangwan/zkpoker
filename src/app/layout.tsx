import type { Metadata } from 'next'
import { Inter, Space_Mono, Orbitron } from 'next/font/google'
import './globals.css'

// Clean neutral grotesque for everything (matches the Uniswap reference); a mono
// only for hex addresses / hashes.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})
const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono-ui',
  display: 'swap',
})
// A display face for the poker page's dark/neon skin -- headings and the
// pot readout only. Loaded globally (next/font needs a server component)
// but nothing outside /poker references --font-display, so the STRK20 page
// is unaffected.
const orbitron = Orbitron({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Shielded STRK · WalletAccountV6',
  description: 'Shield, unshield and privately move STRK on Starknet with WalletAccountV6',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceMono.variable} ${orbitron.variable}`}
      suppressHydrationWarning
    >
      <body>{children}</body>
    </html>
  )
}
