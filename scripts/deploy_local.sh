#!/usr/bin/env bash
# Deploys the whole stack to a local starknet-devnet, in dependency order.
#
#   starknet-devnet --seed 0 --host 127.0.0.1 --port 5050 &
#   ./scripts/deploy_local.sh
#
# --seed 0 matters: sncast reads accounts from
# ~/.starknet_accounts/starknet_open_zeppelin_accounts.json, and devnet's
# predeployed accounts are derived from the seed. A different seed means those
# saved accounts do not exist on the chain you just started, and every call
# fails with something much less obvious than "wrong seed".
#
# Six contracts, and the order is forced by the constructors:
#
#   UltraKeccakZKHonkVerifier x2   the shuffle and deck-open Honk verifiers.
#                                  Same contract NAME, different classes --
#                                  they differ only in their VK constants, so
#                                  they must be declared from their own
#                                  packages and never assumed interchangeable.
#   SchnorrKeyVerifier             the rogue-key defence
#   DleqVerifier                   decryption shares and card recovery
#   VerifierAdapter                the single contract PokerGame talks to
#   PokerGame(pool, adapter)       the game
#
# The buy-in token is devnet's own PREDEPLOYED STRK, not a mock. sncast builds
# with the release profile, so cairo/'s feature-gated MockErc20 is not in the
# artifact -- and that is the right outcome: a deployment should not contain a
# token whose mint() is open to anyone. Devnet's predeployed accounts already
# hold STRK, so buy-ins work with no minting step at all.
STRK_DEVNET="0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
set -euo pipefail

ACCOUNT="${ACCOUNT:-devnet0}"
ACCOUNTS_FILE="${ACCOUNTS_FILE:-$HOME/.starknet_accounts/starknet_open_zeppelin_accounts.json}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC="${RPC:-http://127.0.0.1:5050}"

if ! curl -s -o /dev/null -X POST "$RPC" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"starknet_chainId","params":[]}'; then
  echo "no devnet at $RPC -- start it with: starknet-devnet --seed 0 --host 127.0.0.1 --port 5050"
  exit 1
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Explicit --url/--account rather than --profile: snfoundry.toml lives in
# cairo/ only, so a profile name is invisible from the verifier packages and
# fails with "Profile not found in global config", which reads like a missing
# install rather than a missing file.
SN=(sncast --account "$ACCOUNT" --accounts-file "$ACCOUNTS_FILE" --json)
SNARGS=(--url "$RPC")

# sncast prints a human table by default; --json makes it parseable. `declare`
# is idempotent in spirit but not in fact -- a second declare of an identical
# class errors, so an already-declared class is treated as success and the
# hash recovered from the error.
declare_contract() {
  local dir="$1" name="$2" out hash
  out="$(cd "$ROOT/$dir" && "${SN[@]}" declare "${SNARGS[@]}" --contract-name "$name" 2>&1 || true)"
  hash="$(printf '%s' "$out" | python3 -c '
import sys, json, re
raw = sys.stdin.read()
for line in raw.splitlines():
    try:
        d = json.loads(line)
    except Exception:
        continue
    if isinstance(d, dict) and d.get("class_hash"):
        print(d["class_hash"]); sys.exit(0)
m = re.search(r"0x[0-9a-fA-F]{20,}", raw)
print(m.group(0) if m else "", end="")
')"
  if [ -z "$hash" ]; then
    echo "declare $name failed:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s' "$hash"
}

deploy_contract() {
  local hash="$1"; shift
  local out addr
  out="$(cd "$ROOT/cairo" && "${SN[@]}" deploy "${SNARGS[@]}" --class-hash "$hash" "$@" 2>&1 || true)"
  addr="$(printf '%s' "$out" | python3 -c '
import sys, json
for line in sys.stdin.read().splitlines():
    try:
        d = json.loads(line)
    except Exception:
        continue
    if isinstance(d, dict) and d.get("contract_address"):
        print(d["contract_address"]); sys.exit(0)
')"
  if [ -z "$addr" ]; then
    echo "deploy $hash failed:" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s' "$addr"
}

say "declaring"
SHUFFLE_CLASS="$(declare_contract circuits/shuffle_verifier UltraKeccakZKHonkVerifier)"
echo "  shuffle verifier   $SHUFFLE_CLASS"
DECKOPEN_CLASS="$(declare_contract circuits/deck_open_verifier UltraKeccakZKHonkVerifier)"
echo "  deck-open verifier $DECKOPEN_CLASS"
SCHNORR_CLASS="$(declare_contract cairo-verifier SchnorrKeyVerifier)"
echo "  schnorr            $SCHNORR_CLASS"
DLEQ_CLASS="$(declare_contract cairo-verifier DleqVerifier)"
echo "  dleq               $DLEQ_CLASS"
ADAPTER_CLASS="$(declare_contract cairo-verifier VerifierAdapter)"
echo "  adapter            $ADAPTER_CLASS"
GAME_CLASS="$(declare_contract cairo PokerGame)"
echo "  pokergame          $GAME_CLASS"
if [ "$SHUFFLE_CLASS" = "$DECKOPEN_CLASS" ]; then
  echo "the two Honk verifiers declared to the SAME class hash -- they should differ" >&2
  echo "only in their VK constants, so this means one package was built stale." >&2
  exit 1
fi

say "deploying"
SHUFFLE_ADDR="$(deploy_contract "$SHUFFLE_CLASS")";     echo "  shuffle verifier   $SHUFFLE_ADDR"
DECKOPEN_ADDR="$(deploy_contract "$DECKOPEN_CLASS")";   echo "  deck-open verifier $DECKOPEN_ADDR"
SCHNORR_ADDR="$(deploy_contract "$SCHNORR_CLASS")";     echo "  schnorr            $SCHNORR_ADDR"
DLEQ_ADDR="$(deploy_contract "$DLEQ_CLASS")";           echo "  dleq               $DLEQ_ADDR"

ADAPTER_ADDR="$(deploy_contract "$ADAPTER_CLASS" --arguments "$SHUFFLE_ADDR,$DECKOPEN_ADDR,$SCHNORR_ADDR,$DLEQ_ADDR")"
echo "  adapter            $ADAPTER_ADDR"

# `pool` is the STRK20 privacy pool. There is none on devnet, so it is set to
# the deploying account: privacy_invoke is the only entrypoint that uses it and
# nothing in the poker flow touches it.
POOL="$(ACCOUNT="$ACCOUNT" ACCOUNTS_FILE="$ACCOUNTS_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['ACCOUNTS_FILE']))
for net in d.values():
    if os.environ['ACCOUNT'] in net:
        print(net[os.environ['ACCOUNT']]['address']); break
")"
GAME_ADDR="$(deploy_contract "$GAME_CLASS" --arguments "$POOL,$ADAPTER_ADDR")"
echo "  pokergame          $GAME_ADDR"

TOKEN_ADDR="$STRK_DEVNET"
echo "  buy-in token       $TOKEN_ADDR (devnet predeployed STRK)"

say "wiring .env.local"
python3 - "$GAME_ADDR" "$TOKEN_ADDR" <<'PY'
import re, sys, pathlib
game, token = sys.argv[1], sys.argv[2]
p = pathlib.Path("/home/x/Documents/zkpoker/.env.local")
text = p.read_text() if p.exists() else ""
def setvar(t, k, v):
    if re.search(rf"^{k}=.*$", t, re.M):
        return re.sub(rf"^{k}=.*$", f"{k}={v}", t, flags=re.M)
    return t.rstrip("\n") + f"\n{k}={v}\n"
text = setvar(text, "NEXT_PUBLIC_POKERGAME_DEVNET", game)
text = setvar(text, "NEXT_PUBLIC_DEVNET_TOKEN", token)
text = setvar(text, "NEXT_PUBLIC_DEVNET_RPC_URL", "http://127.0.0.1:5050")
p.write_text(text)
print("  NEXT_PUBLIC_POKERGAME_DEVNET =", game)
print("  NEXT_PUBLIC_DEVNET_TOKEN     =", token)
PY

say "done"
cat <<EOT
Addresses recorded in .env.local. Restart \`npm run dev\` to pick them up --
Next inlines NEXT_PUBLIC_* at build time, so a running server keeps the old
values.

  shuffle verifier    $SHUFFLE_ADDR
  deck-open verifier  $DECKOPEN_ADDR
  schnorr verifier    $SCHNORR_ADDR
  dleq verifier       $DLEQ_ADDR
  verifier adapter    $ADAPTER_ADDR
  PokerGame           $GAME_ADDR
  buy-in token        $TOKEN_ADDR (predeployed STRK)
EOT
