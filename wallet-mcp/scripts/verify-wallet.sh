#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 4: brings up the chain and chain-svc,
# spawns two wallets, then drives wallet-mcp OVER STDIO with a real MCP client
# (scripts/mcp-probe.ts) - the same transport the harness uses.
# Needs Docker and Foundry.
set -euo pipefail

# PARCEL B: A QUIET STEP THAT SPEAKS WHEN IT FAILS.
#
# The expensive setup steps discarded their output entirely, so a failure inside
# one left `set -e` killing the script with the log ending mid-step and nothing
# to read. Measured on this branch: a compose interpolation error reached me as
# a script that stopped after printing "=== cold start", two layers from its
# cause.
#
# Quiet on success - a green verification is a wall of forge and docker output
# nobody reads - and the last 40 lines on failure, which is where the reason is.
# NO `trap ... EXIT` HERE, deliberately. Every one of these scripts sets its own
# EXIT trap to tear down containers and volumes, and a second `trap` on the same
# signal REPLACES the first rather than adding to it - so a helper that installed
# one would leak a stack instead of a temp file. The log is per call and removed
# on both paths.
quietly() { # quietly <label> <cmd...> - prints the command's output only if it fails
  local label=$1; shift
  local log; log=$(mktemp)
  if ! "$@" >"$log" 2>&1; then
    echo "FAIL: $label" >&2
    echo "--- last 40 lines ---" >&2
    tail -40 "$log" >&2
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
}

IMAGE=${IMAGE:-agent-chain-anvil:dev}; NAME=${NAME:-agent-chain-anvil-wallet}; VOLUME=${VOLUME:-agent-chain-wallet-state}
RPC=${RPC:-http://127.0.0.1:8545}; PORT=${PORT:-7005}; TOKEN=${CHAIN_SVC_TOKEN:-wallet-verify-token}
MNEMONIC="test test test test test test test test test test test junk"
HERE="$(cd "$(dirname "$0")" && pwd)"; MCP="$HERE/.."; SVC="$MCP/../svc"
CONTRACTS="$MCP/../contracts"; DEPLOYMENTS="$MCP/../deployments"
WORK=$(mktemp -d); SVC_PID=""

predown() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
cleanup() { [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true; predown; rm -rf "$WORK"; }
trap cleanup EXIT; predown

printf '\n=== chain up + deploy + chain-svc\n'
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break; sleep 1; done
rm -f "$DEPLOYMENTS/local.json"
# The manifest this script's deployment declares. chain-deploy requires one and
# has no built-in default, so a script that deploys must say what it deploys --
# and the TLD here is the suffix every name below is registered under. Without
# this the deploy refuses and every check afterwards is testing nothing.
cat > "$DEPLOYMENTS/manifest.json" <<'MANIFEST_JSON'
{
  "schema": 1,
  "modules": [
    { "kind": "token", "key": "play", "name": "Play Token", "symbol": "PLAY", "initialSupply": "1000000" },
    { "kind": "names", "tld": "play" }
  ]
}
MANIFEST_JSON
# DERIVED FROM THE MNEMONIC, not scraped from `docker logs`.
#
# Account 0 is the deployer AND the treasury, so this is the same derivation
# chain-svc itself makes - which is also what makes it a check rather than a
# lookup: it verifies that this mnemonic really does control account 0 on the
# running chain.
#
# The scrape this replaces returned EMPTY and had for some time: the anvil image
# runs with -q precisely so the banner's private keys never reach the log, and
# `docker logs` is not a secret store - readable by anyone with docker access,
# shipped wholesale by any log collector, and kept after the container is gone.
# With an empty KEY the deploy died at `vm.envUint: failed parsing
# $DEPLOYER_PRIVATE_KEY ... missing hex prefix`, which names the variable and
# not the cause. verify-chain.sh and compose already derive it this way.
KEY=$(cast wallet private-key --mnemonic "$MNEMONIC")
# ALLOW_FRESH_DEPLOY and the PROMOTION are what the container's one-shot does.
# This script drives `forge script` directly into a fresh temp directory, so it
# has to do both itself: the script writes local.json.pending and never
# local.json, because a run WITHOUT --broadcast would otherwise hand every
# service downstream a manifest of contracts nobody mined.
_deploy() {
  cd "$CONTRACTS" && DEPLOYER_PRIVATE_KEY="$KEY" DEPLOYMENTS_DIR="$DEPLOYMENTS" \
    ALLOW_FRESH_DEPLOY=1 \
    forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast
}
quietly "the deploy" _deploy
mv "$DEPLOYMENTS/local.json.pending" "$DEPLOYMENTS/local.json"
# KIND DEFAULTS ARE OPT-IN AS OF v0.8.0, and this line is what this script
# needs to keep asserting what it asserts. Every cap and deny check below
# depends on the agent kind having defaults; unset, `POLICY_DEFAULTS_FILE`
# means NO kind defaults at all, so the wallet is unbounded, the deny list is
# empty, and three checks report a broken guard on a service working exactly as
# configured.
#
# Found by RUNNING this script rather than by reading it: v0.8.0 shipped, and
# this and verify-money.sh had been red since, because a change to the meaning
# of a default needs the list of everything that depends on one - not the
# callers that happen to get exercised.
( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=s ANVIL_MNEMONIC="$MNEMONIC" \
    DEPLOYMENTS_DIR="$DEPLOYMENTS" KEYSTORE_DIR="$WORK/k" POLICY_DIR="$WORK/policies" \
    POLICY_DEFAULTS_FILE="$SVC/policy-defaults.example.json" \
    STORE_PATH="$WORK/s/db.sqlite" PORT="$PORT" bun run src/index.ts ) >"$WORK/svc.log" 2>&1 &
SVC_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
U="http://127.0.0.1:$PORT"; A=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

# Funded above max_per_stage on purpose, so the wallet runs out of CAP before it
# runs out of MONEY - otherwise the stage-cap check would really be measuring an
# overdraft, which is a mistake this suite has already made once.
SB=$(curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"orch:vendor","fundVee":1000,"kind":"agent","alias":"vendor.play"}')
WALLET_TOKEN=$(echo "$SB" | jget "['walletToken']")
curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"alpha:client","fundVee":10,"kind":"agent","alias":"alpha.play"}' >/dev/null
# A lookalike owned by someone else, for the resolve check.
curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"orch:scammer","fundVee":0,"kind":"agent"}' >/dev/null
curl -fsS "${A[@]}" -X POST "$U/aliases" -d '{"agentId":"orch:scammer","alias":"aIpha.play"}' >/dev/null
echo "  wallets spawned; policy file: $(ls "$WORK/policies")"

cd "$MCP"
WALLET_AGENT_ID=orch:vendor \
  CHAIN_SVC_URL="$U" \
  WALLET_TOKEN="$WALLET_TOKEN" \
  POLICY_FILE="$WORK/policies/orch%3Avendor.json" \
  WALLET_STATE_FILE="$WORK/wallet-state.json" \
  bun run scripts/mcp-probe.ts
