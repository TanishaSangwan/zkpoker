// Deck opening: proves specific ciphertexts sit at specific positions of
// the deck the shuffle chain committed to.
//
// This is what lets the contract use real cards without ever hashing a
// BN254 value itself. The shuffle circuit keeps both decks PRIVATE and
// exposes only Poseidon2 commitments; the contract stores `hash_out` as an
// opaque u256 lifted straight out of the proof's public inputs. This
// circuit then takes that same hash as a public input and proves what the
// committed deck holds at chosen slots. The contract only ever COMPARES
// two hashes for equality -- it never computes one -- so the BN254 vs
// STARK-field mismatch never has to be bridged.
//
// Why this exists rather than making the shuffle circuit's decks public:
// garaga 1.1.0 builds an internal circuit identifier
// "zk_honk_sumcheck_size_<log_n>_pub_<num_public_inputs>" and asserts it
// fits a felt252 short string (31 chars). The prefix is 29 chars at
// log_n=17, leaving two digits, so a verifier CANNOT be generated for a
// circuit with more than 99 total public inputs. Exposing both decks needs
// 434. Opening 5 community cards needs 42. See docs/PROTOCOL.md section 7.
//
// Without this binding the protocol is completely broken: the joint key is
// public, so anyone can encrypt any card as (r*G, M_i + r*y) and hand the
// contract a fabricated ciphertext that every downstream DLEQ verifies
// against honestly.
use poseidon::poseidon2::Poseidon2;

global N: u32 = 52;
global DECK_FIELDS: u32 = 208; // 4 * N
global K: u32 = 5; // slots opened at once (flop+turn+river = 5)

fn main(
    // -- public --
    deck_hash: pub Field, // must equal the shuffle chain's final hash_out
    positions: pub [u32; K], // which deck slots are being opened
    cards: pub [Field; 20], // 4 * K -- the ciphertexts claimed at those slots
    // -- private --
    deck: [Field; DECK_FIELDS],
) {
    // Bind the private deck to the commitment the contract already holds.
    assert(Poseidon2::hash(deck, DECK_FIELDS) == deck_hash);

    for i in 0..K {
        let pos = positions[i];
        assert(pos < N);
        let base = 4 * pos;
        assert(deck[base] == cards[4 * i]);
        assert(deck[base + 1] == cards[4 * i + 1]);
        assert(deck[base + 2] == cards[4 * i + 2]);
        assert(deck[base + 3] == cards[4 * i + 3]);
    }
}
