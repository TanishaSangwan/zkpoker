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

fn all_ciphertexts() -> Span<u256> {
    let mut out: Array<u256> = array![];
    let mut i: u32 = 0;
    while i != 9 {
        let c = ct(i.into() + 1);
        out.append(*c.at(0));
        out.append(*c.at(1));
        out.append(*c.at(2));
        out.append(*c.at(3));
        i += 1;
    }
    out.span()
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
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y, DECK_0);
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
    game.open_deck(TABLE_1, all_positions(), all_ciphertexts(), proof());
    (game, verifier)
}

// ─── open_deck ──────────────────────────────────────────────────────────

#[test]
fn test_open_deck_success_and_event() {
    let (game, _v) = setup_shuffled();
    let mut spy = spy_events();
    game.open_deck(TABLE_1, all_positions(), all_ciphertexts(), proof());
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
    game.open_deck(TABLE_1, all_positions(), all_ciphertexts(), proof());
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
    let outcome = safe.open_deck(TABLE_1, all_positions(), all_ciphertexts(), proof());
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
    let outcome = safe.open_deck(TABLE_1, all_positions(), all_ciphertexts(), proof());
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
    let outcome = safe
        .open_deck(TABLE_1, array![0_u32, 1_u32].span(), ct('X').span(), proof());
    match outcome {
        Result::Ok(_) => panic!("accepted 2 positions with 1 ciphertext"),
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
    let outcome = safe.open_deck(TABLE_1, all_positions(), all_ciphertexts(), proof());
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
