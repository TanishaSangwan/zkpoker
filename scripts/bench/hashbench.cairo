// Micro-benchmark: Cairo-native keccak vs Cairo-native Poseidon, over the
// same logical payload. Used to bound what garaga's ultra_starknet_zk_honk
// transcript WOULD save, given that variant does not exist in garaga 1.1.0
// and so cannot be measured directly.
#[starknet::interface]
pub trait IHashBench<T> {
    fn keccak_reps(self: @T, reps: u32, words: u32) -> u256;
    fn poseidon_reps(self: @T, reps: u32, words: u32) -> felt252;
}

#[starknet::contract]
pub mod HashBench {
    use core::keccak;
    use core::poseidon::poseidon_hash_span;

    #[storage]
    struct Storage {}

    #[abi(embed_v0)]
    impl HashBenchImpl of super::IHashBench<ContractState> {
        // `words` u64 limbs per digest, `reps` digests.
        fn keccak_reps(self: @ContractState, reps: u32, words: u32) -> u256 {
            let mut acc: u256 = 0;
            for _r in 0..reps {
                let mut input: Array<u64> = array![];
                for i in 0..words {
                    input.append(i.into() + acc.low.try_into().unwrap_or(1_u64));
                }
                let d = keccak::cairo_keccak(ref input, 0, 0);
                acc = acc ^ d;
            }
            acc
        }

        // `words` felts per hash (2 felts ~ 1 u256, so pass 2x the keccak
        // u64 count / 2 for an equivalent payload).
        fn poseidon_reps(self: @ContractState, reps: u32, words: u32) -> felt252 {
            let mut acc: felt252 = 0;
            for _r in 0..reps {
                let mut input: Array<felt252> = array![];
                for i in 0..words {
                    input.append(i.into() + acc);
                }
                acc = poseidon_hash_span(input.span());
            }
            acc
        }
    }
}
