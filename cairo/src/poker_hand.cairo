// Standard Texas Hold'em hand evaluation — pure functions, no storage, no
// external calls. Used by PokerGame::settle_table_by_hand to determine a
// showdown's winner(s) on-chain from revealed hole + community cards,
// instead of trusting a dealer-supplied winner list.
//
// Card encoding matches scripts/deal_verify.py: a card is a felt in 0..51,
// `rank = card % 13` (0='2' .. 12='A'), `suit = card / 13` (0..3, suit
// identity doesn't matter for ranking beyond "same or different").
//
// Unlike most of this project, this module is genuinely unit-tested and
// those tests genuinely run: it has zero dependency on snforge (no
// storage, no cheat codes, no contract deployment needed), so
// `scarb test -- -t unit` exercises it for real with Scarb's bundled
// `cairo_test` runner — see the `tests` module at the bottom of this file.
// Contrast with cairo/tests/, which needs snforge and has never been run
// in this environment (see cairo/tests/README.md).

/// Score encoding: `category * 13^5 + t0*13^4 + t1*13^3 + t2*13^2 + t3*13 + t4`,
/// where `category` (0-8, Ace-high-straight-flush highest) dominates, and
/// t0..t4 are up to 5 tie-break ranks (0-12) in decreasing significance,
/// zero-padded in unused trailing slots. Padding is safe: two hands in the
/// same category always exhaust their real tie-break slots before any
/// padding position is compared, so the padding value never participates
/// in a real comparison.
const CAT_MULT: u64 = 371293; // 13^5
const T0_MULT: u64 = 28561; // 13^4
const T1_MULT: u64 = 2197; // 13^3
const T2_MULT: u64 = 169; // 13^2
const T3_MULT: u64 = 13; // 13^1

fn score(category: u8, t0: u8, t1: u8, t2: u8, t3: u8, t4: u8) -> u64 {
    let cat: u64 = category.into();
    let a: u64 = t0.into();
    let b: u64 = t1.into();
    let c: u64 = t2.into();
    let d: u64 = t3.into();
    let e: u64 = t4.into();
    cat * CAT_MULT + a * T0_MULT + b * T1_MULT + c * T2_MULT + d * T3_MULT + e
}

/// Descending sort of a small (<=7 in this module's usage) span of ranks.
/// O(n^2) repeated-max-extraction — fine at this size, and simple enough
/// to trust without a dedicated sort-correctness test (the hand-category
/// tests below exercise it thoroughly as a side effect).
fn sort_desc(vals: Span<u8>) -> Array<u8> {
    let mut remaining: Array<u8> = array![];
    let mut i: u32 = 0;
    loop {
        if i == vals.len() {
            break;
        }
        remaining.append(*vals.at(i));
        i += 1;
    };

    let mut sorted: Array<u8> = array![];
    loop {
        if remaining.len() == 0 {
            break;
        }
        let rem = remaining.span();
        let mut max_idx: u32 = 0;
        let mut max_val: u8 = *rem.at(0);
        let mut k: u32 = 1;
        loop {
            if k == rem.len() {
                break;
            }
            let v = *rem.at(k);
            if v > max_val {
                max_val = v;
                max_idx = k;
            }
            k += 1;
        };
        sorted.append(max_val);
        let mut next: Array<u8> = array![];
        let mut m: u32 = 0;
        loop {
            if m == rem.len() {
                break;
            }
            if m != max_idx {
                next.append(*rem.at(m));
            }
            m += 1;
        };
        remaining = next;
    };
    sorted
}

/// Distinct (rank, count) pairs among `ranks`, in no particular order.
fn rank_groups(ranks: Span<u8>) -> Array<(u8, u8)> {
    let mut groups: Array<(u8, u8)> = array![];
    let mut i: u32 = 0;
    loop {
        if i == ranks.len() {
            break;
        }
        let r = *ranks.at(i);
        let mut seen = false;
        let mut j: u32 = 0;
        loop {
            if j == i {
                break;
            }
            if *ranks.at(j) == r {
                seen = true;
                break;
            }
            j += 1;
        };
        if !seen {
            let mut count: u8 = 0;
            let mut k: u32 = 0;
            loop {
                if k == ranks.len() {
                    break;
                }
                if *ranks.at(k) == r {
                    count += 1;
                }
                k += 1;
            };
            groups.append((r, count));
        }
        i += 1;
    };
    groups
}

/// The rank with exactly `count` occurrences, if any. If more than one
/// rank shares `count` (only possible for count==2, i.e. two pair), the
/// caller must use `all_ranks_with_count` instead — this returns the
/// first match only.
fn find_rank_with_count(groups: Span<(u8, u8)>, count: u8) -> (bool, u8) {
    let mut i: u32 = 0;
    loop {
        if i == groups.len() {
            break (false, 0);
        }
        let (r, c) = *groups.at(i);
        if c == count {
            break (true, r);
        }
        i += 1;
    }
}

fn all_ranks_with_count(groups: Span<(u8, u8)>, count: u8) -> Array<u8> {
    let mut result: Array<u8> = array![];
    let mut i: u32 = 0;
    loop {
        if i == groups.len() {
            break;
        }
        let (r, c) = *groups.at(i);
        if c == count {
            result.append(r);
        }
        i += 1;
    };
    result
}

/// All rank values in `ranks` (duplicates included) that are NOT in
/// `excluded`, sorted descending. Excluding a rank removes every
/// occurrence of it — exactly what's needed to strip a named group (e.g.
/// a pair, both occurrences) and get the remaining kickers.
fn kickers_excluding(ranks: Span<u8>, excluded: Span<u8>) -> Array<u8> {
    let mut result: Array<u8> = array![];
    let mut i: u32 = 0;
    loop {
        if i == ranks.len() {
            break;
        }
        let r = *ranks.at(i);
        let mut is_excluded = false;
        let mut j: u32 = 0;
        loop {
            if j == excluded.len() {
                break;
            }
            if *excluded.at(j) == r {
                is_excluded = true;
                break;
            }
            j += 1;
        };
        if !is_excluded {
            result.append(r);
        }
        i += 1;
    };
    sort_desc(result.span())
}

/// Evaluates exactly 5 cards. Higher return value = stronger hand. Panics
/// if `cards.len() != 5` — callers (best_of_7 below) are responsible for
/// only ever calling this with real 5-card subsets.
pub fn evaluate_5(cards: Span<u8>) -> u64 {
    assert(cards.len() == 5, 'BAD_HAND_SIZE');

    let mut ranks: Array<u8> = array![];
    let mut suits: Array<u8> = array![];
    let mut i: u32 = 0;
    loop {
        if i == 5 {
            break;
        }
        let c = *cards.at(i);
        ranks.append(c % 13);
        suits.append(c / 13);
        i += 1;
    };
    let ranks = ranks.span();
    let suits = suits.span();

    let s0 = *suits.at(0);
    let is_flush = *suits.at(1) == s0 && *suits.at(2) == s0 && *suits.at(3) == s0 && *suits.at(4) == s0;

    let sorted_desc = sort_desc(ranks);
    let sd = sorted_desc.span();
    let is_normal_straight = *sd.at(0) == *sd.at(1)
        + 1 && *sd.at(1) == *sd.at(2)
        + 1 && *sd.at(2) == *sd.at(3)
        + 1 && *sd.at(3) == *sd.at(4)
        + 1;
    // Ace-low wheel: A-2-3-4-5, ranks {12,3,2,1,0}. High card for ranking
    // purposes is the 5 (rank 3), not the Ace.
    let is_wheel = *sd.at(0) == 12 && *sd.at(1) == 3 && *sd.at(2) == 2 && *sd.at(3) == 1 && *sd.at(4) == 0;
    let is_straight = is_normal_straight || is_wheel;
    let straight_high: u8 = if is_wheel {
        3
    } else {
        *sd.at(0)
    };

    let groups = rank_groups(ranks);
    let g = groups.span();
    let (has_quad, quad_rank) = find_rank_with_count(g, 4);
    let (has_trip, trip_rank) = find_rank_with_count(g, 3);
    let pair_ranks_sorted = sort_desc(all_ranks_with_count(g, 2).span());
    let pr = pair_ranks_sorted.span();
    let num_pairs = pr.len();

    if is_straight && is_flush {
        return score(8, straight_high, 0, 0, 0, 0);
    }
    if has_quad {
        let kickers = kickers_excluding(ranks, array![quad_rank].span());
        return score(7, quad_rank, *kickers.span().at(0), 0, 0, 0);
    }
    // Full house: with only 5 cards, at most one rank can reach count==3
    // (two would need 6 cards), so has_trip + any pair is unambiguous.
    if has_trip && num_pairs >= 1 {
        return score(6, trip_rank, *pr.at(0), 0, 0, 0);
    }
    if is_flush {
        let ss = sort_desc(ranks).span();
        return score(5, *ss.at(0), *ss.at(1), *ss.at(2), *ss.at(3), *ss.at(4));
    }
    if is_straight {
        return score(4, straight_high, 0, 0, 0, 0);
    }
    if has_trip {
        let kickers = kickers_excluding(ranks, array![trip_rank].span());
        let ks = kickers.span();
        return score(3, trip_rank, *ks.at(0), *ks.at(1), 0, 0);
    }
    if num_pairs == 2 {
        let kickers = kickers_excluding(ranks, pr);
        return score(2, *pr.at(0), *pr.at(1), *kickers.span().at(0), 0, 0);
    }
    if num_pairs == 1 {
        let kickers = kickers_excluding(ranks, pr);
        let ks = kickers.span();
        return score(1, *pr.at(0), *ks.at(0), *ks.at(1), *ks.at(2), 0);
    }
    let ss = sort_desc(ranks).span();
    score(0, *ss.at(0), *ss.at(1), *ss.at(2), *ss.at(3), *ss.at(4))
}

/// Best 5-card hand out of 7 (2 hole + 5 community, Texas Hold'em style) —
/// tries all C(7,5)=21 five-card subsets (by choosing which 2 of the 7 to
/// exclude) and returns the highest `evaluate_5` score.
pub fn best_of_7(cards: Span<u8>) -> u64 {
    assert(cards.len() == 7, 'BAD_HAND_SIZE_7');

    let mut best: u64 = 0;
    let mut i: u32 = 0;
    loop {
        if i == 7 {
            break;
        }
        let mut j: u32 = i + 1;
        loop {
            if j == 7 {
                break;
            }
            let mut hand: Array<u8> = array![];
            let mut k: u32 = 0;
            loop {
                if k == 7 {
                    break;
                }
                if k != i && k != j {
                    hand.append(*cards.at(k));
                }
                k += 1;
            };
            let s = evaluate_5(hand.span());
            if s > best {
                best = s;
            }
            j += 1;
        };
        i += 1;
    };
    best
}

#[cfg(test)]
mod tests {
    use super::{best_of_7, evaluate_5};

    // rank 0-12 ('2'..'A'), suit 0-3 — matches scripts/deal_verify.py.
    fn card(rank: u8, suit: u8) -> u8 {
        suit * 13 + rank
    }

    #[test]
    fn test_high_card() {
        let hand = array![card(0, 0), card(2, 1), card(4, 2), card(6, 3), card(8, 0)].span();
        let s = evaluate_5(hand);
        assert(s < 371293, 'should be below category 1'); // CAT_MULT
        assert(s / 371293 == 0, 'wrong category');
    }

    #[test]
    fn test_one_pair() {
        let hand = array![card(5, 0), card(5, 1), card(1, 2), card(3, 3), card(9, 0)].span();
        assert(evaluate_5(hand) / 371293 == 1, 'wrong category');
    }

    #[test]
    fn test_two_pair() {
        let hand = array![card(5, 0), card(5, 1), card(2, 2), card(2, 3), card(9, 0)].span();
        assert(evaluate_5(hand) / 371293 == 2, 'wrong category');
    }

    #[test]
    fn test_three_of_a_kind() {
        let hand = array![card(5, 0), card(5, 1), card(5, 2), card(2, 3), card(9, 0)].span();
        assert(evaluate_5(hand) / 371293 == 3, 'wrong category');
    }

    #[test]
    fn test_straight() {
        // 2,3,4,5,6 mixed suits
        let hand = array![card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)].span();
        assert(evaluate_5(hand) / 371293 == 4, 'wrong category');
    }

    #[test]
    fn test_wheel_straight() {
        // A,2,3,4,5 mixed suits — ranks {12,0,1,2,3}
        let hand = array![card(12, 0), card(0, 1), card(1, 2), card(2, 3), card(3, 0)].span();
        let s = evaluate_5(hand);
        assert(s / 371293 == 4, 'wrong category');
        // high card for the wheel is the 5 (rank 3), not the Ace (rank 12)
        assert(s % 371293 / 28561 == 3, 'wheel high card should be 5');
    }

    #[test]
    fn test_flush() {
        // same suit, not consecutive (no straight)
        let hand = array![card(0, 0), card(2, 0), card(4, 0), card(7, 0), card(9, 0)].span();
        assert(evaluate_5(hand) / 371293 == 5, 'wrong category');
    }

    #[test]
    fn test_full_house() {
        let hand = array![card(5, 0), card(5, 1), card(5, 2), card(2, 3), card(2, 0)].span();
        assert(evaluate_5(hand) / 371293 == 6, 'wrong category');
    }

    #[test]
    fn test_four_of_a_kind() {
        let hand = array![card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(2, 0)].span();
        assert(evaluate_5(hand) / 371293 == 7, 'wrong category');
    }

    #[test]
    fn test_straight_flush() {
        let hand = array![card(0, 0), card(1, 0), card(2, 0), card(3, 0), card(4, 0)].span();
        assert(evaluate_5(hand) / 371293 == 8, 'wrong category');
    }

    #[test]
    fn test_straight_flush_beats_four_of_a_kind() {
        let sf = evaluate_5(array![card(0, 0), card(1, 0), card(2, 0), card(3, 0), card(4, 0)].span());
        let quad = evaluate_5(array![card(5, 0), card(5, 1), card(5, 2), card(5, 3), card(2, 0)].span());
        assert(sf > quad, 'straight flush should win');
    }

    #[test]
    fn test_flush_beats_straight() {
        let flush = evaluate_5(array![card(0, 0), card(2, 0), card(4, 0), card(7, 0), card(9, 0)].span());
        let straight = evaluate_5(array![card(0, 0), card(1, 1), card(2, 2), card(3, 3), card(4, 0)].span());
        assert(flush > straight, 'flush should beat straight');
    }

    #[test]
    fn test_higher_pair_wins() {
        let aces = evaluate_5(array![card(12, 0), card(12, 1), card(1, 2), card(3, 3), card(5, 0)].span());
        let kings = evaluate_5(array![card(11, 0), card(11, 1), card(1, 2), card(3, 3), card(5, 0)].span());
        assert(aces > kings, 'pair of aces should beat kings');
    }

    #[test]
    fn test_kicker_breaks_pair_tie() {
        let high_kicker = evaluate_5(array![card(5, 0), card(5, 1), card(12, 2), card(3, 3), card(1, 0)].span());
        let low_kicker = evaluate_5(array![card(5, 0), card(5, 1), card(11, 2), card(3, 3), card(1, 0)].span());
        assert(high_kicker > low_kicker, 'ace kicker should win');
    }

    #[test]
    fn test_two_pair_top_pair_breaks_tie() {
        // 9s+2s vs 9s+3s: same top pair, different second pair — higher
        // second pair should win.
        let a = evaluate_5(array![card(7, 0), card(7, 1), card(0, 2), card(0, 3), card(3, 0)].span());
        let b = evaluate_5(array![card(7, 0), card(7, 1), card(1, 2), card(1, 3), card(3, 0)].span());
        assert(b > a, 'higher second pair should win');
    }

    #[test]
    fn test_full_house_trips_rank_breaks_tie() {
        let fives_over_twos = evaluate_5(array![card(3, 0), card(3, 1), card(3, 2), card(0, 3), card(0, 0)].span());
        let fours_over_twos = evaluate_5(array![card(2, 0), card(2, 1), card(2, 2), card(0, 3), card(0, 0)].span());
        assert(fives_over_twos > fours_over_twos, 'higher trips should win');
    }

    #[test]
    fn test_best_of_7_finds_best_five() {
        // Board: 2,7,9,J,K (mixed suits) + hole cards 2,2 -> should find
        // the pair of 2s (trips isn't available; this is really just a
        // sanity check that best_of_7 evaluates the actual best subset).
        let seven = array![
            card(0, 0), card(0, 1), // hole: pair of 2s
            card(5, 2), card(7, 3), card(9, 0), card(10, 1), card(11, 2) // board
        ]
            .span();
        let s = best_of_7(seven);
        assert(s / 371293 == 1, 'expected one pair category');
    }

    #[test]
    fn test_best_of_7_picks_straight_over_lower_pair() {
        // Hole: 6,6. Board: 2,3,4,5,K -> best 5 is the straight (2-3-4-5-6
        // using one of the 6s), not the pair of 6s.
        let seven = array![
            card(4, 0), card(4, 1), // hole: pair of 6s
            card(0, 2), card(1, 3), card(2, 0), card(3, 1), card(11, 2) // board: 2,3,4,5,K
        ]
            .span();
        let s = best_of_7(seven);
        assert(s / 371293 == 4, 'expected straight category');
    }

    #[test]
    fn test_best_of_7_full_house_from_board_plus_hole() {
        // Hole: 9,9. Board: 9,9,2,2,K -> quad 9s is NOT possible (only one
        // 9 in hole matches board's two 9s = 4 total... wait: hole has two
        // 9s, board has two 9s -> four 9s total is impossible with a
        // single 52-card deck (only 4 nines exist, using distinct suits
        // here deliberately to stay within a real deck).
        let seven = array![
            card(7, 0), card(7, 1), // hole: two 9s (suits 0,1)
            card(7, 2), card(7, 3), // board: two more 9s (suits 2,3) -> four 9s total
            card(0, 0), card(0, 1), card(11, 2) // board: two 2s + a King
        ]
            .span();
        let s = best_of_7(seven);
        // Four 9s is the actual best (all four 9s + any kicker) since all
        // four suits of rank 7 are present across hole+board.
        assert(s / 371293 == 7, 'expected four of a kind');
    }
}
