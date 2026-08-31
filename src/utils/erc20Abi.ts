// Minimal snake_case ERC20 ABI — just enough to approve/read balance/read
// allowance for a table's buy-in token before calling PokerGame.bet(),
// matching exactly the entrypoint names cairo/src/lib.cairo's own IErc20
// trait expects any token it calls to expose (approve/transfer_from/
// transfer/balance_of). Not every ERC20 on Starknet exposes snake_case
// names (some post-Cairo-2.6 tokens use camelCase only, or both) — if a
// token this UI is pointed at reverts on `approve`, that's most likely why;
// this starter doesn't attempt to auto-detect the naming convention.
export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
      { name: "amount", type: "core::integer::u256" },
    ],
    outputs: [{ type: "core::bool" }],
    state_mutability: "external",
  },
  {
    type: "function",
    name: "allowance",
    inputs: [
      { name: "owner", type: "core::starknet::contract_address::ContractAddress" },
      { name: "spender", type: "core::starknet::contract_address::ContractAddress" },
    ],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
  {
    type: "function",
    name: "balance_of",
    inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }],
    outputs: [{ type: "core::integer::u256" }],
    state_mutability: "view",
  },
] as const;
