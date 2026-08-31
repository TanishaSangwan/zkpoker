use starknet::ContractAddress;

// Must match privacy::objects::OpenNoteDeposit (positional Serde). Copied from
// the strk20-anonymizer-contracts skill: this is the shape `privacy_invoke`
// must return so the pool can fill the caller's open note.
#[derive(Serde, Copy, Drop, PartialEq, Debug)]
pub struct OpenNoteDeposit {
    pub note_id: felt252,
    pub token: ContractAddress,
    pub amount: u128,
}

#[starknet::interface]
pub trait IErc20<TState> {
    fn balance_of(self: @TState, account: ContractAddress) -> u256;
    fn approve(ref self: TState, spender: ContractAddress, amount: u256) -> bool;
    // Security review (2026-08-30 re-audit, Finding 2): bet() must pull real
    // funds instead of only incrementing table_pot, or a table's pot is
    // fabricable with no backing.
    fn transfer_from(ref self: TState, sender: ContractAddress, recipient: ContractAddress, amount: u256) -> bool;
    // Security review (round 3, Finding 2 fix): reclaim_stalled_bet refunds
    // a seat's own contribution directly, not via transfer_from.
    fn transfer(ref self: TState, recipient: ContractAddress, amount: u256) -> bool;
}

// Test-only mock ERC20 (configurable failure/fee/reentrancy behavior) used
// by cairo/tests/*.cairo. Compiled only for `scarb build --test` / `snforge
// test`, never shipped in the production `starknet-contract` build.
// pub: tests/ compiles as a separate crate and needs zkpoker::mocks::... .
#[cfg(test)]
pub mod mocks;

// Pure Texas Hold'em hand evaluation, used by
// PokerGame::settle_table_by_hand. Part of the production build (not
// cfg(test)-gated) — its own #[cfg(test)] unit tests are genuinely run via
// `scarb test -- -t unit` (see the module doc comment in poker_hand.cairo
// for why that works here but not for cairo/tests/).
pub mod poker_hand;

// ─────────────────────────────────────────────────────────────────────────
// PokerGame: the STRK20 anonymizer for provably-fair on-chain poker.
//
// Scope of this V1 skeleton (see ../../docs/DESIGN.md for the full writeup):
//
//   - Trusted-dealer commit/reveal fairness, not a shuffle-correctness STARK
//     circuit. The dealer commits hash(seed) before dealing; hole cards are
//     dealt off-chain as STRK20 encrypted notes (one per seat, via the pool's
//     normal CreateEncNote action — this contract does not touch card
//     content); at showdown the dealer reveals `seed` and anyone can
//     recompute the deal with scripts/deal_verify.py and check it against
//     the seat/note commitments recorded here.
//   - Bet/fold accounting and pot bookkeeping per table, structured into
//     real PreFlop/Flop/Turn/River/Showdown streets (`advance_street`).
//     `settle_table` still trusts an externally-supplied winner list;
//     `settle_table_by_hand` is the alternative that computes the winner
//     on-chain from revealed cards via the `poker_hand` module instead
//     (round 6 — see that module and the header note below for what it
//     does and doesn't yet guarantee).
//   - `privacy_invoke` is the pool's phase-7 (InvokeExternal) hook: it pays
//     a table's pot into the winner's *already-created* open note. Unlike
//     the starter kit's echo helper (which grabs "whatever balance we hold"
//     — fine for a single demo call), this contract can hold several tables'
//     funds at once, so payouts are tracked per note_id, not per balance.
//
// Security review (cairo-auditor, 2026-08-31): an initial pass found 2
// Critical, 1 High, 1 Medium, and 1 Low-confidence finding — all rooted in
// the contract trusting caller-supplied identity instead of anything pinned
// in storage. Fixed here: a constructor pins the real `pool` address
// (privacy_invoke no longer trusts its own `pool_address` argument);
// `create_table`/`settle_table` now enforce a per-table dealer and check
// `payout_note_ids` against real seat ownership; `settle_table` binds each
// payout to its table's token (`payout_token`) so `privacy_invoke` can
// refuse a mismatched token; `privacy_invoke` has a reentrancy lock around
// its external `balance_of` call; and settlement no longer strands the
// integer-division remainder. Follow-up (same date): `join_table` now
// records a `seat_owner`, and `bet`/`fold` require the caller to be that
// seat's owner; `commit_deal`/`mark_dealt`/`reveal_seed` require the caller
// to be the table's `table_dealer`.
//
// Re-audit round 2 of that follow-up found the identity checks held, but 2
// new Critical findings: (1) `bet` gated *identity* but not *value* — a
// self-dealt table could still fabricate a pot with no real transfer,
// drainable via privacy_invoke against the contract's shared per-token
// balance; fixed by having `bet` pull funds via `transfer_from` before
// crediting `table_pot`. (2) `pending_payout`/`payout_token` are keyed by
// bare `note_id` with no `table_id`, so an attacker could register a
// victim's real `note_id` on their own throwaway table and hijack that
// note's payout; fixed with a `note_id_owner` map, bound once at
// `join_table` and cross-checked in `settle_table`.
//
// Re-audit round 3 found: (1) `note_id_owner` fixed *identity* reuse but not
// *token* reuse — settling the same note_id at a second table in a
// different token silently relabeled an accumulated balance; fixed with a
// same-token check in `settle_table` before `payout_token` is (re)written.
// (2) round 2's `bet` fix meant real funds now sit in `table_pot` until
// `settle_table` runs, but only the fixed `table_dealer` could ever call
// it — an abandoned dealer permanently locked real funds; fixed with
// `reclaim_stalled_bet`, letting any seat reclaim its own contribution
// (tracked via `seat_contributed`) once `SETTLE_TIMEOUT_SECS` has passed
// since `create_table` and the table hasn't been settled (`table_settled`).
// (3) `bet`'s `transfer_from` call had no reentrancy lock and trusted the
// nominal `amount` over the real balance delta; fixed by taking
// `reentrancy_lock` in `bet` too and crediting only the measured delta.
//
// Re-audit round 4 (auditing round 3's new reclaim_stalled_bet code)
// confirmed rounds 1-3 hold, but found: (1) `bet`/`settle_table` never
// checked `table_settled` — a bet placed after settlement, or a second
// `settle_table` call, was possible, and post-settlement bets became
// permanently unreclaimable since `reclaim_stalled_bet` is itself gated on
// `!table_settled`; fixed by asserting `!table_settled` in both. (2)
// `settle_table` mutates the same state `bet`/`reclaim_stalled_bet`/
// `privacy_invoke` guard with `reentrancy_lock` around their external
// calls, but never checked the lock itself, so a dealer-controlled token
// could reenter it mid-`bet()`; fixed by asserting `!reentrancy_lock` at
// entry (no external calls happen inside `settle_table`, so checking,
// without also holding, the lock is sufficient).
//
// Re-audit round 5: full fresh pass across all four partitions, not just
// re-verification — confirmed every round 1-4 fix holds with no bypass and
// no regression (reentrancy_lock formally shown to never persist as true
// across a transaction boundary; the settle_table payout-sum identity
// proven to hold even with duplicate seats/note_ids in one call). One
// long-standing below-threshold item finally crossed the confidence bar:
// `privacy_invoke`'s `approve()` return value was unchecked, so a token
// returning `false` instead of reverting could zero `pending_payout` with
// no allowance actually granted and no recovery path; fixed by asserting
// the return value, matching the pattern already used for `transfer_from`
// (`bet`) and `transfer` (`reclaim_stalled_bet`).
//
// Still open (below round 5's confidence threshold, not attacker-
// exploitable, not yet fixed): the constructor doesn't reject a zero `pool`
// address.
//
// A test suite exists (cairo/tests/, cairo/src/mocks.cairo) but has not
// been run or even compile-checked — no snforge on this machine (no
// Windows binary, no Rust toolchain to build one). See
// cairo/tests/README.md before trusting any of it.
//
// Post round-5 hardening (not itself a cairo-auditor finding, but a known
// gap closed proactively): `reveal_seed` checked seed against its own
// commitment with a literal identity comparison through round 5
// (`computed_hash = seed`) — any seed value "verified" against itself, so
// `commit_deal` carried no real binding. Now uses
// `poseidon_hash_span(array![seed].span())`, matching what `commit_deal`'s
// doc comment specifies as the required off-chain construction. Existing
// tests referencing the old placeholder behavior were updated to match.
//
// Round 6 (feature work, not a security finding — NOT yet audited):
// multi-street betting (`advance_street`: PreFlop/Flop/Turn/River/Showdown,
// dealer-only, `bet` closes once Showdown is reached) and
// `settle_table_by_hand`, an on-chain-showdown alternative to
// `settle_table` that computes each seat's best 5-of-7 hand via the new
// `poker_hand` module and splits the pot among the actual strongest
// hand(s) instead of trusting a dealer-supplied winner list. `poker_hand`
// is genuinely unit-tested (19 tests, all passing — run with
// `scarb test -- -t unit`, no snforge needed for that module). The new
// contract entrypoints reuse settle_table's exact security patterns
// (dealer-only, reentrancy check, table_settled, note_id_owner/
// payout_token binding) but are new code and have NOT been through
// cairo-auditor. Known simplifications, documented in full on
// `advance_street`'s and `settle_table_by_hand`'s doc comments: no
// bet-matching/turn-order enforcement when advancing streets, and no
// on-chain link yet between the submitted hole cards and the seed
// commitment (that needs the shuffle-from-seed check to move on-chain
// too — see docs/DESIGN.md open items).
//
// Everything here remains unaudited beyond round 5 — round 6's new code
// (poseidon commitment fix, multi-street betting, settle_table_by_hand)
// has not been through cairo-auditor at all. Re-run it after any further
// change and before this touches a real pool.
// ─────────────────────────────────────────────────────────────────────────

#[starknet::interface]
pub trait IPokerGame<TState> {
    // ── Table lifecycle ────────────────────────────────────────────────
    // Dealer opens a table for a fixed buy-in, in a given token.
    fn create_table(ref self: TState, table_id: felt252, token: ContractAddress, buy_in: u128);

    // Player joins a seat. Actual buy-in shielding happens at the pool layer
    // (Deposit action); this just reserves the seat and records the note_id
    // the player will be dealt into.
    fn join_table(ref self: TState, table_id: felt252, seat: felt252, hole_card_note_id: felt252);

    // ── Fairness: commit / deal / reveal ───────────────────────────────
    // Dealer commits hash(seed) before any cards are dealt. `seed` itself
    // must stay secret until reveal_seed. `seed_hash` MUST equal
    // `core::poseidon::poseidon_hash_span(array![seed].span())` — reveal_seed
    // recomputes exactly that and reverts on any mismatch (Security review,
    // round 6: this was a literal identity-check placeholder through round 5,
    // documented as a known TODO; now a real commitment). Any off-chain
    // tooling that commits on the dealer's behalf (a future dealer service,
    // scripts/deal_verify.py if it grows a commit-side check) must hash the
    // same way — a single-element span containing the raw seed felt252, no
    // table_id or other domain separator mixed in. Reusing a literal seed
    // value across two different tables is a dealer mistake, not an
    // exploit: seed_hash is stored per table_id, so it doesn't create any
    // cross-table collision either party could act on.
    fn commit_deal(ref self: TState, table_id: felt252, seed_hash: felt252);

    // Dealer records that seats are dealt (hole-card notes already created
    // and encrypted to each player's channel key at the pool layer). This
    // only fixes *which seat got which note_id* on-chain — the card value
    // stays hidden inside that note until the player's viewing key decrypts
    // it, or until showdown reveal.
    fn mark_dealt(ref self: TState, table_id: felt252);

    // Dealer reveals the seed at showdown. Reverts if it doesn't hash to the
    // stored commitment. Once revealed, scripts/deal_verify.py (or any
    // observer) can recompute the shuffle from `seed` and check it against
    // the seat -> hole_card_note_id mapping recorded at join/deal time.
    fn reveal_seed(ref self: TState, table_id: felt252, seed: felt252);

    // ── Betting ─────────────────────────────────────────────────────────
    // Bet/call/raise. Amounts are intentionally public (poker needs public
    // pot math per the RFP's visibility table) — only identity and hole
    // cards are private. Reverts once the table has reached Showdown
    // (street 4) — see `advance_street`.
    fn bet(ref self: TState, table_id: felt252, seat: felt252, amount: u128);

    fn fold(ref self: TState, table_id: felt252, seat: felt252);

    // Security review (round 6): the pre-round-6 contract had exactly one
    // flat betting phase for a whole hand — no pre-flop/flop/turn/river
    // structure. This is a real (if minimal) multi-street model: 0=PreFlop,
    // 1=Flop, 2=Turn, 3=River, 4=Showdown. Dealer-only, one street forward
    // per call, no skipping. `bet` refuses once street reaches Showdown;
    // `settle_table_by_hand` requires it. What this does NOT do: enforce
    // that every active seat has matched the current street's bet before
    // advancing (no "all called or folded" check), and it doesn't gate any
    // actual on-chain community-card disclosure to a street boundary —
    // community cards, like hole cards, are only ever cryptographically
    // revealed once, at showdown, via the existing single `reveal_seed`
    // (see docs/DESIGN.md — progressive per-street reveal without a
    // trusted dealer is the RFP's own "aspirational" V2 problem, not
    // solved here). Streets are a real betting-round structure a frontend
    // can build on; they are not yet a fully-enforced betting engine.
    fn advance_street(ref self: TState, table_id: felt252);

    // Security review (round 6): on-chain showdown alternative to
    // `settle_table` — instead of trusting a dealer-supplied winner list,
    // the dealer (or anyone reconstructing the same public inputs) submits
    // the revealed hole cards for each non-folded seat plus the 5 revealed
    // community cards, and this function computes each seat's best 5-of-7
    // hand via `poker_hand::best_of_7` and splits the pot evenly among the
    // seat(s) with the strongest hand (remainder to the first tied
    // winner, same rule as `settle_table`). This removes "trust the
    // dealer's claimed winner" — the winner is now a deterministic
    // function of the submitted cards, checkable by anyone. It does NOT
    // remove "trust that the submitted cards are the cards actually dealt"
    // — that needs the shuffle-from-seed check to move on-chain too (see
    // docs/DESIGN.md open items; scripts/deal_verify.py does this
    // off-chain today). `seats`/`hole_cards`/`payout_note_ids` must be the
    // same length and in the same order; each seat must not be folded, and
    // requires `table_street == 4` (Showdown) — call `advance_street` four
    // times first. Shares every other guard `settle_table` has (dealer,
    // reentrancy, `table_settled`, `note_id_owner`/`payout_token` binding).
    fn settle_table_by_hand(
        ref self: TState,
        table_id: felt252,
        seats: Span<felt252>,
        hole_cards: Span<(u8, u8)>,
        community_cards: Span<u8>,
        payout_note_ids: Span<felt252>,
    );

    // Security review (round 3, Finding 2): the only way to move real funds
    // out of a table used to be settle_table, dealer-only with no timeout —
    // an absent/malicious dealer permanently locked real bettor funds. Any
    // seat can reclaim exactly what it personally contributed via bet(),
    // once the table has sat unsettled past SETTLE_TIMEOUT_SECS since
    // creation. No-op (reverts) once the table has been settled — a losing
    // seat's contribution legitimately became the winner's payout by then,
    // not a refund target.
    fn reclaim_stalled_bet(ref self: TState, table_id: felt252, seat: felt252);

    // ── Settlement ──────────────────────────────────────────────────────
    // TODO(hand-eval): winners is trusted input for this skeleton. Replace
    // with on-chain (or STARK-proven off-chain) hand evaluation once
    // showdown reveal logic is designed — see docs/DESIGN.md "Open items".
    // Splits the table's recorded pot evenly across `winners`' open notes
    // and marks each amount owed. The pool's privacy_invoke call (below)
    // is what actually moves the tokens once those open notes exist.
    fn settle_table(
        ref self: TState, table_id: felt252, winners: Span<felt252>, payout_note_ids: Span<felt252>,
    );

    // Called by the pool via selector!("privacy_invoke") during phase 7
    // (InvokeExternal / ComputeAndInvoke) to fill one winner's open note.
    fn privacy_invoke(
        ref self: TState,
        token: ContractAddress, // STRK/USDC address (literal felt in calldata)
        pool_address: ContractAddress, // wallet placeholder: poolAddress
        note_id: felt252, // wallet placeholder: openNoteIds[0] — the note to fill
    ) -> Span<OpenNoteDeposit>;

    // ── Views ───────────────────────────────────────────────────────────
    fn get_pot(self: @TState, table_id: felt252) -> u128;
    fn get_seed_hash(self: @TState, table_id: felt252) -> felt252;
    fn get_revealed_seed(self: @TState, table_id: felt252) -> felt252;
    fn get_seat_note(self: @TState, table_id: felt252, seat: felt252) -> felt252;
    fn get_pending_payout(self: @TState, note_id: felt252) -> u128;
    fn get_pool(self: @TState) -> ContractAddress;
    fn get_table_dealer(self: @TState, table_id: felt252) -> ContractAddress;
    fn get_seat_owner(self: @TState, table_id: felt252, seat: felt252) -> ContractAddress;
    fn get_note_id_owner(self: @TState, note_id: felt252) -> ContractAddress;
    fn get_table_created_at(self: @TState, table_id: felt252) -> u64;
    fn get_seat_contributed(self: @TState, table_id: felt252, seat: felt252) -> u128;
    fn get_table_settled(self: @TState, table_id: felt252) -> bool;
    fn get_table_street(self: @TState, table_id: felt252) -> u8;
}

// pub: tests/ compiles as a separate crate and needs zkpoker::PokerGame::
// Event::... for event assertions (spy_events + assert_emitted).
#[starknet::contract]
pub mod PokerGame {
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use core::num::traits::Zero;
    use core::poseidon::poseidon_hash_span;
    use starknet::{ContractAddress, get_block_timestamp, get_caller_address, get_contract_address};
    use super::{IErc20Dispatcher, IErc20DispatcherTrait, OpenNoteDeposit};

    mod errors {
        pub const BAD_POOL: felt252 = 'BAD_POOL';
        pub const NO_INPUT: felt252 = 'NO_INPUT';
        pub const AMOUNT_OVERFLOW: felt252 = 'AMOUNT_OVERFLOW';
        pub const TABLE_EXISTS: felt252 = 'TABLE_EXISTS';
        pub const NO_TABLE: felt252 = 'NO_TABLE';
        pub const ALREADY_COMMITTED: felt252 = 'ALREADY_COMMITTED';
        pub const NOT_COMMITTED: felt252 = 'NOT_COMMITTED';
        pub const SEED_MISMATCH: felt252 = 'SEED_MISMATCH';
        pub const ALREADY_REVEALED: felt252 = 'ALREADY_REVEALED';
        pub const SEAT_TAKEN: felt252 = 'SEAT_TAKEN';
        pub const FOLDED: felt252 = 'SEAT_FOLDED';
        pub const LEN_MISMATCH: felt252 = 'LEN_MISMATCH';
        pub const NO_PAYOUT: felt252 = 'NO_PAYOUT_FOR_NOTE';
        pub const BAD_TOKEN: felt252 = 'BAD_TOKEN';
        pub const NOT_DEALER: felt252 = 'NOT_DEALER';
        pub const REENTRANCY: felt252 = 'REENTRANCY';
        pub const NOT_SEAT_OWNER: felt252 = 'NOT_SEAT_OWNER';
        pub const NOTE_ID_TAKEN: felt252 = 'NOTE_ID_TAKEN';
        pub const TRANSFER_FAILED: felt252 = 'TRANSFER_FAILED';
        pub const TOO_EARLY: felt252 = 'TOO_EARLY';
        pub const ALREADY_SETTLED: felt252 = 'ALREADY_SETTLED';
        pub const BETTING_CLOSED: felt252 = 'BETTING_CLOSED';
        pub const NOT_SHOWDOWN: felt252 = 'NOT_SHOWDOWN';
        pub const BAD_CARDS: felt252 = 'BAD_CARDS';
    }

    // Security review (round 3, Finding 2): how long a table may sit
    // unsettled before its players can reclaim their own contributions via
    // reclaim_stalled_bet. 24h — a starting point, not a value validated
    // against real game-session lengths yet.
    const SETTLE_TIMEOUT_SECS: u64 = 86400;

    // Street ordinals (round 6): 0=PreFlop, 1=Flop, 2=Turn, 3=River,
    // 4=Showdown. `table_street` defaults to 0 for any table that never
    // calls `advance_street` — `bet` stays open the whole time in that
    // case, so this is backward compatible with a table that just wants
    // one flat betting phase, matching every pre-round-6 test/usage.
    const SHOWDOWN_STREET: u8 = 4;

    #[storage]
    struct Storage {
        // Security review (2026-08-31, cairo-auditor): pinned once at deploy
        // time. privacy_invoke must trust only this, never a caller-supplied
        // parameter — see Finding 1 in the audit report.
        pool: ContractAddress,
        // table_id -> table metadata
        table_token: Map<felt252, ContractAddress>,
        table_buy_in: Map<felt252, u128>,
        table_pot: Map<felt252, u128>,
        table_exists: Map<felt252, bool>,
        // table_id -> the address permitted to advance/settle it (Finding 2).
        table_dealer: Map<felt252, ContractAddress>,
        // table_id -> commit/reveal state
        seed_hash: Map<felt252, felt252>,
        seed_committed: Map<felt252, bool>,
        revealed_seed: Map<felt252, felt252>,
        seed_revealed: Map<felt252, bool>,
        dealt: Map<felt252, bool>,
        // (table_id, seat) -> hole_card_note_id, and the reverse seat-taken flag
        seat_note: Map<(felt252, felt252), felt252>,
        seat_taken: Map<(felt252, felt252), bool>,
        seat_folded: Map<(felt252, felt252), bool>,
        // (table_id, seat) -> the address that joined it; bet/fold on that
        // seat are only accepted from this address.
        seat_owner: Map<(felt252, felt252), ContractAddress>,
        // note_id -> the address that first registered it via join_table.
        // pending_payout/payout_token are keyed by bare note_id with no
        // table_id, so without this, any account could reuse a note_id
        // it doesn't own from another table and hijack that note's payout.
        note_id_owner: Map<felt252, ContractAddress>,
        // note_id -> amount owed, cleared once privacy_invoke pays it out
        pending_payout: Map<felt252, u128>,
        // note_id -> the token that payout is denominated in (Finding 1).
        payout_token: Map<felt252, ContractAddress>,
        // Guards privacy_invoke's (and, as of round 3, bet's) external calls.
        reentrancy_lock: bool,
        // table_id -> block timestamp at create_table, for the
        // reclaim_stalled_bet timeout (round 3, Finding 2).
        table_created_at: Map<felt252, u64>,
        // (table_id, seat) -> total this seat has personally contributed via
        // bet(), refundable through reclaim_stalled_bet if the table stalls.
        seat_contributed: Map<(felt252, felt252), u128>,
        // table_id -> true once settle_table has run for it. Blocks
        // reclaim_stalled_bet after a hand legitimately resolved — a
        // losing seat's contribution became the winner's payout by then.
        table_settled: Map<felt252, bool>,
        // table_id -> current betting street (round 6). 0=PreFlop by
        // default; see SHOWDOWN_STREET and `advance_street`.
        table_street: Map<felt252, u8>,
    }

    #[constructor]
    fn constructor(ref self: ContractState, pool: ContractAddress) {
        self.pool.write(pool);
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        TableCreated: TableCreated,
        SeatJoined: SeatJoined,
        DealCommitted: DealCommitted,
        Dealt: Dealt,
        SeedRevealed: SeedRevealed,
        Bet: Bet,
        Fold: Fold,
        Settled: Settled,
        Invoked: Invoked,
        Reclaimed: Reclaimed,
        StreetAdvanced: StreetAdvanced,
    }

    #[derive(Drop, starknet::Event)]
    struct TableCreated {
        #[key]
        table_id: felt252,
        token: ContractAddress,
        buy_in: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct SeatJoined {
        #[key]
        table_id: felt252,
        seat: felt252,
        hole_card_note_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct DealCommitted {
        #[key]
        table_id: felt252,
        seed_hash: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct Dealt {
        #[key]
        table_id: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct SeedRevealed {
        #[key]
        table_id: felt252,
        seed: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct Bet {
        #[key]
        table_id: felt252,
        seat: felt252,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct Fold {
        #[key]
        table_id: felt252,
        seat: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct Settled {
        #[key]
        table_id: felt252,
        winner_count: u32,
    }

    #[derive(Drop, starknet::Event)]
    struct Invoked {
        #[key]
        note_id: felt252,
        amount: u128,
        caller: ContractAddress,
    }

    #[derive(Drop, starknet::Event)]
    struct Reclaimed {
        #[key]
        table_id: felt252,
        seat: felt252,
        amount: u128,
    }

    #[derive(Drop, starknet::Event)]
    struct StreetAdvanced {
        #[key]
        table_id: felt252,
        street: u8,
    }

    #[abi(embed_v0)]
    impl PokerGameImpl of super::IPokerGame<ContractState> {
        fn create_table(ref self: ContractState, table_id: felt252, token: ContractAddress, buy_in: u128) {
            assert(!self.table_exists.entry(table_id).read(), errors::TABLE_EXISTS);
            self.table_exists.entry(table_id).write(true);
            self.table_token.entry(table_id).write(token);
            self.table_buy_in.entry(table_id).write(buy_in);
            // Security review Finding 2: the caller becomes this table's
            // dealer — the only address settle_table will later accept.
            self.table_dealer.entry(table_id).write(get_caller_address());
            // Security review (round 3, Finding 2): starts the clock for
            // reclaim_stalled_bet's timeout.
            self.table_created_at.entry(table_id).write(get_block_timestamp());
            self.emit(TableCreated { table_id, token, buy_in });
        }

        fn join_table(ref self: ContractState, table_id: felt252, seat: felt252, hole_card_note_id: felt252) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            let key = (table_id, seat);
            assert(!self.seat_taken.entry(key).read(), errors::SEAT_TAKEN);
            self.seat_taken.entry(key).write(true);
            self.seat_note.entry(key).write(hole_card_note_id);
            // Security review follow-up: record who occupies this seat so
            // bet/fold can be restricted to them. The caller here is the
            // account that submitted the join — a fresh/shadow account per
            // STRK20's privacy model, same as any other player action; this
            // doesn't add any new identity leakage beyond what's already
            // on-chain for the join call itself.
            let caller = get_caller_address();
            self.seat_owner.entry(key).write(caller);
            // Security review (2026-08-30 re-audit, Finding 1): bind this
            // note_id to whoever registers it first. pending_payout and
            // payout_token are keyed by bare note_id with no table_id, so
            // without this, a different account could reuse a note_id it
            // doesn't own — copied from someone else's real table — to
            // hijack that note's eventual payout via its own settle_table.
            let existing_owner = self.note_id_owner.entry(hole_card_note_id).read();
            if existing_owner.is_zero() {
                self.note_id_owner.entry(hole_card_note_id).write(caller);
            } else {
                assert(existing_owner == caller, errors::NOTE_ID_TAKEN);
            }
            self.emit(SeatJoined { table_id, seat, hole_card_note_id });
        }

        fn commit_deal(ref self: ContractState, table_id: felt252, seed_hash: felt252) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            // Security review follow-up: only the table's dealer may commit
            // a deal — otherwise anyone could overwrite the fairness
            // commitment for a table they don't run.
            assert(get_caller_address() == self.table_dealer.entry(table_id).read(), errors::NOT_DEALER);
            assert(!self.seed_committed.entry(table_id).read(), errors::ALREADY_COMMITTED);
            self.seed_hash.entry(table_id).write(seed_hash);
            self.seed_committed.entry(table_id).write(true);
            self.emit(DealCommitted { table_id, seed_hash });
        }

        fn mark_dealt(ref self: ContractState, table_id: felt252) {
            // Security review follow-up: dealer-only, same reasoning as
            // commit_deal/reveal_seed — this is a dealer-authored claim
            // about the table's fairness state.
            assert(get_caller_address() == self.table_dealer.entry(table_id).read(), errors::NOT_DEALER);
            assert(self.seed_committed.entry(table_id).read(), errors::NOT_COMMITTED);
            self.dealt.entry(table_id).write(true);
            self.emit(Dealt { table_id });
        }

        fn reveal_seed(ref self: ContractState, table_id: felt252, seed: felt252) {
            // Security review follow-up: only the dealer can reveal — a
            // third party guessing or front-running the real seed would
            // otherwise be indistinguishable from the dealer's own reveal.
            assert(get_caller_address() == self.table_dealer.entry(table_id).read(), errors::NOT_DEALER);
            assert(self.seed_committed.entry(table_id).read(), errors::NOT_COMMITTED);
            assert(!self.seed_revealed.entry(table_id).read(), errors::ALREADY_REVEALED);
            // Security review (round 6): this was a literal identity check
            // (`computed_hash = seed`) through round 5 — any seed value
            // would "verify" against itself, so `commit_deal` carried no
            // real binding at all. Now a genuine Poseidon commitment: the
            // dealer must have committed
            // `poseidon_hash_span(array![seed].span())` as `seed_hash` in
            // `commit_deal`; a mismatched `seed` reverts here instead of
            // silently passing. See the `commit_deal` doc comment for the
            // exact off-chain construction any dealer tooling must match.
            let computed_hash = poseidon_hash_span(array![seed].span());
            assert(computed_hash == self.seed_hash.entry(table_id).read(), errors::SEED_MISMATCH);
            self.revealed_seed.entry(table_id).write(seed);
            self.seed_revealed.entry(table_id).write(true);
            self.emit(SeedRevealed { table_id, seed });
        }

        fn bet(ref self: ContractState, table_id: felt252, seat: felt252, amount: u128) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            // Security review (round 4, Finding 1): a bet placed after
            // settle_table has already run would accumulate in table_pot/
            // seat_contributed with no way out — reclaim_stalled_bet is
            // itself gated on !table_settled, so a post-settlement bet was
            // permanently unrecoverable. Block it at the source instead.
            assert(!self.table_settled.entry(table_id).read(), errors::ALREADY_SETTLED);
            // Security review (round 6): once a table reaches Showdown,
            // betting is over — only settle_table/settle_table_by_hand
            // should move the pot from here on.
            assert(self.table_street.entry(table_id).read() != SHOWDOWN_STREET, errors::BETTING_CLOSED);
            // Security review follow-up: only the address that joined this
            // seat may bet on it — previously any caller could inflate any
            // table's pot for any seat with no real funds behind it.
            let caller = get_caller_address();
            assert(caller == self.seat_owner.entry((table_id, seat)).read(), errors::NOT_SEAT_OWNER);
            assert(!self.seat_folded.entry((table_id, seat)).read(), errors::FOLDED);
            // Security review (round 3, Finding 3): table_token is pinned
            // once by whoever called create_table, with no allowlist, so
            // this call is to a caller-controlled contract in general.
            // Block it from reentering bet/privacy_invoke mid-call — the
            // prior version credited table_pot only *after* this call with
            // no lock at all.
            assert(!self.reentrancy_lock.read(), errors::REENTRANCY);
            self.reentrancy_lock.write(true);

            // Security review (round 3, Finding 4): a malicious or
            // fee-on-transfer token could report success while moving less
            // than `amount` (or nothing at all) — measure the real balance
            // delta instead of trusting the nominal parameter.
            let token = self.table_token.entry(table_id).read();
            let erc20 = IErc20Dispatcher { contract_address: token };
            let balance_before: u256 = erc20.balance_of(get_contract_address());
            let transferred = erc20.transfer_from(caller, get_contract_address(), amount.into());
            assert(transferred, errors::TRANSFER_FAILED);
            let balance_after: u256 = erc20.balance_of(get_contract_address());
            let received: u128 = (balance_after - balance_before).try_into().expect(errors::AMOUNT_OVERFLOW);

            let pot_entry = self.table_pot.entry(table_id);
            pot_entry.write(pot_entry.read() + received);
            // Security review (round 3, Finding 2): tracks what this seat
            // can reclaim via reclaim_stalled_bet if the table never settles.
            let contributed_entry = self.seat_contributed.entry((table_id, seat));
            contributed_entry.write(contributed_entry.read() + received);
            self.emit(Bet { table_id, seat, amount: received });

            self.reentrancy_lock.write(false);
        }

        fn reclaim_stalled_bet(ref self: ContractState, table_id: felt252, seat: felt252) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            assert(!self.table_settled.entry(table_id).read(), errors::ALREADY_SETTLED);
            let caller = get_caller_address();
            assert(caller == self.seat_owner.entry((table_id, seat)).read(), errors::NOT_SEAT_OWNER);
            let created_at = self.table_created_at.entry(table_id).read();
            assert(get_block_timestamp() >= created_at + SETTLE_TIMEOUT_SECS, errors::TOO_EARLY);

            let key = (table_id, seat);
            let owed = self.seat_contributed.entry(key).read();
            assert(owed != 0, errors::NO_PAYOUT);

            assert(!self.reentrancy_lock.read(), errors::REENTRANCY);
            self.reentrancy_lock.write(true);

            // Effects before the external transfer call below — unlike
            // bet(), the amount owed is already known, so there's no need
            // to wait on a post-call balance read the way bet() does.
            self.seat_contributed.entry(key).write(0);
            let pot_entry = self.table_pot.entry(table_id);
            let current_pot = pot_entry.read();
            // Saturating: a settled table can't reach here (blocked above),
            // so current_pot should always be >= owed, but don't underflow
            // if some future path changes that invariant.
            let new_pot = if current_pot >= owed {
                current_pot - owed
            } else {
                0
            };
            pot_entry.write(new_pot);

            let token = self.table_token.entry(table_id).read();
            let erc20 = IErc20Dispatcher { contract_address: token };
            let sent = erc20.transfer(caller, owed.into());
            assert(sent, errors::TRANSFER_FAILED);

            self.emit(Reclaimed { table_id, seat, amount: owed });
            self.reentrancy_lock.write(false);
        }

        fn fold(ref self: ContractState, table_id: felt252, seat: felt252) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            // Security review follow-up: same seat-ownership check as bet —
            // previously any caller could force-fold any seat at any table.
            assert(get_caller_address() == self.seat_owner.entry((table_id, seat)).read(), errors::NOT_SEAT_OWNER);
            self.seat_folded.entry((table_id, seat)).write(true);
            self.emit(Fold { table_id, seat });
        }

        fn advance_street(ref self: ContractState, table_id: felt252) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            assert(!self.table_settled.entry(table_id).read(), errors::ALREADY_SETTLED);
            assert(get_caller_address() == self.table_dealer.entry(table_id).read(), errors::NOT_DEALER);
            let street_entry = self.table_street.entry(table_id);
            let current = street_entry.read();
            assert(current != SHOWDOWN_STREET, errors::BETTING_CLOSED);
            let next = current + 1;
            street_entry.write(next);
            self.emit(StreetAdvanced { table_id, street: next });
        }

        fn settle_table(
            ref self: ContractState, table_id: felt252, winners: Span<felt252>, payout_note_ids: Span<felt252>,
        ) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            // Security review (round 4, Finding 1): a table could otherwise
            // be settled more than once — a second call after new bets
            // landed could redirect that fresh pot independent of the
            // earlier legitimate settlement.
            assert(!self.table_settled.entry(table_id).read(), errors::ALREADY_SETTLED);
            // Security review (round 4, Finding 2): settle_table mutates
            // the same table_pot/pending_payout state that bet()/
            // reclaim_stalled_bet()/privacy_invoke() guard with
            // reentrancy_lock around their external calls, but never
            // checked the lock itself — a dealer-controlled token could
            // reenter here mid-bet() and settle a stale pot before the
            // in-flight call's own contribution landed. No external calls
            // happen in this function, so checking (not also holding) the
            // lock is enough.
            assert(!self.reentrancy_lock.read(), errors::REENTRANCY);
            // Security review Finding 2: only the table's own dealer may
            // settle it — otherwise any caller could redirect the pot to a
            // note it controls.
            assert(get_caller_address() == self.table_dealer.entry(table_id).read(), errors::NOT_DEALER);
            assert(winners.len() == payout_note_ids.len(), errors::LEN_MISMATCH);
            assert(winners.len() != 0, errors::NO_INPUT);

            let token = self.table_token.entry(table_id).read();
            let pot = self.table_pot.entry(table_id).read();
            let share: u128 = pot / winners.len().into();
            // Security review Finding 4: the integer-division remainder was
            // previously dropped on the floor while table_pot was zeroed
            // regardless — route it into the first winner's payout instead
            // of stranding it in the contract with no owner.
            let remainder: u128 = pot - share * winners.len().into();
            let mut i: u32 = 0;
            loop {
                if i == payout_note_ids.len() {
                    break;
                }
                let note_id = *payout_note_ids.at(i);
                // Security review Finding 2: payout_note_ids must actually
                // belong to the seat named in winners, or an attacker could
                // name a legitimate winning seat but redirect its payout to
                // an unrelated note it controls.
                let seat = *winners.at(i);
                assert(self.seat_note.entry((table_id, seat)).read() == note_id, errors::NO_TABLE);
                // Security review (2026-08-30 re-audit, Finding 1): the
                // check above only confirms note_id belongs to *some* seat
                // at *this* table — it doesn't stop an attacker from having
                // registered someone else's note_id via join_table on a
                // throwaway table of their own. Cross-check against the
                // note_id's registered owner (bound once, at join_table).
                assert(
                    self.note_id_owner.entry(note_id).read() == self.seat_owner.entry((table_id, seat)).read(),
                    errors::NOTE_ID_TAKEN,
                );
                // Security review (round 3, Finding 1): note_id_owner above
                // only checked that the same *address* re-registered this
                // note_id — it says nothing about the *token*. Without this
                // guard, settling a second (even zero-pot) table for the
                // same note_id in a different token silently relabels an
                // already-accumulated balance into that new token.
                let existing_pending = self.pending_payout.entry(note_id).read();
                let existing_token = self.payout_token.entry(note_id).read();
                assert(existing_pending == 0 || existing_token == token, errors::BAD_TOKEN);
                // Security review Finding 1: bind this payout to the
                // table's token so privacy_invoke can refuse a mismatched
                // token supplied by an untrusted caller.
                self.payout_token.entry(note_id).write(token);
                let bump = if i == 0 { share + remainder } else { share };
                let entry = self.pending_payout.entry(note_id);
                entry.write(entry.read() + bump);
                i += 1;
            };
            self.table_pot.entry(table_id).write(0);
            // Security review (round 3, Finding 2): blocks
            // reclaim_stalled_bet from running against a table that
            // legitimately resolved — losing seats' contributions are now
            // the winners' payout, not a refund target.
            self.table_settled.entry(table_id).write(true);
            self.emit(Settled { table_id, winner_count: winners.len() });
        }

        fn settle_table_by_hand(
            ref self: ContractState,
            table_id: felt252,
            seats: Span<felt252>,
            hole_cards: Span<(u8, u8)>,
            community_cards: Span<u8>,
            payout_note_ids: Span<felt252>,
        ) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            assert(!self.table_settled.entry(table_id).read(), errors::ALREADY_SETTLED);
            assert(!self.reentrancy_lock.read(), errors::REENTRANCY);
            assert(get_caller_address() == self.table_dealer.entry(table_id).read(), errors::NOT_DEALER);
            assert(self.table_street.entry(table_id).read() == SHOWDOWN_STREET, errors::NOT_SHOWDOWN);
            assert(seats.len() == hole_cards.len(), errors::LEN_MISMATCH);
            assert(seats.len() == payout_note_ids.len(), errors::LEN_MISMATCH);
            assert(seats.len() != 0, errors::NO_INPUT);
            assert(community_cards.len() == 5, errors::BAD_CARDS);

            let n = seats.len();

            // Pass 1: verify each seat exactly as settle_table does (real
            // seat/note ownership, not folded), then score its best 5-of-7
            // hand from its submitted hole cards + the shared community
            // cards. Verifying and scoring in the same pass keeps this at
            // one loop instead of two, but the checks below are otherwise
            // identical to settle_table's per-winner checks.
            let mut scores: Array<u64> = array![];
            let mut i: u32 = 0;
            loop {
                if i == n {
                    break;
                }
                let seat = *seats.at(i);
                let note_id = *payout_note_ids.at(i);
                assert(self.seat_note.entry((table_id, seat)).read() == note_id, errors::NO_TABLE);
                assert(
                    self.note_id_owner.entry(note_id).read() == self.seat_owner.entry((table_id, seat)).read(),
                    errors::NOTE_ID_TAKEN,
                );
                assert(!self.seat_folded.entry((table_id, seat)).read(), errors::FOLDED);

                let (h1, h2) = *hole_cards.at(i);
                let mut seven: Array<u8> = array![h1, h2];
                let mut k: u32 = 0;
                loop {
                    if k == 5 {
                        break;
                    }
                    seven.append(*community_cards.at(k));
                    k += 1;
                };
                scores.append(super::poker_hand::best_of_7(seven.span()));
                i += 1;
            };
            let scores_span = scores.span();

            // Pass 2: find the max score, then collect every seat index
            // that reached it (ties split the pot — see below).
            let mut max_score: u64 = 0;
            let mut j: u32 = 0;
            loop {
                if j == n {
                    break;
                }
                let s = *scores_span.at(j);
                if s > max_score {
                    max_score = s;
                }
                j += 1;
            };
            let mut winner_idxs: Array<u32> = array![];
            let mut m: u32 = 0;
            loop {
                if m == n {
                    break;
                }
                if *scores_span.at(m) == max_score {
                    winner_idxs.append(m);
                }
                m += 1;
            };
            let widx = winner_idxs.span();

            // Pass 3: distribute the pot among the winner(s) — identical
            // token-binding and remainder rules to settle_table.
            let token = self.table_token.entry(table_id).read();
            let pot = self.table_pot.entry(table_id).read();
            let num_winners: u128 = widx.len().into();
            let share: u128 = pot / num_winners;
            let remainder: u128 = pot - share * num_winners;
            let mut w: u32 = 0;
            loop {
                if w == widx.len() {
                    break;
                }
                let idx = *widx.at(w);
                let note_id = *payout_note_ids.at(idx);
                let existing_pending = self.pending_payout.entry(note_id).read();
                let existing_token = self.payout_token.entry(note_id).read();
                assert(existing_pending == 0 || existing_token == token, errors::BAD_TOKEN);
                self.payout_token.entry(note_id).write(token);
                let bump = if w == 0 {
                    share + remainder
                } else {
                    share
                };
                let entry = self.pending_payout.entry(note_id);
                entry.write(entry.read() + bump);
                w += 1;
            };
            self.table_pot.entry(table_id).write(0);
            self.table_settled.entry(table_id).write(true);
            self.emit(Settled { table_id, winner_count: widx.len() });
        }

        fn privacy_invoke(
            ref self: ContractState,
            token: ContractAddress,
            pool_address: ContractAddress,
            note_id: felt252,
        ) -> Span<OpenNoteDeposit> {
            // Security review Finding 3: guard against a malicious `token`
            // reentering bet()/settle_table()/create_table() (none of which
            // carry their own lock) via the balance_of call below, before
            // pending_payout is finalized.
            assert(!self.reentrancy_lock.read(), errors::REENTRANCY);
            self.reentrancy_lock.write(true);

            let caller = get_caller_address();
            // Security review Finding 1: `pool_address` is a caller-supplied
            // argument and must never be trusted on its own — the original
            // `assert(pool_address == caller, ...)` was a tautology anyone
            // could satisfy by passing their own address. Compare against
            // the pool address pinned in storage at deploy time instead.
            assert(caller == self.pool.read(), errors::BAD_POOL);

            let owed = self.pending_payout.entry(note_id).read();
            assert(owed != 0, errors::NO_PAYOUT);
            // Security review Finding 1: refuse a token that doesn't match
            // what settle_table recorded for this note, so a caller can't
            // redirect the approval to an unrelated ERC20 the contract
            // happens to hold a balance in.
            assert(token == self.payout_token.entry(note_id).read(), errors::BAD_TOKEN);

            let erc20 = IErc20Dispatcher { contract_address: token };
            let balance: u256 = erc20.balance_of(get_contract_address());
            let balance_u128: u128 = balance.try_into().expect(errors::AMOUNT_OVERFLOW);
            assert(balance_u128 >= owed, errors::NO_INPUT);

            // Only approve/clear what this note is actually owed — this
            // contract may be holding other tables' funds concurrently.
            self.pending_payout.entry(note_id).write(0);
            // Security review (round 5, Finding 1): a token whose approve()
            // returns false instead of reverting would otherwise let this
            // proceed as if the payout succeeded, with pending_payout
            // already zeroed and no recovery path — same pattern already
            // guarded for transfer_from (bet) and transfer (reclaim_stalled_bet).
            let approved = erc20.approve(self.pool.read(), owed.into());
            assert(approved, errors::TRANSFER_FAILED);

            self.emit(Invoked { note_id, amount: owed, caller });

            self.reentrancy_lock.write(false);
            array![OpenNoteDeposit { note_id, token, amount: owed }].span()
        }

        fn get_pot(self: @ContractState, table_id: felt252) -> u128 {
            self.table_pot.entry(table_id).read()
        }

        fn get_seed_hash(self: @ContractState, table_id: felt252) -> felt252 {
            self.seed_hash.entry(table_id).read()
        }

        fn get_revealed_seed(self: @ContractState, table_id: felt252) -> felt252 {
            self.revealed_seed.entry(table_id).read()
        }

        fn get_seat_note(self: @ContractState, table_id: felt252, seat: felt252) -> felt252 {
            self.seat_note.entry((table_id, seat)).read()
        }

        fn get_pending_payout(self: @ContractState, note_id: felt252) -> u128 {
            self.pending_payout.entry(note_id).read()
        }

        fn get_pool(self: @ContractState) -> ContractAddress {
            self.pool.read()
        }

        fn get_table_dealer(self: @ContractState, table_id: felt252) -> ContractAddress {
            self.table_dealer.entry(table_id).read()
        }

        fn get_seat_owner(self: @ContractState, table_id: felt252, seat: felt252) -> ContractAddress {
            self.seat_owner.entry((table_id, seat)).read()
        }

        fn get_note_id_owner(self: @ContractState, note_id: felt252) -> ContractAddress {
            self.note_id_owner.entry(note_id).read()
        }

        fn get_table_created_at(self: @ContractState, table_id: felt252) -> u64 {
            self.table_created_at.entry(table_id).read()
        }

        fn get_seat_contributed(self: @ContractState, table_id: felt252, seat: felt252) -> u128 {
            self.seat_contributed.entry((table_id, seat)).read()
        }

        fn get_table_settled(self: @ContractState, table_id: felt252) -> bool {
            self.table_settled.entry(table_id).read()
        }

        fn get_table_street(self: @ContractState, table_id: felt252) -> u8 {
            self.table_street.entry(table_id).read()
        }
    }
}
