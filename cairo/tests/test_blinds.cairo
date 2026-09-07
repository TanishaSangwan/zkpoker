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
const DECK_OPEN_K: u32 = 19;

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

// Opens whatever the fused final shuffle proof did not. Chunk 0 rides along
// with submit_final_shuffle now, so this starts at 1 -- and on any table of
// seven seats or fewer (2*max_seats + 5 <= 19) it does nothing at all.
fn open_all(game: zkpoker::IPokerGameDispatcher, max_seats: u32) {
    let total = 2 * max_seats + 5;
    let chunks = (total + DECK_OPEN_K - 1) / DECK_OPEN_K;
    let mut c: u32 = 1;
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
        if i + 1 == seats {
            game
                .submit_final_shuffle(
                    TABLE_1, DECK_N + i.into(), deck_of(1), chunk_cts(0, 2 * seats + 5), proof(),
                );
        } else {
            game.submit_shuffle(TABLE_1, DECK_N + i.into(), deck_of(1), proof());
        }
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    open_all(game, seats);
    (game, verifier, token)
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

// ─── the button ─────────────────────────────────────────────────────────

#[test]
fn test_button_starts_on_the_lowest_occupied_seat() {
    // No draw, no reveal, no proof: the button is a rule, not a card. It is
    // fixed when begin_shuffle freezes the participant list, which is before
    // any card exists -- so it cannot be steered by anything anyone learns
    // from the deal.
    let (game, _v, _t) = setup(3);
    assert(game.get_button_set(TABLE_1), 'button not set by shuffle');
    assert(game.get_button(TABLE_1) == SEAT_0, 'button not on lowest seat');
}

#[test]
fn test_button_skips_an_empty_low_seat() {
    // "Lowest occupied", not "seat zero": a table whose first seat nobody
    // took must still have a button, and it must be a seat that exists.
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    game.set_blinds(TABLE_1, SMALL, BIG);
    stop_cheat_caller_address(game.contract_address);

    let players = array![BOB(), CAROL()];
    let notes = array![NOTE_B, NOTE_C];
    let mut i: u32 = 0;
    while i != 2 {
        let who = *players.at(i);
        fund_and_approve(token, admin, who, game.contract_address, STACK);
        start_cheat_caller_address(game.contract_address, who);
        game.join_table(TABLE_1, (i + 1).into(), *notes.at(i));
        game.register_shuffle_key(TABLE_1, (i + 1).into(), PK_X, PK_Y, proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_button(TABLE_1) == SEAT_1, 'button on an empty seat');
}

#[test]
fn test_button_is_set_before_any_card_is_opened() {
    // The ordering is the whole safety argument: if the button could be
    // decided after the deck opened, whoever opened it would be choosing.
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    let players = array![ALICE(), BOB()];
    let notes = array![NOTE_A, NOTE_B];
    let mut i: u32 = 0;
    while i != 2 {
        let who = *players.at(i);
        fund_and_approve(token, admin, who, game.contract_address, STACK);
        start_cheat_caller_address(game.contract_address, who);
        game.join_table(TABLE_1, i.into(), *notes.at(i));
        game.register_shuffle_key(TABLE_1, i.into(), PK_X, PK_Y, proof());
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    assert(!game.get_button_set(TABLE_1), 'button set before the shuffle');
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_button_set(TABLE_1), 'button not set at begin_shuffle');
    assert(!game.get_deck_opened(TABLE_1), 'deck opened too early');
}

// ─── post_blinds ────────────────────────────────────────────────────────

#[test]
fn test_heads_up_button_posts_the_small_blind() {
    let (game, _v, token) = setup(2);
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
    // setup() cannot reach this state any more -- it calls begin_shuffle,
    // which is where the button is fixed -- so the table is built by hand and
    // stopped one step short.
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    game.set_blinds(TABLE_1, SMALL, BIG);
    stop_cheat_caller_address(game.contract_address);
    fund_and_approve(token, admin, ALICE(), game.contract_address, STACK);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

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
                        PokerGame::ButtonSet { table_id: TABLE_1, seat: SEAT_1 },
                    ),
                ),
            ],
        );
}

#[test]
fn test_next_hand_clears_the_last_one() {
    let (game, _v, _t) = setup(3);
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
        if i + 1 == 3 {
            game
                .submit_final_shuffle(
                    TABLE_1, DECK_N + 20 + i.into(), deck_of(2), chunk_cts(0, 11), proof(),
                );
        } else {
            game.submit_shuffle(TABLE_1, DECK_N + 20 + i.into(), deck_of(2), proof());
        }
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

// ─── the blind ladder ───────────────────────────────────────────────────

// A table on the ladder: same as setup(), but with a schedule instead of a
// fixed pair. Returns the pieces a multi-hand test needs to keep the seats
// funded as the blinds climb.
fn setup_ladder(
    seats: u32, hands_per_level: u32,
) -> (
    zkpoker::IPokerGameDispatcher,
    zkpoker::IErc20Dispatcher,
    zkpoker::mocks::IMockErc20AdminDispatcher,
) {
    let (game, _verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, seats);
    game.set_blind_schedule(TABLE_1, hands_per_level);
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
    deal(game, seats, 1);
    (game, token, admin)
}

// One shuffle chain and one deck opening, on a table whose seats are already
// registered. `nonce` keeps successive hands' deck commitments distinct.
fn deal(game: zkpoker::IPokerGameDispatcher, seats: u32, nonce: u256) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    let players = array![ALICE(), BOB(), CAROL()];
    let mut i: u32 = 0;
    while i != seats {
        start_cheat_caller_address(game.contract_address, *players.at(i));
        if i + 1 == seats {
            game
                .submit_final_shuffle(
                    TABLE_1,
                    DECK_N + nonce * 100 + i.into(),
                    deck_of(1),
                    chunk_cts(0, 2 * seats + 5),
                    proof(),
                );
        } else {
            game.submit_shuffle(TABLE_1, DECK_N + nonce * 100 + i.into(), deck_of(1), proof());
        }
        stop_cheat_caller_address(game.contract_address);
        i += 1;
    }
    open_all(game, seats);
}

// Folds every seat but one, in whatever order the action reaches them, then
// walks the streets out and settles. The order is not a detail: fold is
// turn-gated, and the button rotates every hand, so a fixed fold order works
// on hand one and reverts on hand two.
fn fold_around_and_settle(game: zkpoker::IPokerGameDispatcher, seats: u32) {
    let players = array![ALICE(), BOB(), CAROL()];
    let mut remaining = seats;
    while remaining != 1 {
        let turn = game.get_action_turn(TABLE_1);
        let idx: u32 = turn.try_into().unwrap();
        start_cheat_caller_address(game.contract_address, *players.at(idx));
        game.fold(TABLE_1, turn);
        stop_cheat_caller_address(game.contract_address);
        remaining -= 1;
    }
    let mut st: u8 = game.get_table_street(TABLE_1);
    while st != 4 {
        game.advance_street(TABLE_1);
        st += 1;
    }
    game.settle_from_reveals(TABLE_1);
    assert(game.get_table_settled(TABLE_1), 'ladder: hand not settled');
}

// Plays the current hand out and deals the next one, topping every seat back
// up on the way -- the blinds climb past any one starting stack.
fn next_hand(
    game: zkpoker::IPokerGameDispatcher,
    token: zkpoker::IErc20Dispatcher,
    admin: zkpoker::mocks::IMockErc20AdminDispatcher,
    seats: u32,
    nonce: u256,
) {
    game.post_blinds(TABLE_1);
    fold_around_and_settle(game, seats);
    game.start_next_hand(TABLE_1);
    let players = array![ALICE(), BOB(), CAROL()];
    let mut i: u32 = 0;
    while i != seats {
        fund_and_approve(token, admin, *players.at(i), game.contract_address, STACK);
        i += 1;
    }
    deal(game, seats, nonce);
}

#[test]
fn test_a_fixed_blind_table_is_untouched_by_the_ladder() {
    // The ladder is opt-in. A table that never asks for one keeps whatever
    // set_blinds stored, and reads as level 0 rather than as something
    // undefined.
    let (game, _v, _t) = setup(3);
    assert(game.get_blind_level_hands(TABLE_1) == 0, 'schedule set by default');
    assert(game.get_blind_level(TABLE_1) == 0, 'level should be 0');
    assert(game.get_small_blind(TABLE_1) == SMALL, 'small blind changed');
    assert(game.get_big_blind(TABLE_1) == BIG, 'big blind changed');
}

#[test]
fn test_blind_ladder_starts_on_the_first_rung() {
    let (game, _token, _admin) = setup_ladder(3, 2);
    assert(game.get_blind_level(TABLE_1) == 0, 'first hand is level 0');
    assert(game.get_small_blind(TABLE_1) == 10, 'rung 0 small');
    assert(game.get_big_blind(TABLE_1) == 20, 'rung 0 big');
}

#[test]
fn test_blind_ladder_holds_for_a_whole_level_then_climbs() {
    // Two hands per rung, so hand 1 is still 10/20 and hand 2 is 20/40. The
    // "holds" half matters as much as the "climbs" half: a ladder that moved
    // every hand would be a different game.
    let (game, token, admin) = setup_ladder(3, 2);
    next_hand(game, token, admin, 3, 2);
    assert(game.get_hand_number(TABLE_1) == 1, 'hand 1 expected');
    assert(game.get_blind_level(TABLE_1) == 0, 'still on rung 0');
    assert(game.get_big_blind(TABLE_1) == 20, 'blinds moved too early');

    next_hand(game, token, admin, 3, 3);
    assert(game.get_hand_number(TABLE_1) == 2, 'hand 2 expected');
    assert(game.get_blind_level(TABLE_1) == 1, 'should be on rung 1');
    assert(game.get_small_blind(TABLE_1) == 20, 'rung 1 small');
    assert(game.get_big_blind(TABLE_1) == 40, 'rung 1 big');
}

#[test]
fn test_blind_ladder_walks_every_rung_and_then_stops() {
    // One hand per rung: 10/20, 20/40, 30/60, 50/100, 100/200, 200/400,
    // 300/600 -- and then 300/600 again. Clamping, not wrapping: a ladder that
    // wrapped would take a table from 300/600 back to 10/20 and quietly undo
    // every stack it had just decided.
    let (game, token, admin) = setup_ladder(3, 1);
    let smalls = array![10_u128, 20, 30, 50, 100, 200, 300];
    let bigs = array![20_u128, 40, 60, 100, 200, 400, 600];

    let mut h: u32 = 0;
    while h != 7 {
        assert(game.get_blind_level(TABLE_1) == h, 'wrong rung');
        assert(game.get_small_blind(TABLE_1) == *smalls.at(h), 'wrong small blind');
        assert(game.get_big_blind(TABLE_1) == *bigs.at(h), 'wrong big blind');
        next_hand(game, token, admin, 3, (h + 2).into());
        h += 1;
    }

    // Hand 7 is past the top rung.
    assert(game.get_hand_number(TABLE_1) == 7, 'hand 7 expected');
    assert(game.get_blind_level(TABLE_1) == 6, 'must clamp at the top');
    assert(game.get_big_blind(TABLE_1) == 600, 'must stay at 300/600');
}

#[test]
fn test_ladder_blinds_are_actually_posted() {
    // The views agreeing with the ladder is not the same as the money moving.
    // Rung 1 on a three-handed table: small blind one seat left of the button,
    // big blind the seat after.
    let (game, token, admin) = setup_ladder(3, 1);
    next_hand(game, token, admin, 3, 2);
    game.post_blinds(TABLE_1);
    assert(game.get_street_contributed(TABLE_1, SEAT_2) == 20, 'small blind not 20');
    assert(game.get_street_contributed(TABLE_1, SEAT_0) == 40, 'big blind not 40');
}

#[test]
#[feature("safe_dispatcher")]
fn test_acting_before_ladder_blinds_are_posted_rejected() {
    // A ladder table never writes small_blind/big_blind, so the "does this
    // table have a structure?" gate cannot read storage: doing so reported no
    // blinds and let a seat act before the forced bets were in.
    let (game, _token, _admin) = setup_ladder(3, 1);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.check(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("acted before the ladder blinds were posted"),
        Result::Err(p) => assert(*p.at(0) == 'BLINDS_NOT_POSTED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_blind_schedule_non_dealer_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.set_blind_schedule(TABLE_1, 1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("a stranger set the blind structure"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_DEALER', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_blind_schedule_of_zero_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.set_blind_schedule(TABLE_1, 0);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("zero hands per level accepted"),
        Result::Err(p) => assert(*p.at(0) == 'BIG_BLIND_MUST_EXCEED_SB', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_blind_schedule_after_the_shuffle_starts_rejected() {
    // Same rule as set_blinds, and for the same reason: the structure is fixed
    // before a single card exists, so it cannot be tuned to a deal.
    let (game, _v, _t) = setup(2);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.set_blind_schedule(TABLE_1, 1);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("ladder set mid-hand"),
        Result::Err(p) => assert(*p.at(0) == 'SHUFFLE_ALREADY_STARTED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_blind_schedule_after_the_first_hand_rejected() {
    // Stricter than set_blinds. A ladder is a whole-table structure that every
    // stack is played against, so it is fixed before the table's FIRST card,
    // not merely before this hand's -- otherwise a dealer could watch a hand,
    // see who is winning, and re-time the levels against them.
    let (game, token, admin) = setup_ladder(3, 1);
    next_hand(game, token, admin, 3, 2);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.set_blind_schedule(TABLE_1, 5);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("ladder re-timed after a hand had played"),
        Result::Err(p) => assert(*p.at(0) == 'SHUFFLE_ALREADY_STARTED', 'wrong error'),
    }
}
