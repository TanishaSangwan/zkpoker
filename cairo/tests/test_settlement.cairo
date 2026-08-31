// settle_table, privacy_invoke — plus the pool-spoofing, cross-table
// note_id/token hijacking, remainder-stranding, reentrancy, and
// unchecked-approve regression tests spanning all 5 security review
// rounds. See tests/README.md — unexecuted/unverified in this environment.

use starknet::ContractAddress;
use snforge_std::{
    EventSpyAssertionsTrait, spy_events, start_cheat_caller_address, stop_cheat_caller_address,
};
use zkpoker::mocks::{IMockErc20AdminDispatcher, IMockErc20AdminDispatcherTrait};
use zkpoker::{IPokerGameDispatcherTrait, PokerGame};
use super::helpers::{
    ALICE, BOB, DEALER, MALLORY, NOTE_A, NOTE_B, POOL, SEAT_0, SEAT_1, TABLE_1, TABLE_2, TWO_SEATS,
    deploy_pokergame, deploy_mock_token, fund_and_approve, setup_table_with_bets, setup_table_with_two_seats,
};

const FUND: u256 = 10_000;
const BET: u128 = 1_000;

// ─── settle_table ────────────────────────────────────────────────────────

#[test]
fn test_settle_table_success_single_winner() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    let mut spy = spy_events();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_pending_payout(NOTE_A) == BET * 2, 'winner should get whole pot');
    assert(game.get_pot(TABLE_1) == 0, 'pot should be zeroed');
    assert(game.get_table_settled(TABLE_1), 'table should be settled');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::Settled(PokerGame::Settled { table_id: TABLE_1, winner_count: 1 }),
                ),
            ],
        );
}

#[test]
fn test_settle_table_remainder_credited_to_first_winner() {
    // Round 1 Finding 4 regression: the integer-division remainder must
    // land somewhere, not be silently stranded while table_pot is zeroed.
    let (game, _token, _admin, _token_addr) = setup_table_with_two_seats(FUND);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, 1500);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, BOB());
    game.bet(TABLE_1, SEAT_1, 1001);
    stop_cheat_caller_address(game.contract_address);
    // pot = 2501, 2 winners -> share 1250, remainder 1

    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0, SEAT_1].span(), array![NOTE_A, NOTE_B].span());
    stop_cheat_caller_address(game.contract_address);

    assert(game.get_pending_payout(NOTE_A) == 1251, 'winner 0 should get remainder');
    assert(game.get_pending_payout(NOTE_B) == 1250, 'winner 1 gets plain share');
}

#[test]
#[should_panic(expected: 'NOT_DEALER')]
fn test_settle_table_unauthorized_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
}

#[test]
#[should_panic(expected: 'LEN_MISMATCH')]
fn test_settle_table_length_mismatch_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0, SEAT_1].span(), array![NOTE_A].span());
}

#[test]
#[should_panic(expected: 'NO_INPUT')]
fn test_settle_table_empty_winners_rejected() {
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![].span(), array![].span());
}

// Note: a cross-table note_id hijack by a DIFFERENT account is already
// blocked one step earlier, at join_table (see
// test_join_table_note_id_reuse_by_different_owner_rejected in
// tests/test_lifecycle.cairo) — join_table's note_id_owner check makes
// settle_table's own note_id_owner == seat_owner check unreachable for
// that specific attack today. Kept as defense-in-depth in the contract;
// not separately regression-tested here since there's no code path left
// that reaches it without already reverting at join_table first.

#[test]
#[should_panic(expected: 'BAD_TOKEN')]
fn test_settle_table_cross_table_token_relabel_rejected() {
    // Regression: round 3 Finding 1 — settling the SAME note_id at a
    // second table denominated in a DIFFERENT token must not silently
    // relabel the first table's already-accumulated payout, even when the
    // second table's own pot is zero (no bet placed on it at all) — the
    // historical bug fired on the unconditional payout_token overwrite
    // alone, independent of pot size.
    let game = deploy_pokergame(DEALER());
    let (token_a_addr, token_a, admin_a) = deploy_mock_token();
    let (token_b_addr, _token_b, _admin_b) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, DEALER());
    game.create_table(TABLE_1, token_a_addr, 0, TWO_SEATS);
    game.create_table(TABLE_2, token_b_addr, 0, TWO_SEATS);
    stop_cheat_caller_address(game.contract_address);

    // ALICE plays (and wins) table 1 in token_a, registering NOTE_A there.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);
    fund_and_approve(token_a, admin_a, ALICE(), game.contract_address, FUND);
    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
    stop_cheat_caller_address(game.contract_address);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
    stop_cheat_caller_address(game.contract_address);
    // pending_payout[NOTE_A] is now BET, denominated in token_a.

    // ALICE (same owner, so note_id reuse is allowed by note_id_owner)
    // rejoins table 2 with the SAME note_id — no bet placed on table 2 at
    // all, so its pot is zero.
    start_cheat_caller_address(game.contract_address, ALICE());
    game.join_table(TABLE_2, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, DEALER());
    // Even this zero-pot settlement of table 2 must not be allowed to
    // rebind payout_token[NOTE_A] to token_b while a token_a balance is
    // still pending for it.
    game.settle_table(TABLE_2, array![SEAT_0].span(), array![NOTE_A].span());
}

#[test]
#[should_panic(expected: 'ALREADY_SETTLED')]
fn test_settle_table_twice_rejected() {
    // Regression: round 4 Finding 1.
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
}

#[test]
#[should_panic(expected: 'ALREADY_SETTLED')]
fn test_bet_after_settlement_rejected() {
    // Regression: round 4 Finding 1's other half — a bet placed after
    // settlement must not be accepted (it would be permanently
    // unreclaimable, since reclaim_stalled_bet is itself gated on
    // !table_settled).
    let (game, _token, _admin, _token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
    stop_cheat_caller_address(game.contract_address);

    start_cheat_caller_address(game.contract_address, ALICE());
    game.bet(TABLE_1, SEAT_0, BET);
}

#[test]
#[should_panic(expected: 'REENTRANCY')]
fn test_settle_table_reentrancy_blocked() {
    // Regression: round 4 Finding 2 — a dealer-controlled token reentering
    // settle_table mid-bet() must be blocked, not allowed to settle a
    // stale pot before the in-flight bet's contribution lands.
    //
    // As in test_bet_reentrancy_blocked, the reentrant call's caller (as
    // PokerGame sees it) is the token contract's own address, so it must
    // also be this table's dealer for the settle_table call to reach the
    // reentrancy_lock check instead of failing NOT_DEALER first.
    let game = deploy_pokergame(DEALER());
    let (token_addr, token, admin) = deploy_mock_token();

    start_cheat_caller_address(game.contract_address, token_addr);
    game.create_table(TABLE_1, token_addr, 0, TWO_SEATS);
    game.join_table(TABLE_1, SEAT_0, NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    fund_and_approve(token, admin, token_addr, game.contract_address, FUND);
    admin.set_reenter_settle(game.contract_address, TABLE_1, SEAT_0, NOTE_A);

    start_cheat_caller_address(game.contract_address, token_addr);
    game.bet(TABLE_1, SEAT_0, BET); // token's transfer_from reenters settle_table -> should panic
}

// ─── privacy_invoke ────────────────────────────────────────────────────

fn setup_settled_table() -> (zkpoker::IPokerGameDispatcher, zkpoker::IErc20Dispatcher, ContractAddress) {
    let (game, token, _admin, token_addr) = setup_table_with_bets(FUND, BET);
    start_cheat_caller_address(game.contract_address, DEALER());
    game.settle_table(TABLE_1, array![SEAT_0].span(), array![NOTE_A].span());
    stop_cheat_caller_address(game.contract_address);
    (game, token, token_addr)
}

#[test]
fn test_privacy_invoke_success() {
    let (game, _token, token_addr) = setup_settled_table();
    let mut spy = spy_events();

    start_cheat_caller_address(game.contract_address, POOL());
    let result = game.privacy_invoke(token_addr, POOL(), NOTE_A);
    stop_cheat_caller_address(game.contract_address);

    assert(result.len() == 1, 'expected one deposit');
    let deposit = *result.at(0);
    assert(deposit.note_id == NOTE_A, 'wrong note_id in result');
    assert(deposit.amount == BET * 2, 'wrong amount in result');
    assert(game.get_pending_payout(NOTE_A) == 0, 'payout should be cleared');

    spy
        .assert_emitted(
            @array![
                (
                    game.contract_address,
                    PokerGame::Event::Invoked(
                        PokerGame::Invoked { note_id: NOTE_A, amount: BET * 2, caller: POOL() },
                    ),
                ),
            ],
        );
}

#[test]
#[should_panic(expected: 'BAD_POOL')]
fn test_privacy_invoke_wrong_caller_rejected() {
    // Regression: round 1 Finding 1 — the original bug let ANY caller
    // satisfy the pool check by passing its own address as `pool_address`.
    // Now only the address pinned at deploy time may call this at all,
    // regardless of what `pool_address` argument is supplied.
    let (game, _token, token_addr) = setup_settled_table();
    start_cheat_caller_address(game.contract_address, MALLORY());
    game.privacy_invoke(token_addr, MALLORY(), NOTE_A); // MALLORY claims to be the pool
}

#[test]
#[should_panic(expected: 'BAD_TOKEN')]
fn test_privacy_invoke_wrong_token_rejected() {
    let (game, _token, _token_addr) = setup_settled_table();
    let (other_token_addr, _other_token, _other_admin) = deploy_mock_token();
    start_cheat_caller_address(game.contract_address, POOL());
    game.privacy_invoke(other_token_addr, POOL(), NOTE_A);
}

#[test]
#[should_panic(expected: 'NO_PAYOUT_FOR_NOTE')]
fn test_privacy_invoke_no_pending_payout_rejected() {
    let (game, _token, token_addr) = setup_settled_table();
    start_cheat_caller_address(game.contract_address, POOL());
    game.privacy_invoke(token_addr, POOL(), NOTE_B); // BOB has no pending payout
}

#[test]
#[should_panic(expected: 'NO_PAYOUT_FOR_NOTE')]
fn test_privacy_invoke_twice_rejected() {
    let (game, _token, token_addr) = setup_settled_table();
    start_cheat_caller_address(game.contract_address, POOL());
    game.privacy_invoke(token_addr, POOL(), NOTE_A);
    game.privacy_invoke(token_addr, POOL(), NOTE_A); // already paid out
}

#[test]
#[should_panic(expected: 'TRANSFER_FAILED')]
fn test_privacy_invoke_approve_failure_rejected() {
    // Regression: round 5 Finding 1 — an approve() that returns false
    // instead of reverting must not be treated as a successful payout.
    let (game, _token, token_addr) = setup_settled_table();
    // Reach into the mock via its admin interface to make approve() fail.
    let admin = IMockErc20AdminDispatcher { contract_address: token_addr };
    admin.set_fail_approve(true);

    start_cheat_caller_address(game.contract_address, POOL());
    game.privacy_invoke(token_addr, POOL(), NOTE_A);
}
