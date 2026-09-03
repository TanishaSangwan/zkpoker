// Real Schnorr proof-of-knowledge verifier over Grumpkin, for
// PokerGame::register_shuffle_key (docs/V2-MENTAL-POKER.md §4.1).
//
// This is the rogue-key defence. Without proof that a registrant knows the
// secret behind their published key share, the player who registers LAST
// can pick pk_last = X - Σ(other shares) for an X whose secret they know:
// the joint key becomes theirs alone, they decrypt every hole card at the
// table, and every shuffle proof in the chain still verifies. A share built
// by subtraction has no known discrete log, so requiring knowledge of it
// makes that choice unprovable.
//
// Deployed SEPARATELY from PokerGame and referenced by address, so Garaga
// never enters PokerGame's dependency graph (Garaga targets an older Cairo
// than this project pins) and so the proof system can be swapped without
// touching the game contract.

// Chaum-Pedersen DLEQ verifier for threshold decryption shares. Separate
// contract, same package -- keeps every Garaga dependency in one crate.
pub mod dleq;

#[starknet::interface]
pub trait IKeyVerifier<TState> {
    // proof         = Serde(SchnorrSignatureWithHint): rx, s, e, msm_hint
    // public_inputs = [pk_x.low, pk_x.high, pk_y.low, pk_y.high]
    fn verify_key_ownership(self: @TState, proof: Span<felt252>, public_inputs: Span<felt252>) -> bool;

    // The challenge this contract will accept for a given (rx, pk), where
    // rx is passed as its four 96-bit Garaga limbs. Exposed so a prover can
    // compute e exactly as the verifier does rather than guessing at the
    // encoding — a mismatch here is the most likely reason an honest proof
    // gets rejected.
    fn challenge(
        self: @TState,
        rx_limb0: felt252,
        rx_limb1: felt252,
        rx_limb2: felt252,
        rx_limb3: felt252,
        pk_x: u256,
        pk_y: u256,
    ) -> felt252;
}

#[starknet::contract]
pub mod SchnorrKeyVerifier {
    use core::poseidon::poseidon_hash_span;
    use garaga::definitions::G1Point;
    use garaga::signatures::schnorr::{SchnorrSignatureWithHint, is_valid_schnorr_signature_assuming_hash};

    // Garaga curve id: 0 BN254, 1 BLS12_381, 2 SECP256K1, 3 SECP256R1,
    // 4 ED25519, 5 GRUMPKIN.
    const GRUMPKIN: usize = 5;

    #[storage]
    struct Storage {}

    // e = Poseidon(rx.limb0..limb3, pk_x.low, pk_x.high, pk_y.low, pk_y.high)
    //
    // rx is hashed as its four raw 96-bit limbs. u384 has no felt252
    // conversion (it is wider than the STARK prime), and hashing the limbs
    // avoids needing one.
    //
    // Binding e to BOTH the nonce point and the public key is what makes
    // this a proof of knowledge rather than a signature that can be
    // replayed onto a different key.
    //
    // The output is a felt252, so it is always < the STARK prime
    // (~3.62e75), and Grumpkin's scalar order n is BN254's base field
    // (~2.19e76). Every challenge is therefore automatically in range —
    // no modular reduction, and no reduction bias.
    fn compute_challenge(
        rx_limb0: felt252,
        rx_limb1: felt252,
        rx_limb2: felt252,
        rx_limb3: felt252,
        pk_x: u256,
        pk_y: u256,
    ) -> felt252 {
        poseidon_hash_span(
            array![
                rx_limb0,
                rx_limb1,
                rx_limb2,
                rx_limb3,
                pk_x.low.into(),
                pk_x.high.into(),
                pk_y.low.into(),
                pk_y.high.into(),
            ]
                .span(),
        )
    }

    #[abi(embed_v0)]
    impl KeyVerifierImpl of super::IKeyVerifier<ContractState> {
        fn verify_key_ownership(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            if public_inputs.len() != 4 {
                return false;
            }

            // Reject rather than panic on malformed limbs: this is called
            // from PokerGame with caller-supplied data.
            let pkx_lo: Option<u128> = (*public_inputs.at(0)).try_into();
            let pkx_hi: Option<u128> = (*public_inputs.at(1)).try_into();
            let pky_lo: Option<u128> = (*public_inputs.at(2)).try_into();
            let pky_hi: Option<u128> = (*public_inputs.at(3)).try_into();
            if pkx_lo.is_none() || pkx_hi.is_none() || pky_lo.is_none() || pky_hi.is_none() {
                return false;
            }
            let pk_x = u256 { low: pkx_lo.unwrap(), high: pkx_hi.unwrap() };
            let pk_y = u256 { low: pky_lo.unwrap(), high: pky_hi.unwrap() };

            let mut proof_span = proof;
            let parsed: Option<SchnorrSignatureWithHint> = Serde::deserialize(ref proof_span);
            if parsed.is_none() {
                return false;
            }
            let sig_with_hint = parsed.unwrap();

            // ── The check Garaga explicitly does NOT do ──────────────────
            // is_valid_schnorr_signature_assuming_hash trusts the caller's
            // `e`. On its own that is forgeable with no secret at all: pick
            // any s and e, set R = sG - eP, and the equation holds. So the
            // challenge MUST be recomputed here and compared, or this whole
            // contract would verify nothing.
            let rx = sig_with_hint.signature.rx;
            let expected_e: felt252 = compute_challenge(
                rx.limb0.into(), rx.limb1.into(), rx.limb2.into(), rx.limb3.into(), pk_x, pk_y,
            );
            let expected_e_u256: u256 = expected_e.into();
            if sig_with_hint.signature.e != expected_e_u256 {
                return false;
            }

            let public_key = G1Point { x: pk_x.into(), y: pk_y.into() };
            is_valid_schnorr_signature_assuming_hash(sig_with_hint, public_key, GRUMPKIN)
        }

        fn challenge(
            self: @ContractState,
            rx_limb0: felt252,
            rx_limb1: felt252,
            rx_limb2: felt252,
            rx_limb3: felt252,
            pk_x: u256,
            pk_y: u256,
        ) -> felt252 {
            compute_challenge(rx_limb0, rx_limb1, rx_limb2, rx_limb3, pk_x, pk_y)
        }
    }
}
