// V2 collaborative shuffle chain (docs/V2-MENTAL-POKER.md).
//
// Proof verification is delegated to a MockShuffleVerifier here — these
// tests cover the CHAIN logic the contract owns: key registration, the
// frozen participant list, strict turn order, commitment chaining, proof
// rejection, deadlines, and the all-of-n forfeit. Whether a real proof is
// sound is the circuit's job (circuits/shuffle/), not this contract's.

use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_block_timestamp_global, start_cheat_caller_address,
    stop_cheat_caller_address,
};
use zkpoker::mocks::IMockVerifierAdminTraitDispatcherTrait;
use zkpoker::{IPokerGameDispatcherTrait, IPokerGameSafeDispatcherTrait, PokerGame};
use super::helpers::{
    ALICE, BOB, CAROL, DEALER, MALLORY, NOTE_A, NOTE_B, NOTE_C, POOL, SEAT_0, SEAT_1, SEAT_2, TABLE_1,
    THREE_SEATS, TWO_SEATS, deploy_mock_token, deploy_pokergame_with_verifier,
};

// Stand-in key shares / commitments. The contract treats these as opaque
// felts — it never does elliptic-curve arithmetic itself (see
// docs/V2-SPIKE-RESULTS.md §3a on why the joint key is supplied rather
// than computed on-chain).
// u256 throughout: Grumpkin coordinates and Noir Field outputs live in
// BN254's scalar field, ~6x the STARK prime, so they are NOT felt252 —
// see the storage comment in lib.cairo. The `high` limbs here are
// deliberately non-zero, so these fixtures exercise values a felt252
// could never have held.
const PK_A_X: u256 = u256 { low: 'PKAX', high: 1 };
const PK_A_Y: u256 = u256 { low: 'PKAY', high: 2 };
const PK_B_X: u256 = u256 { low: 'PKBX', high: 3 };
const PK_B_Y: u256 = u256 { low: 'PKBY', high: 4 };
const PK_C_X: u256 = u256 { low: 'PKCX', high: 10 };
const PK_C_Y: u256 = u256 { low: 'PKCY', high: 11 };
const JOINT_X: u256 = u256 { low: 'JOINTX', high: 5 };
const JOINT_Y: u256 = u256 { low: 'JOINTY', high: 6 };
// a_0's real commitment, pinned in the contract. Not a fixture: it is
// Poseidon2 of the one starting deck the protocol defines, produced by
// circuits/deck_init. begin_shuffle no longer takes it as a parameter.
// = 0x1673af0c7a0064af6bb3a70b30eec058d85bec4857307bde801f9244ba8271ad
const A0: u256 = u256 {
    low: 287590538483746469931956317567322321325,
    high: 29843680456175890265454332793043468376,
};
const DECK_0: u256 = u256 { low: 'DECK0', high: 7 };
const DECK_1: u256 = u256 { low: 'DECK1', high: 8 };
const DECK_2: u256 = u256 { low: 'DECK2', high: 9 };
const SHUFFLE_TURN_SECS: u64 = 600;

fn proof() -> Span<felt252> {
    array!['PROOF'].span()
}

fn key_proof() -> Span<felt252> {
    array!['KEYPROOF'].span()
}

// Two-seat table with both keys registered and the shuffle open.
fn setup_shuffle_ready() -> (
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

    (game, verifier)
}

fn begin(game: zkpoker::IPokerGameDispatcher) {
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
}

// ─── key registration ───────────────────────────────────────────────────

#[test]
fn test_register_shuffle_key_success() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    let mut spy = spy_events();
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::ShuffleKeyRegistered(
                        PokerGame::ShuffleKeyRegistered {
                            table_id: TABLE_1, seat: SEAT_0, pk_x: PK_A_X, pk_y: PK_A_Y,
                        },
                    ),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_SEAT_OWNER')]
fn test_register_shuffle_key_by_non_seat_owner_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    // MALLORY tries to publish a key for ALICE's seat — which would put a
    // key MALLORY controls into the joint key.
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_B_X, PK_B_Y, key_proof());
}

#[test]
#[should_panic(expected: 'KEY_ALREADY_REGISTERED')]
fn test_register_shuffle_key_twice_rejected() {
    let (game, _v) = setup_shuffle_ready();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
}

#[test]
#[should_panic(expected: 'SEAT_KEY_NOT_REGISTERED')]
fn test_register_zero_shuffle_key_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    // A zero share contributes nothing to the joint key — it is how a
    // player would appear to participate while actually opting out.
    game.register_shuffle_key(TABLE_1, SEAT_0, 0, 0, key_proof());
}

#[test]
#[should_panic(expected: 'SHUFFLE_ALREADY_STARTED')]
fn test_register_shuffle_key_after_begin_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    // CAROL can't slip a key in after the participant list is frozen.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.register_shuffle_key(TABLE_1, SEAT_1, PK_B_X, PK_B_Y, key_proof());
}

// ─── begin_shuffle ──────────────────────────────────────────────────────

#[test]
fn test_begin_shuffle_freezes_participants_in_seat_order() {
    let (game, _v) = setup_shuffle_ready();
    let mut spy = spy_events();
    begin(game);

    assert(game.get_shuffle_order_len(TABLE_1) == 2, 'wrong participant count');
    assert(game.get_shuffle_seat_at(TABLE_1, 0) == SEAT_0, 'pos 0 should be seat 0');
    assert(game.get_shuffle_seat_at(TABLE_1, 1) == SEAT_1, 'pos 1 should be seat 1');
    assert(game.get_shuffle_commitment(TABLE_1) == A0, 'must pin the real a_0');
    assert(game.get_shuffle_turn(TABLE_1) == 0, 'turn should start at 0');
    assert(!game.get_shuffle_complete(TABLE_1), 'should not be complete');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::ShuffleBegun(
                        PokerGame::ShuffleBegun {
                            table_id: TABLE_1, participants: 2, initial_commitment: A0,
                        },
                    ),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_begin_shuffle_unauthorized_rejected() {
    let (game, _v) = setup_shuffle_ready();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
}

#[test]
#[should_panic(expected: 'NO_SHUFFLE_PARTICIPANTS')]
fn test_begin_shuffle_with_no_keys_rejected() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
}

#[test]
#[should_panic(expected: 'SHUFFLE_ALREADY_STARTED')]
fn test_begin_shuffle_twice_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
}

// AUDIT FINDING D, fixed. This used to skip a keyless seat and start the
// chain without it, which sounds like liveness but is a trust break: the
// dealer chooses when to call begin_shuffle, so calling it one block
// before a player registers excluded them from the joint key while
// leaving them seated, still dealt hole cards at deck positions 2*seat
// and 2*seat+1, and still a contender at showdown. Their cards would be
// encrypted under a key made only of the other players' shares -- the
// participants could read the excluded player's hand and the excluded
// player could not read their own. With only the dealer registered, the
// dealer alone knows the whole deck. Every seated player must now have
// registered before the chain can start.
#[test]
#[feature("safe_dispatcher")]
fn test_begin_shuffle_requires_every_seated_player_to_have_a_key() {
    let (game, _v) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, THREE_SEATS);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    // BOB joins seat 1 but never registers a key.
    start_cheat_caller_address(game.contract_address, BOB());
    game.join_table(TABLE_1, SEAT_1, NOTE_B);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, CAROL());
    game.join_table(TABLE_1, SEAT_2, NOTE_C);
    game.register_shuffle_key(TABLE_1, SEAT_2, PK_B_X, PK_B_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("started a chain that excluded a seated player"),
        Result::Err(p) => assert(*p.at(0) == 'SEAT_KEY_NOT_REGISTERED', 'wrong error'),
    }
    assert(game.get_shuffle_order_len(TABLE_1) == 0, 'no chain started');

    // Once BOB registers too, the chain starts and covers all three.
    start_cheat_caller_address(game.contract_address, BOB());
    game.register_shuffle_key(TABLE_1, SEAT_1, PK_C_X, PK_C_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);
    begin(game);
    assert(game.get_shuffle_order_len(TABLE_1) == 3, 'every seat participates');
    assert(game.get_shuffle_seat_at(TABLE_1, 1) == SEAT_1, 'pos 1 = seat 1');
}

// ─── the chain itself ───────────────────────────────────────────────────

#[test]
fn test_full_shuffle_chain_completes() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    let mut spy = spy_events();

    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_shuffle_commitment(TABLE_1) == DECK_1, 'head should advance');
    assert(game.get_shuffle_turn(TABLE_1) == 1, 'turn should advance');
    assert(!game.get_shuffle_complete(TABLE_1), 'not complete after 1 of 2');

    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, proof());
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_shuffle_commitment(TABLE_1) == DECK_2, 'head should be final deck');
    assert(game.get_shuffle_complete(TABLE_1), 'should be complete');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::Shuffled(
                        PokerGame::Shuffled {
                            table_id: TABLE_1, position: 0, seat: SEAT_0, commitment: DECK_1,
                        },
                    ),
                ),
                (
                    game.contract_address,
                    PokerGame::Event::ShuffleComplete(
                        PokerGame::ShuffleComplete { table_id: TABLE_1, final_commitment: DECK_2 },
                    ),
                ),
            ],
        );
}

// The point of the whole construction: player 2 cannot shuffle first, so
// no one can see the final deck before contributing their own permutation.
#[test]
#[should_panic(expected: 'NOT_YOUR_SHUFFLE_TURN')]
fn test_shuffle_out_of_turn_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
}

#[test]
#[should_panic(expected: 'NOT_YOUR_SHUFFLE_TURN')]
fn test_shuffle_by_non_participant_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
}

#[test]
#[should_panic(expected: 'SHUFFLE_PROOF_REJECTED')]
fn test_shuffle_with_rejected_proof_is_refused() {
    let (game, verifier) = setup_shuffle_ready();
    begin(game);
    verifier.set_reject(true);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
}

// A rejected proof must leave the chain untouched, not half-advanced —
// and the turn must not be consumed, or one bad proof would knock a player
// out of a hand. Uses a safe dispatcher so the failed call is actually
// MADE and its state effects inspected, rather than only asserting that it
// panics.
#[test]
#[feature("safe_dispatcher")]
fn test_rejected_proof_leaves_chain_head_and_turn_unchanged() {
    let (game, verifier) = setup_shuffle_ready();
    begin(game);
    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };

    verifier.set_reject(true);
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);
    assert(outcome.is_err(), 'submit should have failed');

    assert(game.get_shuffle_commitment(TABLE_1) == A0, 'head must be untouched');
    assert(game.get_shuffle_turn(TABLE_1) == 0, 'turn must be untouched');

    // ..and the same player can still take their turn once they produce a
    // proof that verifies.
    verifier.set_reject(false);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_shuffle_commitment(TABLE_1) == DECK_1, 'chain resumes normally');
    assert(game.get_shuffle_turn(TABLE_1) == 1, 'turn advances after success');
}

#[test]
#[should_panic(expected: 'SHUFFLE_NOT_STARTED')]
fn test_shuffle_before_begin_rejected() {
    let (game, _v) = setup_shuffle_ready();
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
}

#[test]
#[should_panic(expected: 'SHUFFLE_ALREADY_COMPLETE')]
fn test_shuffle_after_complete_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, proof());
    // chain is complete; a third submission must not reopen it
    game.submit_shuffle(TABLE_1, u256 { low: 'DECK3', high: 10 }, proof());
}

// ─── deadlines and the all-of-n forfeit ─────────────────────────────────

#[test]
#[should_panic(expected: 'SHUFFLE_DEADLINE_PASSED')]
fn test_shuffle_after_deadline_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_block_timestamp_global(SHUFFLE_TURN_SECS + 2);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
}

#[test]
#[should_panic(expected: 'DEADLINE_NOT_PASSED')]
fn test_claim_timeout_before_deadline_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.claim_shuffle_timeout(TABLE_1);
}

#[test]
fn test_claim_timeout_voids_table() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    let mut spy = spy_events();
    start_cheat_block_timestamp_global(SHUFFLE_TURN_SECS + 2);

    // Deliberately callable by anyone — the stalling player will not
    // report themselves.
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.claim_shuffle_timeout(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_table_voided(TABLE_1), 'table should be voided');
    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::TableVoided(
                        PokerGame::TableVoided { table_id: TABLE_1, stalled_seat: SEAT_0 },
                    ),
                ),
            ],
        );
}

// The deadline is per turn, not per hand: a player who shuffles promptly
// must not be punished for the previous player being slow.
#[test]
fn test_deadline_resets_each_turn() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    let first_deadline = game.get_shuffle_deadline(TABLE_1);

    start_cheat_block_timestamp_global(SHUFFLE_TURN_SECS - 1);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);

    let second_deadline = game.get_shuffle_deadline(TABLE_1);
    assert(second_deadline > first_deadline, 'deadline should extend');

    // BOB still gets a full turn even though ALICE used nearly all of hers.
    start_cheat_block_timestamp_global(SHUFFLE_TURN_SECS + 100);
    start_cheat_caller_address(game.contract_address, BOB());
    game.submit_shuffle(TABLE_1, DECK_2, proof());
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_shuffle_complete(TABLE_1), 'BOB should still fit in turn');
}

#[test]
#[should_panic(expected: 'TABLE_VOIDED')]
fn test_shuffle_on_voided_table_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_block_timestamp_global(SHUFFLE_TURN_SECS + 2);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.claim_shuffle_timeout(TABLE_1);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
}

#[test]
#[should_panic(expected: 'TABLE_VOIDED')]
fn test_claim_timeout_twice_rejected() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    start_cheat_block_timestamp_global(SHUFFLE_TURN_SECS + 2);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.claim_shuffle_timeout(TABLE_1);
    game.claim_shuffle_timeout(TABLE_1);
}

// ─── rogue-key defence ──────────────────────────────────────────────────

// The attack this blocks: whoever registers LAST can otherwise choose
// pk_last = X - sum(everyone else's shares) for an X whose secret they
// know, making the joint key theirs alone. Every shuffle proof in the
// chain still verifies, and they quietly decrypt every hole card at the
// table. Requiring proof of knowledge of the discrete log makes that
// choice unprovable, because a key built by subtraction has no known
// secret.
#[test]
#[should_panic(expected: 'KEY_PROOF_REJECTED')]
fn test_register_shuffle_key_without_valid_ownership_proof_rejected() {
    let (game, verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);

    verifier.set_reject_key(true);
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
}

// A failed ownership proof must leave the seat unregistered, so the
// attacker cannot retry into a half-written state or end up counted as a
// participant with an unproven key.
#[test]
#[feature("safe_dispatcher")]
fn test_rejected_key_proof_leaves_seat_unregistered() {
    let (game, verifier) = deploy_pokergame_with_verifier(POOL());
    let (token_addr, _t, _a) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    verifier.set_reject_key(true);
    start_cheat_caller_address(game.contract_address, ALICE());
    let outcome = safe.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);
    assert(outcome.is_err(), 'registration should fail');

    // The seat is not a participant: begin_shuffle finds nobody.
    verifier.set_reject_key(false);
    start_cheat_caller_address(game.contract_address, DEALER());
    let begun = safe.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    assert(begun.is_err(), 'no participants expected');

    // ..and once a real proof is supplied the same seat registers fine.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.register_shuffle_key(TABLE_1, SEAT_0, PK_A_X, PK_A_Y, key_proof());
    stop_cheat_caller_address(game.contract_address);
    begin(game);
    assert(game.get_shuffle_order_len(TABLE_1) == 1, 'seat should now count');
}

// Keys and commitments must survive a round-trip with a non-zero high
// limb — the whole point of moving off felt252. A felt252 field would
// have wrapped these mod the STARK prime.
#[test]
fn test_large_key_and_commitment_values_round_trip() {
    let (game, _v) = setup_shuffle_ready();
    begin(game);
    assert(game.get_shuffle_commitment(TABLE_1) == A0, 'commitment must round-trip');
    assert(A0.high != 0, 'a_0 exceeds felt252');

    start_cheat_caller_address(game.contract_address, ALICE());
    game.submit_shuffle(TABLE_1, DECK_1, proof());
    stop_cheat_caller_address(game.contract_address);
    assert(game.get_shuffle_commitment(TABLE_1) == DECK_1, 'head must round-trip');
}

// ─── the joint key is checked, not trusted ──────────────────────────────

// joint_pk_x/y used to be a dealer-supplied parameter that nothing
// on-chain ever verified -- players were told to check off-chain that it
// equalled the sum of the registered shares. A dealer who published a key
// of their own choosing could read every hole card at the table while
// every proof in the chain still verified: the shuffle circuit takes the
// joint key as a public input and honestly proves re-randomisation under
// whatever key it is handed, and each seat's Schnorr proof only says that
// seat knows its own secret. Nothing tied the two together.
//
// begin_shuffle now hands the registered shares to the adapter, which
// sums them on Grumpkin. The mock cannot do curve arithmetic on these
// opaque fixtures, so what this covers is the CONTRACT's handling of the
// answer; the arithmetic itself is checked against real curve points in
// scripts/joint_key_check.py.
#[test]
#[feature("safe_dispatcher")]
fn test_begin_shuffle_rejects_a_joint_key_that_is_not_the_sum() {
    let (game, verifier) = setup_shuffle_ready();
    verifier.set_reject_joint_key(true);

    let safe = zkpoker::IPokerGameSafeDispatcher { contract_address: game.contract_address };
    start_cheat_caller_address(game.contract_address, DEALER());
    let outcome = safe.begin_shuffle(TABLE_1, JOINT_X, JOINT_Y);
    stop_cheat_caller_address(game.contract_address);
    match outcome {
        Result::Ok(_) => panic!("dealer imposed a joint key of their choosing"),
        Result::Err(p) => assert(*p.at(0) == 'BAD_JOINT_KEY', 'wrong error'),
    }
    // Nothing was frozen, so the table is still recoverable.
    assert(game.get_shuffle_order_len(TABLE_1) == 0, 'no chain started');

    verifier.set_reject_joint_key(false);
    begin(game);
    assert(game.get_shuffle_order_len(TABLE_1) == 2, 'chain starts on a good key');
}
