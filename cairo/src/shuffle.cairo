// Deterministic Poseidon-based Fisher-Yates shuffle of a 52-card deck from
// a revealed seed — the on-chain half of the commit-reveal fairness model
// (see docs/DESIGN.md "What 'provably fair' means in V1"). Pure functions,
// no storage, no external calls — same testing story as poker_hand.cairo:
// genuinely unit-tested via `scarb test -- -t unit`, no snforge needed.
//
// MUST match scripts/deal_verify.py's Python implementation exactly (same
// algorithm, same per-draw randomness source) — that script is the
// off-chain half anyone (not just this contract) can use to recompute a
// deal from a revealed seed. See that file's own header for the Python
// side and how the two are kept in sync.
//
// Card encoding matches poker_hand.cairo and deal_verify.py: a card is
// 0..51, `rank = card % 13` (0='2'..12='A'), `suit = card / 13` (0..3).

use core::poseidon::poseidon_hash_span;

pub const DECK_SIZE: u32 = 52;

/// Fisher-Yates draw: a deterministic pseudo-random index in `[0, bound)`,
/// derived from `seed` and the current shuffle `step` so consecutive draws
/// in the same shuffle never collide. Not a rejection-sampled uniform
/// draw (plain `% bound` has a small modulo bias) — an accepted
/// simplification at this scale (52-element deck), consistent with V1's
/// overall commit-reveal fairness model rather than a cryptographically
/// airtight RNG.
fn draw_index(seed: felt252, step: u32, bound: u32) -> u32 {
    let h: felt252 = poseidon_hash_span(array![seed, step.into()].span());
    let h_u256: u256 = h.into();
    let bound_u256: u256 = bound.into();
    let r: u256 = h_u256 % bound_u256;
    r.try_into().unwrap()
}

/// Returns a new array identical to `arr` except positions `i` and `j` are
/// swapped. `Array<u8>` has no in-place index assignment in Cairo, so this
/// rebuilds — fine at 52 elements, called ~51 times per shuffle.
fn swap(arr: Array<u8>, i: u32, j: u32) -> Array<u8> {
    if i == j {
        return arr;
    }
    let span = arr.span();
    let mut result: Array<u8> = array![];
    let mut k: u32 = 0;
    loop {
        if k == span.len() {
            break;
        }
        if k == i {
            result.append(*span.at(j));
        } else if k == j {
            result.append(*span.at(i));
        } else {
            result.append(*span.at(k));
        }
        k += 1;
    };
    result
}

/// The full 52-card deck (values 0..51), shuffled deterministically from
/// `seed` via Fisher-Yates. Same `seed` always produces the same deck.
pub fn shuffled_deck(seed: felt252) -> Array<u8> {
    let mut deck: Array<u8> = array![];
    let mut i: u32 = 0;
    loop {
        if i == DECK_SIZE {
            break;
        }
        deck.append(i.try_into().unwrap());
        i += 1;
    };

    let mut result = deck;
    let mut idx: u32 = DECK_SIZE - 1;
    loop {
        if idx == 0 {
            break;
        }
        let j = draw_index(seed, idx, idx + 1);
        result = swap(result, idx, j);
        idx -= 1;
    };
    result
}

#[cfg(test)]
mod tests {
    use super::{DECK_SIZE, shuffled_deck};

    #[test]
    fn test_shuffled_deck_has_correct_length() {
        let deck = shuffled_deck(12345);
        assert(deck.len() == DECK_SIZE, 'wrong deck length');
    }

    #[test]
    fn test_shuffled_deck_is_a_permutation() {
        // Every value 0..51 must appear in the shuffled deck EXACTLY once
        // — not just "52 elements", a genuine permutation of the real
        // deck. This is the property settle_table_by_hand's card-vs-deck
        // check ultimately relies on.
        let deck = shuffled_deck(999_999);
        let span = deck.span();
        let mut v: u32 = 0;
        loop {
            if v == DECK_SIZE {
                break;
            }
            let target: u8 = v.try_into().unwrap();
            let mut count: u32 = 0;
            let mut i: u32 = 0;
            loop {
                if i == span.len() {
                    break;
                }
                if *span.at(i) == target {
                    count += 1;
                }
                i += 1;
            };
            assert(count == 1, 'card missing or duplicated');
            v += 1;
        };
    }

    #[test]
    fn test_shuffled_deck_deterministic() {
        let a = shuffled_deck(42);
        let b = shuffled_deck(42);
        assert(a.span() == b.span(), 'same seed should match');
    }

    #[test]
    fn test_shuffled_deck_different_seeds_differ() {
        // Not a rigorous randomness test — just confirms the seed
        // actually influences the output (catches an accidental
        // seed-ignoring bug), by checking at least one position differs.
        let a = shuffled_deck(1);
        let b = shuffled_deck(2);
        let sa = a.span();
        let sb = b.span();
        let mut i: u32 = 0;
        let mut any_diff = false;
        loop {
            if i == sa.len() {
                break;
            }
            if *sa.at(i) != *sb.at(i) {
                any_diff = true;
                break;
            }
            i += 1;
        };
        assert(any_diff, 'different seeds gave same deck');
    }
}
