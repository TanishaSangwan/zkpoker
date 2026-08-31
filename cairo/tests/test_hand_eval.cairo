// advance_street, bet()'s post-Showdown gate, and settle_table_by_hand
// (round 6, extended round 8). See tests/README.md — unexecuted/unverified
// in this environment, same caveat as every other file here. Unlike these,
// the underlying poker_hand::evaluate_5/best_of_7 and
// shuffle::shuffled_deck functions this settlement path depends on ARE
// genuinely tested and passing — see cairo/src/poker_hand.cairo and
// cairo/src/shuffle.cairo's own #[cfg(test)] modules, run via
// `scarb test -- -t unit` (no snforge needed for those).
//
// Round 8: settle_table_by_hand now requires reveal_seed and checks
// submitted cards against shuffle::shuffled_deck(revealed_seed) — see
// lib.cairo's doc comment on that fn. Tests that reach that check now use
// REAL cards derived from an actual committed/revealed seed instead of
// hand-picked ones, since a fabricated (if plausible) hand would now fail
// with CARD_MISMATCH before ever reaching poker_hand's scoring. Those real
// deals (seed, resulting hole/community cards, and — for the clear-winner
// and tie tests — the actual winner/scores) were found by brute-force
// search over seeds in Python (using the same verified Poseidon shuffle as
// poseidon_vector_check.cairo/shuffle_vector_check.cairo, plus a Python
// port of poker_hand.cairo's exact scoring algorithm, itself cross-checked
// against poker_hand.cairo's own test vectors before trusting the search),
// then independently confirmed by calling shuffle::shuffled_deck directly
// in a genuinely-run `scarb test -- -t unit` scratch test before being
// baked in here. See scripts/ for nothing checked in from that search (it
// was a one-off, not a maintained tool) — regenerate with:
//
//   from poseidon_py.poseidon_hash import poseidon_hash_many
//   def draw_index(seed, step, bound): return poseidon_hash_many([seed, step]) % bound
//   def shuffled_deck(seed):
//       deck = list(range(52)); idx = 51
//       while idx != 0:
//           j = draw_index(seed, idx, idx + 1); deck[idx], deck[j] = deck[j], deck[idx]; idx -= 1
//       return deck
//   # then search seeds for shuffled_deck(seed)[0:9] (or [0:11] for a
//   # 3-seat deal) giving the desired seat-hole/community split +
//   # winner/tie via a port of poker_hand.cairo's evaluate_5/best_of_7.
//
// test_settle_table_by_hand_three_seat_table additionally covers
// max_seats != 2 (every other test here uses the default 2-seat
// setup_table_with_bets fixture) — same verification standard, a
// separate 3-seat deal for CLEAR_WINNER_SEED (shuffled_deck depends only
// on the seed, not on max_seats, so it's the same deck, just sliced into
// 3 seats instead of 2).

use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::{IPokerGameDispatcherTrait, PokerGame};
use super::helpers::{
    ALICE, BOB, CAROL, DEALER, MALLORY, NOTE_A, NOTE_B, NOTE_C, POOL, SEAT_0, SEAT_1, SEAT_2, TABLE_1,
    THREE_SEATS, deploy_mock_token, deploy_pokergame, fund_and_approve, seed_hash_of, setup_table_with_bets,
};

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

// Round 8: settle_table_by_hand now requires this — commits and reveals
// `seed` for `table_id` as DEALER. Order relative to advance_to_showdown
// doesn't matter (reveal_seed has no street dependency).
fn commit_and_reveal(game: zkpoker::IPokerGameDispatcher, table_id: felt252, seed: felt252) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.commit_deal(table_id, seed_hash_of(seed));
    game.reveal_seed(table_id, seed);
    stop_cheat_caller_address(game.contract_address);
}

// ─── Real deals, verified against shuffle::shuffled_deck directly (see
// this file's header) — TABLE_1's max_seats is 2 (setup_table_with_bets),
// so seat0=SEAT_0's hole cards are shuffled_deck positions 0/1, seat1=
// SEAT_1's are positions 2/3, and community is positions 4..9. ───────────

// seed=1: seat1 (BOB) wins clearly — both make one pair using a hole card
// plus its community match (seat0: 5s+5h; seat1: 6c+6d), so it comes down
// to the pair rank alone: seat1's pair of 6s beats seat0's pair of 5s,
// before kickers even matter. Verified via a Python port of
// evaluate_5/best_of_7 (see this file's header) trying all C(7,5) subsets
// for both seats, not just asserted.
const CLEAR_WINNER_SEED: felt252 = 1;
fn clear_winner_seat0_hole() -> (u8, u8) {
    (card(11, 2), card(3, 3)) // Kh, 5s (37, 42)
}
fn clear_winner_seat1_hole() -> (u8, u8) {
    (card(2, 0), card(4, 0)) // 4c, 6c (2, 4)
}
fn clear_winner_community() -> Span<u8> {
    array![card(12, 3), card(4, 1), card(10, 2), card(8, 0), card(3, 2)].span() // As,6d,Qh,Tc,5h (51,17,36,8,29)
}

// seed=22: seat0 and seat1 reach the exact same best-of-7 score — both play
// the board's pair of 8s plus their own hole queen pairing the board's
// lone Qc, plus the board's Ad kicker (their other hole card is unused,
// lower than what's already on the board). A genuine tie, not contrived.
const TIE_SEED: felt252 = 22;
fn tie_seat0_hole() -> (u8, u8) {
    (card(3, 2), card(10, 1)) // 5h, Qd (29, 23)
}
fn tie_seat1_hole() -> (u8, u8) {
    (card(10, 2), card(5, 2)) // Qh, 7h (36, 31)
}
fn tie_community() -> Span<u8> {
    array![card(6, 3), card(5, 0), card(10, 0), card(12, 1), card(6, 0)].span() // 8s,7c,Qc,Ad,8c (45,5,10,25,6)
}

// Round 8 gap-closing: a 3-seat deal for the same seed=1 as
// CLEAR_WINNER_SEED above (shuffled_deck depends only on the seed, not on
// how many seats the caller slices it for — seat0/seat1's hole cards are
// therefore identical to clear_winner_seat0_hole()/clear_winner_seat1_hole()
// above; only seat2's hole cards and where community starts are new).
// Exercises settle_table_by_hand's community_start = 2*max_seats math at
// max_seats=3, not just the 2 every other test in this file uses. CAROL
// (seat2) wins clearly — pair of aces beats ALICE's pair of 5s beats BOB's
// ace-high (no pair at all for BOB once the community shifts to
// deck[6..11], which no longer contains a rank matching either of BOB's
// hole cards). Verified the same doubly-checked way as the other deals in
// this file (see its header).
fn three_seat_seat2_hole() -> (u8, u8) {
    (card(12, 3), card(4, 1)) // As, 6d (51, 17)
}
fn three_seat_community() -> Span<u8> {
    array![card(10, 2), card(8, 0), card(3, 2), card(1, 1), card(12, 0)].span() // Qh,Tc,5h,3d,Ac (36,8,29,14,12)
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
    commit_and_reveal(game, TABLE_1, CLEAR_WINNER_SEED);
    advance_to_showdown(game, TABLE_1);

    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![clear_winner_seat0_hole(), clear_winner_seat1_hole()].span(),
            clear_winner_community(),
            array![NOTE_A, NOTE_B].span(),
        );
    stop_cheat_caller_address(game.contract_address);

    // BOB (seat1) has the stronger hand for this seed — see this file's
    // header for how that was determined and verified.
    assert(game.get_pending_payout(NOTE_B) == BET * 2, 'BOB should win the pot');
    assert(game.get_pending_payout(NOTE_A) == 0, 'ALICE should get nothing');
    assert(game.get_table_settled(TABLE_1), 'table should be settled');
}

#[test]
fn test_settle_table_by_hand_tie_splits_pot() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    commit_and_reveal(game, TABLE_1, TIE_SEED);
    advance_to_showdown(game, TABLE_1);

    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![tie_seat0_hole(), tie_seat1_hole()].span(),
            tie_community(),
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
    // never advanced past PreFlop -> should panic before ever reaching the
    // (also unmet, here) reveal_seed requirement.
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![clear_winner_seat0_hole()].span(),
            clear_winner_community(),
            array![NOTE_A].span(),
        );
}

#[test]
#[should_panic(expected: 'SEAT_FOLDED')]
fn test_settle_table_by_hand_folded_seat_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    commit_and_reveal(game, TABLE_1, CLEAR_WINNER_SEED);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.fold(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    advance_to_showdown(game, TABLE_1);

    // Community must still match the real deal (checked before the
    // per-seat loop reaches the fold check) — hole cards don't matter
    // here, since SEAT_0's fold panics before its cards are ever checked
    // against the deck.
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![(card(12, 1), card(12, 2))].span(),
            clear_winner_community(),
            array![NOTE_A].span(),
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_settle_table_by_hand_unauthorized_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![clear_winner_seat0_hole()].span(),
            clear_winner_community(),
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

#[test]
#[should_panic(expected: 'BAD_CARDS')]
fn test_settle_table_by_hand_out_of_range_card_rejected() {
    // Regression: round 7 Finding 1 — a card value >= 52 must revert, not
    // silently fold via poker_hand's `% 13` into a valid-looking rank.
    // Fails at assert_valid_deck_cards, before the (also unmet, here)
    // reveal_seed requirement — no commit_and_reveal needed.
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    let community = array![card(0, 0), card(3, 1), card(7, 2), card(9, 3), 200_u8].span();
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
#[should_panic(expected: 'BAD_CARDS')]
fn test_settle_table_by_hand_duplicate_card_across_seats_rejected() {
    // Regression: round 7 Finding 1 — a dealer must not be able to submit
    // the same real card to two different seats (or to a seat and the
    // community cards) to fabricate an impossible hand. Fails at
    // assert_valid_deck_cards, before reveal_seed is required.
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1);
    let community = array![card(0, 0), card(3, 1), card(7, 2), card(9, 3), card(11, 0)].span();
    let alice_hole = (card(12, 1), card(12, 2));
    let bob_hole = (card(12, 1), card(6, 3)); // card(12,1) reused from ALICE's hole cards
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![alice_hole, bob_hole].span(),
            community,
            array![NOTE_A, NOTE_B].span(),
        );
}

#[test]
#[should_panic(expected: 'SEED_NOT_REVEALED')]
fn test_settle_table_by_hand_seed_not_revealed_rejected() {
    // Regression: round 8 — settle_table_by_hand must not proceed to any
    // per-card checking without a revealed seed to check against, even
    // when every other input is well-shaped (real, distinct cards).
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    advance_to_showdown(game, TABLE_1); // no commit_and_reveal
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![clear_winner_seat0_hole(), clear_winner_seat1_hole()].span(),
            clear_winner_community(),
            array![NOTE_A, NOTE_B].span(),
        );
}

#[test]
#[should_panic(expected: 'CARD_MISMATCH')]
fn test_settle_table_by_hand_wrong_hole_card_rejected() {
    // Regression: round 8 — the actual provenance check. Community matches
    // the real deal, but SEAT_0's second hole card is swapped for a
    // different real, unused card (41, not part of this deal at all) —
    // still passes assert_valid_deck_cards (real, distinct), so this is
    // what specifically exercises the new per-seat deck-position check,
    // not the round-7 validity check.
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    commit_and_reveal(game, TABLE_1, CLEAR_WINNER_SEED);
    advance_to_showdown(game, TABLE_1);

    let (real_h1, _real_h2) = clear_winner_seat0_hole();
    let wrong_hole = (real_h1, card(2, 3)); // 41 — a real card, but not seat0's actual second card
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0].span(),
            array![wrong_hole].span(),
            clear_winner_community(),
            array![NOTE_A].span(),
        );
}

#[test]
#[should_panic(expected: 'CARD_MISMATCH')]
fn test_settle_table_by_hand_wrong_community_card_rejected() {
    // Regression: round 8 — same provenance check, community side. Hole
    // cards are correct; one community card is swapped for a different
    // real, unused card (30).
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    commit_and_reveal(game, TABLE_1, CLEAR_WINNER_SEED);
    advance_to_showdown(game, TABLE_1);

    let wrong_community = array![
        card(12, 3), card(4, 1), card(10, 2), card(8, 0), card(4, 2), // last card (29 -> 30) is wrong
    ]
        .span();
    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1].span(),
            array![clear_winner_seat0_hole(), clear_winner_seat1_hole()].span(),
            wrong_community,
            array![NOTE_A, NOTE_B].span(),
        );
}

#[test]
fn test_settle_table_by_hand_three_seat_table() {
    // Regression: round 8 gap-closing — every other settle_table_by_hand
    // test in this file uses TABLE_1's default 2-seat setup
    // (setup_table_with_bets via helpers.cairo), which never exercises
    // settle_table_by_hand's community_start = 2*max_seats math at any
    // max_seats other than 2. This table has 3 real seats — see the
    // three_seat_* helpers above for how the deal was found and verified.
    let game = deploy_pokergame(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, CAROL());
    game.join_table(TABLE_1, SEAT_2, NOTE_C);
    stop_cheat_caller_address(game.contract_address);

    fund_and_approve(token, admin, ALICE(), game.contract_address, FUND);
    fund_and_approve(token, admin, BOB(), game.contract_address, FUND);
    fund_and_approve(token, admin, CAROL(), game.contract_address, FUND);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, BET);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, CAROL());
    game.bet(TABLE_1, SEAT_2, BET);
    stop_cheat_caller_address(game.contract_address);

    // Same seed as CLEAR_WINNER_SEED — shuffled_deck depends only on the
    // seed, not on max_seats, so seat0/seat1's hole cards here are
    // identical to the 2-seat clear-winner scenario's; only how the deck
    // is sliced (3 seats instead of 2, community starting 2 slots later)
    // differs.
    commit_and_reveal(game, TABLE_1, CLEAR_WINNER_SEED);
    advance_to_showdown(game, TABLE_1);

    start_cheat_caller_address(game.contract_address, DEALER());
    game
        .settle_table_by_hand(
            TABLE_1,
            array![SEAT_0, SEAT_1, SEAT_2].span(),
            array![clear_winner_seat0_hole(), clear_winner_seat1_hole(), three_seat_seat2_hole()].span(),
            three_seat_community(),
            array![NOTE_A, NOTE_B, NOTE_C].span(),
        );
    stop_cheat_caller_address(game.contract_address);

    // CAROL (seat2) has the strongest hand — pair of aces beats ALICE's
    // pair of 5s beats BOB's ace-high (no pair at all). pot = BET*3.
    assert(game.get_pending_payout(NOTE_C) == BET * 3, 'CAROL should win the pot');
    assert(game.get_pending_payout(NOTE_A) == 0, 'ALICE should get nothing');
    assert(game.get_pending_payout(NOTE_B) == 0, 'BOB should get nothing');
    assert(game.get_table_settled(TABLE_1), 'table should be settled');
}
