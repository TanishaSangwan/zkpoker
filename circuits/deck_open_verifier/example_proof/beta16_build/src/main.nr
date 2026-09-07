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
// Slots opened per proof.
//
// Was 5 -- the five community cards -- which meant a table's in-play positions
// took several proofs: 3 for a two-seat table, 10 for a fifteen-seat one.
// That is expensive for a reason worth stating: on-chain Honk verification is
// roughly 587M gas FIXED per proof plus ~13M per sumcheck round, so cost
// tracks the NUMBER of proofs and barely notices circuit size. The shuffle
// circuit is 8x larger than this one and verifies for only 5% more.
//
// So the constraint to optimise against is not gates, it is PUBLIC INPUTS,
// which garaga caps at 99: it names its verifier
// "zk_honk_sumcheck_size_<log_n>_pub_<num_public_inputs>" and asserts that
// fits a felt252 short string (31 chars). It counts SIXTEEN more than the
// circuit declares -- the pairing-point accumulator Honk carries -- so the
// real budget is 99 - 16 = 83.
//
// Publishing K explicit positions costs 1 + 5K, which caps K at 16. DERIVING
// them from `chunk` and `k_total` costs 3 + 4K instead, which allows 20; K is
// 19 because `circuits/shuffle_open` -- which must agree with this circuit on
// chunk arithmetic, since it proves chunk 0 and this one proves the rest --
// also carries the shuffle's 4 public inputs, and 6 + 4K caps IT at 19.
//
// Deriving is sound because the in-play slots are CONTIGUOUS by construction:
// 2 hole cards per seat followed by 5 community cards, so opening slot i of
// chunk c is deck position K*c + i. The contract derives `k_total` from its
// own storage and never takes it from the caller, exactly as it did when it
// passed the positions themselves.
//
// K = 19 opens every table up to SEVEN seats in a single proof -- and since
// `circuits/shuffle_open` folds chunk 0 into the last shuffle, such a table
// needs no `open_deck` transaction at all.
global K: u32 = 19;
global CARD_FIELDS: u32 = 76; // 4 * K

fn main(
    // -- public --
    deck_hash: pub Field, // must equal the shuffle chain's final hash_out
    chunk: pub u32, // which block of K in-play slots this opens
    k_total: pub u32, // 2*max_seats + 5, derived on-chain from storage
    cards: pub [Field; CARD_FIELDS], // the ciphertexts claimed at those slots
    // -- private --
    deck: [Field; DECK_FIELDS],
) {
    // Bind the private deck to the commitment the contract already holds.
    assert(Poseidon2::hash(deck, DECK_FIELDS) == deck_hash);

    // Bounds first, so the derived index cannot leave the array and the u32
    // arithmetic below cannot overflow.
    assert(k_total != 0);
    assert(k_total <= N);
    assert(chunk < N);

    for i in 0..K {
        // A final partial chunk repeats the last in-play position rather than
        // running past it -- the contract pads the same way, and proving the
        // repeat is exactly as sound as proving any other slot.
        let raw = K * chunk + i;
        let pos = if raw < k_total { raw } else { k_total - 1 };
        let base = 4 * pos;
        assert(deck[base] == cards[4 * i]);
        assert(deck[base + 1] == cards[4 * i + 1]);
        assert(deck[base + 2] == cards[4 * i + 2]);
        assert(deck[base + 3] == cards[4 * i + 3]);
    }
}
