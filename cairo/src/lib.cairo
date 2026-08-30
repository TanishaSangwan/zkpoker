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
}

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
//   - Bet/fold accounting and pot bookkeeping per table. Multi-street betting
//     (pre-flop/flop/turn/river) and hand ranking are NOT implemented here —
//     `settle_table` currently trusts an externally-supplied winner list.
//     That's the next real chunk of work, not a privacy-layer concern.
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
// Re-audit (2026-08-30) of that follow-up found the identity checks held,
// but 2 new Critical findings: (1) `bet` gated *identity* but not *value* —
// a self-dealt table could still fabricate a pot with no real transfer,
// drainable via privacy_invoke against the contract's shared per-token
// balance; fixed by having `bet` pull funds via `transfer_from` before
// crediting `table_pot`. (2) `pending_payout`/`payout_token` are keyed by
// bare `note_id` with no `table_id`, so an attacker could register a
// victim's real `note_id` on their own throwaway table and hijack that
// note's payout; fixed with a `note_id_owner` map, bound once at
// `join_table` and cross-checked in `settle_table`. Also flagged
// (below-threshold, not yet fixed): no recovery path if a dealer goes dark
// or `pool` needs rotating, and the constructor doesn't reject a zero
// `pool` address.
//
// Still open: the unchecked `approve()` return value (Low-confidence).
// Everything here remains unaudited beyond that pass — re-run cairo-auditor
// after any further change before this touches a real pool.
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
    // must stay secret until reveal_seed.
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
    // cards are private.
    fn bet(ref self: TState, table_id: felt252, seat: felt252, amount: u128);

    fn fold(ref self: TState, table_id: felt252, seat: felt252);

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
}

#[starknet::contract]
mod PokerGame {
    use starknet::storage::{
        Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use core::num::traits::Zero;
    use starknet::{ContractAddress, get_caller_address, get_contract_address};
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
    }

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
        // Guards privacy_invoke's external balance_of call (Finding 3).
        reentrancy_lock: bool,
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
            // TODO(hash-choice): pick and pin the actual commitment hash (e.g.
            // Poseidon, to match the pool's own hashing) before this leaves
            // skeleton stage. Placeholder equality check below documents the
            // intended shape; wire in the real hash before relying on it.
            let computed_hash = seed; // TODO: replace with poseidon_hash_span or similar
            assert(computed_hash == self.seed_hash.entry(table_id).read(), errors::SEED_MISMATCH);
            self.revealed_seed.entry(table_id).write(seed);
            self.seed_revealed.entry(table_id).write(true);
            self.emit(SeedRevealed { table_id, seed });
        }

        fn bet(ref self: ContractState, table_id: felt252, seat: felt252, amount: u128) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            // Security review follow-up: only the address that joined this
            // seat may bet on it — previously any caller could inflate any
            // table's pot for any seat with no real funds behind it.
            let caller = get_caller_address();
            assert(caller == self.seat_owner.entry((table_id, seat)).read(), errors::NOT_SEAT_OWNER);
            assert(!self.seat_folded.entry((table_id, seat)).read(), errors::FOLDED);
            // Security review (2026-08-30 re-audit, Finding 2): the
            // seat-ownership check above only gates *identity* — it says
            // nothing about *value*. Without pulling real funds here,
            // table_pot was fabricable by anyone acting as their own
            // dealer/seat-owner, then drainable via privacy_invoke against
            // the contract's shared balance for that token. The caller must
            // approve this contract for at least `amount` beforehand.
            let token = self.table_token.entry(table_id).read();
            let erc20 = IErc20Dispatcher { contract_address: token };
            let transferred = erc20.transfer_from(caller, get_contract_address(), amount.into());
            assert(transferred, errors::TRANSFER_FAILED);
            let pot_entry = self.table_pot.entry(table_id);
            pot_entry.write(pot_entry.read() + amount);
            self.emit(Bet { table_id, seat, amount });
        }

        fn fold(ref self: ContractState, table_id: felt252, seat: felt252) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
            // Security review follow-up: same seat-ownership check as bet —
            // previously any caller could force-fold any seat at any table.
            assert(get_caller_address() == self.seat_owner.entry((table_id, seat)).read(), errors::NOT_SEAT_OWNER);
            self.seat_folded.entry((table_id, seat)).write(true);
            self.emit(Fold { table_id, seat });
        }

        fn settle_table(
            ref self: ContractState, table_id: felt252, winners: Span<felt252>, payout_note_ids: Span<felt252>,
        ) {
            assert(self.table_exists.entry(table_id).read(), errors::NO_TABLE);
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
            self.emit(Settled { table_id, winner_count: winners.len() });
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
            erc20.approve(self.pool.read(), owed.into());

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
    }
}
