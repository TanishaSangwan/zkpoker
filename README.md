# STRK[20] Provably Fair On-Chain Poker

Texas hold'em where **no one deals**. There is no server that knows the deck,
no trusted operator, and no player who has to be taken on trust — including
the one who created the table. Every card is encrypted under a key no single
party holds, every shuffle is a STARK proof verified on Starknet, and a card
becomes readable only when every player at the table has contributed a share
of the decryption.

Hackathon entry for the [STRK20 Private Sprint](https://strk20.starknet.io/hackathon),
answering the [Provably Fair On-Chain Poker RFP](https://strk20.starknet.io/rfp/private-poker).

**Live demo: https://zkpoker-three.vercel.app** — runs against Starknet
Sepolia. Open it in two browser tabs and you can play a whole hand against
yourself; two people on two machines need the share relay (below).

**Demo video:** [3-minute walkthrough](https://drive.google.com/file/d/1yQK8YbUfJGtkqUj9W8cwJHoYybyRgOjM/view?usp=sharing)

## Status, stated plainly

| | |
|---|---|
| Contract | Deployed and playable on **Starknet Sepolia** — `PokerGame` at [`0x014b3c7c…9e049`](https://sepolia.voyager.online/contract/0x014b3c7c70159f0da82699dad66e9be372417fd6c5cb9fbe57492bd8cd19e049), plus six verifier/adapter contracts ([`cairo/address.md`](cairo/address.md)) |
| Mainnet | **Not deployed.** No transactions against the live STRK20 pool |
| Tests | 282 passing (`snforge`), including the shuffle chain, side pots and the hand evaluator |
| Security | 8 recorded review rounds in `security-review-*.md`; findings fixed and referenced from the code |
| Audit | None. Do not put money on this |

The mainnet row is the honest one and it is the hackathon's own headline
criterion. **This entry does not meet it.** The hashes in `strk20.json` are
Sepolia, against this project's own contract, not mainnet and not the STRK20
pool — they are there so the work can be checked, not to claim the criterion.

### A whole hand, on chain

One complete hand against the deployed contract, in order, all verifiable on
[Voyager](https://sepolia.voyager.online/):

| | transaction |
|---|---|
| `begin_shuffle` — freezes the participants, checks the joint key is the sum of the registered shares | [`0x1fdf36b5…`](https://sepolia.voyager.online/tx/0x1fdf36b5f4b5eed94c789dcd19304851cad93e1eebc07f9aed4bc2e911e48b1) |
| `submit_shuffle` — one player's permutation + re-randomisation proof | [`0x597c0170…`](https://sepolia.voyager.online/tx/0x597c0170372621d164a71e30e5de478cf8cf9810536725f74abed996087bd40) |
| `submit_final_shuffle` — the last shuffle fused with the deck opening, one proof instead of two (3,787 felts of calldata) | [`0x538ef969…`](https://sepolia.voyager.online/tx/0x538ef969d2feb64b52656a275f17c19388749de984d5abadd9faaa2f40fb079) |
| `reveal_hole_card` — threshold decryption, with a DLEQ proof that the share used the registered secret | [`0x337bb9d7…`](https://sepolia.voyager.online/tx/0x337bb9d7a24b5a210fcc481ac3ddb2f51facc0aa42b1e70dd35de0f402983e8) |
| `settle_from_reveals` — the pot paid out from cards a proof bound | [`0x43d74fb0…`](https://sepolia.voyager.online/tx/0x43d74fb05791f35a31e4544cdf42844e3110ae9d8042a74b9b5403cec8233dd) |
| `end_table` — one player held every chip, so the table closed | [`0x5e045fd0…`](https://sepolia.voyager.online/tx/0x5e045fd0e6ce9d1d89eaea9ddad2fb23444add9d72e78a5c66562852b07db18) |

Nothing in that sequence trusts anybody. The shuffle proofs are checked by a
Garaga-generated verifier on chain, the joint key is recomputed rather than
accepted, and no card is readable until every seat has published a share.

## How it actually works

The protocol is written up in full in **[docs/PROTOCOL.md](docs/PROTOCOL.md)** —
including the things that are still wrong with it, which is the more useful
half. The short version:

**Keys.** Every seat generates a Grumpkin keypair in the browser and proves
knowledge of the secret with a Schnorr proof. The table's joint key is the sum
of the shares, `Y = Σ pk_i`, and the contract *checks* that sum rather than
trusting the number it was handed. It has to: the shuffle circuit honestly
proves re-randomisation under whatever key it is given, and each Schnorr proof
only says that seat knows its own secret. Nothing tied the two together until
the contract did.

**Shuffling.** The deck starts as 52 public ElGamal encryptions of the
canonical order. Each player in turn permutes and re-randomises the whole deck
and proves in Noir that the output is a permutation of the input under the
joint key, without revealing the permutation. The chain is `k = n`: every
player shuffles, so the deck is unknown to anyone unless *everyone* colludes.
The last player's proof is fused with the deck-opening proof — one transaction
instead of two, which is where 22.6 STRK per hand went.

**Dealing and showing.** Decryption is n-of-n. To read a card, each seat
publishes a partial decryption share with a DLEQ proof that it used the same
secret it registered — so a share cannot be faked or withheld silently. Your
hole cards are the two positions only *you* aggregate; the board is the five
everyone does.

**Money.** A table with a buy-in escrows chips at `join_table`; betting draws
them down; a seat that cannot cover may fold or push what it has, and
settlement splits the pot into layers so a short stack wins only what it
actually matched. Blinds can rise on a schedule. A player who loses their last
chip sits the next hand out rather than being dealt in and unable to act, and
when one player holds every chip the table closes and they cash out.

**STRK20.** `PokerGame` is an anonymizer contract: `privacy_invoke` is the
pool's phase-7 `InvokeExternal` hook, and the pool address is pinned in the
constructor — `privacy_invoke` asserts the caller *is* that address, after a
review found the original compared a caller-supplied argument against itself.
The intended flow is buy in from a shielded note and take the payout into an
open note, so the amounts move without the addresses. This is implemented and
tested against a mock pool; it has never run against the live one.

## What's inside

- `cairo/src/lib.cairo` — `PokerGame`. The table state machine, the shuffle
  chain, threshold reveals, betting, side pots, the blind ladder, the
  accusation and timeout paths, and `privacy_invoke`.
- `circuits/` — Noir circuits: `shuffle` (permutation + re-randomisation),
  `deck_open`, and `shuffle_open`, the fused proof the last shuffler submits.
  Their Cairo verifiers are generated by [Garaga](https://github.com/keep-starknet-strange/garaga).
- `src/` — the Next.js client. Proving runs **in the browser** via bb.js
  (WASM), so no server ever sees a shuffle or a key.
- `docs/PROTOCOL.md` — the design, and every hole found in it so far.
- `cairo/address.md` — every deployment, what it cost, and what was verified
  on-chain afterwards.
- `security-review-*.md` — eight review rounds. Findings are cited by number
  in the code at the line that fixes them.

## Running it

```bash
npm install
npm run dev            # http://localhost:3000/poker
```

Against a local devnet:

```bash
starknet-devnet --seed 0 --host 127.0.0.1 --port 5050
npm run deploy:local
npm run smoke:local
```

Cairo tests need [Scarb](https://docs.swmansion.com/scarb/) 2.18.0 and
`snforge`:

```bash
cd cairo && snforge test --features testing     # 282 tests
```

### Two players on two machines

A hole card needs a decryption share from every seat, and those shares have to
get between browsers. `scripts/relay.mjs` is a dumb pipe for them — it is
trusted with nothing, since every share is sealed to the recipient's
registered key and carries a DLEQ proof, so anyone including a player can host
it. Without one the client falls back to `BroadcastChannel`, which reaches
only other tabs of the same browser.

## What is not done

Listed because a README that omits them is not worth reading:

- **No mainnet deployment and no STRK20 pool transactions.** See above.
- **Liveness depends on every player.** n-of-n decryption means one player
  walking away stalls a hand. There are accusation and timeout paths that void
  the hand and refund, but "the hand is voided" is not the same as "the hand
  finishes".
- **Unaudited**, holding pooled funds across concurrent tables.
- `docs/PROTOCOL.md` §8 and §9 record the remaining trust and liveness gaps in
  detail.

## Links

[STRK20 by example](https://strk20-by-example.org/) ·
[Privacy SDK](https://github.com/starkware-libs/starknet-privacy) ·
[RFP](https://strk20.starknet.io/rfp/private-poker) ·
[Hackathon](https://strk20.starknet.io/hackathon)

Scaffolded from [Akashneelesh/strk20-starter-kit](https://github.com/Akashneelesh/strk20-starter-kit),
itself from [PhilippeR26/Starknet-WalletAccount](https://github.com/PhilippeR26/Starknet-WalletAccount).
The poker protocol, circuits, contract and client are this project's.

MIT licensed.
