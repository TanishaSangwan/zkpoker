// Compiled by nargo 1.0.0-beta.16 into the DEPLOYED verifier. Must stay
// semantically identical to circuits/shuffle_open/src/main.nr, which is what
// the project documents and measures; they differ only in spelling.
// The LAST link of the shuffle chain, proving its opening at the same time.
//
// This is circuits/shuffle and `circuits/deck_open` fused into one circuit.
// It proves, in a single statement:
//
//   1. I took the deck committed to by `hash_in`, applied SOME secret
//      permutation, re-randomized every ciphertext, and the result is the
//      deck committed to by `hash_out`   (the shuffle statement), and
//   2. that same output deck holds `cards` at the in-play slots of chunk
//      `chunk`                            (the opening statement).
//
// Why fuse them: on-chain Honk verification costs ~587M gas FIXED per proof
// plus ~13.2M per sumcheck round, so a hand's cost tracks the NUMBER of
// proofs and barely notices circuit size (docs/PROTOCOL.md section 6.4). The last
// shuffler already holds the final deck in private witness and already pays
// to hash it -- `hash_out` IS the deck-open circuit's `deck_hash`. So the
// opening constraints ride along for a handful of gates, and the separate
// ~587M-gas opening verification disappears. Worth 23.65 STRK a hand.
//
// The non-final links still use circuits/shuffle unchanged: only the final
// deck may be opened, so only the final link carries these public inputs.
//
// Positions are DERIVED here rather than passed, which is what makes the
// public-input budget work. Garaga 1.1.0 names its verifier
// "zk_honk_sumcheck_size_<log_n>_pub_<num_public_inputs>" and asserts that
// fits a felt252 short string (31 chars), so num_public_inputs <= 99; it
// counts 16 more than the circuit declares (Honk's pairing-point
// accumulator), leaving 83. Passing K explicit positions costs 4 + K + 4K,
// which is 84 at K=16 -- one over, and the fusion would not fit at all.
// Deriving them from `chunk` and `k_total` costs 6 + 4K, which is 82 at
// K=19: 98 counted, one under the cap.
//
// Deriving is safe because the in-play slots are CONTIGUOUS by construction:
// the contract lays out 2 hole cards per seat followed by 5 community cards,
// so position i of the opening is simply deck slot `K*chunk + i`. The
// contract derives `k_total = 2*max_seats + 5` from its own storage and
// never takes it from the caller, exactly as it did when it passed the
// positions themselves.
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};
use poseidon::poseidon2::Poseidon2;

global N: u32 = 52; // cards in a deck
global DECK_FIELDS: u32 = 208; // 4 * N

// Slots opened per proof. 19 is the largest K with 6 + 4K <= 83 (see above).
//
// It is not an arbitrary maximum: k_total is 2*max_seats + 5, so K = 19
// opens every table up to SEVEN seats in this one fused proof, with no
// separate `open_deck` transaction at all. Eight seats and up spill into
// `circuits/deck_open` for the remaining chunks, which shares this K so the
// chunk arithmetic is identical on both sides.
global K: u32 = 19;
global CARD_FIELDS: u32 = 76; // 4 * K

// See circuits/shuffle/src/main.nr -- identical, and for the identical
// reason: beta.16's `embedded_curve_add` runs an on-curve check on the raw
// coordinates, and the deck encodes the point at infinity as (0, 0), which
// is on no curve. Substitute an on-curve stand-in, add, then discard that
// branch and return the other operand since O + q = q.
fn add_encoded(x: Field, y: Field, q: EmbeddedCurvePoint) -> EmbeddedCurvePoint {
    let is_inf = (x == 0) & (y == 0);
    let stand_in = EmbeddedCurvePoint::generator();
    let base = if is_inf { stand_in } else { EmbeddedCurvePoint { x, y, is_infinite: false } };
    let sum = base + q;
    if is_inf { q } else { sum }
}

fn encode_x(p: EmbeddedCurvePoint) -> Field {
    if p.is_infinite { 0 } else { p.x }
}
fn encode_y(p: EmbeddedCurvePoint) -> Field {
    if p.is_infinite { 0 } else { p.y }
}

fn main(
    // -- public --
    pk_x: pub Field,
    pk_y: pub Field,
    hash_in: pub Field,
    hash_out: pub Field,
    chunk: pub u32, // which block of K in-play slots this opens
    k_total: pub u32, // 2*max_seats + 5, derived on-chain from storage
    cards: pub [Field; CARD_FIELDS], // the ciphertexts claimed at those slots
    // -- private --
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
    // c2 = M + r*Y = M -- every card in the clear), so `new` is safe here.
    let pk = EmbeddedCurvePoint { x: pk_x, y: pk_y, is_infinite: false };
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

    // 6. The opening, against the SAME deck_out just proved and hashed.
    //
    //    Bounds first, so the derived index cannot leave the array and the
    //    u32 arithmetic below cannot overflow: k_total is a real deck-slot
    //    count, and chunk is a real chunk of one.
    assert(k_total != 0);
    assert(k_total <= N);
    assert(chunk < N);

    for i in 0..K {
        // A final partial chunk repeats the last in-play position rather
        // than running past it -- the contract pads the same way, and
        // proving the repeat is exactly as sound as proving any other slot.
        let raw = K * chunk + i;
        let pos = if raw < k_total { raw } else { k_total - 1 };
        let base = 4 * pos;
        assert(deck_out[base] == cards[4 * i]);
        assert(deck_out[base + 1] == cards[4 * i + 1]);
        assert(deck_out[base + 2] == cards[4 * i + 2]);
        assert(deck_out[base + 3] == cards[4 * i + 3]);
    }
}
