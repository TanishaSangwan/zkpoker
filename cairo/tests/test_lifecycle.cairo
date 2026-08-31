// Table lifecycle: create_table, join_table, commit_deal, mark_dealt,
// reveal_seed. See tests/README.md — unexecuted/unverified in this
// environment.

use core::poseidon::poseidon_hash_span;
use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::{IPokerGameDispatcherTrait, PokerGame};
use super::helpers::{ALICE, BOB, DEALER, MALLORY, NOTE_A, NOTE_B, SEAT_0, TABLE_1, TABLE_2, deploy_pokergame};

const SEED: felt252 = 'MY_SECRET_SEED';

// commit_deal's `seed_hash` argument must equal
// poseidon_hash_span(array![seed].span()) — see the interface doc comment
// on commit_deal in lib.cairo for the exact contract.
fn seed_hash_of(seed: felt252) -> felt252 {
    poseidon_hash_span(array![seed].span())
}

// ─── create_table ───────────────────────────────────────────────────────

#[test]
fn test_create_table_success() {
    let game = deploy_pokergame(DEALER());
    let mut spy = spy_events();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_table_dealer(TABLE_1) == DEALER(), 'dealer not recorded');
    assert(game.get_pot(TABLE_1) == 0, 'pot should start at 0');
    assert(!game.get_table_settled(TABLE_1), 'should not start settled');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::TableCreated(
                        PokerGame::TableCreated { table_id: TABLE_1, token: DEALER(), buy_in: 0 },
                    ),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'TABLE_EXISTS')]
fn test_create_table_duplicate_rejected() {
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    game.create_table(TABLE_1, DEALER(), 0); // should panic
}

#[test]
fn test_create_table_caller_becomes_dealer_regardless_of_who() {
    // create_table is intentionally permissionless (anyone can open a
    // table) — the caller just becomes ITS dealer, not a global role.
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.create_table(TABLE_2, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_table_dealer(TABLE_2) == MALLORY(), 'wrong dealer recorded');
}

// ─── join_table ──────────────────────────────────────────────────────────

#[test]
fn test_join_table_success() {
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);

    let mut spy = spy_events();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_seat_owner(TABLE_1, SEAT_0) == ALICE(), 'seat owner not recorded');
    assert(game.get_seat_note(TABLE_1, SEAT_0) == NOTE_A, 'note not recorded');
    assert(game.get_note_id_owner(NOTE_A) == ALICE(), 'note owner not recorded');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::SeatJoined(
                        PokerGame::SeatJoined { table_id: TABLE_1, seat: SEAT_0, hole_card_note_id: NOTE_A },
                    ),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NO_TABLE')]
fn test_join_table_nonexistent_table_rejected() {
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A); // TABLE_1 was never created
}

#[test]
#[should_panic(expected: 'SEAT_TAKEN')]
fn test_join_table_seat_taken_rejected() {
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_0, NOTE_B); // seat 0 already taken
}

#[test]
#[should_panic(expected: 'NOTE_ID_TAKEN')]
fn test_join_table_note_id_reuse_by_different_owner_rejected() {
    // Regression: round 2/3 Finding — a different account must not be able
    // to register a note_id someone else already owns, on a second table,
    // to later hijack its payout via their own settle_table.
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    game.create_table(TABLE_2, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, MALLORY());
    game.join_table(TABLE_2, SEAT_0, NOTE_A); // NOTE_A belongs to ALICE
}

#[test]
fn test_join_table_note_id_reuse_by_same_owner_allowed() {
    // The same account reusing its own note_id across tables is fine —
    // only a DIFFERENT account reusing it is the attack.
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    game.create_table(TABLE_2, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    game.join_table(TABLE_2, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_note_id_owner(NOTE_A) == ALICE(), 'owner should stay ALICE');
}

// ─── commit_deal ─────────────────────────────────────────────────────────

fn setup_created_table() -> zkpoker::IPokerGameDispatcher {
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, DEALER(), 0);
    stop_cheat_caller_address(game.contract_address);
    game
}

#[test]
fn test_commit_deal_success() {
    let game = setup_created_table();
    let mut spy = spy_events();

    let hash = seed_hash_of(SEED);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, hash);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_seed_hash(TABLE_1) == hash, 'seed hash not recorded');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::DealCommitted(PokerGame::DealCommitted { table_id: TABLE_1, seed_hash: hash }),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_commit_deal_unauthorized_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
}

#[test]
#[should_panic(expected: 'ALREADY_COMMITTED')]
fn test_commit_deal_twice_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
}

// ─── mark_dealt ──────────────────────────────────────────────────────────

#[test]
fn test_mark_dealt_success() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    let mut spy = spy_events();
    game.mark_dealt(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    spy
        .assert_emitted(
            @array![(game.contract_address, PokerGame::Event::Dealt(PokerGame::Dealt { table_id: TABLE_1 }))],
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_mark_dealt_unauthorized_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, MALLORY());
    game.mark_dealt(TABLE_1);
}

#[test]
#[should_panic(expected: 'NOT_COMMITTED')]
fn test_mark_dealt_before_commit_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.mark_dealt(TABLE_1); // no commit_deal yet
}

// ─── reveal_seed ─────────────────────────────────────────────────────────

#[test]
fn test_reveal_seed_success() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    let mut spy = spy_events();
    game.reveal_seed(TABLE_1, SEED);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_revealed_seed(TABLE_1) == SEED, 'revealed seed not recorded');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::SeedRevealed(PokerGame::SeedRevealed { table_id: TABLE_1, seed: SEED }),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_reveal_seed_unauthorized_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, MALLORY());
    game.reveal_seed(TABLE_1, SEED);
}

#[test]
#[should_panic(expected: 'SEED_MISMATCH')]
fn test_reveal_seed_wrong_seed_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    game.reveal_seed(TABLE_1, 'WRONG_SEED');
}

#[test]
#[should_panic(expected: 'ALREADY_REVEALED')]
fn test_reveal_seed_twice_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(TABLE_1, seed_hash_of(SEED));
    game.reveal_seed(TABLE_1, SEED);
    game.reveal_seed(TABLE_1, SEED);
}

#[test]
#[should_panic(expected: 'NOT_COMMITTED')]
fn test_reveal_seed_before_commit_rejected() {
    let game = setup_created_table();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.reveal_seed(TABLE_1, SEED); // no commit_deal yet
}
