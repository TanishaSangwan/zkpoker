// Chaum-Pedersen DLEQ verifier over Grumpkin, for threshold decryption
// (docs/PROTOCOL.md §3 proof system 3, §4 phases 2-4).
//
// Proves: log_G(PK) == log_H(D), i.e. one secret x satisfies BOTH
// PK = x*G and D = x*H, without revealing x.
//
// In the protocol H is a card's ciphertext component c1, and D is that
// party's decryption share d_X = c1^{x_X}. So this is the proof that a
// share was computed with the SAME secret whose public key the party
// registered at setup — the thing that stops a player fabricating a share
// that decrypts their card to whatever they would prefer it to be.
//
// Deployed SEPARATELY from PokerGame and referenced by address, for the
// same two reasons as SchnorrKeyVerifier: Garaga targets an older Cairo
// than this project pins, and the proof system stays swappable without
// touching the game contract.
//
// ── The trap, inherited from the Schnorr verifier ─────────────────────
// Garaga's signature helpers take `e` from the caller and do not derive
// it. On its own that is forgeable with no secret at all: pick any s and
// e, set R = sG - ePK, and the equation holds. This contract therefore
// RECOMPUTES the challenge from the transcript and compares, exactly as
// SchnorrKeyVerifier does. Without that comparison it would verify
// nothing. The MSM results R1/R2 are never supplied by the caller — they
// are derived here and fed into the hash — so a forger would have to hit a
// Poseidon preimage.

#[starknet::interface]
pub trait IDleqVerifier<TState> {
    // proof = [ s.low, s.high, e.low, e.high, msm_hint_1 (20), msm_hint_2 (20) ]
    //         = 44 felts. Each hint is Garaga's FakeGlvHint x2: Q (8 limbs)
    //         + s1 + s2 = 10 felts per (point, scalar) pair.
    //
    // public_inputs = [ pk_x, pk_y, h_x, h_y, d_x, d_y ] as u256 low/high
    //                 pairs = 12 felts.
    fn verify_decryption_share(
        self: @TState, proof: Span<felt252>, public_inputs: Span<felt252>,
    ) -> bool;

    // Verifies a decryption share AND that removing it from the ciphertext
    // yields the claimed card. This is the call PokerGame actually makes:
    // it cannot do the point arithmetic itself, because that would drag
    // Garaga into the game contract's dependency graph.
    //
    // The card index is CHECKED, not trusted -- the caller names a card and
    // this recomputes m = c2 - D and compares against the encoding table.
    // Naming the card costs one comparison instead of scanning all 52.
    //
    // In the aggregated flow (docs/PROTOCOL.md 6.2) the "share" is the sum
    // of every party's share and `pk` is the table's JOINT key, so one call
    // settles a card regardless of how many players sit at the table.
    //
    // public_inputs = [pk, h, d] as u256 low/high pairs, exactly as for
    // verify_decryption_share, where h is the ciphertext's c1.
    fn verify_card_reveal(
        self: @TState,
        proof: Span<felt252>,
        public_inputs: Span<felt252>,
        c2_x: u256,
        c2_y: u256,
        claimed_card: u8,
    ) -> bool;
}

#[starknet::contract]
pub mod DleqVerifier {
    use core::poseidon::poseidon_hash_span;
    use garaga::basic_field_ops::neg_mod_p;
    use garaga::definitions::{G1Point, Zero, get_G, get_curve_order_modulus, get_n, u384};
    use garaga::ec_ops::{G1PointTrait, ec_safe_add, msm_g1};
    use zkpoker_verifier::card_table::card_x;

    // Garaga curve id: 0 BN254, 1 BLS12_381, 2 SECP256K1, 3 SECP256R1,
    // 4 ED25519, 5 GRUMPKIN.
    const GRUMPKIN: usize = 5;

    // 4 felts (s, e) + 2 * 20 felts of MSM hints.
    const PROOF_LEN: u32 = 44;
    const PUBLIC_INPUTS_LEN: u32 = 12;
    const HINT_LEN: u32 = 20;

    #[storage]
    struct Storage {}

    fn push_u384(ref out: Array<felt252>, v: u384) {
        // Limbs are 96-bit, so each fits a felt252 comfortably. u384 has no
        // felt252 conversion of its own (it is wider than the STARK prime),
        // which is why the limbs are hashed directly — same approach as
        // SchnorrKeyVerifier's handling of rx.
        out.append(v.limb0.into());
        out.append(v.limb1.into());
        out.append(v.limb2.into());
        out.append(v.limb3.into());
    }

    fn push_point(ref out: Array<felt252>, p: G1Point) {
        push_u384(ref out, p.x);
        push_u384(ref out, p.y);
    }

    // e = Poseidon(PK, H, D, R1, R2)
    //
    // Binding the challenge to all five points is what makes this a DLEQ
    // rather than two unrelated Schnorr proofs: a prover who used different
    // secrets for the two equations cannot produce one `e` consistent with
    // both. G is omitted deliberately — it is a fixed curve constant, not
    // attacker-influenced, so including it adds nothing.
    //
    // The output is a felt252, hence always < the STARK prime (~3.62e75),
    // while Grumpkin's scalar order n is BN254's base field (~2.19e76).
    // Every challenge is therefore in range with no modular reduction and
    // no reduction bias — same argument as SchnorrKeyVerifier.
    fn compute_challenge(pk: G1Point, h: G1Point, d: G1Point, r1: G1Point, r2: G1Point) -> felt252 {
        let mut buf: Array<felt252> = array![];
        push_point(ref buf, pk);
        push_point(ref buf, h);
        push_point(ref buf, d);
        push_point(ref buf, r1);
        push_point(ref buf, r2);
        poseidon_hash_span(buf.span())
    }

    fn read_u256(inputs: Span<felt252>, at: u32) -> Option<u256> {
        let lo: Option<u128> = (*inputs.at(at)).try_into();
        let hi: Option<u128> = (*inputs.at(at + 1)).try_into();
        if lo.is_none() || hi.is_none() {
            return Option::None;
        }
        Option::Some(u256 { low: lo.unwrap(), high: hi.unwrap() })
    }

    // Shared by both entrypoints. Returns the decryption share point D on
    // success so the caller can subtract it, or None if anything about the
    // proof or its inputs is wrong.
    fn check_dleq(proof: Span<felt252>, public_inputs: Span<felt252>) -> Option<G1Point> {
            // Reject rather than panic on anything malformed: this is
            // called from PokerGame with caller-supplied data.
            if proof.len() != PROOF_LEN || public_inputs.len() != PUBLIC_INPUTS_LEN {
                return Option::None;
            }

            let mut coords: Array<u256> = array![];
            let mut i: u32 = 0;
            while i != PUBLIC_INPUTS_LEN {
                match read_u256(public_inputs, i) {
                    Option::Some(v) => coords.append(v),
                    Option::None => { return Option::None; },
                }
                i += 2;
            }

            let pk = G1Point { x: (*coords.at(0)).into(), y: (*coords.at(1)).into() };
            let h = G1Point { x: (*coords.at(2)).into(), y: (*coords.at(3)).into() };
            let d = G1Point { x: (*coords.at(4)).into(), y: (*coords.at(5)).into() };

            // All three must be real curve points. Skipping this would let
            // a caller pass off-curve values into the MSM, where the group
            // law does not hold and the soundness argument evaporates.
            if !pk.is_on_curve_excluding_infinity(GRUMPKIN)
                || !h.is_on_curve_excluding_infinity(GRUMPKIN)
                || !d.is_on_curve_excluding_infinity(GRUMPKIN) {
                return Option::None;
            }

            let s = match read_u256(proof, 0) {
                Option::Some(v) => v,
                Option::None => { return Option::None; },
            };
            let e = match read_u256(proof, 2) {
                Option::Some(v) => v,
                Option::None => { return Option::None; },
            };

            let n: u256 = get_n(GRUMPKIN);
            if s == 0 || s >= n || e == 0 || e >= n {
                return Option::None;
            }

            let n_modulus = get_curve_order_modulus(GRUMPKIN);
            let e_neg: u256 = neg_mod_p(e.into(), n_modulus).try_into().unwrap();

            let hint1 = proof.slice(4, HINT_LEN);
            let hint2 = proof.slice(4 + HINT_LEN, HINT_LEN);

            // R1 = s*G - e*PK
            let r1 = msm_g1(
                array![get_G(GRUMPKIN), pk].span(), array![s, e_neg].span(), GRUMPKIN, hint1,
            );
            // R2 = s*H - e*D
            let r2 = msm_g1(array![h, d].span(), array![s, e_neg].span(), GRUMPKIN, hint2);

            if r1.is_zero() || r2.is_zero() {
                return Option::None;
            }

        let expected_e: felt252 = compute_challenge(pk, h, d, r1, r2);
        let expected_e_u256: u256 = expected_e.into();
        if e != expected_e_u256 {
            return Option::None;
        }
        Option::Some(d)
    }

    #[abi(embed_v0)]
    impl DleqVerifierImpl of super::IDleqVerifier<ContractState> {
        fn verify_decryption_share(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            check_dleq(proof, public_inputs).is_some()
        }

        fn verify_card_reveal(
            self: @ContractState,
            proof: Span<felt252>,
            public_inputs: Span<felt252>,
            c2_x: u256,
            c2_y: u256,
            claimed_card: u8,
        ) -> bool {
            if claimed_card >= 52 {
                return false;
            }
            let d = match check_dleq(proof, public_inputs) {
                Option::Some(v) => v,
                Option::None => { return false; },
            };

            let c2 = G1Point { x: c2_x.into(), y: c2_y.into() };
            if !c2.is_on_curve_excluding_infinity(GRUMPKIN) {
                return false;
            }

            // m = c2 - D. With D = X*c1 for the joint secret X, this is the
            // plaintext card point: c2 = M + X*c1 by construction, so
            // subtracting a share proven to equal X*c1 recovers M exactly.
            let m = ec_safe_add(c2, d.negate(GRUMPKIN), GRUMPKIN);
            if m.is_zero() {
                return false;
            }

            // Compare against the encoding table. x alone identifies the
            // card: the 52 x-coordinates are distinct and m is a genuine
            // curve point, so y is determined up to sign.
            let expected_x = card_x(claimed_card);
            let m_x: u256 = m.x.try_into().unwrap();
            expected_x != 0 && m_x == expected_x
        }
    }
}
