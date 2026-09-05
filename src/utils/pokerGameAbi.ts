// GENERATED FILE -- do not edit by hand.
//
// ABI for cairo/src/lib.cairo's PokerGame, extracted from
// cairo/target/dev/zkpoker_PokerGame.contract_class.json by scripts/gen_abi.mjs.
// Regenerate with `scarb build` in cairo/ then `node scripts/gen_abi.mjs`.
// `node scripts/gen_abi.mjs --check` fails if this file has drifted from the
// compiled contract -- which is how the previous hand-maintained copy ended up
// an entire protocol version behind without anything complaining.
export const pokerGameAbi = [
  {
    "type": "impl",
    "name": "PokerGameImpl",
    "interface_name": "zkpoker::IPokerGame"
  },
  {
    "type": "struct",
    "name": "core::array::Span::<core::felt252>",
    "members": [
      {
        "name": "snapshot",
        "type": "@core::array::Array::<core::felt252>"
      }
    ]
  },
  {
    "type": "struct",
    "name": "core::array::Span::<(core::integer::u8, core::integer::u8)>",
    "members": [
      {
        "name": "snapshot",
        "type": "@core::array::Array::<(core::integer::u8, core::integer::u8)>"
      }
    ]
  },
  {
    "type": "struct",
    "name": "core::array::Span::<core::integer::u8>",
    "members": [
      {
        "name": "snapshot",
        "type": "@core::array::Array::<core::integer::u8>"
      }
    ]
  },
  {
    "type": "struct",
    "name": "zkpoker::OpenNoteDeposit",
    "members": [
      {
        "name": "note_id",
        "type": "core::felt252"
      },
      {
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "amount",
        "type": "core::integer::u128"
      }
    ]
  },
  {
    "type": "struct",
    "name": "core::array::Span::<zkpoker::OpenNoteDeposit>",
    "members": [
      {
        "name": "snapshot",
        "type": "@core::array::Array::<zkpoker::OpenNoteDeposit>"
      }
    ]
  },
  {
    "type": "struct",
    "name": "core::integer::u256",
    "members": [
      {
        "name": "low",
        "type": "core::integer::u128"
      },
      {
        "name": "high",
        "type": "core::integer::u128"
      }
    ]
  },
  {
    "type": "struct",
    "name": "core::array::Span::<core::integer::u256>",
    "members": [
      {
        "name": "snapshot",
        "type": "@core::array::Array::<core::integer::u256>"
      }
    ]
  },
  {
    "type": "enum",
    "name": "core::bool",
    "variants": [
      {
        "name": "False",
        "type": "()"
      },
      {
        "name": "True",
        "type": "()"
      }
    ]
  },
  {
    "type": "interface",
    "name": "zkpoker::IPokerGame",
    "items": [
      {
        "type": "function",
        "name": "create_table",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "token",
            "type": "core::starknet::contract_address::ContractAddress"
          },
          {
            "name": "buy_in",
            "type": "core::integer::u128"
          },
          {
            "name": "max_seats",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "join_table",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "hole_card_note_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "register_payout_note",
        "inputs": [
          {
            "name": "note_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "bind_payout_note",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "note_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "commit_deal",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seed_hash",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "mark_dealt",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "reveal_seed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seed",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "bet",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "amount",
            "type": "core::integer::u128"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "fold",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "advance_street",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "settle_table_by_hand",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seats",
            "type": "core::array::Span::<core::felt252>"
          },
          {
            "name": "hole_cards",
            "type": "core::array::Span::<(core::integer::u8, core::integer::u8)>"
          },
          {
            "name": "community_cards",
            "type": "core::array::Span::<core::integer::u8>"
          },
          {
            "name": "payout_note_ids",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "reclaim_stalled_bet",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "settle_table",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "winners",
            "type": "core::array::Span::<core::felt252>"
          },
          {
            "name": "payout_note_ids",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "privacy_invoke",
        "inputs": [
          {
            "name": "token",
            "type": "core::starknet::contract_address::ContractAddress"
          },
          {
            "name": "pool_address",
            "type": "core::starknet::contract_address::ContractAddress"
          },
          {
            "name": "note_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::array::Span::<zkpoker::OpenNoteDeposit>"
          }
        ],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "register_shuffle_key",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "pk_x",
            "type": "core::integer::u256"
          },
          {
            "name": "pk_y",
            "type": "core::integer::u256"
          },
          {
            "name": "key_proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "begin_shuffle",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "joint_pk_x",
            "type": "core::integer::u256"
          },
          {
            "name": "joint_pk_y",
            "type": "core::integer::u256"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "submit_shuffle",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "new_commitment",
            "type": "core::integer::u256"
          },
          {
            "name": "deck",
            "type": "core::array::Span::<core::integer::u256>"
          },
          {
            "name": "proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "dispute_deck",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "claim_shuffle_timeout",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "claim_action_timeout",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "accuse_share",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "answer_accusation",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          },
          {
            "name": "share_x",
            "type": "core::integer::u256"
          },
          {
            "name": "share_y",
            "type": "core::integer::u256"
          },
          {
            "name": "proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "claim_share_timeout",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "open_deck",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "chunk",
            "type": "core::integer::u32"
          },
          {
            "name": "ciphertexts",
            "type": "core::array::Span::<core::integer::u256>"
          },
          {
            "name": "proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "reveal_community_card",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "index",
            "type": "core::integer::u32"
          },
          {
            "name": "share_x",
            "type": "core::integer::u256"
          },
          {
            "name": "share_y",
            "type": "core::integer::u256"
          },
          {
            "name": "claimed_card",
            "type": "core::integer::u8"
          },
          {
            "name": "proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "commit_hole_shares",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "slot",
            "type": "core::integer::u32"
          },
          {
            "name": "commitment",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "reveal_hole_card",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "slot",
            "type": "core::integer::u32"
          },
          {
            "name": "share_x",
            "type": "core::integer::u256"
          },
          {
            "name": "share_y",
            "type": "core::integer::u256"
          },
          {
            "name": "blinding",
            "type": "core::felt252"
          },
          {
            "name": "claimed_card",
            "type": "core::integer::u8"
          },
          {
            "name": "proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "get_community_card",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "index",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u8"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_community_revealed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "index",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_hole_card",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "slot",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u8"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_hole_revealed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "slot",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_deck_opened",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "settle_from_reveals",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "muck",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "set_blinds",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "small_blind",
            "type": "core::integer::u128"
          },
          {
            "name": "big_blind",
            "type": "core::integer::u128"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "reveal_draw_card",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "share_x",
            "type": "core::integer::u256"
          },
          {
            "name": "share_y",
            "type": "core::integer::u256"
          },
          {
            "name": "claimed_card",
            "type": "core::integer::u8"
          },
          {
            "name": "proof",
            "type": "core::array::Span::<core::felt252>"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "post_blinds",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "start_next_hand",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "get_small_blind",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_big_blind",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_button",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_button_set",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_draw_card",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u8"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_draw_revealed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_blinds_posted",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_hand_number",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u32"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "claim_showdown_timeout",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "get_showdown_turn",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_showdown_deadline",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_showdown_started",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_mucked",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "check",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [],
        "state_mutability": "external"
      },
      {
        "type": "function",
        "name": "get_action_turn",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_action_deadline",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_amount_to_call",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_street_contributed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_round_complete",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_commitment",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u256"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_turn",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u32"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_order_len",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u32"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_seat_at",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_deadline",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_complete",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_voided",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_verifier",
        "inputs": [],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_key_registered",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_pk",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "(core::integer::u256, core::integer::u256)"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_joint_pk",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "(core::integer::u256, core::integer::u256)"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_folded",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_shuffle_started",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_published_deck_hash",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_published_deck_seat",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_position_opened",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_opened_ciphertext",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "(core::integer::u256, core::integer::u256, core::integer::u256, core::integer::u256)"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_hole_commitment",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "slot",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_deck_open_chunk",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u32"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_pot",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seed_hash",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_revealed_seed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_accusation_deadline",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_share_posted",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          },
          {
            "name": "position",
            "type": "core::integer::u32"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_share_defaulter_plus_one",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_note",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_payout_note",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::felt252"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_pending_payout",
        "inputs": [
          {
            "name": "note_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_pool",
        "inputs": [],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_dealer",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_owner",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_note_id_owner",
        "inputs": [
          {
            "name": "note_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_created_at",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u64"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_seat_contributed",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          },
          {
            "name": "seat",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u128"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_settled",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::bool"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_street",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u8"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_max_seats",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::integer::u32"
          }
        ],
        "state_mutability": "view"
      },
      {
        "type": "function",
        "name": "get_table_token",
        "inputs": [
          {
            "name": "table_id",
            "type": "core::felt252"
          }
        ],
        "outputs": [
          {
            "type": "core::starknet::contract_address::ContractAddress"
          }
        ],
        "state_mutability": "view"
      }
    ]
  },
  {
    "type": "constructor",
    "name": "constructor",
    "inputs": [
      {
        "name": "pool",
        "type": "core::starknet::contract_address::ContractAddress"
      },
      {
        "name": "shuffle_verifier",
        "type": "core::starknet::contract_address::ContractAddress"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::TableCreated",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "token",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      },
      {
        "name": "buy_in",
        "type": "core::integer::u128",
        "kind": "data"
      },
      {
        "name": "max_seats",
        "type": "core::integer::u32",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::SeatJoined",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "hole_card_note_id",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::DealCommitted",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seed_hash",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Dealt",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::SeedRevealed",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seed",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Bet",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "amount",
        "type": "core::integer::u128",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Fold",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Settled",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "winner_count",
        "type": "core::integer::u32",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Invoked",
    "kind": "struct",
    "members": [
      {
        "name": "note_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "amount",
        "type": "core::integer::u128",
        "kind": "data"
      },
      {
        "name": "caller",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Reclaimed",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "amount",
        "type": "core::integer::u128",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::StreetAdvanced",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "street",
        "type": "core::integer::u8",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::PayoutNoteRegistered",
    "kind": "struct",
    "members": [
      {
        "name": "note_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "owner",
        "type": "core::starknet::contract_address::ContractAddress",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShuffleKeyRegistered",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "pk_x",
        "type": "core::integer::u256",
        "kind": "data"
      },
      {
        "name": "pk_y",
        "type": "core::integer::u256",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShuffleBegun",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "participants",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "initial_commitment",
        "type": "core::integer::u256",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Shuffled",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "position",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "commitment",
        "type": "core::integer::u256",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::DeckPublished",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "position",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "deck_hash",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::DeckDisputed",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "disputing_seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "publisher_seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "published_deck_hash",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShowdownTurn",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShowdownComplete",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Mucked",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "by_timeout",
        "type": "core::bool",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShuffleComplete",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "final_commitment",
        "type": "core::integer::u256",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::TableVoided",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "stalled_seat",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Checked",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "street",
        "type": "core::integer::u8",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::DeckOpened",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "positions",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "deck_hash",
        "type": "core::integer::u256",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::CommunityCardRevealed",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "index",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "card",
        "type": "core::integer::u8",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::HoleSharesCommitted",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "slot",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "commitment",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::HoleCardRevealed",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "slot",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "card",
        "type": "core::integer::u8",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShareAccused",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "position",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "deadline",
        "type": "core::integer::u64",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShareAnswered",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "position",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "share_x",
        "type": "core::integer::u256",
        "kind": "data"
      },
      {
        "name": "share_y",
        "type": "core::integer::u256",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ShareDefaulted",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "position",
        "type": "core::integer::u32",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::StakeForfeited",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "amount",
        "type": "core::integer::u128",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ActionTimedOut",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "key"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::BlindsSet",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "small_blind",
        "type": "core::integer::u128",
        "kind": "data"
      },
      {
        "name": "big_blind",
        "type": "core::integer::u128",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::DrawCardRevealed",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "card",
        "type": "core::integer::u8",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::ButtonSet",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "by_draw",
        "type": "core::bool",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::BlindsPosted",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "small_seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "big_seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "small",
        "type": "core::integer::u128",
        "kind": "data"
      },
      {
        "name": "big",
        "type": "core::integer::u128",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::BlindPosted",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "seat",
        "type": "core::felt252",
        "kind": "data"
      },
      {
        "name": "amount",
        "type": "core::integer::u128",
        "kind": "data"
      },
      {
        "name": "is_big",
        "type": "core::bool",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::HandStarted",
    "kind": "struct",
    "members": [
      {
        "name": "table_id",
        "type": "core::felt252",
        "kind": "key"
      },
      {
        "name": "hand_number",
        "type": "core::integer::u32",
        "kind": "data"
      },
      {
        "name": "button",
        "type": "core::felt252",
        "kind": "data"
      }
    ]
  },
  {
    "type": "event",
    "name": "zkpoker::PokerGame::Event",
    "kind": "enum",
    "variants": [
      {
        "name": "TableCreated",
        "type": "zkpoker::PokerGame::TableCreated",
        "kind": "nested"
      },
      {
        "name": "SeatJoined",
        "type": "zkpoker::PokerGame::SeatJoined",
        "kind": "nested"
      },
      {
        "name": "DealCommitted",
        "type": "zkpoker::PokerGame::DealCommitted",
        "kind": "nested"
      },
      {
        "name": "Dealt",
        "type": "zkpoker::PokerGame::Dealt",
        "kind": "nested"
      },
      {
        "name": "SeedRevealed",
        "type": "zkpoker::PokerGame::SeedRevealed",
        "kind": "nested"
      },
      {
        "name": "Bet",
        "type": "zkpoker::PokerGame::Bet",
        "kind": "nested"
      },
      {
        "name": "Fold",
        "type": "zkpoker::PokerGame::Fold",
        "kind": "nested"
      },
      {
        "name": "Settled",
        "type": "zkpoker::PokerGame::Settled",
        "kind": "nested"
      },
      {
        "name": "Invoked",
        "type": "zkpoker::PokerGame::Invoked",
        "kind": "nested"
      },
      {
        "name": "Reclaimed",
        "type": "zkpoker::PokerGame::Reclaimed",
        "kind": "nested"
      },
      {
        "name": "StreetAdvanced",
        "type": "zkpoker::PokerGame::StreetAdvanced",
        "kind": "nested"
      },
      {
        "name": "PayoutNoteRegistered",
        "type": "zkpoker::PokerGame::PayoutNoteRegistered",
        "kind": "nested"
      },
      {
        "name": "ShuffleKeyRegistered",
        "type": "zkpoker::PokerGame::ShuffleKeyRegistered",
        "kind": "nested"
      },
      {
        "name": "ShuffleBegun",
        "type": "zkpoker::PokerGame::ShuffleBegun",
        "kind": "nested"
      },
      {
        "name": "Shuffled",
        "type": "zkpoker::PokerGame::Shuffled",
        "kind": "nested"
      },
      {
        "name": "DeckPublished",
        "type": "zkpoker::PokerGame::DeckPublished",
        "kind": "nested"
      },
      {
        "name": "DeckDisputed",
        "type": "zkpoker::PokerGame::DeckDisputed",
        "kind": "nested"
      },
      {
        "name": "ShowdownTurn",
        "type": "zkpoker::PokerGame::ShowdownTurn",
        "kind": "nested"
      },
      {
        "name": "ShowdownComplete",
        "type": "zkpoker::PokerGame::ShowdownComplete",
        "kind": "nested"
      },
      {
        "name": "Mucked",
        "type": "zkpoker::PokerGame::Mucked",
        "kind": "nested"
      },
      {
        "name": "ShuffleComplete",
        "type": "zkpoker::PokerGame::ShuffleComplete",
        "kind": "nested"
      },
      {
        "name": "TableVoided",
        "type": "zkpoker::PokerGame::TableVoided",
        "kind": "nested"
      },
      {
        "name": "Checked",
        "type": "zkpoker::PokerGame::Checked",
        "kind": "nested"
      },
      {
        "name": "DeckOpened",
        "type": "zkpoker::PokerGame::DeckOpened",
        "kind": "nested"
      },
      {
        "name": "CommunityCardRevealed",
        "type": "zkpoker::PokerGame::CommunityCardRevealed",
        "kind": "nested"
      },
      {
        "name": "HoleSharesCommitted",
        "type": "zkpoker::PokerGame::HoleSharesCommitted",
        "kind": "nested"
      },
      {
        "name": "HoleCardRevealed",
        "type": "zkpoker::PokerGame::HoleCardRevealed",
        "kind": "nested"
      },
      {
        "name": "ShareAccused",
        "type": "zkpoker::PokerGame::ShareAccused",
        "kind": "nested"
      },
      {
        "name": "ShareAnswered",
        "type": "zkpoker::PokerGame::ShareAnswered",
        "kind": "nested"
      },
      {
        "name": "ShareDefaulted",
        "type": "zkpoker::PokerGame::ShareDefaulted",
        "kind": "nested"
      },
      {
        "name": "StakeForfeited",
        "type": "zkpoker::PokerGame::StakeForfeited",
        "kind": "nested"
      },
      {
        "name": "ActionTimedOut",
        "type": "zkpoker::PokerGame::ActionTimedOut",
        "kind": "nested"
      },
      {
        "name": "BlindsSet",
        "type": "zkpoker::PokerGame::BlindsSet",
        "kind": "nested"
      },
      {
        "name": "DrawCardRevealed",
        "type": "zkpoker::PokerGame::DrawCardRevealed",
        "kind": "nested"
      },
      {
        "name": "ButtonSet",
        "type": "zkpoker::PokerGame::ButtonSet",
        "kind": "nested"
      },
      {
        "name": "BlindsPosted",
        "type": "zkpoker::PokerGame::BlindsPosted",
        "kind": "nested"
      },
      {
        "name": "BlindPosted",
        "type": "zkpoker::PokerGame::BlindPosted",
        "kind": "nested"
      },
      {
        "name": "HandStarted",
        "type": "zkpoker::PokerGame::HandStarted",
        "kind": "nested"
      }
    ]
  }
] as const;
