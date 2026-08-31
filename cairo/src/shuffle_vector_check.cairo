// Regression test: pins shuffle::shuffled_deck's full output for seed=42
// against the same computation done independently in Python (the
// scripts/deal_verify.py side), so a future change to shuffle.cairo's
// swap/draw logic that broke Cairo/Python parity — even one that kept
// producing a valid permutation, which poseidon_vector_check.cairo alone
// wouldn't catch — fails here instead of silently in the field.
//
// To regenerate the vector: run this Python (needs `pip install
// poseidon-py`, verified against poseidon_vector_check.cairo's own vector):
//
//   from poseidon_py.poseidon_hash import poseidon_hash_many
//   DECK_SIZE = 52
//   def draw_index(seed, step, bound):
//       return poseidon_hash_many([seed, step]) % bound
//   def shuffled_deck(seed):
//       deck = list(range(DECK_SIZE))
//       idx = DECK_SIZE - 1
//       while idx != 0:
//           j = draw_index(seed, idx, idx + 1)
//           deck[idx], deck[j] = deck[j], deck[idx]
//           idx -= 1
//       return deck
//   print(','.join(str(x) for x in shuffled_deck(42)))
//
// This is exactly scripts/deal_verify.py's seeded_shuffle — see that file.
#[cfg(test)]
mod tests {
    use super::super::shuffle::shuffled_deck;

    #[test]
    fn test_e2e_vs_python() {
        let deck = shuffled_deck(42);
        let expected: Array<u8> = array![
            30, 15, 14, 2, 11, 32, 51, 22, 23, 50, 33, 29, 0, 6, 9, 28, 1, 45, 4, 37, 20, 13, 31,
            19, 48, 12, 42, 41, 27, 16, 3, 21, 17, 26, 40, 18, 25, 46, 35, 47, 43, 34, 39, 7, 5,
            10, 49, 44, 36, 38, 24, 8,
        ];
        assert(deck.span() == expected.span(), 'mismatch vs python e2e');
    }
}
