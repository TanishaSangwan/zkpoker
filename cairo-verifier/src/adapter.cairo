// Adapter: the one contract PokerGame talks to.
//
// PokerGame declares IShuffleVerifier and knows nothing about proof
// systems. The four real verifiers behind it do not share an interface:
//
//   shuffle       Garaga-generated, verify_ultra_keccak_zk_honk_proof
//                 (Span<felt252>) -> Result<Span<u256>, felt252>
//   deck opening  Garaga-generated, same signature, different circuit
//   key ownership SchnorrKeyVerifier, already IShuffleVerifier-shaped
//   card reveal   DleqVerifier, already IShuffleVerifier-shaped
//
// This routes each call and, for the two Garaga verifiers, performs the
// translation that actually matters.
//
// ── Why returning "it verified" is not enough ─────────────────────────
//
// A Garaga verifier answers one question: "is this a valid proof, and if
// so what were its public inputs?" It has no idea which table, deck or key
// the caller cares about. Accepting a proof purely because it verifies
// would let anyone replay a perfectly valid proof from ANOTHER table --
// or from an earlier round of the same one -- and have the contract treat
// it as proof about the deck it is actually holding.
//
// So this adapter compares the public inputs the verifier returns against
// the ones PokerGame supplied from its own storage, and rejects on any
// mismatch. That comparison is the security boundary; the proof check
// alone is not.

// Mirrors zkpoker::IShuffleVerifier exactly. Redeclared rather than
// imported so this package does not depend on the game crate -- only the
// ABI has to match, and keeping the dependency one-way means the game
// contract can be rebuilt without touching Garaga.
#[starknet::interface]
pub trait IShuffleVerifier<TState> {
    fn verify_shuffle(self: @TState, proof: Span<felt252>, public_inputs: Span<felt252>) -> bool;
    fn verify_key_ownership(
        self: @TState, proof: Span<felt252>, public_inputs: Span<felt252>,
    ) -> bool;
    fn verify_deck_opening(
        self: @TState, proof: Span<felt252>, public_inputs: Span<felt252>,
    ) -> bool;
    fn verify_card_reveal(
        self: @TState,
        proof: Span<felt252>,
        public_inputs: Span<felt252>,
        c2_x: u256,
        c2_y: u256,
        claimed_card: u8,
    ) -> bool;

    // Checks that the table's joint key really is the sum of the seats'
    // registered key shares: Y == SUM(pk_i) on Grumpkin.
    //
    // `shares` is flat, two u256 per seat (x then y), in the order
    // PokerGame walks its seats. `joint_x`/`joint_y` are what the dealer
    // supplied to begin_shuffle.
    //
    // Why this lives here: PokerGame does no elliptic-curve arithmetic by
    // design -- that is what keeps Garaga out of the game contract's
    // dependency graph -- so until this existed the joint key was simply a
    // dealer-supplied parameter that nothing on-chain ever checked, and
    // players were expected to verify it off-chain. A dealer who published
    // a joint key of their own choosing could read every hole card at the
    // table while every proof in the chain still verified: the shuffle
    // circuit takes the joint key as a public input and proves
    // re-randomisation under whatever key it is given.
    fn verify_joint_key(
        self: @TState, shares: Span<u256>, joint_x: u256, joint_y: u256,
    ) -> bool;

    // One party's INDIVIDUAL decryption share, proved against that party's
    // own key share rather than the table's joint key: log_G(pk) ==
    // log_c1(share). This is what an accused player posts to clear
    // themselves -- the normal reveal path uses the aggregate over the
    // joint key, which says nothing about who did or did not contribute.
    //
    // public_inputs = [pk, c1, share] as u256 low/high pairs.
    fn verify_decryption_share(
        self: @TState, proof: Span<felt252>, public_inputs: Span<felt252>,
    ) -> bool;
}

// The Garaga-generated verifiers. `full_proof_with_hints` is the whole
// calldata array `garaga calldata` emits -- proof, public inputs and MSM
// hints together -- which is why `proof` is passed through untouched.
#[starknet::interface]
pub trait IUltraKeccakZKHonkVerifier<TState> {
    fn verify_ultra_keccak_zk_honk_proof(
        self: @TState, full_proof_with_hints: Span<felt252>,
    ) -> Result<Span<u256>, felt252>;
}

#[starknet::contract]
pub mod VerifierAdapter {
    use garaga::definitions::{G1Point, G1PointZero, Zero};
    use garaga::ec_ops::{G1PointTrait, ec_safe_add};
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{IUltraKeccakZKHonkVerifierDispatcher, IUltraKeccakZKHonkVerifierDispatcherTrait};
    use zkpoker_verifier::dleq::{IDleqVerifierDispatcher, IDleqVerifierDispatcherTrait};
    use zkpoker_verifier::{IKeyVerifierDispatcher, IKeyVerifierDispatcherTrait};

    // Garaga curve id, same as dleq.cairo.
    const GRUMPKIN: usize = 5;

    #[storage]
    struct Storage {
        shuffle: ContractAddress,
        deck_open: ContractAddress,
        schnorr: ContractAddress,
        dleq: ContractAddress,
    }

    // All four pinned at construction, for the same reason PokerGame pins
    // `pool` and `shuffle_verifier` (security review round 1, finding 1):
    // a caller-supplied verifier address is a contract that returns true
    // for everything.
    #[constructor]
    fn constructor(
        ref self: ContractState,
        shuffle: ContractAddress,
        deck_open: ContractAddress,
        schnorr: ContractAddress,
        dleq: ContractAddress,
    ) {
        self.shuffle.write(shuffle);
        self.deck_open.write(deck_open);
        self.schnorr.write(schnorr);
        self.dleq.write(dleq);
    }

    // PokerGame serialises every field element as a u256 low/high pair,
    // because Grumpkin coordinates and Noir Field outputs live in BN254's
    // scalar field and are NOT felt252. Garaga hands them back already as
    // u256, so this rebuilds the pairs and compares.
    //
    // Returns false on any length mismatch: a proof carrying a different
    // number of public inputs than the caller expects is a proof about a
    // different statement, whatever else is true of it.
    fn public_inputs_match(expected: Span<felt252>, actual: Span<u256>) -> bool {
        if expected.len() != actual.len() * 2 {
            return false;
        }
        let mut i: u32 = 0;
        let mut ok = true;
        while i != actual.len() {
            let lo: Option<u128> = (*expected.at(i * 2)).try_into();
            let hi: Option<u128> = (*expected.at(i * 2 + 1)).try_into();
            if lo.is_none() || hi.is_none() {
                ok = false;
                break;
            }
            // Bound to a local first: a struct literal directly in an `if`
            // condition is parsed as the start of the block.
            let rebuilt = u256 { low: lo.unwrap(), high: hi.unwrap() };
            if rebuilt != *actual.at(i) {
                ok = false;
                break;
            }
            i += 1;
        }
        ok
    }

    // Y == SUM(pk_i) on Grumpkin. Sums the shares and compares both
    // coordinates.
    //
    // ec_safe_add handles the awkward cases the naive formula does not:
    // the identity (so the accumulator can start at infinity), equal
    // points (doubling), and opposite points (which collapse to
    // infinity). Two colluding seats CAN choose shares x and -x that
    // cancel -- both know their secret, so both Schnorr proofs pass -- but
    // cancelling only removes their own contribution from a sum they
    // already knew their part of, so it buys them nothing. The one case
    // that must not slip through is every share cancelling: the joint key
    // would be the identity, c2 = M + r*Y = M, and every card would be in
    // the clear. An infinity sum is therefore rejected outright.
    fn joint_key_matches(shares: Span<u256>, joint_x: u256, joint_y: u256) -> bool {
        // Two coordinates per seat, and a table of nobody has no key.
        if shares.len() == 0 || shares.len() % 2 != 0 {
            return false;
        }

        let mut acc: G1Point = G1PointZero::zero();
        let mut ok = true;
        let mut i: u32 = 0;
        while i != shares.len() {
            let p = G1Point { x: (*shares.at(i)).into(), y: (*shares.at(i + 1)).into() };
            // Every share must be a real curve point. Off-curve values do
            // not obey the group law, so summing them proves nothing about
            // the key anyone actually holds.
            if !p.is_on_curve_excluding_infinity(GRUMPKIN) {
                ok = false;
                break;
            }
            acc = ec_safe_add(acc, p, GRUMPKIN);
            i += 2;
        }
        if !ok || acc.is_zero() {
            return false;
        }

        let joint = G1Point { x: joint_x.into(), y: joint_y.into() };
        if !joint.is_on_curve_excluding_infinity(GRUMPKIN) {
            return false;
        }
        let acc_x: u256 = acc.x.try_into().unwrap();
        let acc_y: u256 = acc.y.try_into().unwrap();
        // Both coordinates, not just x: -Y has the same x as Y, and
        // encrypting to -Y is a different key.
        acc_x == joint_x && acc_y == joint_y
    }

    fn check_honk(
        verifier: ContractAddress, proof: Span<felt252>, expected: Span<felt252>,
    ) -> bool {
        let dispatcher = IUltraKeccakZKHonkVerifierDispatcher { contract_address: verifier };
        match dispatcher.verify_ultra_keccak_zk_honk_proof(proof) {
            // Valid proof -- but only about whatever public inputs it
            // happens to carry. Bind it to the caller's statement.
            Result::Ok(actual) => public_inputs_match(expected, actual),
            Result::Err(_) => false,
        }
    }

    #[abi(embed_v0)]
    impl AdapterImpl of super::IShuffleVerifier<ContractState> {
        // public_inputs = [joint_pk_x, joint_pk_y, commitment_in, commitment_out]
        // The circuit exposes exactly these four, so a proof that chains
        // onto a different deck fails the comparison rather than the
        // cryptography.
        fn verify_shuffle(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            check_honk(self.shuffle.read(), proof, public_inputs)
        }

        // Already the right shape -- straight through.
        fn verify_key_ownership(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            IKeyVerifierDispatcher { contract_address: self.schnorr.read() }
                .verify_key_ownership(proof, public_inputs)
        }

        // public_inputs = [deck_hash, positions.., ciphertexts..]
        fn verify_deck_opening(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            check_honk(self.deck_open.read(), proof, public_inputs)
        }

        // Also already the right shape. The DLEQ verifier does its own
        // card recovery, so there is nothing to translate.
        fn verify_card_reveal(
            self: @ContractState,
            proof: Span<felt252>,
            public_inputs: Span<felt252>,
            c2_x: u256,
            c2_y: u256,
            claimed_card: u8,
        ) -> bool {
            IDleqVerifierDispatcher { contract_address: self.dleq.read() }
                .verify_card_reveal(proof, public_inputs, c2_x, c2_y, claimed_card)
        }

        fn verify_joint_key(
            self: @ContractState, shares: Span<u256>, joint_x: u256, joint_y: u256,
        ) -> bool {
            joint_key_matches(shares, joint_x, joint_y)
        }

        // Straight through: DleqVerifier already exposes exactly this.
        fn verify_decryption_share(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            IDleqVerifierDispatcher { contract_address: self.dleq.read() }
                .verify_decryption_share(proof, public_inputs)
        }
    }
}
