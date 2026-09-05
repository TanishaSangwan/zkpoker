// V2 spike: one player's verifiable shuffle step.
//
// Proves: "I took the deck committed to by `hash_in`, applied SOME secret
// permutation, re-randomized every ciphertext, and the result is the deck
// committed to by `hash_out`" — while revealing neither the permutation
// nor the randomness.
//
// See docs/V2-MENTAL-POKER.md §5. This is the spike circuit whose cost
// decides whether the naive per-card construction is affordable or whether
// V2 needs a Bayer-Groth shuffle argument instead.
//
// ElGamal over Grumpkin (Noir's embedded curve for a BN254 proving stack),
// so the ~104 scalar multiplications below are close to native in-circuit.
//
// Deck layout: flat [Field; 4*N], four fields per card —
//   [c1.x, c1.y, c2.x, c2.y]
// Ciphertext (c1, c2) = (r*G, M + r*PK), M the card's curve point.
//
// Re-randomization (the step that makes this worth proving — permuting
// alone leaves output ciphertexts byte-identical to inputs, so anyone
// could read the permutation straight off):
//   c1' = c1 + r*G
//   c2' = c2 + r*PK
//
// The decks themselves are PRIVATE, with only Poseidon2 commitments public.
// That is the deployable shape: the on-chain contract stores hash(D_i) and
// the full deck travels in calldata, so the verifier's public-input count
// stays at 4 instead of 416.

// Commitment scheme: Poseidon2, chosen on MEASURED cost. Pedersen (the
// stdlib blackbox) cost ~129,840 gates for these two hashes — more than
// the entire shuffle — and pushed the circuit over the 2^18 boundary.
// Poseidon2 costs ~10,633 and keeps it at 2^17. See
// docs/V2-SPIKE-RESULTS.md §3.
//
// STILL OPEN, and not a gate-count question: this circuit works over
// BN254, while Starknet's native Poseidon is over the STARK field. There
// is no cheap primitive shared by both, so "hash in-circuit, re-hash the
// calldata in Cairo, compare" has no obvious efficient implementation.
// See docs/V2-SPIKE-RESULTS.md §3a — it is a blocking design question.
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};
use poseidon::poseidon2::Poseidon2;

global N: u32 = 52; // cards in a deck
global DECK_FIELDS: u32 = 208; // 4 * N



// The deck encodes the point at infinity as (0, 0), and beta.16 will not add it.
//
// a_0, the canonical starting deck, is encryption with r = 0, so every c1 is
// the identity — and a deck slot is four bare fields, with no room for Noir's
// third `is_infinite` component. (0, 0) is a safe encoding because it
// satisfies no curve equation (y² = x³ − 17 has no root at x = y = 0), so it
// can never collide with a real ciphertext.
//
// The trap: acvm 1.0.0-beta.16 — the toolchain the DEPLOYED verifier requires
// — runs an on-curve check inside `embedded_curve_add` on the RAW coordinates,
// and a witness-derived `is_infinite` does not suppress it. A compile-time
// constant `is_infinite: true` DOES, which is exactly why a small hand-written
// test of "can beta.16 add infinity?" answers yes and misses this. So (0, 0)
// must never reach that blackbox at all.
//
// Hence: substitute an arbitrary on-curve point for the identity, add, then
// throw that result away and return the other operand, since O + q = q. Both
// branches are computed and one is selected, so the stand-in is never observed
// and constrains nothing.
//
// nargo 1.0.0-beta.22 tolerated the old form, which is why this survived seven
// review rounds: every fixture that existed before the browser client was a
// MID-CHAIN shuffle, and only the first link of a chain has identity points in
// its input. See docs/PROTOCOL.md §9.2.
//
// This file and circuits/shuffle_verifier/example_proof/beta16_build/main.nr
// MUST stay semantically identical — the latter is what Garaga compiles into
// the deployed verifier, so a divergence means the chain verifies a different
// statement than this file documents. They differ only in spelling: beta.22
// made `is_infinite` a private field with an accessor, beta.16 exposes it.
fn add_encoded(x: Field, y: Field, q: EmbeddedCurvePoint) -> EmbeddedCurvePoint {
    let is_inf = (x == 0) & (y == 0);
    let stand_in = EmbeddedCurvePoint::generator();
    let base = if is_inf { stand_in } else { EmbeddedCurvePoint::new(x, y) };
    let sum = base + q;
    if is_inf { q } else { sum }
}

// ..and re-encode canonically on the way out, so a result landing on infinity
// is published as (0, 0) rather than whatever representation it carries.
// Without this the asserts below could accept coordinates that are not the
// canonical encoding, and the next link would decode a different point than
// this one proved.
fn encode_x(p: EmbeddedCurvePoint) -> Field {
    if p.is_infinite() { 0 } else { p.x }
}
fn encode_y(p: EmbeddedCurvePoint) -> Field {
    if p.is_infinite() { 0 } else { p.y }
}

fn main(
    // ── public ──
    pk_x: pub Field,
    pk_y: pub Field,
    hash_in: pub Field,
    hash_out: pub Field,
    // ── private ──
    deck_in: [Field; DECK_FIELDS],
    deck_out: [Field; DECK_FIELDS],
    perm: [u32; N], // perm[j] = which input card lands at output slot j
    r_lo: [Field; N], // re-randomization scalar, low limb
    r_hi: [Field; N], // .. high limb
) {
    // 1. Bind the private decks to their public commitments. Without this
    //    the proof would be about decks nobody else can see.
    assert(Poseidon2::hash(deck_in, DECK_FIELDS) == hash_in);
    assert(Poseidon2::hash(deck_out, DECK_FIELDS) == hash_out);

    // The joint key is never the identity: the contract's verify_joint_key
    // rejects a share sum of infinity outright (Y = O would make
    // c2 = M + r*Y = M — every card in the clear), so this is safe.
    // The joint key is never the identity: the contract's verify_joint_key
    // rejects a share sum of infinity outright (Y = O would make
    // c2 = M + r*Y = M — every card in the clear), so `new` is safe here.
    let pk = EmbeddedCurvePoint::new(pk_x, pk_y);
    let g = EmbeddedCurvePoint::generator();

    // 2. `perm` must be a genuine bijection on 0..N-1, not just any map.
    //    A non-injective "permutation" would let a cheat duplicate a good
    //    card and drop a bad one while still satisfying every re-encryption
    //    constraint below. Marking each source index as it is consumed
    //    forces injectivity, and injective on a finite set of equal size is
    //    bijective.
    let mut seen: [bool; N] = [false; N];

    for j in 0..N {
        let idx = perm[j];
        assert(idx < N);
        assert(!seen[idx]);
        seen[idx] = true;

        // 3. Pull the source ciphertext at the secret index.
        let base = 4 * idx;

        // 4. Re-randomize. These two scalar muls per card are the circuit's
        //    dominant cost: 2 * 52 = 104 in total.
        let r = EmbeddedCurveScalar::new(r_lo[j], r_hi[j]);
        let r_g = multi_scalar_mul([g], [r]);
        let r_pk = multi_scalar_mul([pk], [r]);

        let out_c1 = add_encoded(deck_in[base], deck_in[base + 1], r_g);
        let out_c2 = add_encoded(deck_in[base + 2], deck_in[base + 3], r_pk);

        // 5. ..and it must equal what the prover published at slot j.
        let out_base = 4 * j;
        assert(encode_x(out_c1) == deck_out[out_base]);
        assert(encode_y(out_c1) == deck_out[out_base + 1]);
        assert(encode_x(out_c2) == deck_out[out_base + 2]);
        assert(encode_y(out_c2) == deck_out[out_base + 3]);
    }
}
