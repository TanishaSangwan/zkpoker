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
    EventSpyAssertionsTrait, spy_events, start_cheat_block_timestamp,
    start_cheat_block_timestamp_global, start_cheat_caller_address, stop_cheat_block_timestamp,
    stop_cheat_caller_address,
};
use zkpoker::mocks::IMockVerifierAdminTraitDispatcherTrait;
use zkpoker::{IErc20DispatcherTrait, IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait, PokerGame};
use super::helpers::{
    ALICE, BOB, CAROL, DEALER, MALLORY, NOTE_A, NOTE_B, NOTE_C, POOL, SEAT_0, SEAT_1, SEAT_2,
    TABLE_1, THREE_SEATS, TWO_SEATS, deploy_mock_token, deploy_pokergame_with_verifier,
    fund_and_approve,
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

// A well-formed 208-entry deck for submit_shuffle's calldata.
//
// The mock verifier does not look at it, and the real one cannot -- checking a
// deck against its Poseidon2 commitment means BN254 arithmetic Cairo does not
// have (docs/PROTOCOL.md §7). What the CONTRACT checks is the length, and that
// is what these tests exercise: a submission must carry a full deck, which is
// what stops a shuffler advancing its own turn while withholding the deck the
// next seat needs (§9.3).
fn deck_of(tag: u128) -> Span<u256> {
    let mut out: Array<u256> = array![];
    let mut i: u128 = 0;
    while i != 208 {
        out.append(u256 { low: tag + i, high: 0 });
        i += 1;
    }
    out.span()
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

// MUST equal DECK_OPEN_K in src/lib.cairo and K in circuits/deck_open.
const DECK_OPEN_K: u32 = 16;

// One DECK_OPEN_K-sized chunk of ciphertexts, starting at `first`, padded
// the way the contract pads a final partial chunk: by repeating the last
// in-play position. Round 8 finding I -- the deck is opened K positions
// at a time because circuits/deck_open fixes K at compile time.
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

// A two-seat table has 3*2 + 5 = 11 in-play positions -- four hole slots,
// five community cards and one high-card draw per seat -- which now fits in a
// SINGLE chunk of 16. It took three at K=5.
const TWO_SEAT_POSITIONS: u32 = 11;
fn open_all(game: zkpoker::IPokerGameDispatcher) {
    game.open_deck(TABLE_1, 0, chunk_cts(0, TWO_SEAT_POSITIONS), proof());
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
    game.submit_shuffle(TABLE_1, DECK_1, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_shuffle_complete(TABLE_1), 'setup: shuffle incomplete');
    (game, verifier)
}

// A table WIDE enough that its deck still needs more than one chunk.
//
// At K=16 a two-seat table's 11 in-play positions open atomically, which is
// the point of raising K -- but it also means the two-seat fixtures can no
// longer exercise chunk ordering or the "not opened until the last chunk"
// rule. `max_seats` drives the position count (3*max_seats + 5), NOT how many
// seats are filled, so four seats gives 17 positions and two chunks with the
// same two players.
const FOUR_SEATS: u32 = 4;
const WIDE_POSITIONS: u32 = 17;
fn setup_shuffled_wide() -> zkpoker::IPokerGameDispatcher {
    let (game, _verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _token, _admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, FOUR_SEATS);
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
    game.submit_shuffle(TABLE_1, DECK_1, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    game
}

#[test]
fn test_open_deck_is_not_complete_until_every_chunk_lands() {
    // The partial-open rule, on a table that still spans two chunks. A deck
    // marked open before every in-play position is bound is exactly what
    // round 8's finding I was about.
    let game = setup_shuffled_wide();
    game.open_deck(TABLE_1, 0, chunk_cts(0, WIDE_POSITIONS), proof());
    assert(!game.get_deck_opened(TABLE_1), 'not opened until complete');
    game.open_deck(TABLE_1, 1, chunk_cts(DECK_OPEN_K, WIDE_POSITIONS), proof());
    assert(game.get_deck_opened(TABLE_1), 'deck not marked opened');
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
    // A two-seat table's 11 positions fit one chunk at K=16, so opening is
    // atomic here and the "not opened until every chunk lands" rule is
    // exercised by test_open_deck_is_not_complete_until_every_chunk_lands,
    // which uses a table big enough to still need two.
    game.open_deck(TABLE_1, 0, chunk_cts(0, TWO_SEAT_POSITIONS), proof());
    assert(game.get_deck_opened(TABLE_1), 'deck not marked opened');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::DeckOpened(
                        PokerGame::DeckOpened { table_id: TABLE_1, positions: 11, deck_hash: DECK_2 },
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
    let outcome = safe.open_deck(TABLE_1, 0, chunk_cts(0, TWO_SEAT_POSITIONS), proof());
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
    let outcome = safe.open_deck(TABLE_1, 0, chunk_cts(0, TWO_SEAT_POSITIONS), proof());
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
    let outcome = safe.open_deck(TABLE_1, 0, chunk_cts(0, TWO_SEAT_POSITIONS), proof());
    match outcome {
        Result::Ok(_) => panic!("accepted a rejected opening proof"),
        Result::Err(panic_data) => assert(
            *panic_data.at(0) == 'DECK_OPENING_REJECTED', 'wrong error',
        ),
    }
}


// Walks the table to `street` so community reveals are legal there.
//
// reveal_community_card refuses a card before the street that deals it (found
// by playing a hand and noticing the whole board was face-up during pre-flop
// betting), so every test that reveals one has to get there honestly: both
// seats check, the dealer advances, repeat.
fn to_street(game: zkpoker::IPokerGameDispatcher, street: u8) {
    // Reads where the table actually IS rather than assuming pre-flop, so
    // successive calls are cumulative-safe. Assuming 0 made to_street(2) after
    // to_street(1) advance two MORE streets and run off the end of the hand
    // into BETTING_CLOSED.
    while game.get_table_street(TABLE_1) < street {
        start_cheat_caller_address(game.contract_address, ALICE());
        game.check(TABLE_1, SEAT_0);
        stop_cheat_caller_address(game.contract_address);
        start_cheat_caller_address(game.contract_address, BOB());
        game.check(TABLE_1, SEAT_1);
        stop_cheat_caller_address(game.contract_address);
        start_cheat_caller_address(game.contract_address, DEALER());
        game.advance_street(TABLE_1);
        stop_cheat_caller_address(game.contract_address);
    }
}

fn setup_opened_at_flop() -> (
    zkpoker::IPokerGameDispatcher, zkpoker::mocks::IMockVerifierAdminTraitDispatcher,
) {
    let (game, verifier) = setup_opened();
    to_street(game, 1);
    (game, verifier)
}


// Reaches showdown with the deck open, where a hole card may legally be shown.
//
// reveal_hole_card is gated on the showdown having started AND on it being
// that seat's turn: showing is information, so who reveals first is worth
// something, and a rule only clients enforce is not a rule. Order is the
// Hold'em one -- last aggressor on the river, else the first seat still in the
// hand, then clockwise -- so with everyone checking their way here, SEAT_0
// shows first.
//
// Distinct from the settlement-side `setup_showdown` further down, which
// starts from a betting fixture and returns only the game.
fn setup_opened_at_showdown() -> (
    zkpoker::IPokerGameDispatcher, zkpoker::mocks::IMockVerifierAdminTraitDispatcher,
) {
    let (game, verifier) = setup_opened();
    to_street(game, 4);
    (game, verifier)
}

// ─── community cards ────────────────────────────────────────────────────

#[test]
fn test_reveal_community_card_success_and_event() {
    let (game, _v) = setup_opened_at_flop();
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
    let (game, _v) = setup_opened_at_flop();
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
    let (game, verifier) = setup_opened_at_flop();
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
    let (game, _v) = setup_opened_at_showdown();
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
    let (game, _v) = setup_opened_at_showdown();
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
    let (game, _v) = setup_opened_at_showdown();
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
    let (game, _v) = setup_opened_at_showdown();
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
    game.submit_shuffle(TABLE_1, DECK_1, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, deck_of(1), proof());
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
    // On the wide fixture, because a two-seat table now opens atomically and
    // a griefer needs more than one chunk to leave one half-done.
    let game = setup_shuffled_wide();
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
    let jumped = safe.open_deck(TABLE_1, 1, chunk_cts(DECK_OPEN_K, WIDE_POSITIONS), proof());
    stop_cheat_caller_address(game.contract_address);
    match jumped {
        Result::Ok(_) => panic!("griefer skipped a chunk"),
        Result::Err(p) => assert(*p.at(0) == 'BAD_OPENING_CHUNK', 'chunks are ordered'),
    }

    // Stopping after the first chunk leaves the deck unopened, and the
    // hand recoverable: anyone can submit the rest.
    game.open_deck(TABLE_1, 0, chunk_cts(0, WIDE_POSITIONS), proof());
    assert(!game.get_deck_opened(TABLE_1), 'half-open is not open');
    game.open_deck(TABLE_1, 1, chunk_cts(DECK_OPEN_K, WIDE_POSITIONS), proof());

    // The point of this test is that a half-opened deck leaves the hand
    // recoverable, not that a card can be shown early -- so reach the flop
    // the way a real table does before checking the board still opens.
    to_street(game, 1);
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

// ─── the accusation path (docs/PROTOCOL.md §8) ──────────────────────────
//
// Decryption is n-of-n, so a party who simply never sends their share
// freezes the table. Before this existed there was nothing on-chain
// saying who -- and the reveal path cannot tell you either, because it
// verifies the AGGREGATE share against the joint key (that is what makes
// it O(1) in players), and an aggregate that fails proves someone cheated
// but not which someone.

const T0: u64 = 5_000_000;
const ACCUSATION_SECS: u64 = 3600;

fn accuse(
    game: zkpoker::IPokerGameDispatcher,
    who: starknet::ContractAddress,
    seat: felt252,
    pos: u32,
) {
    start_cheat_caller_address(game.contract_address, who);
    game.accuse_share(TABLE_1, seat, pos);
    stop_cheat_caller_address(game.contract_address);
}

#[test]
fn test_accuse_then_answer_clears_it() {
    let (game, _v) = setup_opened();
    start_cheat_block_timestamp(game.contract_address, T0);

    // ALICE accuses BOB of withholding his share for a community card.
    let mut spy = spy_events();
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    assert(
        game.get_accusation_deadline(TABLE_1, SEAT_1, community_pos(0)) == T0 + ACCUSATION_SECS,
        'clock should be running',
    );
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::ShareAccused(
                        PokerGame::ShareAccused {
                            table_id: TABLE_1,
                            seat: SEAT_1,
                            position: community_pos(0),
                            deadline: T0 + ACCUSATION_SECS,
                        },
                    ),
                ),
            ],
        );

    // BOB answers in time. The share lands on-chain, so the hand can go on.
    game.answer_accusation(TABLE_1, SEAT_1, community_pos(0), SHARE_X, SHARE_Y, proof());
    assert(game.get_accusation_deadline(TABLE_1, SEAT_1, community_pos(0)) == 0, 'accusation cleared');
    assert(game.get_share_posted(TABLE_1, SEAT_1, community_pos(0)), 'share recorded');
    assert(game.get_share_defaulter_plus_one(TABLE_1) == 0, 'nobody convicted');
    stop_cheat_block_timestamp(game.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_answered_accusation_cannot_be_reraised() {
    // Otherwise a seat could be ground down by paying gas to answer the
    // same accusation over and over.
    let (game, _v) = setup_opened();
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    game.answer_accusation(TABLE_1, SEAT_1, community_pos(0), SHARE_X, SHARE_Y, proof());

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let again = safe.accuse_share(TABLE_1, SEAT_1, community_pos(0));
    stop_cheat_caller_address(game.contract_address);
    match again {
        Result::Ok(_) => panic!("re-accused an answered position"),
        Result::Err(p) => assert(*p.at(0) == 'SHARE_ALREADY_POSTED', 'wrong error'),
    }
    stop_cheat_block_timestamp(game.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_answer_with_a_bad_proof_is_not_an_answer() {
    let (game, verifier) = setup_opened();
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    verifier.set_reject_share(true);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe
        .answer_accusation(TABLE_1, SEAT_1, community_pos(0), SHARE_X, SHARE_Y, proof());
    match outcome {
        Result::Ok(_) => panic!("accepted a bogus share"),
        Result::Err(p) => assert(*p.at(0) == 'BAD_SHARE_PROOF', 'wrong error'),
    }
    assert(!game.get_share_posted(TABLE_1, SEAT_1, community_pos(0)), 'nothing recorded');
    assert(
        game.get_accusation_deadline(TABLE_1, SEAT_1, community_pos(0)) != 0,
        'accusation still stands',
    );
    stop_cheat_block_timestamp(game.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_late_answer_rejected() {
    // The conviction must not be dodgeable by front-running it with the
    // share that was owed an hour ago -- the rule submit_shuffle already
    // applies to its own deadline.
    let (game, _v) = setup_opened();
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    stop_cheat_block_timestamp(game.contract_address);

    start_cheat_block_timestamp(game.contract_address, T0 + ACCUSATION_SECS + 1);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe
        .answer_accusation(TABLE_1, SEAT_1, community_pos(0), SHARE_X, SHARE_Y, proof());
    match outcome {
        Result::Ok(_) => panic!("answered after the deadline"),
        Result::Err(p) => assert(*p.at(0) == 'ANSWER_DEADLINE_PASSED', 'wrong error'),
    }
    stop_cheat_block_timestamp(game.contract_address);
}

#[test]
#[feature("safe_dispatcher")]
fn test_timeout_before_deadline_rejected() {
    let (game, _v) = setup_opened();
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.claim_share_timeout(TABLE_1, SEAT_1, community_pos(0));
    match outcome {
        Result::Ok(_) => panic!("convicted before the clock ran out"),
        Result::Err(p) => assert(*p.at(0) == 'DEADLINE_NOT_PASSED', 'wrong error'),
    }
    stop_cheat_block_timestamp(game.contract_address);
}

#[test]
fn test_timeout_voids_the_hand_and_names_the_defaulter() {
    let (game, _v) = setup_opened();
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    stop_cheat_block_timestamp(game.contract_address);

    let mut spy = spy_events();
    start_cheat_block_timestamp(game.contract_address, T0 + ACCUSATION_SECS + 1);
    // Anyone may call it: the stalling seat will not report itself, and
    // everyone else stays frozen until someone does.
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.claim_share_timeout(TABLE_1, SEAT_1, community_pos(0));
    stop_cheat_caller_address(game.contract_address);
    stop_cheat_block_timestamp(game.contract_address);

    assert(game.get_table_voided(TABLE_1), 'hand must be void');
    // The evidence: seat + 1, so 0 can mean nobody.
    assert(game.get_share_defaulter_plus_one(TABLE_1) == SEAT_1 + 1, 'defaulter recorded');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::ShareDefaulted(
                        PokerGame::ShareDefaulted {
                            table_id: TABLE_1, seat: SEAT_1, position: community_pos(0),
                        },
                    ),
                ),
            ],
        );
}

// Only the seat whose card it is may accuse over a hole position.
// Answering publishes a share, and a hole card needs every party's share,
// so letting anyone accuse would let anyone strip seat S's cards by
// accusing each party in turn.
#[test]
#[feature("safe_dispatcher")]
fn test_cannot_accuse_over_someone_elses_hole_card() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };

    // BOB tries to force shares for ALICE's hole card into the open.
    start_cheat_caller_address(game.contract_address, BOB());
    let outcome = safe.accuse_share(TABLE_1, SEAT_1, hole_pos(0, 0));
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("stripped another player hole card"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_YOUR_CARD', 'wrong error'),
    }

    // ALICE may, for her own card -- the exposure is hers to accept, and
    // she only does it when the alternative is a hand she cannot play.
    accuse(game, ALICE(), SEAT_1, hole_pos(0, 0));
    assert(game.get_accusation_deadline(TABLE_1, SEAT_1, hole_pos(0, 0)) != 0, 'owner may accuse');
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_accuse_over_an_already_revealed_card() {
    let (game, _v) = setup_opened_at_flop();
    game.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.accuse_share(TABLE_1, SEAT_1, community_pos(0));
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("accused over a card already open"),
        Result::Err(p) => assert(*p.at(0) == 'CARD_ALREADY_REVEALED', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_accuse_a_seat_that_is_not_a_party() {
    // A seat with no registered key contributes no share, so there is
    // nothing it could be withholding.
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.accuse_share(TABLE_1, 'NOSEAT', community_pos(0));
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("accused a non-party"),
        Result::Err(p) => assert(*p.at(0) == 'SEAT_KEY_NOT_REGISTERED', 'wrong error'),
    }
}

// The accusation has to cost the griefer something, or it just names them
// and the table dies for free -- which is the complaint PROTOCOL.md §8
// raises in the first place. A convicted seat's stake is redistributed pro
// rata over everyone else who put money in; the pot total is untouched, so
// the ordinary reclaim path pays the new amounts out unchanged.
#[test]
fn test_conviction_forfeits_the_defaulters_stake() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();
    let stake: u128 = 999; // odd on purpose: exercises the remainder path

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    game.register_shuffle_key(TABLE_1, SEAT_1, PK_B_X, PK_B_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, CAROL());
    game.join_table(TABLE_1, SEAT_2, NOTE_C);
    game.register_shuffle_key(TABLE_1, SEAT_2, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    fund_and_approve(token, admin, ALICE(), game.contract_address, 10_000);
    fund_and_approve(token, admin, BOB(), game.contract_address, 10_000);
    fund_and_approve(token, admin, CAROL(), game.contract_address, 10_000);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, stake);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, stake);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, CAROL());
    game.bet(TABLE_1, SEAT_2, stake);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, CAROL());
    game.submit_shuffle(TABLE_1, DECK_0, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);

    // 3 seats: 6 hole slots, 5 community, 3 draws. 14 positions -- one chunk
    // at K=16, where it took three at K=5.
    game.open_deck(TABLE_1, 0, chunk_cts(0, 14), proof());

    // BOB stalls on the flop.
    let flop = 2 * 3;
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, flop);
    stop_cheat_block_timestamp(game.contract_address);

    start_cheat_block_timestamp(game.contract_address, T0 + ACCUSATION_SECS + 1);
    game.claim_share_timeout(TABLE_1, SEAT_1, flop);
    stop_cheat_block_timestamp(game.contract_address);

    // 999 split pro rata over two equal contributors: 499 each, and the
    // odd 1 to the first of them rather than being dropped on the floor.
    assert(game.get_seat_contributed(TABLE_1, SEAT_1) == 0, 'defaulter forfeits it all');
    assert(game.get_seat_contributed(TABLE_1, SEAT_0) == 999 + 499 + 1, 'first also takes remainder');
    assert(game.get_seat_contributed(TABLE_1, SEAT_2) == 999 + 499, 'split pro rata');

    // The pot is untouched, so the reclaim path pays out exactly what the
    // seats are now owed and the contract keeps nothing.
    let total = game.get_seat_contributed(TABLE_1, SEAT_0)
        + game.get_seat_contributed(TABLE_1, SEAT_1)
        + game.get_seat_contributed(TABLE_1, SEAT_2);
    assert(total == 3 * stake, 'pot must be conserved');

    // Voided, so reclaim needs no timeout wait.
    let before = token.balance_of(ALICE());
    start_cheat_caller_address(game.contract_address, ALICE());
    game.reclaim_stalled_bet(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    let owed: u256 = u256 { low: 999 + 499 + 1, high: 0 };
    assert(token.balance_of(ALICE()) == before + owed, 'paid the larger amount');
}

// A defaulter nobody else backed keeps their stake: there is no one to
// compensate, and burning it would strand the tokens here with no owner.
#[test]
fn test_sole_contributor_default_strands_nothing() {
    let (game, _v) = setup_opened();
    let (_ta, token, admin) = deploy_mock_token();
    let _ = token;
    let _ = admin;
    start_cheat_block_timestamp(game.contract_address, T0);
    accuse(game, ALICE(), SEAT_1, community_pos(0));
    stop_cheat_block_timestamp(game.contract_address);
    start_cheat_block_timestamp(game.contract_address, T0 + ACCUSATION_SECS + 1);
    game.claim_share_timeout(TABLE_1, SEAT_1, community_pos(0));
    stop_cheat_block_timestamp(game.contract_address);
    // Nobody bet at all on this table, so there is nothing to move and
    // nothing to strand.
    assert(game.get_seat_contributed(TABLE_1, SEAT_1) == 0, 'nothing to forfeit');
    assert(game.get_table_voided(TABLE_1), 'still voided');
}

// ── the street gate ────────────────────────────────────────────────────
//
// Found by playing a real hand: reveal_community_card checked that the deck
// was open and the position was proved, and nothing about WHEN. So the whole
// board was revealable the instant the deck opened, and every bet was then
// made with the river face-up. That is not a griefing edge case, it is the
// game not being poker.
//
// Revealing needs a share from every party, so an honest client could refuse
// to contribute early -- but a rule that holds only while every client is
// well behaved is not one the contract may assume.

#[test]
#[feature("safe_dispatcher")]
fn test_flop_cannot_be_revealed_pre_flop() {
    let (game, _v) = setup_opened();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    assert(game.get_table_street(TABLE_1) == 0, 'expected pre-flop');
    let outcome = safe.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());
    match outcome {
        Result::Ok(_) => panic!("revealed the flop during pre-flop betting"),
        Result::Err(p) => assert(*p.at(0) == 'CARD_NOT_DUE_THIS_STREET', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_turn_cannot_be_revealed_on_the_flop() {
    // Index 3 is the turn and needs street 2, so the flop is not enough --
    // this is the case a naive "any community card once betting starts" gate
    // would have let through.
    let (game, _v) = setup_opened_at_flop();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    assert(game.get_table_street(TABLE_1) == 1, 'expected flop');
    let outcome = safe.reveal_community_card(TABLE_1, 3, SHARE_X, SHARE_Y, 7, proof());
    match outcome {
        Result::Ok(_) => panic!("revealed the turn on the flop"),
        Result::Err(p) => assert(*p.at(0) == 'CARD_NOT_DUE_THIS_STREET', 'wrong error'),
    }
}

#[test]
#[feature("safe_dispatcher")]
fn test_river_cannot_be_revealed_on_the_turn() {
    let (game, _v) = setup_opened();
    to_street(game, 2);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_community_card(TABLE_1, 4, SHARE_X, SHARE_Y, 7, proof());
    match outcome {
        Result::Ok(_) => panic!("revealed the river on the turn"),
        Result::Err(p) => assert(*p.at(0) == 'CARD_NOT_DUE_THIS_STREET', 'wrong error'),
    }
}

#[test]
fn test_each_community_card_opens_on_its_own_street() {
    // The whole board, revealed exactly when it is due. Also pins the mapping
    // itself: flop is 0,1,2 together, then one card per street.
    let (game, _v) = setup_opened();
    to_street(game, 1);
    game.reveal_community_card(TABLE_1, 0, SHARE_X, SHARE_Y, 7, proof());
    game.reveal_community_card(TABLE_1, 1, SHARE_X, SHARE_Y, 8, proof());
    game.reveal_community_card(TABLE_1, 2, SHARE_X, SHARE_Y, 9, proof());
    to_street(game, 2);
    game.reveal_community_card(TABLE_1, 3, SHARE_X, SHARE_Y, 10, proof());
    to_street(game, 3);
    game.reveal_community_card(TABLE_1, 4, SHARE_X, SHARE_Y, 11, proof());

    let mut i: u32 = 0;
    while i != 5 {
        assert(game.get_community_revealed(TABLE_1, i), 'card not revealed');
        i += 1;
    }
}

// ── showdown order and the muck clock ──────────────────────────────────
//
// Hold'em's rule: the last player to bet or raise on the river shows first;
// if everyone checked, the first seat still in the hand does; then clockwise.
// A player may muck instead of showing, and running out of time IS mucking.
//
// This is enforced on-chain rather than by clients because showing is
// INFORMATION -- a player who has seen a better hand may decline to expose
// their own -- so who reveals first is worth something, and a rule only
// clients follow is advisory.

#[test]
fn test_showdown_starts_with_the_first_active_seat_when_all_checked() {
    let (game, _v) = setup_opened_at_showdown();
    assert(game.get_showdown_started(TABLE_1), 'showdown not started');
    assert(game.get_showdown_turn(TABLE_1) == SEAT_0, 'seat 0 shows first');
    assert(game.get_showdown_deadline(TABLE_1) != 0, 'clock should run');
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_show_out_of_turn() {
    let (game, _v) = setup_opened_at_showdown();
    let c = commitment_for(SHARE_X, SHARE_Y, 'RHO');
    start_cheat_caller_address(game.contract_address, BOB());
    game.commit_hole_shares(TABLE_1, SEAT_1, 0, c);
    stop_cheat_caller_address(game.contract_address);

    // SEAT_0 is on turn, so SEAT_1 showing now would leak nothing to itself
    // but would give SEAT_0 a free look before deciding.
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.reveal_hole_card(TABLE_1, SEAT_1, 0, SHARE_X, SHARE_Y, 'RHO', 42, proof());
    match outcome {
        Result::Ok(_) => panic!("showed out of turn"),
        Result::Err(p) => assert(*p.at(0) == 'NOT_YOUR_SHOWDOWN_TURN', 'wrong error'),
    }
}

#[test]
fn test_mucking_passes_the_turn_and_forfeits() {
    let (game, _v) = setup_opened_at_showdown();
    assert(game.get_showdown_turn(TABLE_1) == SEAT_0, 'seat 0 first');

    // Mucking forfeits rather than blocking, so nothing moves: the seat's
    // contribution stays exactly where it was and remains in the pot for
    // whoever does show. Compared before and after rather than asserted
    // non-zero -- this fixture checks its way to showdown with a buy-in of 0,
    // so a non-zero assertion would have passed for the wrong reason or, as it
    // did, failed for one.
    let before = game.get_seat_contributed(TABLE_1, SEAT_0);
    let pot_before = game.get_pot(TABLE_1);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.muck(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_seat_mucked(TABLE_1, SEAT_0), 'seat 0 mucked');
    assert(game.get_showdown_turn(TABLE_1) == SEAT_1, 'turn passes on');
    assert(game.get_seat_contributed(TABLE_1, SEAT_0) == before, 'contribution unchanged');
    assert(game.get_pot(TABLE_1) == pot_before, 'pot unchanged');
}

#[test]
fn test_every_seat_mucking_voids_the_hand_instead_of_stranding_it() {
    // Found by play, 2026-09-06: at a three-handed table every seat showed one
    // hole card and was mucked by the ten-second clock before the second. All
    // three had forfeited, so there was no contender -- and settlement used to
    // revert NO_CONTENDERS, which left table_settled false and the pot sitting
    // in this contract until the 24-hour reclaim timeout. A whole day of
    // nothing, for a state the timeouts reach on their own.
    let game = setup_showdown();

    start_cheat_caller_address(game.contract_address, ALICE());
    game.muck(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.muck(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);

    let mut spy = spy_events();
    game.settle_from_reveals(TABLE_1);

    // Voided, NOT settled. Both matter: voiding is what lets every seat
    // reclaim at once, and leaving `settled` false is what keeps
    // reclaim_stalled_bet callable at all.
    assert(game.get_table_voided(TABLE_1), 'hand not voided');
    assert(!game.get_table_settled(TABLE_1), 'must not be marked settled');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::TableVoided(
                        PokerGame::TableVoided { table_id: TABLE_1, stalled_seat: 0 },
                    ),
                ),
            ],
        );
}

#[test]
fn test_a_voided_all_muck_hand_refunds_without_waiting() {
    // The point of voiding rather than reverting: no 24-hour wait. This
    // asserts the money is actually reachable, not merely that a flag got set.
    let game = setup_showdown();
    let staked = game.get_seat_contributed(TABLE_1, SEAT_0);
    assert(staked != 0, 'fixture must have money in');

    start_cheat_caller_address(game.contract_address, ALICE());
    game.muck(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.muck(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    game.settle_from_reveals(TABLE_1);

    // No time is cheated forward. Before this change the same call reverted
    // TOO_EARLY until created_at + SETTLE_TIMEOUT_SECS.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.reclaim_stalled_bet(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_seat_contributed(TABLE_1, SEAT_0) == 0, 'seat 0 not refunded');

    start_cheat_caller_address(game.contract_address, BOB());
    game.reclaim_stalled_bet(TABLE_1, SEAT_1);
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_seat_contributed(TABLE_1, SEAT_1) == 0, 'seat 1 not refunded');
    // Everything that went in has come back out, so nothing is left stranded.
    assert(game.get_pot(TABLE_1) == 0, 'pot not emptied');
}

// The premature case stays a REVERT, and that asymmetry is the whole rule:
// voiding is gated on there being no contender left, not on nobody having
// shown yet. A seat that has not mucked is still entitled to show, so
// settlement then is early rather than terminal -- and if it voided instead,
// anyone could cancel a hand the instant the showdown opened by calling
// settlement before the first reveal. See
// test_settle_from_reveals_all_muck_rejected, which covers exactly that.

#[test]
fn test_running_out_of_time_is_mucking() {
    let (game, _v) = setup_opened_at_showdown();
    let deadline = game.get_showdown_deadline(TABLE_1);

    // Anyone may call it -- the seat holding everyone up will not report
    // itself, and every other timeout here works the same way.
    start_cheat_block_timestamp_global(deadline + 1);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.claim_showdown_timeout(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_seat_mucked(TABLE_1, SEAT_0), 'timed-out seat mucked');
    assert(game.get_showdown_turn(TABLE_1) == SEAT_1, 'turn passes on');
}

#[test]
#[feature("safe_dispatcher")]
fn test_cannot_claim_the_showdown_clock_early() {
    let (game, _v) = setup_opened_at_showdown();
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    let outcome = safe.claim_showdown_timeout(TABLE_1);
    match outcome {
        Result::Ok(_) => panic!("mucked a seat that still had time"),
        Result::Err(p) => assert(*p.at(0) == 'SHOWDOWN_DEADLINE_LIVE', 'wrong error'),
    }
    assert(!game.get_seat_mucked(TABLE_1, SEAT_0), 'must not be mucked');
}

// Same as setup_opened, but with funded seats so bets are possible.
fn setup_opened_funded() -> (
    zkpoker::IPokerGameDispatcher,
    zkpoker::mocks::IMockErc20AdminDispatcher,
    zkpoker::IErc20Dispatcher,
) {
    let (game, _verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, token, admin) = deploy_mock_token();

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
    game.submit_shuffle(TABLE_1, DECK_1, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, deck_of(1), proof());
    stop_cheat_caller_address(game.contract_address);
    open_all(game);

    fund_and_approve(token, admin, ALICE(), game.contract_address, 10_000);
    fund_and_approve(token, admin, BOB(), game.contract_address, 10_000);
    (game, admin, token)
}

#[test]
fn test_the_river_aggressor_shows_first() {
    // Someone bets the river, so order starts with THEM rather than with the
    // lowest seat -- the case a "first active seat" rule alone gets wrong, and
    // the reason the aggressor is tracked at all.
    let (game, _admin, _token) = setup_opened_funded();
    to_street(game, 3);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.check(TABLE_1, SEAT_0);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, 100);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 100);
    stop_cheat_caller_address(game.contract_address);
    game.advance_street(TABLE_1);

    assert(game.get_table_street(TABLE_1) == 4, 'expected showdown');
    assert(game.get_showdown_turn(TABLE_1) == SEAT_1, 'river bettor shows first');
}

