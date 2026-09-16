#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 5, against an assertable fake /events
# sink: exactly one chain.transfer AND one agent.spend for the accepted send.
# hub-core does not exist until C5, so the sink stands in for it - which is what
# the reporting plan agreed. Needs Docker and Foundry.
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

IMAGE=${IMAGE:-agent-chain-anvil:dev}; NAME=${NAME:-agent-chain-anvil-events}; VOLUME=${VOLUME:-agent-chain-events-state}
RPC=${RPC:-http://127.0.0.1:8545}; PORT=${PORT:-7003}; SINK_PORT=${SINK_PORT:-7004}
TOKEN=${CHAIN_SVC_TOKEN:-events-token}
MNEMONIC="test test test test test test test test test test test junk"
HERE="$(cd "$(dirname "$0")" && pwd)"; SVC="$HERE/.."; CONTRACTS="$SVC/../contracts"; DEPLOYMENTS="$SVC/../deployments"
WORK=$(mktemp -d); SVC_PID=""; SINK_PID=""; FAIL=0

step() { printf '\n=== %s\n' "$1"; }
check() { if [ "$2" = "$3" ]; then echo "  ok   $1: $2"; else echo "  FAIL $1: got '$2' want '$3'"; FAIL=1; fi; }
predown() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOLUME" >/dev/null 2>&1 || true; }
cleanup() { [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true
            [ -n "$SINK_PID" ] && kill "$SINK_PID" 2>/dev/null || true; predown; rm -rf "$WORK"; }
trap cleanup EXIT; predown

# The fake hub-core: appends every posted event to a file so the assertions are
# about what ARRIVED, not about the absence of an error.
cat > "$WORK/sink.py" <<'PY'
import http.server, json, sys
OUT = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('content-length', 0)))
        with open(OUT, 'a') as f:
            f.write(body.decode() + "\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
python3 "$WORK/sink.py" "$SINK_PORT" "$WORK/events.jsonl" &
SINK_PID=$!

step "chain up + deploy"
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
echo "  deployed"

( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=s ANVIL_MNEMONIC="$MNEMONIC" \
    DEPLOYMENTS_DIR="$DEPLOYMENTS" KEYSTORE_DIR="$WORK/k" POLICY_DIR="$WORK/p" \
    STORE_PATH="$WORK/s/db.sqlite" PORT="$PORT" HUB_CORE_URL="http://127.0.0.1:$SINK_PORT" \
    bun run src/index.ts ) >"$WORK/svc.log" 2>&1 &
SVC_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
U="http://127.0.0.1:$PORT"
A=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
jget() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }

step "spawn two wallets and make one accepted send"
SB=$(curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"orch:vendor","fundVee":250,"kind":"agent","alias":"vendor.play"}')
SB_TOKEN=$(echo "$SB" | jget "['walletToken']")
curl -fsS "${A[@]}" -X POST "$U/wallets" -d '{"agentId":"alpha:client","fundVee":10,"kind":"agent","alias":"alpha.play"}' >/dev/null
# No X-Wallet-Client header: this is a caller going straight at chain-svc, the
# shape a persona bypassing its own MCP would take.
TX=$(curl -fsS -H "Authorization: Bearer $SB_TOKEN" -H 'content-type: application/json' \
     -X POST "$U/sign-transfer" -d '{"to":"alpha.play","vee":50,"memo":"for the stream job","intentId":"a1"}' | jget "['txHash']")
echo "  txHash: $TX"

# And one WITH the marker, the way wallet-mcp will send it in C3.
TX_MCP=$(curl -fsS -H "Authorization: Bearer $SB_TOKEN" -H 'content-type: application/json' \
     -H 'X-Wallet-Client: wallet-mcp/0.1.0' \
     -X POST "$U/sign-transfer" -d '{"to":"alpha.play","vee":10,"intentId":"a2"}' | jget "['txHash']")
echo "  txHash (via wallet-mcp): $TX_MCP"

step "criterion 5 - what the sink actually received"
for _ in $(seq 1 20); do
  grep -q "$TX" "$WORK/events.jsonl" 2>/dev/null && sleep 2 && break
  sleep 1
done
echo "  events for this txHash:"
grep "$TX" "$WORK/events.jsonl" 2>/dev/null | sed 's/^/    /'
COUNT() { grep "$TX" "$WORK/events.jsonl" 2>/dev/null | grep -c "\"kind\": *\"$1\"" || true; }
check "one chain.transfer" "$(COUNT chain.transfer)" "1"
check "one agent.spend"    "$(COUNT agent.spend)" "1"

# The tell: money always produces an agent.spend, and `via` says which path it
# took. A direct call is not refused - the boundary is the caps and the
# principal - it is REPORTED.
VIA() { grep "$1" "$WORK/events.jsonl" 2>/dev/null | grep '"kind":"agent.spend"' \
        | python3 -c "import sys,json;[print(json.loads(l)['via']) for l in sys.stdin]" | head -1; }
check "direct spend tagged direct" "$(VIA "$TX")" "direct"
check "mcp spend tagged mcp"       "$(VIA "$TX_MCP")" "mcp"

# A known-positive control: the funding transfers must ALSO have produced
# chain.transfer events. If this reads 0, the sink or the matcher is broken and
# the two checks above are measuring nothing.
TOTAL=$(grep -c '"kind": *"chain.transfer"' "$WORK/events.jsonl" 2>/dev/null || true)
echo "  control - total chain.transfer events seen (funding + the send): $TOTAL"
[ "$TOTAL" -ge 3 ] && echo "  ok   the sink is receiving events at all" \
  || { echo "  FAIL control failed: sink or matcher is broken, so the checks above prove nothing"; FAIL=1; }

step "verdict"
[ "$FAIL" = 0 ] && echo "PASS: criterion 5 against the fake sink" || { echo "FAIL: see above"; exit 1; }
