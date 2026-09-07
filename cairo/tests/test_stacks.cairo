// Chips on the table: the buy-in, all-in, and side pots.
//
// `table_buy_in` used to be written by create_table and never read -- no
// getter, no transfer, no cap -- so a seat could bet its entire wallet on one
// hand and the "buy-in" described nothing. These cover the model that
// replaced that, and the rule that decides which one a table plays:
//
//   buy_in == 0  the original wallet-funded betting, unchanged. No stack, no
//                cap, no all-in, so no side pots either. Every other test file
//                exercises this path.
//   buy_in != 0  chips are escrowed at join_table and betting draws them
//                down. A seat that cannot cover a bet may fold or push what
//                it has left, and settlement splits the pot into layers so a
//                short stack wins only what it actually matched.

use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use zkpoker::{
    IErc20DispatcherTrait, IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait,
};
use super::helpers::{
    ALICE, BOB, CAROL, DEALER, NOTE_A, NOTE_B, NOTE_C, POOL, SEAT_0, SEAT_1, SEAT_2, TABLE_1,
    THREE_SEATS, deploy_mock_token, deploy_pokergame_with_verifier, fund_and_approve,
};

const BUY_IN: u128 = 500;
const WALLET: u256 = 10_000;

/// A three-seat table with a REAL buy-in, seats filled, nothing dealt.
fn seated_with_stacks() -> (zkpoker::IPokerGameDispatcher, zkpoker::IErc20Dispatcher) {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, BUY_IN, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);

    let players = array![ALICE(), BOB(), CAROL()];
    let notes = array![NOTE_A, NOTE_B, NOTE_C];
    let mut i: u32 = 0;
    while i != 3 {
        let who = *players.at(i);
        fund_and_approve(token, admin, who, game.contract_address, WALLET);
        start_cheat_caller_address(game.contract_address, who);
        game.join_table(TABLE_1, i.into(), *notes.at(i));
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    (game, token)
}

// ─── the buy-in is real ─────────────────────────────────────────────────

#[test]
fn test_joining_escrows_the_buy_in_as_a_stack() {
    let (game, token) = seated_with_stacks();
    // The chips left the wallet and are ON THE TABLE. Before this change the
    // buy-in moved nothing at all.
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == BUY_IN, 'stack not credited');
    assert(token.balance_of(ALICE()) == (WALLET - BUY_IN.into()), 'wallet not debited');
    assert(token.balance_of(game.contract_address) == (BUY_IN * 3).into(), 'escrow wrong');
}

#[test]
fn test_a_zero_buy_in_table_keeps_the_wallet_model() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);
    fund_and_approve(token, admin, ALICE(), game.contract_address, WALLET);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);
    // No escrow, no stack: the wallet is the stack, exactly as before.
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == 0, 'should hold no chips');
    assert(token.balance_of(ALICE()) == WALLET, 'wallet must not be touched');
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_bet_more_than_the_stack() {
    let (game, _t) = seated_with_stacks();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.bet(TABLE_1, SEAT_0, BUY_IN + 1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("bet chips it never brought to the table"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_ENOUGH_CHIPS', 'wrong error'),
    }
}

#[test]
fn test_betting_draws_the_stack_down() {
    let (game, token) = seated_with_stacks();
    let before = token.balance_of(ALICE());
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 120);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == BUY_IN - 120, 'stack not drawn down');
    assert(game.get_pot(TABLE_1) == 120, 'pot not credited');
    // And crucially the wallet is untouched: the chips were already escrowed.
    assert(token.balance_of(ALICE()) == before, 'wallet moved mid-hand');
}

// ─── all-in ─────────────────────────────────────────────────────────────

#[test]
fn test_spending_the_last_chip_is_all_in() {
    let (game, _t) = seated_with_stacks();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BUY_IN);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == 0, 'stack should be empty');
    assert(game.get_seat_all_in(TABLE_1, SEAT_0), 'should be all in');
    // Still IN the hand -- all-in is not folding.
    assert(!game.get_seat_folded(TABLE_1, SEAT_0), 'all in is not folded');
}

// The rule that makes all-in a DECISION rather than an error: short of the
// call is legal only when it is everything you have.
#[test]
#[feature("safe_dispatcher")]
fn test_short_of_the_call_is_refused_while_chips_remain() {
    let (game, _t) = seated_with_stacks();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 200);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, BOB());
    let outcome = safe.bet(TABLE_1, SEAT_1, 50); // has 500, calls only 50
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("called 200 with 50 while still holding chips"),
        Result::Err(p) => assert(*p.at(0) == 'BET_BELOW_CALL_AMOUNT', 'wrong error'),
    }
}

// ─── leaving with your chips ────────────────────────────────────────────

#[test]
fn test_leaving_returns_the_stack_and_frees_the_seat() {
    let (game, token) = seated_with_stacks();
    let before = token.balance_of(ALICE());
    start_cheat_caller_address(game.contract_address, ALICE());
    game.leave_table(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    assert(token.balance_of(ALICE()) == before + BUY_IN.into(), 'chips not returned');
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == 0, 'stack not cleared');
    assert(game.get_seat_owner(TABLE_1, SEAT_0) == core::num::traits::Zero::zero(), 'seat not freed');
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_leave_with_money_in_the_pot() {
    let (game, _t) = seated_with_stacks();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 100);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.leave_table(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("pulled a stack out from under a live pot"),
        Result::Err(p) => assert(*p.at(0) == 'HAND_IN_PROGRESS', 'wrong error'),
    }
}

// ─── side pots ──────────────────────────────────────────────────────────

// The reason all-in needs layered pots at all.
//
// A seat all-in for less than the bet it faced may win only what the others
// MATCHED against it. Everything above that is a side pot the short stack
// never paid into and cannot win. Settling as a single pot would hand it
// money nobody wagered against it.
#[test]
fn test_a_short_stack_wins_only_what_it_matched() {
    let (game, _t) = seated_with_stacks();

    // ALICE is short by construction: she leaves herself 100 by cashing the
    // rest is not possible mid-table, so instead she simply shoves 100 while
    // the others put in far more.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 100);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, 400);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, CAROL());
    game.bet(TABLE_1, SEAT_2, 400);
    stop_cheat_caller_address(game.contract_address);

    // Contributions are 100 / 400 / 400, so the layers are:
    //   level 100: 100 x 3 = 300, everyone eligible
    //   level 400: 300 x 2 = 600, only BOB and CAROL eligible
    let a0 = game.get_seat_stack(TABLE_1, SEAT_0);
    let b0 = game.get_seat_stack(TABLE_1, SEAT_1);

    // ALICE wins the hand outright.
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
    stop_cheat_caller_address(game.contract_address);

    // She takes the 300 she was matched for, and NOT the 600 above it.
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == a0 + 300, 'short stack won too much');
    // The side pot goes back to the seats who put it up -- no winner of the
    // hand paid into it, so it is not the table's to keep.
    assert(game.get_seat_stack(TABLE_1, SEAT_1) == b0 + 300, 'side pot not returned');
    assert(game.get_pot(TABLE_1) == 0, 'pot not emptied');
}

// The mirror: when the winner covered every layer, layering changes nothing
// and it takes the lot.
#[test]
fn test_a_covered_winner_takes_the_whole_pot() {
    let (game, _t) = seated_with_stacks();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 200);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, 200);
    stop_cheat_caller_address(game.contract_address);

    let b0 = game.get_seat_stack(TABLE_1, SEAT_1);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_1].span(), array![NOTE_B].span());
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_seat_stack(TABLE_1, SEAT_1) == b0 + 400, 'winner short-changed');
    assert(game.get_pot(TABLE_1) == 0, 'pot not emptied');
}

// ─── the rising ladder is denominated, not bare integers ────────────────

// blind_level_amounts returns 10/20 .. 300/600 as bare numbers, and every
// amount this contract takes is a raw u128 in the token's smallest unit -- so
// without a multiplier the top rung of the ladder is 600 wei, which against
// an 18-decimal token is 6e-16 of a coin. A whole rising-blind table was
// unplayable for any stake worth playing for while set_blinds, which takes
// the amount directly, was fine.
#[test]
fn test_the_ladder_scales_by_its_unit() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    // One rung-point is worth 1000 here; a real table would pass 10^18.
    game.set_blind_schedule(TABLE_1, 5, 1000);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_blind_level_unit(TABLE_1) == 1000, 'unit not stored');
    // Rung 0 is 10/20 POINTS, so 10_000/20_000 in the token's units.
    assert(game.get_small_blind(TABLE_1) == 10_000, 'small not scaled');
    assert(game.get_big_blind(TABLE_1) == 20_000, 'big not scaled');
}

#[test]
#[feature("safe_dispatcher")]
fn test_a_ladder_needs_a_nonzero_unit() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.set_blind_schedule(TABLE_1, 5, 0);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("a zero unit makes every rung zero"),
        Result::Err(p) => assert(*p.at(0) == 'BAD_BLIND_UNIT', 'wrong error'),
    }
}
