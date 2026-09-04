// The initial deck a_0, and its Poseidon2 commitment.
//
// a_0 is the same for every table in the protocol: encryption with r = 0,
// so ciphertext i is (identity, M_i) where M_i = (i+1)*G is card i's curve
// point (docs/PROTOCOL.md section 4 phase 0, and cairo-verifier's
// card_table.cairo for the +1). Nothing about it depends on the joint key,
// the players, or the table -- r = 0 means c2 = M + 0*PK = M.
//
// That is why PokerGame does not take initial_commitment from the dealer
// any more. It is a CONSTANT, so the contract pins it. This circuit is how
// that constant is computed: Cairo cannot compute a BN254 Poseidon2 hash
// (its own Poseidon is over the STARK field -- docs/PROTOCOL.md section 7),
// so the value is produced here, once, and hard-coded.
//
//     cd circuits/deck_init && nargo execute
//
// prints the commitment as the circuit's return value.
//
// This is a generator, not part of the proving pipeline: no verifier is
// generated from it and nothing on-chain calls it.
use std::embedded_curve_ops::{EmbeddedCurvePoint, EmbeddedCurveScalar, multi_scalar_mul};
use poseidon::poseidon2::Poseidon2;

global N: u32 = 52;
global DECK_FIELDS: u32 = 208;

// The deck a_0, flat, four fields per card: c1.x, c1.y, c2.x, c2.y --
// exactly the layout circuits/shuffle reads.
pub fn initial_deck() -> [Field; DECK_FIELDS] {
    let g = EmbeddedCurvePoint::generator();
    // r = 0, so c1 = 0*G is the point at infinity for every card.
    let inf = EmbeddedCurvePoint::point_at_infinity();

    let mut deck: [Field; DECK_FIELDS] = [0; DECK_FIELDS];
    for i in 0..N {
        // M_i = (i+1)*G. The +1 matters: 0*G is the point at infinity,
        // which has no affine representation and so cannot carry a card.
        let k = EmbeddedCurveScalar::new((i + 1) as Field, 0);
        let m = multi_scalar_mul([g], [k]);

        let base = 4 * i;
        deck[base] = inf.x;
        deck[base + 1] = inf.y;
        deck[base + 2] = m.x;
        deck[base + 3] = m.y;
    }
    deck
}

fn main() -> pub Field {
    Poseidon2::hash(initial_deck(), DECK_FIELDS)
}
