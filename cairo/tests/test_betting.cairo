// bet, fold, reclaim_stalled_bet — plus the value-fabrication, reentrancy,
// and fee-on-transfer regression tests from rounds 3-4 of the security
// review. See tests/README.md — unexecuted/unverified in this environment.

use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_block_timestamp, start_cheat_caller_address,
    stop_cheat_block_timestamp, stop_cheat_caller_address,
};
use zkpoker::mocks::IMockErc20AdminDispatcherTrait;
use zkpoker::{
    IErc20DispatcherTrait, IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait, PokerGame,
};
use super::helpers::{
    ALICE, BOB, DEALER, MALLORY, NOTE_A, SEAT_0, SEAT_1, TABLE_1, TWO_SEATS, deploy_pokergame,
    deploy_mock_token, fund_and_approve, setup_table_with_two_seats,
};

const FUND: u256 = 10_000;
const BET: u128 = 1_000;

// ─── bet ─────────────────────────────────────────────────────────────────

#[test]
fn test_bet_success_credits_pot_and_contribution() {
    let (game, token, _admin, _token_addr) = setup_table_with_two_seats(FUND);

    let mut spy = spy_events();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_pot(TABLE_1) == BET, 'pot not credited');
    assert(game.get_seat_contributed(TABLE_1, SEAT_0) == BET, 'contribution not tracked');
    assert(token.balance_of(game.contract_address) == BET.into(), 'contract balance wrong');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::Bet(PokerGame::Bet { table_id: TABLE_1, seat: SEAT_0, amount: BET }),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_SEAT_OWNER')]
fn test_bet_by_non_seat_owner_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_two_seats(FUND);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.bet(TABLE_1, SEAT_0, BET); // MALLORY never joined seat 0
}

#[test]
#[should_panic(expected: 'SEAT_FOLDED')]
fn test_bet_on_folded_seat_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_two_seats(FUND);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.fold(TABLE_1, SEAT_0);
    game.bet(TABLE_1, SEAT_0, BET);
}

#[test]
#[should_panic(expected: 'NO_TABLE')]
fn test_bet_on_nonexistent_table_rejected() {
    let game = deploy_pokergame(DEALER());
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
}

#[test]
#[should_panic(expected: 'TRANSFER_FAILED')]
fn test_bet_value_fabrication_without_real_transfer_rejected() {
    // Regression: round 2 Finding — bet() must actually move funds, not
    // just increment table_pot. A token that refuses the transfer must
    // block the bet, not silently credit the pot anyway.
    let (game, _token, admin, _token_addr) = setup_table_with_two_seats(FUND);
    admin.set_fail_transfer_from(true);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
}

#[test]
fn test_bet_fee_on_transfer_credits_only_received_amount() {
    // Regression: round 3 Finding 4 — bet() must credit the measured
    // balance delta, not the nominal `amount`, so a fee-on-transfer token
    // can't let table_pot drift above the contract's real holdings.
    let (game, _token, admin, _token_addr) = setup_table_with_two_seats(FUND);
    admin.set_fee_bps(1000); // 10% fee
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
    stop_cheat_caller_address(game.contract_address);

    let expected_net: u128 = BET - (BET / 10);
    assert(game.get_pot(TABLE_1) == expected_net, 'pot should reflect net amount');
    assert(game.get_seat_contributed(TABLE_1, SEAT_0) == expected_net, 'contribution should reflect net');
}

#[test]
#[should_panic(expected: 'REENTRANCY')]
fn test_bet_reentrancy_blocked() {
    // Regression: round 3 Finding 3 / round 4-5 confirmed-safe coverage —
    // a malicious token reentering bet() mid-transfer must be blocked by
    // reentrancy_lock, not allowed to double-process.
    //
    // The reentrant call's caller (as PokerGame sees it) is the token
    // CONTRACT's own address, not whoever triggered the outer call — so
    // the token contract itself must be the table's dealer/seat_owner for
    // this to isolate the reentrancy_lock check specifically, rather than
    // tripping NOT_SEAT_OWNER first. This mirrors the audit's own attack
    // narrative: the attacker deploys and controls the token, and has it
    // act as its own player.
    let game = deploy_pokergame(DEALER());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, token_addr);
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    fund_and_approve(token, admin, token_addr, game.contract_address, FUND);
    admin.set_reenter_bet(game.contract_address, TABLE_1, SEAT_0, BET);

    start_cheat_caller_address(game.contract_address, token_addr);
    game.bet(TABLE_1, SEAT_0, BET); // token's transfer_from reenters bet() -> should panic
}

// ─── fold ────────────────────────────────────────────────────────────────

#[test]
fn test_fold_success() {
    let (game, _token, _admin, _token_addr) = setup_table_with_two_seats(FUND);
    let mut spy = spy_events();

    start_cheat_caller_address(game.contract_address, ALICE());
    game.fold(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);

    spy
        .assert_emitted(
            @array![
                (game.contract_address, PokerGame::Event::Fold(PokerGame::Fold { table_id: TABLE_1, seat: SEAT_0 })),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_SEAT_OWNER')]
fn test_fold_by_non_seat_owner_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_two_seats(FUND);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.fold(TABLE_1, SEAT_0);
}

// ─── reclaim_stalled_bet ───────────────────────────────────────────────────

const T0: u64 = 1_000_000;
const TIMEOUT_SECS: u64 = 86400;

fn setup_stalled_table() -> (zkpoker::IPokerGameDispatcher, zkpoker::IErc20Dispatcher) {
    let game = deploy_pokergame(DEALER());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_block_timestamp(game.contract_address, T0);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    fund_and_approve(token, admin, ALICE(), game.contract_address, FUND);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
    stop_cheat_caller_address(game.contract_address);
    stop_cheat_block_timestamp(game.contract_address);

    (game, token)
}

#[test]
#[should_panic(expected: 'TOO_EARLY')]
fn test_reclaim_stalled_bet_before_timeout_rejected() {
    let (game, _token) = setup_stalled_table();
    start_cheat_block_timestamp(game.contract_address, T0 + 1); // barely any time passed
    start_cheat_caller_address(game.contract_address, ALICE());
    game.reclaim_stalled_bet(TABLE_1, SEAT_0);
}

#[test]
fn test_reclaim_stalled_bet_success_after_timeout() {
    let (game, token) = setup_stalled_table();
    let mut spy = spy_events();

    start_cheat_block_timestamp(game.contract_address, T0 + TIMEOUT_SECS + 1);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.reclaim_stalled_bet(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    stop_cheat_block_timestamp(game.contract_address);

    assert(game.get_seat_contributed(TABLE_1, SEAT_0) == 0, 'contribution should be zeroed');
    assert(game.get_pot(TABLE_1) == 0, 'pot should be zeroed');
    assert(token.balance_of(ALICE()) == FUND, 'ALICE should get her bet back');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::Reclaimed(
                        PokerGame::Reclaimed { table_id: TABLE_1, seat: SEAT_0, amount: BET },
                    ),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_SEAT_OWNER')]
fn test_reclaim_stalled_bet_by_non_seat_owner_rejected() {
    let (game, _token) = setup_stalled_table();
    start_cheat_block_timestamp(game.contract_address, T0 + TIMEOUT_SECS + 1);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.reclaim_stalled_bet(TABLE_1, SEAT_0);
}

#[test]
#[should_panic(expected: 'NO_PAYOUT_FOR_NOTE')]
fn test_reclaim_stalled_bet_twice_rejected() {
    let (game, _token) = setup_stalled_table();
    start_cheat_block_timestamp(game.contract_address, T0 + TIMEOUT_SECS + 1);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.reclaim_stalled_bet(TABLE_1, SEAT_0);
    game.reclaim_stalled_bet(TABLE_1, SEAT_0); // second reclaim: nothing left owed
}


// ─── turn order and bet matching ────────────────────────────────────────
//
// The gap these close: advance_street used to be callable at any moment and
// bet/fold at any time by anyone seated, so a street could end with bets
// unmatched and a player never given the chance to act. That is not poker.

fn seated() -> zkpoker::IPokerGameDispatcher {
    let (game, _t, _a, _ta) = setup_table_with_two_seats(FUND);
    game
}

fn act_bet(game: zkpoker::IPokerGameDispatcher, who: starknet::ContractAddress, seat: felt252, amt: u128) {
    start_cheat_caller_address(game.contract_address, who);
    game.bet(TABLE_1, seat, amt);
    stop_cheat_caller_address(game.contract_address);
}

#[test]
fn test_action_starts_with_first_seat() {
    let game = seated();
    assert(game.get_action_turn(TABLE_1) == SEAT_0, 'seat 0 acts first');
}

#[test]
#[feature("safe_dispatcher")]
fn test_bet_out_of_turn_rejected() {
    let game = seated();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, BOB());
    let outcome = safe.bet(TABLE_1, SEAT_1, BET);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("acted out of turn"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_YOUR_BETTING_TURN', 'wrong error'),
    }
}

#[test]
fn test_turn_passes_after_acting() {
    let game = seated();
    act_bet(game, ALICE(), SEAT_0, BET);
    assert(game.get_action_turn(TABLE_1) == SEAT_1, 'turn should pass to seat 1');
    assert(game.get_amount_to_call(TABLE_1, SEAT_1) == BET, 'bob owes the bet');
}

#[test]
#[feature("safe_dispatcher")]
fn test_calling_short_rejected() {
    let game = seated();
    act_bet(game, ALICE(), SEAT_0, BET);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, BOB());
    let outcome = safe.bet(TABLE_1, SEAT_1, BET - 1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("called short"),
        Result::Err(p) => assert(*p.at(0) == 'BET_BELOW_CALL_AMOUNT', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_check_facing_a_bet_rejected() {
    let game = seated();
    act_bet(game, ALICE(), SEAT_0, BET);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, BOB());
    let outcome = safe.check(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("checked while facing a bet"),
        Result::Err(p) => assert(*p.at(0) == 'CANNOT_CHECK_FACING_BET', 'wrong error'),
    }
}

#[test]
fn test_round_completes_when_bets_match() {
    let game = seated();
    assert(!game.get_round_complete(TABLE_1), 'nobody has acted yet');
    act_bet(game, ALICE(), SEAT_0, BET);
    assert(!game.get_round_complete(TABLE_1), 'bob still to act');
    act_bet(game, BOB(), SEAT_1, BET);
    assert(game.get_round_complete(TABLE_1), 'both matched');
}

// The subtle one. A raise must reopen the action for players who already
// acted -- otherwise the last raiser gets the final word for free and
// everyone before them is committed to a price they never agreed to.
#[test]
fn test_raise_reopens_the_action() {
    let game = seated();
    act_bet(game, ALICE(), SEAT_0, BET);
    act_bet(game, BOB(), SEAT_1, BET * 2); // raise
    assert(!game.get_round_complete(TABLE_1), 'raise must reopen action');
    assert(game.get_amount_to_call(TABLE_1, SEAT_0) == BET, 'alice owes the raise');
    act_bet(game, ALICE(), SEAT_0, BET); // call the raise
    assert(game.get_round_complete(TABLE_1), 'round closes once called');
}

#[test]
#[feature("safe_dispatcher")]
fn test_advance_street_with_unmatched_bets_rejected() {
    let game = seated();
    act_bet(game, ALICE(), SEAT_0, BET);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.advance_street(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("advanced with bets unmatched"),
        Result::Err(p) => assert(*p.at(0) == 'BETTING_ROUND_INCOMPLETE', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_advance_street_before_anyone_acts_rejected() {
    let game = seated();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.advance_street(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("advanced a street nobody played"),
        Result::Err(p) => assert(*p.at(0) == 'BETTING_ROUND_INCOMPLETE', 'wrong error'),
    }
}

#[test]
fn test_check_around_completes_the_round() {
    let game = seated();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.check(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    assert(!game.get_round_complete(TABLE_1), 'bob still to act');
    start_cheat_caller_address(game.contract_address, BOB());
    game.check(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_round_complete(TABLE_1), 'checked around');
}

// One player left is trivially complete: there is nobody to match.
#[test]
fn test_fold_leaves_round_complete() {
    let game = seated();
    act_bet(game, ALICE(), SEAT_0, BET);
    start_cheat_caller_address(game.contract_address, BOB());
    game.fold(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_round_complete(TABLE_1), 'one player left');
}

#[test]
#[feature("safe_dispatcher")]
fn test_fold_out_of_turn_rejected() {
    let game = seated();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, BOB());
    let outcome = safe.fold(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("folded out of turn"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_YOUR_BETTING_TURN', 'wrong error'),
    }
}
