// Regression test: pins core::poseidon::poseidon_hash_span's output for a
// fixed input against a value independently computed in Python, so that a
// future corelib/Cairo-edition upgrade that silently changed Poseidon's
// behavior would be caught here rather than discovered as a mismatch
// between the deployed contract and scripts/deal_verify.py in the field.
//
// The Python side (poseidon_py.poseidon_hash.poseidon_hash_many, package
// `poseidon-py` 0.2.0, https://pypi.org/project/poseidon-py/) is what
// scripts/deal_verify.py uses to reproduce cairo/src/shuffle.cairo's
// shuffle off-chain from a revealed seed. This test is the evidence that
// choice is actually correct, not just plausible — verified 2026-08-31 by
// computing poseidon_hash_many([12345, 51]) in Python and asserting the
// same two-element hash matches here.
//
// To regenerate the vector (e.g. after bumping poseidon-py or changing the
// input): `python -c "from poseidon_py.poseidon_hash import
// poseidon_hash_many; print(hex(poseidon_hash_many([12345, 51])))"`.
#[cfg(test)]
mod tests {
    use core::poseidon::poseidon_hash_span;

    #[test]
    fn test_cross_check_vs_python() {
        let h = poseidon_hash_span(array![12345, 51].span());
        assert(
            h == 0x7d2034379d6846c64c9c59bd61b2267fd6ef5d11c47dac778544b65a9ca5bb9,
            'poseidon mismatch vs python',
        );
    }
}
