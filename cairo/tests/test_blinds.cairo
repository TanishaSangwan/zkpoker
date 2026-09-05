// Blinds and the button (docs/PROTOCOL.md §9.9).
//
// The button is not appointed. Every seated player draws one card from the
// SAME committed, shuffled deck everybody else's cards come from -- one
// extra deck position per seat, opened by the same proof and readable only
// once every party has contributed a share -- and the highest card takes
// it. From then on it rotates. That is the whole reason a draw is used
// rather than "lowest seat index wins": a rule the dealer could arrange in
// advance is a rule the dealer controls, and this protocol exists to have
// no such person.
//
// Proof checking is the mock verifier's job here, as everywhere in
// cairo/tests/. What these tests own is the STATE MACHINE: who may set the
// structure and when, which seat posts which blind, that a blind is a
// forced bet and not an action, and that the button cycles.

use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::mocks::IMockVerifierAdminTraitDispatcherTrait;
use zkpoker::{
    IErc20DispatcherTrait, IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait, PokerGame,
};
use super::helpers::{
    ALICE, BOB, CAROL, DEALER, MALLORY, NOTE_A, NOTE_B, NOTE_C, POOL, SEAT_0, SEAT_1, SEAT_2,
    TABLE_1, THREE_SEATS, TWO_SEATS, deploy_mock_token, deploy_pokergame_with_verifier,
    fund_and_approve,
};

const PK_X: u256 = u256 { low: 'PKX', high: 1 };
const PK_Y: u256 = u256 { low: 'PKY', high: 2 };
const JOINT_X: u256 = u256 { low: 'JOINTX', high: 5 };
const JOINT_Y: u256 = u256 { low: 'JOINTY', high: 6 };
const DECK_N: u256 = u256 { low: 'DECKN', high: 8 };
const SHARE_X: u256 = u256 { low: 'SHAREX', high: 11 };
const SHARE_Y: u256 = u256 { low: 'SHAREY', high: 12 };

const SMALL: u128 = 10;
const BIG: u128 = 20;
const STACK: u256 = 1000;

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

// MUST equal DECK_OPEN_K in src/lib.cairo and K in circuits/deck_open.
const DECK_OPEN_K: u32 = 16;

// One K-sized chunk starting at `first`, padded the contract's way.
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

// The deck position holding `seat`'s high-card draw.
fn draw_pos(max_seats: u32, seat: u32) -> u32 {
    2 * max_seats + 5 + seat
}

fn open_all(game: zkpoker::IPokerGameDispatcher, max_seats: u32) {
    let total = 3 * max_seats + 5;
    let chunks = (total + DECK_OPEN_K - 1) / DECK_OPEN_K;
    let mut c: u32 = 0;
    while c != chunks {
        game.open_deck(TABLE_1, c, chunk_cts(DECK_OPEN_K * c, total), proof());
        c += 1;
    }
    assert(game.get_deck_opened(TABLE_1), 'setup: deck not opened');
}

// A table of `seats` players, funded and approved, shuffled and opened, with
// the blind structure set. Everything up to the draw.
fn setup(
    seats: u32,
) -> (
    zkpoker::IPokerGameDispatcher,
    zkpoker::mocks::IMockVerifierAdminTraitDispatcher,
    zkpoker::IErc20Dispatcher,
) {
    let (game, verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, seats);
    game.set_blinds(TABLE_1, SMALL, BIG);
    stop_cheat_caller_address(game.contract_address);

    let players = array![ALICE(), BOB(), CAROL()];
    let notes = array![NOTE_A, NOTE_B, NOTE_C];
    let mut i: u32 = 0;
    while i != seats {
        let who = *players.at(i);
        fund_and_approve(token, admin, who, game.contract_address, STACK);
        start_cheat_caller_address(game.contract_address, who);
        game.join_table(TABLE_1, i.into(), *notes.at(i));
        game.register_shuffle_key(TABLE_1, i.into(), PK_X, PK_Y, proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }

    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);

    let mut i: u32 = 0;
    while i != seats {
        start_cheat_caller_address(game.contract_address, *players.at(i));
        game.submit_shuffle(TABLE_1, DECK_N + i.into(), deck_of(1), proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    open_all(game, seats);
    (game, verifier, token)
}

// Reveals `seat`'s draw as `card`. The mock verifier takes the claimed card
// at face value, which is exactly the knob these tests need.
fn draw(game: zkpoker::IPokerGameDispatcher, max_seats: u32, seat: u32, card: u8) {
    game.reveal_draw_card(
        TABLE_1, seat.into(), SHARE_X, SHARE_Y, card, proof(),
    );
    let _ = draw_pos(max_seats, seat);
}

// Runs the hand out to a settled state the short way: everyone but the last
// seat folds, then the streets are walked to showdown. A fold-to-one round is
// always complete, so advance_street needs no betting.
fn fold_to_one_and_settle(
    game: zkpoker::IPokerGameDispatcher, folders: Span<(starknet::ContractAddress, felt252)>,
) {
    let mut i: u32 = 0;
    while i != folders.len() {
        let (who, seat) = *folders.at(i);
        start_cheat_caller_address(game.contract_address, who);
        game.fold(TABLE_1, seat);
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    let mut s: u8 = game.get_table_street(TABLE_1);
    while s != 4 {
        game.advance_street(TABLE_1);
        s += 1;
    }
    game.settle_from_reveals(TABLE_1);
    assert(game.get_table_settled(TABLE_1), 'setup: hand not settled');
}

// ─── set_blinds ─────────────────────────────────────────────────────────

#[test]
fn test_set_blinds_stores_and_emits() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    let mut spy = spy_events();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    game.set_blinds(TABLE_1, SMALL, BIG);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_small_blind(TABLE_1) == SMALL, 'small blind not stored');
    assert(game.get_big_blind(TABLE_1) == BIG, 'big blind not stored');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::BlindsSet(
                        PokerGame::BlindsSet {
                            table_id: TABLE_1, small_blind: SMALL, big_blind: BIG,
                        },
                    ),
                ),
            ],
        );
}

#[test]
#[feature("safe_dispatcher")]
fn test_set_blinds_non_dealer_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.set_blinds(TABLE_1, SMALL, BIG);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("a stranger set the stakes"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_DEALER', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_big_blind_must_exceed_small() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.set_blinds(TABLE_1, BIG, SMALL);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("big blind below small accepted"),
        Result::Err(p) => assert(*p.at(0) == 'BIG_BLIND_MUST_EXCEED_SB', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_set_blinds_after_shuffle_starts_rejected() {
    // The stakes are fixed before a single card exists, so they cannot be
    // tuned to a deal.
    let (game, _v, _t) = setup(2);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.set_blinds(TABLE_1, 1, 2);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("stakes changed mid-hand"),
        Result::Err(p) => assert(*p.at(0) == 'SHUFFLE_ALREADY_STARTED', 'wrong error'),
    }
}

// ─── the draw ───────────────────────────────────────────────────────────

#[test]
fn test_high_card_takes_the_button() {
    let (game, _v, _t) = setup(3);
    // Ranks 2, K, 7 -- BOB's king wins.
    draw(game, 3, 0, 0);
    assert(!game.get_button_set(TABLE_1), 'button set before all drew');
    draw(game, 3, 1, 11);
    assert(!game.get_button_set(TABLE_1), 'button set before all drew');
    draw(game, 3, 2, 5);
    assert(game.get_button_set(TABLE_1), 'button not set after draw');
    assert(game.get_button(TABLE_1) == SEAT_1, 'high card lost the button');
    assert(game.get_draw_card(TABLE_1, SEAT_1) == 11, 'draw card not stored');
}

#[test]
fn test_draw_ties_are_broken_by_suit() {
    // Two kings: card 11 is rank 11 suit 0, card 50 is rank 11 suit 3.
    // A tie on rank alone would have no answer at all, so the higher suit
    // takes it -- and the result must not depend on reveal order.
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 11);
    draw(game, 2, 1, 50);
    assert(game.get_button(TABLE_1) == SEAT_1, 'higher suit lost the tie');
}

#[test]
fn test_draw_tie_break_is_order_independent() {
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 50);
    draw(game, 2, 1, 11);
    assert(game.get_button(TABLE_1) == SEAT_0, 'tie-break depends on order');
}

#[test]
fn test_draw_beats_rank_before_suit() {
    // Card 12 is an ace of the lowest suit; card 50 a king of the highest.
    // Rank must dominate, or the "high card" would be a high suit.
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 12);
    draw(game, 2, 1, 50);
    assert(game.get_button(TABLE_1) == SEAT_0, 'suit outranked rank');
}

#[test]
#[feature("safe_dispatcher")]
fn test_draw_twice_rejected() {
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 4);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe
        .reveal_draw_card(TABLE_1, SEAT_0, SHARE_X, SHARE_Y, 12, proof());
    match outcome {
        Result::Ok(_) => panic!("re-drew for a better button"),
        Result::Err(p) => assert(*p.at(0) == 'CARD_ALREADY_REVEALED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_draw_after_button_set_rejected() {
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 4);
    draw(game, 2, 1, 5);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    // An empty third seat cannot draw its way in after the fact.
    let outcome = safe
        .reveal_draw_card(TABLE_1, SEAT_2, SHARE_X, SHARE_Y, 12, proof());
    match outcome {
        Result::Ok(_) => panic!("drew after the button was decided"),
        Result::Err(p) => assert(*p.at(0) == 'BUTTON_ALREADY_SET', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_empty_seat_cannot_draw() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);
    let players = array![ALICE(), BOB()];
    let notes = array![NOTE_A, NOTE_B];
    let mut i: u32 = 0;
    while i != 2 {
        fund_and_approve(token, admin, *players.at(i), game.contract_address, STACK);
        start_cheat_caller_address(game.contract_address, *players.at(i));
        game.join_table(TABLE_1, i.into(), *notes.at(i));
        game.register_shuffle_key(TABLE_1, i.into(), PK_X, PK_Y, proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    let mut i: u32 = 0;
    while i != 2 {
        start_cheat_caller_address(game.contract_address, *players.at(i));
        game.submit_shuffle(TABLE_1, DECK_N + i.into(), deck_of(1), proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    open_all(game, 3);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_draw_card(TABLE_1, SEAT_2, SHARE_X, SHARE_Y, 12, proof());
    match outcome {
        Result::Ok(_) => panic!("an empty seat drew a card"),
        Result::Err(p) => assert(*p.at(0) == 'SEAT_IS_EMPTY', 'wrong error'),
    }

    // ...and the two real seats still decide the button between them.
    draw(game, 3, 0, 3);
    draw(game, 3, 1, 9);
    assert(game.get_button(TABLE_1) == SEAT_1, 'button not decided');
}

#[test]
#[feature("safe_dispatcher")]
fn test_draw_before_deck_opened_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_draw_card(TABLE_1, SEAT_0, SHARE_X, SHARE_Y, 12, proof());
    match outcome {
        Result::Ok(_) => panic!("drew from an unopened deck"),
        Result::Err(p) => assert(*p.at(0) == 'DECK_NOT_OPENED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_draw_rejects_a_bad_proof() {
    // The draw card is bound to the committed deck by the same DLEQ every
    // other card is. A seat cannot simply claim an ace.
    let (game, verifier, _t) = setup(2);
    verifier.set_reject_reveal(true);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_draw_card(TABLE_1, SEAT_0, SHARE_X, SHARE_Y, 12, proof());
    match outcome {
        Result::Ok(_) => panic!("claimed a card with no proof"),
        Result::Err(p) => assert(*p.at(0) == 'CARD_REVEAL_REJECTED', 'wrong error'),
    }
}

// ─── post_blinds ────────────────────────────────────────────────────────

#[test]
fn test_heads_up_button_posts_the_small_blind() {
    let (game, _v, token) = setup(2);
    draw(game, 2, 0, 12);
    draw(game, 2, 1, 3);
    assert(game.get_button(TABLE_1) == SEAT_0, 'setup: wrong button');

    let mut spy = spy_events();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.post_blinds(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    // Heads-up the button IS the small blind. That is a real rule, not a
    // simplification of the three-handed case.
    assert(game.get_street_contributed(TABLE_1, SEAT_0) == SMALL, 'button not on the small');
    assert(game.get_street_contributed(TABLE_1, SEAT_1) == BIG, 'other seat not on the big');
    assert(game.get_pot(TABLE_1) == SMALL + BIG, 'pot missing the blinds');
    assert(token.balance_of(ALICE()) == STACK - SMALL.into(), 'small not taken');
    assert(token.balance_of(BOB()) == STACK - BIG.into(), 'big not taken');
    // ...and heads-up the small blind acts first pre-flop.
    assert(game.get_action_turn(TABLE_1) == SEAT_0, 'wrong first to act');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::BlindsPosted(
                        PokerGame::BlindsPosted {
                            table_id: TABLE_1,
                            small_seat: SEAT_0,
                            big_seat: SEAT_1,
                            small: SMALL,
                            big: BIG,
                        },
                    ),
                ),
            ],
        );
}

#[test]
fn test_three_handed_blinds_sit_left_of_the_button() {
    let (game, _v, _t) = setup(3);
    draw(game, 3, 0, 12);
    draw(game, 3, 1, 3);
    draw(game, 3, 2, 4);
    assert(game.get_button(TABLE_1) == SEAT_0, 'setup: wrong button');

    game.post_blinds(TABLE_1);
    assert(game.get_street_contributed(TABLE_1, SEAT_0) == 0, 'button posted a blind');
    assert(game.get_street_contributed(TABLE_1, SEAT_1) == SMALL, 'wrong small blind seat');
    assert(game.get_street_contributed(TABLE_1, SEAT_2) == BIG, 'wrong big blind seat');
    // Three-handed, action starts left of the big blind -- the button.
    assert(game.get_action_turn(TABLE_1) == SEAT_0, 'wrong first to act');
}

#[test]
fn test_big_blind_keeps_its_option() {
    // Posting is forced, not a decision. The big blind has not ACTED, so
    // the round cannot close on it before it gets a chance to raise.
    let (game, _v, _t) = setup(3);
    draw(game, 3, 0, 12);
    draw(game, 3, 1, 3);
    draw(game, 3, 2, 4);
    game.post_blinds(TABLE_1);

    assert(game.get_amount_to_call(TABLE_1, SEAT_0) == BIG, 'button must call the big');
    assert(game.get_amount_to_call(TABLE_1, SEAT_2) == 0, 'big blind owes nothing');
    assert(!game.get_round_complete(TABLE_1), 'round closed on the blinds');

    // Button calls, small completes -- still not complete, the big blind
    // has yet to speak.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BIG);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, BIG - SMALL);
    stop_cheat_caller_address(game.contract_address);
    assert(!game.get_round_complete(TABLE_1), 'big blind lost its option');

    // The big blind checks its option and only now is the street over.
    start_cheat_caller_address(game.contract_address, CAROL());
    game.check(TABLE_1, SEAT_2);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_round_complete(TABLE_1), 'round never closed');
}

#[test]
#[feature("safe_dispatcher")]
fn test_post_blinds_before_the_button_rejected() {
    let (game, _v, _t) = setup(2);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.post_blinds(TABLE_1);
    match outcome {
        Result::Ok(_) => panic!("posted blinds with no button"),
        Result::Err(p) => assert(*p.at(0) == 'BUTTON_NOT_DRAWN_YET', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_post_blinds_twice_rejected() {
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 12);
    draw(game, 2, 1, 3);
    game.post_blinds(TABLE_1);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.post_blinds(TABLE_1);
    match outcome {
        Result::Ok(_) => panic!("blinds posted twice"),
        Result::Err(p) => assert(*p.at(0) == 'BLINDS_ALREADY_POSTED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_betting_before_the_blinds_rejected() {
    // A configured structure is not optional: without this the seat left of
    // the big blind could call a bet nobody had posted.
    let (game, _v, _t) = setup(2);
    draw(game, 2, 0, 12);
    draw(game, 2, 1, 3);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.bet(TABLE_1, SEAT_0, 50);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("bet before the blinds were up"),
        Result::Err(p) => assert(*p.at(0) == 'BLINDS_NOT_POSTED', 'wrong error'),
    }
}

#[test]
fn test_a_table_with_no_structure_still_plays() {
    // small = big = 0 is a table without blinds, which is every table that
    // predates this feature. post_blinds must stay a no-op there rather
    // than becoming a new way to fail.
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    let players = array![ALICE(), BOB()];
    let notes = array![NOTE_A, NOTE_B];
    let mut i: u32 = 0;
    while i != 2 {
        fund_and_approve(token, admin, *players.at(i), game.contract_address, STACK);
        start_cheat_caller_address(game.contract_address, *players.at(i));
        game.join_table(TABLE_1, i.into(), *notes.at(i));
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    // No blinds set, so betting is ungated exactly as before.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 50);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_pot(TABLE_1) == 50, 'unblinded table cannot bet');
}

// ─── the cycle ──────────────────────────────────────────────────────────

#[test]
fn test_button_rotates_on_the_next_hand() {
    let (game, _v, _t) = setup(3);
    draw(game, 3, 0, 12);
    draw(game, 3, 1, 3);
    draw(game, 3, 2, 4);
    game.post_blinds(TABLE_1);
    assert(game.get_button(TABLE_1) == SEAT_0, 'setup: wrong button');

    // End the hand the short way: everyone but CAROL folds.
    fold_to_one_and_settle(game, array![(ALICE(), SEAT_0), (BOB(), SEAT_1)].span());

    let mut spy = spy_events();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.start_next_hand(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    // No second draw -- the button simply moves one seat left. That IS the
    // cycle the blinds ride on.
    assert(game.get_button(TABLE_1) == SEAT_1, 'button did not rotate');
    assert(game.get_hand_number(TABLE_1) == 1, 'hand number did not advance');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::ButtonSet(
                        PokerGame::ButtonSet { table_id: TABLE_1, seat: SEAT_1, by_draw: false },
                    ),
                ),
            ],
        );
}

#[test]
fn test_next_hand_clears_the_last_one() {
    let (game, _v, _t) = setup(3);
    draw(game, 3, 0, 12);
    draw(game, 3, 1, 3);
    draw(game, 3, 2, 4);
    game.post_blinds(TABLE_1);
    fold_to_one_and_settle(game, array![(ALICE(), SEAT_0), (BOB(), SEAT_1)].span());

    game.start_next_hand(TABLE_1);

    assert(!game.get_table_settled(TABLE_1), 'still settled');
    assert(game.get_table_street(TABLE_1) == 0, 'street not rewound');
    assert(!game.get_deck_opened(TABLE_1), 'deck still open');
    assert(!game.get_shuffle_started(TABLE_1), 'shuffle not reset');
    assert(!game.get_shuffle_complete(TABLE_1), 'shuffle still complete');
    assert(!game.get_blinds_posted(TABLE_1), 'blinds still posted');
    assert(!game.get_seat_folded(TABLE_1, SEAT_0), 'fold survived the hand');
    assert(game.get_street_contributed(TABLE_1, SEAT_1) == 0, 'street bet survived');
    // The money is gone -- award() moved it to pending_payout -- so a stale
    // contribution here would let reclaim_stalled_bet pay it out twice.
    assert(game.get_seat_contributed(TABLE_1, SEAT_1) == 0, 'stake survived the payout');
    // Seats, keys and the structure are the TABLE's, not the hand's.
    assert(game.get_seat_owner(TABLE_1, SEAT_0) == ALICE(), 'seat lost its owner');
    assert(game.get_seat_key_registered(TABLE_1, SEAT_0), 'key lost');
    assert(game.get_big_blind(TABLE_1) == BIG, 'stakes lost');
}

#[test]
fn test_second_hand_plays_from_a_clean_slate() {
    // The real test of a reset is whether the next hand actually runs.
    let (game, _v, _t) = setup(3);
    draw(game, 3, 0, 12);
    draw(game, 3, 1, 3);
    draw(game, 3, 2, 4);
    game.post_blinds(TABLE_1);
    fold_to_one_and_settle(game, array![(ALICE(), SEAT_0), (BOB(), SEAT_1)].span());
    game.start_next_hand(TABLE_1);

    // A whole new shuffle and deal, on the same seats and the same keys.
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    let players = array![ALICE(), BOB(), CAROL()];
    let mut i: u32 = 0;
    while i != 3 {
        start_cheat_caller_address(game.contract_address, *players.at(i));
        game.submit_shuffle(TABLE_1, DECK_N + 20 + i.into(), deck_of(2), proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    open_all(game, 3);
    game.post_blinds(TABLE_1);

    // Button on SEAT_1 now, so the blinds moved one seat with it.
    assert(game.get_street_contributed(TABLE_1, SEAT_2) == SMALL, 'small blind did not move');
    assert(game.get_street_contributed(TABLE_1, SEAT_0) == BIG, 'big blind did not move');
    // And every seat is live again, including the two that folded.
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, BIG);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_street_contributed(TABLE_1, SEAT_1) == BIG, 'folded seat still dead');
}

#[test]
#[feature("safe_dispatcher")]
fn test_next_hand_before_settlement_rejected() {
    let (game, _v, _t) = setup(3);
    draw(game, 3, 0, 12);
    draw(game, 3, 1, 3);
    draw(game, 3, 2, 4);
    game.post_blinds(TABLE_1);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.start_next_hand(TABLE_1);
    match outcome {
        Result::Ok(_) => panic!("wiped a hand that was still live"),
        Result::Err(p) => assert(*p.at(0) == 'HAND_NOT_SETTLED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_next_hand_without_a_button_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    fund_and_approve(token, admin, ALICE(), game.contract_address, STACK);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);
    fund_and_approve(token, admin, BOB(), game.contract_address, STACK);
    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    stop_cheat_caller_address(game.contract_address);
    // No blinds on this table, so it settles without a button ever existing.
    fold_to_one_and_settle(game, array![(ALICE(), SEAT_0)].span());

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.start_next_hand(TABLE_1);
    match outcome {
        Result::Ok(_) => panic!("cycled a button that never existed"),
        Result::Err(p) => assert(*p.at(0) == 'BUTTON_NOT_DRAWN_YET', 'wrong error'),
    }
}
