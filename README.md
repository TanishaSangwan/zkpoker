# STRK[20] Provably Fair On-Chain Poker

Hackathon entry for https://strk20.starknet.io/hackathon, answering the
[Provably Fair On-Chain Poker RFP](https://strk20.starknet.io/rfp/private-poker).
Hole cards as encrypted STRK20 notes, commit-reveal dealing, paymaster-hidden
player identity, private buy-ins and payouts. See **[docs/DESIGN.md](docs/DESIGN.md)**
for the full architecture and current scope (V1: trusted-dealer commit-reveal,
not yet the STARK-proven-shuffle V2).

Scaffolded from [Akashneelesh/strk20-starter-kit](https://github.com/Akashneelesh/strk20-starter-kit)
(Next.js + Wallet API pre-wired) — original app code is otherwise untouched
so far; the poker-specific pieces are `cairo/src/lib.cairo`,
`scripts/deal_verify.py`, and `docs/DESIGN.md`.

## What's inside?

- `cairo/src/lib.cairo` — `PokerGame`, the STRK20 anonymizer (`privacy_invoke`)
  for this table: table/seat setup, commit-reveal dealing, bet/fold pot
  accounting, per-note settlement. Unaudited skeleton — see the TODOs and
  `docs/DESIGN.md` "Open items".
- `scripts/deal_verify.py` — independent fairness check. Feed it a revealed
  seed and it recomputes the deal; diff against what was actually dealt.
- `src/` — the starter kit's Next.js app (wallet connect, shield/unshield/
  transfer/echo actions). Still the original demo UI; wiring in `PokerGame`
  actions is the next step (see `docs/DESIGN.md`).

## Quick start

```bash
npm install
cp .env.example .env.local     # add your Alchemy key
npm run dev                    # http://localhost:3000
```

Needs a free [Alchemy](https://alchemy.com) Starknet RPC key and a
privacy-enabled wallet (Ready) on Sepolia or Mainnet.

### Cairo contract

Requires [Scarb](https://docs.swmansion.com/scarb/) 2.18.0 (pinned in
`cairo/.tool-versions`) — not installed in this environment yet. Once
installed:

```bash
cd cairo
scarb build
```

Deploying requires one constructor argument: the STRK20 pool's address
(`privacy_invoke` now checks the caller against this pinned value, not a
caller-supplied argument — see `security-review-20260830-194015.md`).

Run `cairo-auditor` again after any further change to `lib.cairo`, and run
`cairo-testing` to build out the required-tests list from that report,
before deploying anywhere real — it currently holds pooled funds across
concurrent tables, and several findings (see `docs/DESIGN.md` "Still open")
remain unfixed.

### Fairness verification tool

```bash
python3 scripts/deal_verify.py --seed 0xdeadbeef --seats 6
python3 scripts/deal_verify.py --seed 0xdeadbeef --seats 6 --claimed claimed_deal.json

# 2 players sat down at a 6-seat table: pass the table's capacity, or the
# community cards get read from the wrong deck positions.
python3 scripts/deal_verify.py --seed 0xdeadbeef --seats 2 --max-seats 6
```

## Skills used

- `strk20-privacy`, `strk20-anonymizer-contracts`, `strk20-privacy-sdk`,
  `strk20-wallet-api` — STRK20 concepts, `privacy_invoke` pattern, SDK/wallet
  integration.
- `starknet-skills` (`cairo-contract-authoring`, `cairo-auditor`,
  `cairo-testing`, `cairo-optimization`) — writing and hardening the Cairo
  contract.

## Links

[STRK20 by example](https://strk20-by-example.org/) ·
[Privacy SDK](https://github.com/starkware-libs/starknet-privacy) ·
[RFP: Provably Fair On-Chain Poker](https://strk20.starknet.io/rfp/private-poker) ·
[Hackathon](https://strk20.starknet.io/hackathon)

Bootstrapped from [Akashneelesh/strk20-starter-kit](https://github.com/Akashneelesh/strk20-starter-kit),
itself bootstrapped from [PhilippeR26/Starknet-WalletAccount](https://github.com/PhilippeR26/Starknet-WalletAccount).
