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
#
# STRK lives at the same canonical address on devnet, Sepolia and Mainnet, so
# this needs no per-network table.
STRK="0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
set -euo pipefail

# ── which network ──────────────────────────────────────────────────────
#
# NETWORK picks the RPC, the account and which NEXT_PUBLIC_* pair the result
# is written to. Devnet stays the default: this script is run far more often
# against a throwaway node than against a public chain, and a script that
# deploys to a real network when you forget an argument is a bad script.
#
#   ./scripts/deploy_local.sh                       devnet (default)
#   NETWORK=sepolia ./scripts/deploy_local.sh       Starknet Sepolia
#
# Sepolia needs a funded, deployed account named in ACCOUNT. Nothing here
# creates or funds one -- see the README section this prints on failure.
NETWORK="${NETWORK:-devnet}"
case "$NETWORK" in
  devnet)
    RPC="${RPC:-http://127.0.0.1:5050}"
    ACCOUNT="${ACCOUNT:-devnet0}"
    ENV_GAME="NEXT_PUBLIC_POKERGAME_DEVNET"
    ENV_TOKEN="NEXT_PUBLIC_DEVNET_TOKEN"
    ;;
  sepolia)
    RPC="${RPC:-https://starknet-sepolia.drpc.org}"
    ACCOUNT="${ACCOUNT:-sepolia}"
    ENV_GAME="NEXT_PUBLIC_POKERGAME_SEPOLIA"
    ENV_TOKEN=""
    ;;
  *)
    echo "unknown NETWORK '$NETWORK' -- use devnet or sepolia"
    exit 1
    ;;
esac
ACCOUNTS_FILE="${ACCOUNTS_FILE:-$HOME/.starknet_accounts/starknet_open_zeppelin_accounts.json}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! curl -s -o /dev/null -X POST "$RPC" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"starknet_chainId","params":[]}'; then
  if [ "$NETWORK" = devnet ]; then
    echo "no devnet at $RPC -- start it with: starknet-devnet --seed 0 --host 127.0.0.1 --port 5050"
  else
    echo "no RPC at $RPC -- set RPC to a Starknet $NETWORK endpoint"
  fi
  exit 1
fi

# Declaring six contracts is not free on a public chain, and the failure mode
# for an unfunded account is a wall of fee-estimation JSON. Say it plainly
# first instead.
if [ "$NETWORK" != devnet ]; then
  say_addr="$(ACCOUNT="$ACCOUNT" ACCOUNTS_FILE="$ACCOUNTS_FILE" python3 -c "
import json, os
d = json.load(open(os.environ['ACCOUNTS_FILE']))
for net in d.values():
    if os.environ['ACCOUNT'] in net:
        print(net[os.environ['ACCOUNT']]['address']); break
")"
  if [ -z "$say_addr" ]; then
    echo "no account named '$ACCOUNT' in $ACCOUNTS_FILE"
    exit 1
  fi
  if ! curl -s -m 20 -X POST "$RPC" -H 'content-type: application/json' \
       -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"starknet_getClassHashAt\",\"params\":{\"block_id\":\"latest\",\"contract_address\":\"$say_addr\"}}" \
       | grep -q '"result"'; then
    echo "account $ACCOUNT ($say_addr) is not deployed on $NETWORK."
    echo "Fund it, then: sncast --account $ACCOUNT --accounts-file $ACCOUNTS_FILE account deploy --url $RPC --name $ACCOUNT"
    exit 1
  fi
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# Explicit --url/--account rather than --profile: snfoundry.toml lives in
# cairo/ only, so a profile name is invisible from the verifier packages and
# fails with "Profile not found in global config", which reads like a missing
# install rather than a missing file.
# --wait on a public network, not on devnet.
#
# Devnet mines a block per transaction, so the next nonce is ready the instant
# the previous call returns. A real chain is not: firing six declares
# back-to-back builds each one against a nonce the node has not seen used yet,
# and every call after the first fails "Invalid transaction nonce". Waiting for
# acceptance is what makes the sequence a sequence.
SN=(sncast --account "$ACCOUNT" --accounts-file "$ACCOUNTS_FILE" --json)
if [ "$NETWORK" != devnet ]; then
  SN+=(--wait --wait-timeout 600 --wait-retry-interval 5)
fi
SNARGS=(--url "$RPC")

# sncast prints a human table by default; --json makes it parseable. `declare`
# is idempotent in spirit but not in fact -- a second declare of an identical
# class errors, so an already-declared class is treated as success and the
# hash recovered from the error.
declare_contract() {
  local dir="$1" name="$2" out hash attempt
  # A nonce error is transient on a public chain -- the node has simply not
  # caught up with a transaction it already accepted -- so it is retried rather
  # than treated as a failed declare. Anything else fails immediately.
  for attempt in 1 2 3 4 5; do
    out="$(cd "$ROOT/$dir" && "${SN[@]}" declare "${SNARGS[@]}" --contract-name "$name" 2>&1 || true)"
    printf '%s' "$out" | grep -q "Invalid transaction nonce" || break
    echo "  ($name: nonce not settled yet, retry $attempt)" >&2
    sleep 15
  done
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
  local out addr attempt
  for attempt in 1 2 3 4 5; do
    out="$(cd "$ROOT/cairo" && "${SN[@]}" deploy "${SNARGS[@]}" --class-hash "$hash" "$@" 2>&1 || true)"
    printf '%s' "$out" | grep -q "Invalid transaction nonce" || break
    echo "  (deploy $hash: nonce not settled yet, retry $attempt)" >&2
    sleep 15
  done
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

TOKEN_ADDR="$STRK"
echo "  buy-in token       $TOKEN_ADDR (STRK)"

say "wiring .env.local"
python3 - "$GAME_ADDR" "$TOKEN_ADDR" "$ENV_GAME" "$ENV_TOKEN" "$NETWORK" "$ROOT" <<'PY'
import re, sys, pathlib
game, token, env_game, env_token, network, root = sys.argv[1:7]
p = pathlib.Path(root) / ".env.local"
text = p.read_text() if p.exists() else ""
def setvar(t, k, v):
    if re.search(rf"^{k}=.*$", t, re.M):
        return re.sub(rf"^{k}=.*$", f"{k}={v}", t, flags=re.M)
    return t.rstrip("\n") + f"\n{k}={v}\n"
text = setvar(text, env_game, game)
print(f"  {env_game} = {game}")
if env_token:
    text = setvar(text, env_token, token)
    print(f"  {env_token} = {token}")
if network == "devnet":
    text = setvar(text, "NEXT_PUBLIC_DEVNET_RPC_URL", "http://127.0.0.1:5050")
p.write_text(text)
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
