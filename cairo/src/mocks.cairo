// Test-only mock ERC20 with configurable failure/fee/reentrancy behavior,
// used by cairo/tests/*.cairo to exercise PokerGame's external-call guards
// (transfer_from failure, fee-on-transfer accounting, malicious-token
// reentrancy) without needing a real ERC20 deployment. Only compiled when
// `#[cfg(test)]` is active (see the `mod mocks;` declaration in lib.cairo)
// — never part of the production `starknet-contract` build.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IMockErc20Admin<TState> {
    fn mint(ref self: TState, to: ContractAddress, amount: u256);
    fn set_fail_transfer_from(ref self: TState, fail: bool);
    fn set_fail_transfer(ref self: TState, fail: bool);
    fn set_fail_approve(ref self: TState, fail: bool);
    fn set_fee_bps(ref self: TState, fee_bps: u256);
    // Arms a one-shot reentrant call into PokerGame.bet(...), fired from
    // inside this token's transfer_from — used to prove bet()'s
    // reentrancy_lock blocks a malicious dealer-controlled token (round 3
    // Finding 3 / round 4-5 regression coverage).
    fn set_reenter_bet(
        ref self: TState, pokergame: ContractAddress, table_id: felt252, seat: felt252, amount: u128,
    );
    // Arms a one-shot reentrant call into PokerGame.settle_table(...) from
    // inside transfer_from — used to prove settle_table's reentrancy_lock
    // check (round 4 Finding 2) actually blocks this specific path.
    fn set_reenter_settle(
        ref self: TState, pokergame: ContractAddress, table_id: felt252, seat: felt252, note_id: felt252,
    );
    // Arms a one-shot reentrant call into PokerGame.advance_street(...)
    // from inside transfer_from. advance_street is dealer-gated, so this
    // only fires when the token contract is itself the table's dealer --
    // exactly the setup set_reenter_bet already uses. Round 8 finding F.
    fn set_reenter_advance_street(ref self: TState, pokergame: ContractAddress, table_id: felt252);
}

#[starknet::contract]
mod MockErc20 {
    use starknet::storage::{Map, StoragePathEntry, StoragePointerReadAccess, StoragePointerWriteAccess};
    use starknet::{ContractAddress, get_caller_address};
    use crate::{IPokerGameDispatcher, IPokerGameDispatcherTrait};

    #[storage]
    struct Storage {
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
        fail_transfer_from: bool,
        fail_transfer: bool,
        fail_approve: bool,
        fee_bps: u256,
        reenter_pokergame: ContractAddress,
        // 0 = none, 1 = reenter bet(), 2 = reenter settle_table(),
        // 3 = reenter advance_street()
        reenter_mode: felt252,
        reenter_table_id: felt252,
        reenter_seat: felt252,
        reenter_amount: u128,
        reenter_note_id: felt252,
    }

    #[abi(embed_v0)]
    impl Erc20Impl of crate::IErc20<ContractState> {
        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.entry(account).read()
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            if self.fail_approve.read() {
                return false;
            }
            self.allowances.entry((get_caller_address(), spender)).write(amount);
            true
        }

        fn transfer_from(
            ref self: ContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
        ) -> bool {
            if self.fail_transfer_from.read() {
                return false;
            }
            let spender = get_caller_address();
            let allowed_entry = self.allowances.entry((sender, spender));
            let allowed = allowed_entry.read();
            assert(allowed >= amount, 'MOCK_INSUFFICIENT_ALLOWANCE');
            allowed_entry.write(allowed - amount);

            let sender_bal_entry = self.balances.entry(sender);
            let sender_bal = sender_bal_entry.read();
            assert(sender_bal >= amount, 'MOCK_INSUFFICIENT_BALANCE');
            sender_bal_entry.write(sender_bal - amount);

            // Fee-on-transfer simulation: recipient receives less than
            // `amount` whenever fee_bps is nonzero (round 3 Finding 4
            // regression coverage).
            let fee = amount * self.fee_bps.read() / 10000_u256;
            let net = amount - fee;
            let recip_entry = self.balances.entry(recipient);
            recip_entry.write(recip_entry.read() + net);

            // Reentrancy hook: call back into PokerGame before returning,
            // mid-transfer, exactly the window bet()'s reentrancy_lock is
            // meant to close.
            let mode = self.reenter_mode.read();
            if mode == 1 {
                let pg = IPokerGameDispatcher { contract_address: self.reenter_pokergame.read() };
                pg.bet(self.reenter_table_id.read(), self.reenter_seat.read(), self.reenter_amount.read());
            } else if mode == 2 {
                let pg = IPokerGameDispatcher { contract_address: self.reenter_pokergame.read() };
                pg
                    .settle_table(
                        self.reenter_table_id.read(),
                        array![self.reenter_seat.read()].span(),
                        array![self.reenter_note_id.read()].span(),
                    );
            } else if mode == 3 {
                let pg = IPokerGameDispatcher { contract_address: self.reenter_pokergame.read() };
                pg.advance_street(self.reenter_table_id.read());
            }

            true
        }

        fn transfer(ref self: ContractState, recipient: ContractAddress, amount: u256) -> bool {
            if self.fail_transfer.read() {
                return false;
            }
            let caller = get_caller_address();
            let caller_bal_entry = self.balances.entry(caller);
            let caller_bal = caller_bal_entry.read();
            assert(caller_bal >= amount, 'MOCK_INSUFFICIENT_BALANCE');
            caller_bal_entry.write(caller_bal - amount);
            let recip_entry = self.balances.entry(recipient);
            recip_entry.write(recip_entry.read() + amount);
            true
        }
    }

    #[abi(embed_v0)]
    impl AdminImpl of super::IMockErc20Admin<ContractState> {
        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            let entry = self.balances.entry(to);
            entry.write(entry.read() + amount);
        }

        fn set_fail_transfer_from(ref self: ContractState, fail: bool) {
            self.fail_transfer_from.write(fail);
        }

        fn set_fail_transfer(ref self: ContractState, fail: bool) {
            self.fail_transfer.write(fail);
        }

        fn set_fail_approve(ref self: ContractState, fail: bool) {
            self.fail_approve.write(fail);
        }

        fn set_fee_bps(ref self: ContractState, fee_bps: u256) {
            self.fee_bps.write(fee_bps);
        }

        fn set_reenter_bet(
            ref self: ContractState, pokergame: ContractAddress, table_id: felt252, seat: felt252, amount: u128,
        ) {
            self.reenter_pokergame.write(pokergame);
            self.reenter_mode.write(1);
            self.reenter_table_id.write(table_id);
            self.reenter_seat.write(seat);
            self.reenter_amount.write(amount);
        }

        fn set_reenter_settle(
            ref self: ContractState, pokergame: ContractAddress, table_id: felt252, seat: felt252, note_id: felt252,
        ) {
            self.reenter_pokergame.write(pokergame);
            self.reenter_mode.write(2);
            self.reenter_table_id.write(table_id);
            self.reenter_seat.write(seat);
            self.reenter_note_id.write(note_id);
        }

        fn set_reenter_advance_street(
            ref self: ContractState, pokergame: ContractAddress, table_id: felt252,
        ) {
            self.reenter_pokergame.write(pokergame);
            self.reenter_mode.write(3);
            self.reenter_table_id.write(table_id);
        }
    }
}

// ── V2: mock shuffle-proof verifier ─────────────────────────────────────
// Lets cairo/tests/ exercise the shuffle chain's ordering, chaining and
// forfeit logic without a real proving stack. Configurable so a test can
// make verification fail on demand and check the contract rejects that
// step — the case that actually matters.
#[starknet::contract]
pub mod MockShuffleVerifier {
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};

    #[storage]
    struct Storage {
        reject: bool,
        reject_key: bool,
        reject_opening: bool,
        reject_reveal: bool,
        reject_joint_key: bool,
    }

    #[abi(embed_v0)]
    impl VerifierImpl of super::super::IShuffleVerifier<ContractState> {
        fn verify_shuffle(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            // Accepts by default so the happy path needs no setup; a test
            // calls set_reject(true) to exercise rejection.
            !self.reject.read()
        }

        fn verify_key_ownership(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            !self.reject_key.read()
        }

        fn verify_deck_opening(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            !self.reject_opening.read()
        }

        // The real adapter sums the shares on Grumpkin. The fixtures in
        // cairo/tests/ are opaque felts, not curve points, so this cannot
        // do the arithmetic -- it exercises the CONTRACT's handling of
        // both answers. That the sum itself is right is checked against
        // real curve points in scripts/joint_key_check.py and on devnet.
        fn verify_joint_key(
            self: @ContractState, shares: Span<u256>, joint_x: u256, joint_y: u256,
        ) -> bool {
            !self.reject_joint_key.read()
        }

        // Accepts any card the caller names unless set_reject_reveal(true).
        // A test that needs "this specific card is wrong" should use the
        // real verifier -- a mock cannot distinguish cards without doing the
        // curve arithmetic it exists to avoid.
        fn verify_card_reveal(
            self: @ContractState,
            proof: Span<felt252>,
            public_inputs: Span<felt252>,
            c2_x: u256,
            c2_y: u256,
            claimed_card: u8,
        ) -> bool {
            claimed_card < 52 && !self.reject_reveal.read()
        }
    }

    #[abi(embed_v0)]
    impl AdminImpl of super::IMockVerifierAdminTrait<ContractState> {
        fn set_reject(ref self: ContractState, reject: bool) {
            self.reject.write(reject);
        }

        fn set_reject_key(ref self: ContractState, reject: bool) {
            self.reject_key.write(reject);
        }

        fn set_reject_opening(ref self: ContractState, reject: bool) {
            self.reject_opening.write(reject);
        }

        fn set_reject_reveal(ref self: ContractState, reject: bool) {
            self.reject_reveal.write(reject);
        }

        fn set_reject_joint_key(ref self: ContractState, reject: bool) {
            self.reject_joint_key.write(reject);
        }
    }
}

#[starknet::interface]
pub trait IMockVerifierAdminTrait<TState> {
    fn set_reject(ref self: TState, reject: bool);
    fn set_reject_key(ref self: TState, reject: bool);
    fn set_reject_opening(ref self: TState, reject: bool);
    fn set_reject_reveal(ref self: TState, reject: bool);
    fn set_reject_joint_key(ref self: TState, reject: bool);
}
