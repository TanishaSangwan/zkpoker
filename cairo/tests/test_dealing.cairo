// Dealing: deck opening, community reveals, hole-card commit/reveal
// (docs/PROTOCOL.md §4 phases 2-4).
//
// Proof and card-recovery checks are delegated to MockShuffleVerifier here.
// These tests cover the STATE MACHINE the contract owns: ordering against
// the shuffle chain, which deck positions may be touched, one-shot
// reveals, seat ownership, and the dealing-time commitment binding.
// Whether a share really decrypts to a given card is the verifier's job
// (cairo-verifier/src/dleq.cairo, exercised on devnet against real
// Grumpkin proofs).

use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::mocks::IMockVerifierAdminTraitDispatcherTrait;
use zkpoker::{IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait, PokerGame};
use super::helpers::{
    ALICE, BOB, DEALER, MALLORY, NOTE_A, NOTE_B, POOL, SEAT_0, SEAT_1, TABLE_1, TWO_SEATS,
    deploy_mock_token, deploy_pokergame_with_verifier,
};

const PK_A_X: u256 = u256 { low: 'PKAX', high: 1 };
const PK_A_Y: u256 = u256 { low: 'PKAY', high: 2 };
const PK_B_X: u256 = u256 { low: 'PKBX', high: 3 };
const PK_B_Y: u256 = u256 { low: 'PKBY', high: 4 };
const JOINT_X: u256 = u256 { low: 'JOINTX', high: 5 };
const JOINT_Y: u256 = u256 { low: 'JOINTY', high: 6 };
const DECK_0: u256 = u256 { low: 'DECK0', high: 7 };
const DECK_1: u256 = u256 { low: 'DECK1', high: 8 };
const DECK_2: u256 = u256 { low: 'DECK2', high: 9 };
const SHARE_X: u256 = u256 { low: 'SHAREX', high: 11 };
const SHARE_Y: u256 = u256 { low: 'SHAREY', high: 12 };

fn proof() -> Span<felt252> {
    array!['PROOF'].span()
}

fn key_proof() -> Span<felt252> {
    array!['KEYPROOF'].span()
}

// max_seats = 2, so hole positions are 0..3 and community is 2*2 + k.
fn hole_pos(seat: u32, slot: u32) -> u32 {
    2 * seat + slot
}

fn community_pos(k: u32) -> u32 {
    2 * 2 + k
}

// Four ciphertext coords per position: c1.x, c1.y, c2.x, c2.y. Opaque to
// the contract, which never does curve arithmetic itself.
fn ct(tag: felt252) -> Array<u256> {
    array![
        u256 { low: tag.try_into().unwrap(), high: 100 },
        u256 { low: tag.try_into().unwrap(), high: 101 },
        u256 { low: tag.try_into().unwrap(), high: 102 },
        u256 { low: tag.try_into().unwrap(), high: 103 },
    ]
}

fn all_positions() -> Span<u32> {
    array![
        hole_pos(0, 0), hole_pos(0, 1), hole_pos(1, 0), hole_pos(1, 1),
        community_pos(0), community_pos(1), community_pos(2), community_pos(3), community_pos(4),
    ]
        .span()
}

// One DECK_OPEN_K-sized chunk of ciphertexts, starting at `first`, padded
// the way the contract pads a final partial chunk: by repeating the last
// in-play position. Round 8 finding I -- the deck is opened K=5 positions
// at a time because circuits/deck_open fixes K at compile time.
fn chunk_cts(first: u32, k_total: u32) -> Span<u256> {
    let mut out: Array<u256> = array![];
    let mut i: u32 = 0;
    while i != 5 {
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

// A two-seat table has 2*2 + 5 = 9 in-play positions, so two chunks.
fn open_all(game: zkpoker::IPokerGameDispatcher) {
    game.open_deck(TABLE_1, 0, chunk_cts(0, 9), proof());
    game.open_deck(TABLE_1, 1, chunk_cts(5, 9), proof());
}


// Table with both keys registered, shuffle run to completion.
fn setup_shuffled() -> (
    zkpoker::IPokerGameDispatcher, zkpoker::mocks::IMockVerifierAdminTraitDispatcher,
) {
    let (game, verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _token, _admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    game.register_shuffle_key(TABLE_1, SEAT_1, PK_B_X, PK_B_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, proof());
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_shuffle_complete(TABLE_1), 'setup: shuffle incomplete');
    (game, verifier)
}

fn setup_opened() -> (
    zkpoker::IPokerGameDispatcher, zkpoker::mocks::IMockVerifierAdminTraitDispatcher,
) {
    let (game, verifier) = setup_shuffled();
    open_all(game);
    (game, verifier)
}

// ─── open_deck ──────────────────────────────────────────────────────────

#[test]
fn test_open_deck_success_and_event() {
    let (game, _v) = setup_shuffled();
    let mut spy = spy_events();
    // The first chunk alone must NOT mark the deck open -- a partial open
    // is what finding 1's griefer wanted.
    game.open_deck(TABLE_1, 0, chunk_cts(0, 9), proof());
    assert(!game.get_deck_opened(TABLE_1), 'not opened until complete');
    game.open_deck(TABLE_1, 1, chunk_cts(5, 9), proof());
    assert(game.get_deck_opened(TABLE_1), 'deck not marked opened');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::DeckOpened(
                        PokerGame::DeckOpened { table_id: TABLE_1, positions: 9, deck_hash: DECK_2 },
                    ),
                ),
            ],
        );
}

// Anyone may submit it: the proof is self-authenticating, so who relays it
// cannot change what it proves.
#[test]
fn test_open_deck_callable_by_non_participant() {
    let (game, _v) = setup_shuffled();
    start_cheat_caller_address(game.contract_address, MALLORY());
    open_all(game);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_deck_opened(TABLE_1), 'deck not opened');
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_deck_before_shuffle_complete_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.open_deck(TABLE_1, 0, chunk_cts(0, 9), proof());
    match outcome {
        Result::Ok(_) => panic!("opened a deck before the shuffle finished"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'SHUFFLE_NOT_COMPLETE', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_deck_twice_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.open_deck(TABLE_1, 0, chunk_cts(0, 9), proof());
    match outcome {
        Result::Ok(_) => panic!("reopened the deck"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'DECK_ALREADY_OPENED', 'wrong error',
        ),
    }
}

// Four coords per position or the ciphertexts do not line up with the
// positions they claim to be at.
#[test]
#[feature("safe_dispatcher")]
fn test_open_deck_mismatched_lengths_rejected() {
    let (game, _v) = setup_shuffled();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.open_deck(TABLE_1, 0, ct('X').span(), proof());
    match outcome {
        Result::Ok(_) => panic!("accepted a short ciphertext array"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'BAD_OPENING_LENGTH', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_open_deck_rejected_proof() {
    let (game, verifier) = setup_shuffled();
    verifier.set_reject_opening(true);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.open_deck(TABLE_1, 0, chunk_cts(0, 9), proof());
    match outcome {
        Result::Ok(_) => panic!("accepted a rejected opening proof"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'DECK_OPENING_REJECTED', 'wrong error',
        ),
    }
}

// ─── community cards ────────────────────────────────────────────────────

#[test]
fn test_reveal_community_card_success_and_event() {
    let (game, _v) = setup_opened();
    let mut spy = spy_events();
    game.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());
    assert(game.get_community_revealed(TABLE_1, 0), 'not revealed');
    assert(game.get_community_card(TABLE_1, 0) == 7, 'wrong card');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::CommunityCardRevealed(
                        PokerGame::CommunityCardRevealed { table_id: TABLE_1, index: 0, card: 7 },
                    ),
                ),
            ],
        );
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_community_before_open_rejected() {
    let (game, _v) = setup_shuffled();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());
    match outcome {
        Result::Ok(_) => panic!("revealed before the deck was opened"),
        Result::Err(panic_data) => assert(*panic_data.at(0) == 'DECK_NOT_OPENED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_community_bad_index_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_community_card(TABLE_1, 5, SHARE_X, SHARE_Y, 7, proof());
    match outcome {
        Result::Ok(_) => panic!("accepted a 6th community card"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'BAD_COMMUNITY_INDEX', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_community_twice_rejected() {
    let (game, _v) = setup_opened();
    game.reveal_community_card(TABLE_1, 2, SHARE_X, SHARE_Y, 30, proof());
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_community_card(TABLE_1, 2, SHARE_X, SHARE_Y, 31, proof());
    match outcome {
        Result::Ok(_) => panic!("re-revealed a community card"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'CARD_ALREADY_REVEALED', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_community_rejected_proof() {
    let (game, verifier) = setup_opened();
    verifier.set_reject_reveal(true);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());
    match outcome {
        Result::Ok(_) => panic!("accepted a rejected reveal proof"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'CARD_REVEAL_REJECTED', 'wrong error',
        ),
    }
}

// ─── hole-card commitment ───────────────────────────────────────────────

fn commitment_for(share_x: u256, share_y: u256, blinding: felt252) -> felt252 {
    core::poseidon::poseidon_hash_span(
        array![
            share_x.low.into(), share_x.high.into(), share_y.low.into(), share_y.high.into(),
            blinding,
        ]
            .span(),
    )
}

#[test]
fn test_commit_hole_shares_success_and_event() {
    let (game, _v) = setup_opened();
    let c = commitment_for(SHARE_X, SHARE_Y, 'RHO');
    let mut spy = spy_events();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.commit_hole_shares(TABLE_1, SEAT_0, 0, c);
    stop_cheat_caller_address(game.contract_address);
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::HoleSharesCommitted(
                        PokerGame::HoleSharesCommitted {
                            table_id: TABLE_1, seat: SEAT_0, slot: 0, commitment: c,
                        },
                    ),
                ),
            ],
        );
}

#[test]
#[feature("safe_dispatcher")]
fn test_commit_hole_shares_not_seat_owner_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.commit_hole_shares(TABLE_1, SEAT_0, 0, 'C');
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("committed for someone else's seat"),
        Result::Err(panic_data) => assert(*panic_data.at(0) == 'NOT_SEAT_OWNER', 'wrong error'),
    }
}

// A replaceable commitment binds nothing: the player could wait for the
// board and then commit to whichever share set suits them.
#[test]
#[feature("safe_dispatcher")]
fn test_commit_hole_shares_twice_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    game.commit_hole_shares(TABLE_1, SEAT_0, 0, 'FIRST');
    let outcome = safe.commit_hole_shares(TABLE_1, SEAT_0, 0, 'SECOND');
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("replaced a hole-card commitment"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'HOLE_ALREADY_COMMITTED', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_commit_hole_shares_bad_slot_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.commit_hole_shares(TABLE_1, SEAT_0, 2, 'C');
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("accepted a third hole card"),
        Result::Err(panic_data) => assert(*panic_data.at(0) == 'BAD_HOLE_SLOT', 'wrong error'),
    }
}

// ─── showdown ───────────────────────────────────────────────────────────

#[test]
fn test_reveal_hole_card_success_and_event() {
    let (game, _v) = setup_opened();
    let c = commitment_for(SHARE_X, SHARE_Y, 'RHO');
    start_cheat_caller_address(game.contract_address, ALICE());
    game.commit_hole_shares(TABLE_1, SEAT_0, 0, c);
    stop_cheat_caller_address(game.contract_address);

    let mut spy = spy_events();
    game.reveal_hole_card(TABLE_1, SEAT_0, 0, SHARE_X, SHARE_Y, 'RHO', 42, proof());
    assert(game.get_hole_revealed(TABLE_1, SEAT_0, 0), 'not revealed');
    assert(game.get_hole_card(TABLE_1, SEAT_0, 0) == 42, 'wrong card');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::HoleCardRevealed(
                        PokerGame::HoleCardRevealed {
                            table_id: TABLE_1, seat: SEAT_0, slot: 0, card: 42,
                        },
                    ),
                ),
            ],
        );
}

// The binding that matters: a different share set than the one committed
// to during dealing must not open. Otherwise a player could pick their
// hand after seeing the board.
#[test]
#[feature("safe_dispatcher")]
fn test_reveal_hole_card_wrong_shares_rejected() {
    let (game, _v) = setup_opened();
    let c = commitment_for(SHARE_X, SHARE_Y, 'RHO');
    start_cheat_caller_address(game.contract_address, ALICE());
    game.commit_hole_shares(TABLE_1, SEAT_0, 0, c);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let other_x = u256 { low: 'OTHER', high: 99 };
    let outcome = safe
        .reveal_hole_card(TABLE_1, SEAT_0, 0, other_x, SHARE_Y, 'RHO', 42, proof());
    match outcome {
        Result::Ok(_) => panic!("opened with shares that were never committed"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'COMMITMENT_MISMATCH', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_hole_card_wrong_blinding_rejected() {
    let (game, _v) = setup_opened();
    let c = commitment_for(SHARE_X, SHARE_Y, 'RHO');
    start_cheat_caller_address(game.contract_address, ALICE());
    game.commit_hole_shares(TABLE_1, SEAT_0, 0, c);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe
        .reveal_hole_card(TABLE_1, SEAT_0, 0, SHARE_X, SHARE_Y, 'WRONG', 42, proof());
    match outcome {
        Result::Ok(_) => panic!("opened with the wrong blinding factor"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'COMMITMENT_MISMATCH', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_hole_card_without_commitment_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe
        .reveal_hole_card(TABLE_1, SEAT_0, 0, SHARE_X, SHARE_Y, 'RHO', 42, proof());
    match outcome {
        Result::Ok(_) => panic!("revealed without ever committing"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'NO_HOLE_COMMITMENT', 'wrong error',
        ),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_reveal_hole_card_twice_rejected() {
    let (game, _v) = setup_opened();
    let c = commitment_for(SHARE_X, SHARE_Y, 'RHO');
    start_cheat_caller_address(game.contract_address, ALICE());
    game.commit_hole_shares(TABLE_1, SEAT_0, 0, c);
    stop_cheat_caller_address(game.contract_address);

    game.reveal_hole_card(TABLE_1, SEAT_0, 0, SHARE_X, SHARE_Y, 'RHO', 42, proof());
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe
        .reveal_hole_card(TABLE_1, SEAT_0, 0, SHARE_X, SHARE_Y, 'RHO', 43, proof());
    match outcome {
        Result::Ok(_) => panic!("re-revealed a hole card"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'CARD_ALREADY_REVEALED', 'wrong error',
        ),
    }
}

// ─── showdown scoring ───────────────────────────────────────────────────
//
// settle_from_reveals takes NO caller input beyond the table: every card
// comes from storage a reveal proof already bound, and every payout note
// from the binding join_table made. So these tests drive it purely by
// changing what has been revealed.
//
// card = suit * 13 + rank, rank 0='2'..12='A'. The board below is
// deliberately mixed-suit and non-consecutive so the tie case is a real
// tie on ranks rather than an accidental flush or straight.

fn card(rank: u8, suit: u8) -> u8 {
    suit * 13 + rank
}

// 2♠ 5♥ 7♦ 9♣ J♠ — no flush draw, no straight
fn board() -> Array<u8> {
    array![card(0, 0), card(3, 1), card(5, 2), card(7, 3), card(9, 0)]
}

fn setup_preflop_done() -> zkpoker::IPokerGameDispatcher {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    super::helpers::fund_and_approve(token, admin, ALICE(), game.contract_address, 10_000);
    super::helpers::fund_and_approve(token, admin, BOB(), game.contract_address, 10_000);

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    // Everyone seats BEFORE anyone bets. Turn order skips seats that have
    // not joined, so betting into a half-empty table would leave the turn
    // stuck on the only occupied seat.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    game.register_shuffle_key(TABLE_1, SEAT_1, PK_B_X, PK_B_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 1_000);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, 1_000);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, proof());
    stop_cheat_caller_address(game.contract_address);

    open_all(game);

    game
}

fn setup_showdown() -> zkpoker::IPokerGameDispatcher {
    let game = setup_preflop_done();
    advance(game); // PreFlop -> Flop; the bets above completed that round
    let mut n: u32 = 0;
    while n != 3 {
        check_both(game);
        advance(game);
        n += 1;
    }
    game
}

fn advance(game: zkpoker::IPokerGameDispatcher) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.advance_street(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
}

// A street with no betting still has to be played out: every seat still in
// the hand must act before it can end. That is the rule advance_street used
// to let you skip entirely.
fn check_both(game: zkpoker::IPokerGameDispatcher) {
    start_cheat_caller_address(game.contract_address, ALICE());
    game.check(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.check(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
}

fn reveal_board(game: zkpoker::IPokerGameDispatcher) {
    let b = board();
    let mut k: u32 = 0;
    while k != 5 {
        game.reveal_community_card(TABLE_1, k, SHARE_X, SHARE_Y, *b.at(k), proof());
        k += 1;
    }
}

fn reveal_hole(
    game: zkpoker::IPokerGameDispatcher, who: starknet::ContractAddress, seat: felt252, a: u8, b: u8,
) {
    start_cheat_caller_address(game.contract_address, who);
    game.commit_hole_shares(TABLE_1, seat, 0, commitment_for(SHARE_X, SHARE_Y, 'R0'));
    game.commit_hole_shares(TABLE_1, seat, 1, commitment_for(SHARE_X, SHARE_Y, 'R1'));
    stop_cheat_caller_address(game.contract_address);
    game.reveal_hole_card(TABLE_1, seat, 0, SHARE_X, SHARE_Y, 'R0', a, proof());
    game.reveal_hole_card(TABLE_1, seat, 1, SHARE_X, SHARE_Y, 'R1', b, proof());
}

#[test]
fn test_settle_from_reveals_best_hand_wins() {
    let game = setup_showdown();
    reveal_board(game);
    // ALICE: pair of aces. BOB: K-Q high.
    reveal_hole(game, ALICE(), SEAT_0, card(12, 0), card(12, 1));
    reveal_hole(game, BOB(), SEAT_1, card(11, 0), card(10, 1));

    let mut spy = spy_events();
    game.settle_from_reveals(TABLE_1);
    assert(game.get_pending_payout(NOTE_A) == 2_000, 'alice should win whole pot');
    assert(game.get_pending_payout(NOTE_B) == 0, 'bob should win nothing');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::Settled(
                        PokerGame::Settled { table_id: TABLE_1, winner_count: 1 },
                    ),
                ),
            ],
        );
}

#[test]
fn test_settle_from_reveals_tie_splits_pot() {
    let game = setup_showdown();
    reveal_board(game);
    // Same ranks, different suits, on a board with no flush or straight.
    reveal_hole(game, ALICE(), SEAT_0, card(12, 0), card(11, 1));
    reveal_hole(game, BOB(), SEAT_1, card(12, 2), card(11, 3));

    game.settle_from_reveals(TABLE_1);
    assert(game.get_pending_payout(NOTE_A) == 1_000, 'alice half');
    assert(game.get_pending_payout(NOTE_B) == 1_000, 'bob half');
}

// Everyone folded to one player: no cards are needed and none should be
// demanded. Making them show would leak a hand nobody contested.
#[test]
fn test_settle_from_reveals_uncontested_needs_no_cards() {
    let game = setup_preflop_done();
    advance(game); // PreFlop -> Flop
    // BOB folds in turn on the flop. With one seat left the round is
    // trivially complete, so the remaining streets need no action at all.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.check(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.fold(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    advance(game);
    advance(game);
    advance(game);

    game.settle_from_reveals(TABLE_1);
    assert(game.get_pending_payout(NOTE_A) == 2_000, 'alice takes it uncontested');
}

// Anyone may settle: the contract reads every card and note from its own
// storage, so there is nothing a caller could steer.
#[test]
fn test_settle_from_reveals_callable_by_anyone() {
    let game = setup_showdown();
    reveal_board(game);
    reveal_hole(game, ALICE(), SEAT_0, card(12, 0), card(12, 1));
    reveal_hole(game, BOB(), SEAT_1, card(11, 0), card(10, 1));

    start_cheat_caller_address(game.contract_address, MALLORY());
    game.settle_from_reveals(TABLE_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_pending_payout(NOTE_A) == 2_000, 'alice still wins');
}

#[test]
#[feature("safe_dispatcher")]
fn test_settle_from_reveals_incomplete_board_rejected() {
    let game = setup_showdown();
    let b = board();
    game.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, *b.at(0), proof());
    reveal_hole(game, ALICE(), SEAT_0, card(12, 0), card(12, 1));
    reveal_hole(game, BOB(), SEAT_1, card(11, 0), card(10, 1));

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    match safe.settle_from_reveals(TABLE_1) {
        Result::Ok(_) => panic!("settled on a 1-card board"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'COMMUNITY_NOT_REVEALED', 'wrong error',
        ),
    }
}

// A contender who never opened cannot be scored. They have effectively
// mucked -- but the hand cannot be settled while they are still in it.
#[test]
#[feature("safe_dispatcher")]
fn test_settle_from_reveals_mucking_forfeits_it_does_not_veto() {
    // AUDIT FINDING B, fixed. settle_from_reveals used to assert that every
    // contender had revealed both hole cards, so a seat that simply never
    // revealed -- mucking, or going offline -- reverted settlement for
    // everyone and stranded the pot until the reclaim timeout. A losing
    // player could therefore deny the winner their profit for free. Now a
    // seat that did not show forfeits: it is skipped, and the pot goes to
    // the best hand among those who did show.
    let game = setup_showdown();
    reveal_board(game);
    reveal_hole(game, ALICE(), SEAT_0, card(12, 0), card(12, 1));
    // BOB never reveals.

    game.settle_from_reveals(TABLE_1);
    assert(game.get_pending_payout(NOTE_A) == 2_000, 'shower takes the whole pot');
    assert(game.get_pending_payout(NOTE_B) == 0, 'mucker forfeits');
}

#[test]
#[feature("safe_dispatcher")]
fn test_settle_from_reveals_all_muck_rejected() {
    // The one case that must still revert: nobody showed, so there is no
    // hand to score. Falling through would award the pot to seat 0 on a
    // score of zero.
    let game = setup_showdown();
    reveal_board(game);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    match safe.settle_from_reveals(TABLE_1) {
        Result::Ok(_) => panic!("settled with no hands shown"),
        Result::Err(panic_data) => assert(*panic_data.at(0) == 'HOLE_NOT_REVEALED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_settle_from_reveals_twice_rejected() {
    let game = setup_showdown();
    reveal_board(game);
    reveal_hole(game, ALICE(), SEAT_0, card(12, 0), card(12, 1));
    reveal_hole(game, BOB(), SEAT_1, card(11, 0), card(10, 1));
    game.settle_from_reveals(TABLE_1);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    match safe.settle_from_reveals(TABLE_1) {
        Result::Ok(_) => panic!("settled twice"),
        Result::Err(panic_data) => assert(*panic_data.at(0) == 'ALREADY_SETTLED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_settle_from_reveals_before_showdown_rejected() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    match safe.settle_from_reveals(TABLE_1) {
        Result::Ok(_) => panic!("settled before showdown"),
        Result::Err(panic_data) => assert(*panic_data.at(0) == 'NOT_SHOWDOWN', 'wrong error'),
    }
}

// ─── AUDIT: proof-of-concept for suspected findings ─────────────────────

// AUDIT FINDING 1, fixed. open_deck is callable by anyone and the deck
// travels in public calldata, so any observer can build a valid opening
// proof. When positions were caller-supplied, opening one irrelevant
// position flipped deck_opened and left every later reveal failing
// POSITION_NOT_OPENED -- the hand was permanently unplayable and the pot
// stuck until the reclaim timeout. Positions are now derived on-chain and
// deck_opened only flips once the final chunk lands, so a griefer can
// choose neither which slots get opened nor when to stop.
#[test]
#[feature("safe_dispatcher")]
fn test_open_deck_partial_open_is_unexpressible() {
    let (game, _v) = setup_shuffled();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };

    // A short ciphertext array is rejected outright.
    start_cheat_caller_address(game.contract_address, MALLORY());
    let outcome = safe.open_deck(TABLE_1, 0, ct('X').span(), proof());
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("griefer opened a partial deck"),
        Result::Err(p) => assert(*p.at(0) == 'BAD_OPENING_LENGTH', 'must cover every slot'),
    }
    assert(!game.get_deck_opened(TABLE_1), 'deck must stay unopened');

    // Skipping ahead to the last chunk, so the earlier slots are never
    // opened, is refused too -- chunks are consumed strictly in order.
    start_cheat_caller_address(game.contract_address, MALLORY());
    let jumped = safe.open_deck(TABLE_1, 1, chunk_cts(5, 9), proof());
    stop_cheat_caller_address(game.contract_address);
    match jumped {
        Result::Ok(_) => panic!("griefer skipped a chunk"),
        Result::Err(p) => assert(*p.at(0) == 'BAD_OPENING_CHUNK', 'chunks are ordered'),
    }

    // Stopping after the first chunk leaves the deck unopened, and the
    // hand recoverable: anyone can submit the rest.
    game.open_deck(TABLE_1, 0, chunk_cts(0, 9), proof());
    assert(!game.get_deck_opened(TABLE_1), 'half-open is not open');
    game.open_deck(TABLE_1, 1, chunk_cts(5, 9), proof());

    game.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());
    assert(game.get_community_revealed(TABLE_1, 0), 'board still revealable');
}

// AUDIT FINDING 2, fixed. The last player in the hand has already won it.
// Letting them fold dropped the contender count to zero, after which
// settle_from_reveals reverts NO_CONTENDERS and the pot is stranded until
// the reclaim timeout -- a way to burn a pot nobody could collect.
#[test]
#[feature("safe_dispatcher")]
fn test_last_player_cannot_fold() {
    let game = setup_preflop_done();
    advance(game); // PreFlop -> Flop
    start_cheat_caller_address(game.contract_address, ALICE());
    game.check(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.fold(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    // ALICE has won and must not be able to fold it away.
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.fold(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("last player folded and stranded the pot"),
        Result::Err(p) => assert(*p.at(0) == 'LAST_PLAYER_CANNOT_FOLD', 'wrong error'),
    }

    // The pot is still collectable.
    advance(game);
    advance(game);
    advance(game);
    game.settle_from_reveals(TABLE_1);
    assert(game.get_pending_payout(NOTE_A) == 2_000, 'alice collects');
}
