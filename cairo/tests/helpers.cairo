// Shared test fixtures: addresses, table/seat/note constants, and deploy
// helpers for PokerGame + the mock ERC20. See tests/README.md before
// running this suite — it has NOT been executed or compile-checked (no
// Rust/cargo toolchain on the machine this was written on, so
// snforge_scarb_plugin couldn't be fetched even to type-check).

use starknet::{ContractAddress, contract_address_const};
use core::poseidon::poseidon_hash_span;
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::{IErc20Dispatcher, IErc20DispatcherTrait, IPokerGameDispatcher, IPokerGameDispatcherTrait};
use zkpoker::mocks::{IMockErc20AdminDispatcher, IMockErc20AdminDispatcherTrait};

pub fn POOL() -> ContractAddress {
    contract_address_const::<'POOL'>()
}

pub fn DEALER() -> ContractAddress {
    contract_address_const::<'DEALER'>()
}

pub fn ALICE() -> ContractAddress {
    contract_address_const::<'ALICE'>()
}

pub fn BOB() -> ContractAddress {
    contract_address_const::<'BOB'>()
}

pub fn MALLORY() -> ContractAddress {
    contract_address_const::<'MALLORY'>()
}

// Round 8: a third player, for coverage that needs max_seats > 2 (see
// test_hand_eval.cairo's test_settle_table_by_hand_three_seat_table).
pub fn CAROL() -> ContractAddress {
    contract_address_const::<'CAROL'>()
}

pub const TABLE_1: felt252 = 'TABLE_1';
pub const TABLE_2: felt252 = 'TABLE_2';
pub const SEAT_0: felt252 = 0;
pub const SEAT_1: felt252 = 1;
pub const SEAT_2: felt252 = 2;
pub const NOTE_A: felt252 = 'NOTE_A';
pub const NOTE_B: felt252 = 'NOTE_B';
pub const NOTE_C: felt252 = 'NOTE_C';
// Round 8: create_table's max_seats. 2 covers every two-seat fixture in
// this suite (SEAT_0/SEAT_1 only) — see create_table's doc comment in
// lib.cairo for what max_seats means.
pub const TWO_SEATS: u32 = 2;
// Round 8: for the one test that deliberately uses a table size other
// than 2, to exercise settle_table_by_hand's position math
// (community_start = 2*max_seats) at a value that isn't always 2.
pub const THREE_SEATS: u32 = 3;

// commit_deal's `seed_hash` argument must equal
// poseidon_hash_span(array![seed].span()) — see commit_deal's interface doc
// comment in lib.cairo for the exact contract. Shared by test_lifecycle.cairo
// (its own local copy predates this one) and test_hand_eval.cairo (round 8).
pub fn seed_hash_of(seed: felt252) -> felt252 {
    poseidon_hash_span(array![seed].span())
}

pub fn deploy_pokergame(pool: ContractAddress) -> IPokerGameDispatcher {
    let contract = declare("PokerGame").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![pool.into()]).unwrap();
    IPokerGameDispatcher { contract_address: address }
}

pub fn deploy_mock_token() -> (ContractAddress, IErc20Dispatcher, IMockErc20AdminDispatcher) {
    let contract = declare("MockErc20").unwrap().contract_class();
    let (address, _) = contract.deploy(@array![]).unwrap();
    (address, IErc20Dispatcher { contract_address: address }, IMockErc20AdminDispatcher { contract_address: address })
}

// Mints `amount` of `token` to `player` and has them approve `spender`
// (normally the PokerGame contract address) for it — mirrors what a real
// wallet does before calling bet().
pub fn fund_and_approve(
    token: IErc20Dispatcher,
    admin: IMockErc20AdminDispatcher,
    player: ContractAddress,
    spender: ContractAddress,
    amount: u256,
) {
    admin.mint(player, amount);
    start_cheat_caller_address(token.contract_address, player);
    token.approve(spender, amount);
    stop_cheat_caller_address(token.contract_address);
}

// Deploys PokerGame + a mock token, creates TABLE_1 as DEALER, seats ALICE
// at SEAT_0 (note NOTE_A) and BOB at SEAT_1 (note NOTE_B), and funds+
// approves both for `amount` each against the PokerGame contract. Returns
// everything a betting/settlement test needs.
pub fn setup_table_with_two_seats(
    amount: u256,
) -> (IPokerGameDispatcher, IErc20Dispatcher, IMockErc20AdminDispatcher, ContractAddress) {
    let game = deploy_pokergame(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    stop_cheat_caller_address(game.contract_address);

    fund_and_approve(token, admin, ALICE(), game.contract_address, amount);
    fund_and_approve(token, admin, BOB(), game.contract_address, amount);

    (game, token, admin, token_addr)
}

// Same as above, but also has ALICE and BOB each bet `bet_amount` (as
// u128), leaving the table ready for settle_table/privacy_invoke tests.
pub fn setup_table_with_bets(
    fund_amount: u256, bet_amount: u128,
) -> (IPokerGameDispatcher, IErc20Dispatcher, IMockErc20AdminDispatcher, ContractAddress) {
    let (game, token, admin, token_addr) = setup_table_with_two_seats(fund_amount);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, bet_amount);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, bet_amount);
    stop_cheat_caller_address(game.contract_address);

    (game, token, admin, token_addr)
}
