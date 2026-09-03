// Test crate root. See tests/README.md for how to run this suite — it has
// not been executed in this environment (no Rust/cargo toolchain, so even
// `scarb build --test` can't fetch snforge_scarb_plugin to type-check it).
mod helpers;
mod test_lifecycle;
mod test_betting;
mod test_settlement;
mod test_hand_eval;
mod test_shuffle;
mod test_dealing;
