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
    use starknet::ContractAddress;
    use starknet::storage::{StoragePointerReadAccess, StoragePointerWriteAccess};
    use super::{IUltraKeccakZKHonkVerifierDispatcher, IUltraKeccakZKHonkVerifierDispatcherTrait};
    use zkpoker_verifier::dleq::{IDleqVerifierDispatcher, IDleqVerifierDispatcherTrait};
    use zkpoker_verifier::{IKeyVerifierDispatcher, IKeyVerifierDispatcherTrait};

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
    }
}
