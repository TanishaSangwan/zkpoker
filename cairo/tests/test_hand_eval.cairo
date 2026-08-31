// advance_street, bet()'s post-Showdown gate, and settle_table_by_hand
// (round 6). See tests/README.md — unexecuted/unverified in this
// environment, same caveat as every other file here. Unlike these, the
// underlying poker_hand::evaluate_5/best_of_7 functions this settlement
// path depends on ARE genuinely tested and passing — see
// cairo/src/poker_hand.cairo's own #[cfg(test)] module, run via
// `scarb test -- -t unit` (no snforge needed for that one).

use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::{IPokerGameDispatcherTrait, PokerGame};
use super::helpers::{ALICE, DEALER, MALLORY, NOTE_A, NOTE_B, SEAT_0, SEAT_1, TABLE_1, setup_table_with_bets};

const FUND: u256 = 10_000;
const BET: u128 = 1_000;

fn card(rank: u8, suit: u8) -> u8 {
    suit * 13 + rank
}

fn advance_to_showdown(game: zkpoker::IPokerGameDispatcher, table_id: felt252) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.advance_street(table_id); // PreFlop -> Flop
    game.advance_street(table_id); // Flop -> Turn
    game.advance_street(table_id); // Turn -> River
    game.advance_street(table_id); // River -> Showdown
    stop_cheat_caller_address(game.contract_address);
}

// ─── advance_street ────────────────────────────────────────────────────

#[test]
fn test_advance_street_success() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    let mut spy = spy_events();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.advance_street(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_table_street(TABLE_1) == 1, 'should be on Flop');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::StreetAdvanced(PokerGame::StreetAdvanced { table_id: TABLE_1, street: 1 }),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_advance_street_unauthorized_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.advance_street(TABLE_1);
}

#[test]
#[should_panic(expected: 'BETTING_CLOSED')]
fn test_advance_street_past_showdown_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.advance_street(TABLE_1); // already at Showdown (4) -> should panic
}

#[test]
#[should_panic(expected: 'BETTING_CLOSED')]
fn test_bet_blocked_after_showdown() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
}

// ─── settle_table_by_hand ──────────────────────────────────────────────

#[test]
fn test_settle_table_by_hand_clear_winner() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);

    // Community: 2,5,9,J,K (mixed suits). ALICE holds pocket rockets
    // (AA) -> top pair aces. BOB holds 3,4 offsuit -> nothing (high
    // card K from the board). ALICE should win the whole pot (2*BET).
    let community = array![card(0, 0), card(3, 1), card(7, 2), card(9, 3), card(11, 0)].span();
    let alice_hole = (card(12, 1), card(12, 2)); // AA
    let bob_hole = (card(1, 3), card(2, 0)); // 3,4 offsuit, no help

    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![alice_hole, bob_hole].span(),
            community,
            array![NOTE_A, NOTE_B].span(),
        );
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_pending_payout(NOTE_A) == BET * 2, 'ALICE should win the pot');
    assert(game.get_pending_payout(NOTE_B) == 0, 'BOB should get nothing');
    assert(game.get_table_settled(TABLE_1), 'table should be settled');
}

#[test]
fn test_settle_table_by_hand_tie_splits_pot() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);

    // Board itself is the best hand for both (a wheel straight on the
    // board: 2,3,4,5,A with mixed suits, no flush possible for either
    // hole pairing below) — both play the board, identical 5-card best
    // hand, so it's a genuine tie split.
    let community = array![card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(12, 0)].span();
    let alice_hole = (card(6, 1), card(7, 2)); // doesn't beat the board straight
    let bob_hole = (card(8, 3), card(9, 0)); // doesn't beat the board straight

    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![alice_hole, bob_hole].span(),
            community,
            array![NOTE_A, NOTE_B].span(),
        );
    stop_cheat_caller_address(game.contract_address);

    // pot = BET*2 = 2000, split 2 ways -> 1000 each, no remainder.
    assert(game.get_pending_payout(NOTE_A) == BET, 'ALICE should get half');
    assert(game.get_pending_payout(NOTE_B) == BET, 'BOB should get half');
}

#[test]
#[should_panic(expected: 'NOT_SHOWDOWN')]
fn test_settle_table_by_hand_requires_showdown() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    // never advanced past PreFlop
    let community = array![card(0, 0), card(3, 1), card(7, 2), card(9, 3), card(11, 0)].span();
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![(card(12, 1), card(12, 2))].span(),
            community,
            array![NOTE_A].span(),
        );
}

#[test]
#[should_panic(expected: 'SEAT_FOLDED')]
fn test_settle_table_by_hand_folded_seat_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.fold(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    advance_to_showdown(game, TABLE_1);

    let community = array![card(0, 0), card(3, 1), card(7, 2), card(9, 3), card(11, 0)].span();
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![(card(12, 1), card(12, 2))].span(),
            community,
            array![NOTE_A].span(),
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_settle_table_by_hand_unauthorized_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    let community = array![card(0, 0), card(3, 1), card(7, 2), card(9, 3), card(11, 0)].span();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![(card(12, 1), card(12, 2))].span(),
            community,
            array![NOTE_A].span(),
        );
}

#[test]
#[should_panic(expected: 'BAD_CARDS')]
fn test_settle_table_by_hand_bad_community_length_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    let community = array![card(0, 0), card(3, 1), card(7, 2)].span(); // only 3, not 5
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![(card(12, 1), card(12, 2))].span(),
            community,
            array![NOTE_A].span(),
        );
}
