// Busted seats, and the end of a table.
//
// A player who loses their last chip used to stay in every subsequent hand
// forever. Nothing removed them, because nothing looked: `is_active` was
// `owner != 0 && !folded`, and a stack of zero is neither. So they were dealt
// in, they held a share of the joint key that every reveal needed, and when
// the turn reached them they could not act at all -- `bet` asserts
// `amount <= stack`, `check` refuses to check into a blind -- so each hand
// cost the table a fold or a timeout on a seat that had nothing to say. Worse,
// `take_blind` takes zero from an empty stack WITHOUT marking it all-in (that
// branch needs a non-zero take), so `round_complete` and `advance_turn` kept
// waiting on them.
//
// Now they sit out: not dealt, not in the joint key, not owed a blind, not a
// contender. And when only one seat still holds chips there is no hand left to
// deal, so the table closes and that seat cashes out holding every chip that
// was ever escrowed on it.

use core::num::traits::Zero;
use snforge_std::{start_cheat_caller_address, stop_cheat_caller_address};
use zkpoker::{
    IErc20DispatcherTrait, IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait,
};
use super::helpers::{
    ALICE, BOB, CAROL, DEALER, MALLORY, NOTE_A, NOTE_B, NOTE_C, POOL, SEAT_0, SEAT_1, SEAT_2,
    TABLE_1, TWO_SEATS, deploy_mock_token, deploy_pokergame_with_verifier,
    fund_and_approve,
};

const PK_X: u256 = u256 { low: 'PKX', high: 1 };
const PK_Y: u256 = u256 { low: 'PKY', high: 2 };
const JOINT_X: u256 = u256 { low: 'JOINTX', high: 5 };
const JOINT_Y: u256 = u256 { low: 'JOINTY', high: 6 };
const DECK_N: u256 = u256 { low: 'DECKN', high: 8 };

const BUY_IN: u128 = 500;
const WALLET: u256 = 10_000;

// MUST equal DECK_OPEN_K in src/lib.cairo and K in circuits/deck_open.
const DECK_OPEN_K: u32 = 19;

fn proof() -> Span<felt252> {
    array!['PROOF'].span()
}

fn deck_of(tag: u128) -> Span<u256> {
    let mut out: Array<u256> = array![];
    let mut i: u128 = 0;
    while i != 208 {
        out.append(u256 { low: tag + i, high: 0 });
        i += 1;
    }
    out.span()
}

fn ct(tag: u128) -> Array<u256> {
    array![
        u256 { low: tag, high: 100 },
        u256 { low: tag, high: 101 },
        u256 { low: tag, high: 102 },
        u256 { low: tag, high: 103 },
    ]
}

fn chunk_cts(first: u32, k_total: u32) -> Span<u256> {
    let mut out: Array<u256> = array![];
    let mut i: u32 = 0;
    while i != DECK_OPEN_K {
        let raw = first + i;
        let p = if raw < k_total {
            raw
        } else {
            k_total - 1
        };
        let c = ct((p + 1).into());
        out.append(*c.at(0));
        out.append(*c.at(1));
        out.append(*c.at(2));
        out.append(*c.at(3));
        i += 1;
    }
    out.span()
}

fn who(seat: u32) -> starknet::ContractAddress {
    if seat == 0 {
        ALICE()
    } else if seat == 1 {
        BOB()
    } else {
        CAROL()
    }
}

/// Seats `seats` players on a table with a REAL buy-in and no blind
/// structure, and registers every seat's key. Nothing dealt yet.
fn seated(seats: u32) -> zkpoker::IPokerGameDispatcher {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, BUY_IN, seats);
    stop_cheat_caller_address(game.contract_address);

    let notes = array![NOTE_A, NOTE_B, NOTE_C];
    let mut i: u32 = 0;
    while i != seats {
        fund_and_approve(token, admin, who(i), game.contract_address, WALLET);
        start_cheat_caller_address(game.contract_address, who(i));
        game.join_table(TABLE_1, i.into(), *notes.at(i));
        game.register_shuffle_key(TABLE_1, i.into(), PK_X, PK_Y, proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    game
}

/// Runs the shuffle chain and opens the deck for whoever is in the hand.
/// `order` is the seats begin_shuffle will have frozen, in its order --
/// which is the point of several of these tests, so it is passed in rather
/// than assumed.
fn deal(game: zkpoker::IPokerGameDispatcher, max_seats: u32, order: Span<u32>) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);

    let total = 2 * max_seats + 5;
    let mut i: u32 = 0;
    while i != order.len() {
        let seat = *order.at(i);
        start_cheat_caller_address(game.contract_address, who(seat));
        if i + 1 == order.len() {
            game
                .submit_final_shuffle(
                    TABLE_1, DECK_N + seat.into(), deck_of(1), chunk_cts(0, total), proof(),
                );
        } else {
            game.submit_shuffle(TABLE_1, DECK_N + seat.into(), deck_of(1), proof());
        }
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }

    let chunks = (total + DECK_OPEN_K - 1) / DECK_OPEN_K;
    let mut c: u32 = 1;
    while c != chunks {
        game.open_deck(TABLE_1, c, chunk_cts(DECK_OPEN_K * c, total), proof());
        c += 1;
    }
    assert(game.get_deck_opened(TABLE_1), 'setup: deck not opened');
}

fn bet_as(game: zkpoker::IPokerGameDispatcher, seat: u32, amount: u128) {
    start_cheat_caller_address(game.contract_address, who(seat));
    game.bet(TABLE_1, seat.into(), amount);
    stop_cheat_caller_address(game.contract_address);
}

fn fold_as(game: zkpoker::IPokerGameDispatcher, seat: u32) {
    start_cheat_caller_address(game.contract_address, who(seat));
    game.fold(TABLE_1, seat.into());
    stop_cheat_caller_address(game.contract_address);
}

fn settle_to(game: zkpoker::IPokerGameDispatcher, seat: felt252, note: felt252) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![seat].span(), array![note].span());
    stop_cheat_caller_address(game.contract_address);
}

/// Three seats, dealt, then ALICE and BOB both shove and BOB takes it.
/// Leaves ALICE on zero, BOB on 1000, CAROL untouched on 500, hand settled.
fn alice_busts() -> zkpoker::IPokerGameDispatcher {
    let game = seated(3);
    deal(game, 3, array![0, 1, 2].span());
    bet_as(game, 0, BUY_IN);
    bet_as(game, 1, BUY_IN);
    fold_as(game, 2);
    settle_to(game, SEAT_1, NOTE_B);
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == 0, 'setup: alice not busted');
    assert(game.get_seat_stack(TABLE_1, SEAT_1) == 2 * BUY_IN, 'setup: bob not paid');
    game
}

// ─── who is in the hand ─────────────────────────────────────────────────

#[test]
fn test_a_seat_with_no_chips_sits_the_next_hand_out() {
    let game = alice_busts();
    // Still true DURING the settled hand: the flag is frozen per hand, and
    // this hand was dealt while she still had chips.
    assert(!game.get_seat_sitting_out(TABLE_1, SEAT_0), 'flagged mid-hand');

    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_seat_sitting_out(TABLE_1, SEAT_0), 'busted seat still in');
    assert(!game.get_seat_sitting_out(TABLE_1, SEAT_1), 'winner sat out');
    assert(!game.get_seat_sitting_out(TABLE_1, SEAT_2), 'folder sat out');
    // The seat is still THEIRS. Sitting out is not being thrown off the table.
    assert(game.get_seat_owner(TABLE_1, SEAT_0) == ALICE(), 'seat taken away');
}

// The distinction the whole design turns on: a stack reads zero both when a
// player is broke and when they have just pushed everything into the pot. If
// the flag were derived from the stack on demand rather than frozen between
// hands, BOB -- who shoved his last chip and WON -- would be folded out of the
// next hand for it.
#[test]
fn test_a_seat_that_shoved_its_last_chip_and_won_is_still_in() {
    let game = alice_busts();
    // BOB's stack really did hit zero mid-hand.
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    assert(!game.get_seat_sitting_out(TABLE_1, SEAT_1), 'all-in winner sat out');
    assert(game.get_seat_stack(TABLE_1, SEAT_1) == 2 * BUY_IN, 'winnings lost');
}

// The invariant begin_shuffle exists to keep (round 8 finding D) is
// "participants == who is in the hand". A busted seat is out of the hand, so
// it is out of the joint key -- and, because it is out of the joint key, it
// MUST be out of the deal too, which is what is_active now guarantees.
#[test]
fn test_a_sitting_out_seat_is_not_a_shuffle_participant() {
    let game = alice_busts();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    deal(game, 3, array![1, 2].span());
    assert(game.get_shuffle_order_len(TABLE_1) == 2, 'busted seat in the chain');
    assert(game.get_shuffle_seat_at(TABLE_1, 0) == SEAT_1, 'chain starts wrong');
    assert(game.get_shuffle_seat_at(TABLE_1, 1) == SEAT_2, 'chain ends wrong');
}

// reset_hand used to open every hand with the turn flatly on seat 0, which
// was safe only because seat 0 was always playing. assert_on_turn compares
// literally, so with seat 0 sitting out that left a table where nobody could
// act -- and a table with no blind structure never calls post_blinds, so
// nothing would ever move the turn off it.
#[test]
fn test_the_hand_opens_on_a_seat_that_is_actually_playing() {
    let game = alice_busts();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_action_turn(TABLE_1) == 1, 'turn left on a busted seat');

    // And it really can act.
    deal(game, 3, array![1, 2].span());
    bet_as(game, 1, 100);
    assert(game.get_pot(TABLE_1) == 100, 'the table could not act');
}

// The button is position, and position is only meaningful among the players
// who are dealt in.
#[test]
fn test_the_button_passes_over_a_sitting_out_seat() {
    let game = alice_busts();
    assert(game.get_button(TABLE_1) == SEAT_0, 'setup: wrong button');
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    // From SEAT_0 the next seat clockwise is SEAT_1, which is in the hand.
    assert(game.get_button(TABLE_1) == SEAT_1, 'button did not move');

    // Round it again: 1 -> 2 -> back past the busted 0 to 1.
    deal(game, 3, array![1, 2].span());
    bet_as(game, 1, 100);
    bet_as(game, 2, 100);
    settle_to(game, SEAT_1, NOTE_B);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_button(TABLE_1) == SEAT_2, 'button skipped a player');
}

// ─── the end of the table ───────────────────────────────────────────────

/// Two seats, dealt, ALICE shoves and loses: BOB holds every chip.
fn bob_holds_everything() -> zkpoker::IPokerGameDispatcher {
    let game = seated(2);
    deal(game, 2, array![0, 1].span());
    bet_as(game, 0, BUY_IN);
    bet_as(game, 1, BUY_IN);
    settle_to(game, SEAT_1, NOTE_B);
    assert(game.get_seat_stack(TABLE_1, SEAT_1) == 2 * BUY_IN, 'setup: bob not paid');
    game
}

#[test]
#[feature("safe_dispatcher")]
fn test_one_player_holding_every_chip_is_not_a_hand() {
    let game = bob_holds_everything();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        // The alternative is a lone seat posting both blinds to itself and
        // winning them straight back, hand after hand, forever.
        Result::Ok(_) => panic!("dealt a hand to one player"),
        Result::Err(p) => assert(*p.at(0) == 'TABLE_IS_OVER', 'wrong error'),
    }
}

#[test]
fn test_end_table_closes_it_and_frees_the_busted_seats() {
    let game = bob_holds_everything();
    // Permissionless: the player who wants this most is the one with no
    // chips left, and they should not have to be the only one who can ask.
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.end_table(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_table_finished(TABLE_1), 'table not closed');
    // ALICE is gone without having had to send anything.
    assert(game.get_seat_owner(TABLE_1, SEAT_0).is_zero(), 'busted seat not freed');
    // BOB keeps his seat, because he still has money on it.
    assert(game.get_seat_owner(TABLE_1, SEAT_1) == BOB(), 'winner evicted');
    assert(game.get_seat_stack(TABLE_1, SEAT_1) == 2 * BUY_IN, 'stack disturbed');
}

// The whole point of the endgame: the last player's stack IS the table. Chips
// are conserved, so once one seat holds a non-zero stack and no other does, it
// holds every buy-in ever escrowed here.
#[test]
fn test_the_last_player_collects_every_chip() {
    let game = bob_holds_everything();
    let token = zkpoker::IErc20Dispatcher {
        contract_address: game.get_table_token(TABLE_1),
    };
    let before = token.balance_of(BOB());

    start_cheat_caller_address(game.contract_address, MALLORY());
    game.end_table(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.leave_table(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);

    // Both buy-ins, not just his own.
    assert(token.balance_of(BOB()) == before + (2 * BUY_IN).into(), 'winner short-changed');
    assert(token.balance_of(game.contract_address) == 0, 'chips stranded');
}

// Cashing out after the final hand was impossible before this: leave_table
// required seat_contributed == 0, and only reset_hand clears it -- which
// start_next_hand does, and a table that has just played its last hand never
// reaches. The money was in the stack and unreachable.
#[test]
fn test_a_settled_hand_does_not_pin_a_player_to_the_table() {
    let game = alice_busts();
    // No start_next_hand, so CAROL's contribution record from the settled
    // hand is still on the books.
    let token = zkpoker::IErc20Dispatcher {
        contract_address: game.get_table_token(TABLE_1),
    };
    let before = token.balance_of(CAROL());
    start_cheat_caller_address(game.contract_address, CAROL());
    game.leave_table(TABLE_1, SEAT_2);
    stop_cheat_caller_address(game.contract_address);
    assert(token.balance_of(CAROL()) == before + BUY_IN.into(), 'could not cash out');
}

#[test]
#[feature("safe_dispatcher")]
fn test_end_table_refuses_while_two_seats_can_still_play() {
    let game = alice_busts(); // BOB 1000, CAROL 500 -- a real game
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.end_table(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("ended a game two players were still in"),
        Result::Err(p) => assert(*p.at(0) == 'TABLE_STILL_PLAYABLE', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_end_table_refuses_mid_hand() {
    let game = seated(2);
    deal(game, 2, array![0, 1].span());
    bet_as(game, 0, BUY_IN);
    // ALICE is on zero and the hand is live, so funded_count is 1 -- but the
    // pot is not settled and those chips are not anyone's yet.
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.end_table(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("closed a table over a live pot"),
        Result::Err(p) => assert(*p.at(0) == 'HAND_IN_PROGRESS', 'wrong error'),
    }
}

// A wallet-funded table has no stacks, so "the last player with chips" names
// nothing: the wallet is the stack and the table never runs out.
#[test]
#[feature("safe_dispatcher")]
fn test_end_table_does_not_apply_to_a_wallet_table() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.end_table(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("ended a table that has no stacks"),
        Result::Err(p) => assert(*p.at(0) == 'TABLE_HAS_NO_STACKS', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_a_closed_table_takes_no_new_players() {
    let game = bob_holds_everything();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.end_table(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, CAROL());
    let outcome = safe.join_table(TABLE_1, SEAT_0, NOTE_C);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("sat down at a table that is over"),
        Result::Err(p) => assert(*p.at(0) == 'TABLE_IS_FINISHED', 'wrong error'),
    }
}

// The rebuy. Sitting out is a property of the SEAT, and a seat that has just
// bought in has chips whatever the player who went broke on it was flagged as.
#[test]
fn test_buying_back_in_puts_the_seat_back_in_the_hand() {
    let game = alice_busts();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_seat_sitting_out(TABLE_1, SEAT_0), 'setup: not sitting out');

    start_cheat_caller_address(game.contract_address, ALICE());
    game.leave_table(TABLE_1, SEAT_0);
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    assert(!game.get_seat_sitting_out(TABLE_1, SEAT_0), 'rebuy still sitting out');
    assert(game.get_seat_stack(TABLE_1, SEAT_0) == BUY_IN, 'rebuy has no chips');
}
