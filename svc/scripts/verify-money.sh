#!/usr/bin/env bash
# Runnable evidence for spec S8 criteria 3, 7, 8 and the chain-svc half of 9:
# spawn, aliases, transfers, memos, retirement. Needs Docker and Foundry, so it
# cannot run in the repo's CI - run it by hand and paste the output:
#   ./svc/scripts/verify-money.sh
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

IMAGE=${IMAGE:-agent-chain-anvil:dev}
NAME=${NAME:-agent-chain-anvil-money-verify}
VOLUME=${VOLUME:-agent-chain-state-money-verify}
RPC=${RPC:-http://127.0.0.1:8545}
PORT=${PORT:-7001}
TOKEN=${CHAIN_SVC_TOKEN:-verify-token}
MNEMONIC="test test test test test test test test test test test junk"

HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$HERE/.."
CONTRACTS="$SVC/../contracts"
DEPLOYMENTS="$SVC/../deployments"
WORK=$(mktemp -d)
SVC_PID=""
FAIL=0
FAILED_CHECKS=""

step() { printf '\n=== %s\n' "$1"; }
check() { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1: $2"
  else
    echo "  FAIL $1: got '$2' want '$3'"
    FAIL=1
    FAILED_CHECKS="$FAILED_CHECKS
    - $1: got '$2' want '$3'"
  fi
}
# Docker teardown only. Deliberately separate from cleanup(): running the full
# cleanup up front would delete $WORK, which was created moments earlier - it
# did, and the service then failed to start with no log to say why.
predown() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
cleanup() {
  [ -n "$SVC_PID" ] && kill "$SVC_PID" 2>/dev/null || true
  predown
  rm -rf "$WORK"
}
trap cleanup EXIT
predown

# Platform credential: hub-core / facilitator / setup script. Mints and funds.
A=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
api()  { curl -fsS "${A[@]}" "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "${A[@]}" "$@"; }
body() { curl -s "${A[@]}" "$@"; }
# Wallet credential: one agent, spends from itself only.
wcode() { local t=$1; shift; curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $t" -H 'content-type: application/json' "$@"; }
wbody() { local t=$1; shift; curl -s -H "Authorization: Bearer $t" -H 'content-type: application/json' "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)"; }

step "chain up + deploy"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" \
  -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break; sleep 1
done
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
echo "  deployed: $(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m['kind']=='token'][0]['address'])")"

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
( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=verify-secret \
    ANVIL_MNEMONIC="$MNEMONIC" DEPLOYMENTS_DIR="$DEPLOYMENTS" KEYSTORE_DIR="$WORK/keystore" \
    POLICY_DIR="$WORK/policies" STORE_PATH="$WORK/store/db.sqlite" PORT="$PORT" \
    POLICY_DEFAULTS_FILE="$SVC/policy-defaults.example.json" \
    bun run src/index.ts ) >"$WORK/svc.log" 2>&1 &
SVC_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
U="http://127.0.0.1:$PORT"

step "criterion 3 - spawn a named, funded wallet"
# Three spawns and the MEDIAN, because a single timing sample measures the host
# as much as the service: this bound has read 277ms and 789ms on the same
# machine minutes apart. Expected p50 under 1s on an idle host; the HARD failure
# is at 5s, which catches a pathological regression without failing on load
# (ruled). A warning instead of a failure was explicitly rejected -
# a check that never fails measures nothing.
TIMES=""
for who in vendor timing1 timing2; do
  START=$(date +%s%N)
  RESULT=$(api -X POST "$U/wallets" -d "{\"agentId\":\"orch:$who\",\"fundVee\":250,\"kind\":\"agent\",\"alias\":\"$who.play\"}")
  [ "$who" = vendor ] && SB_TOKEN=$(echo "$RESULT" | jget "['walletToken']")
  MS=$(( ($(date +%s%N) - START) / 1000000 ))
  TIMES="$TIMES $MS"
  [ "$who" = vendor ] && SPAWN="$RESULT"
done
P50=$(echo $TIMES | tr ' ' '\n' | sort -n | sed -n 2p)
echo "  POST /wallets -> $SPAWN"
echo "  timings:$TIMES ms   p50=${P50}ms"
[ "$P50" -lt 1000 ] && echo "  ok   p50 under the 1s expectation" || echo "  note p50 ${P50}ms is over the 1s expectation (host load?)"
[ "$P50" -lt 5000 ] && echo "  ok   p50 within the 5s hard bound" || { echo "  FAIL p50 ${P50}ms exceeds the 5s hard bound"; FAIL=1; FAILED_CHECKS="$FAILED_CHECKS
    - spawn p50 ${P50}ms exceeds the 5s hard bound"; }
ADDR=$(echo "$SPAWN" | jget "['address']")

check "balance"            "$(api "$U/balance/orch%3Avendor" | jget "['vee']")" "250"
check "resolve canonical"  "$(api "$U/resolve/orch%3Avendor" | jget "['address']")" "$ADDR"
check "resolve alias"      "$(api "$U/resolve/vendor.play"    | jget "['address']")" "$ADDR"
check "reverse"            "$(api "$U/reverse/$ADDR" | jget "['canonical']")" "orch:vendor"
check "reverse aliases"    "$(api "$U/reverse/$ADDR" | jget "['aliases'][0]")" "vendor.play"

step "criterion 3 - a repeat spawn must not mint money"
AGAIN=$(api -X POST "$U/wallets" -d '{"agentId":"orch:vendor","fundVee":250,"kind":"agent","alias":"vendor.play"}')
check "same address"       "$(echo "$AGAIN" | jget "['address']")" "$ADDR"
check "balance unchanged"  "$(api "$U/balance/orch%3Avendor" | jget "['vee']")" "250"
check "no token on repeat" "$(echo "$AGAIN" | python3 -c "import sys,json;print('walletToken' in json.load(sys.stdin))")" "False"

step "criterion 9 - addressing at the service layer"
check "two-colon id"       "$(code -X POST "$U/wallets" -d '{"agentId":"orch:pod1:alice","kind":"agent"}')" "400"
echo "    $(body -X POST "$U/wallets" -d '{"agentId":"orch:pod1:alice","kind":"agent"}')"
check "bare local id"      "$(code -X POST "$U/wallets" -d '{"agentId":"client","kind":"agent"}')" "400"
check "uppercase id"       "$(code -X POST "$U/wallets" -d '{"agentId":"orch:Vendor","kind":"agent"}')" "400"

step "transfer by name, with a memo (wallet credential)"
api -X POST "$U/wallets" -d '{"agentId":"alpha:client","fundVee":10,"kind":"agent","alias":"alpha.play"}' >/dev/null
TX=$(wbody "$SB_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"alpha.play","vee":50,"memo":"for the stream job","intentId":"a1"}')
echo "  POST /sign-transfer -> $TX"
check "sender balance"     "$(api "$U/balance/orch%3Avendor" | jget "['vee']")" "200"
check "recipient balance"  "$(api "$U/balance/alpha.play"           | jget "['vee']")" "60"
HIST=$(api "$U/history/orch%3Avendor?limit=10")
check "history memo"       "$(echo "$HIST" | jget "[0]['memo']")" "for the stream job"
check "history counterparty" "$(echo "$HIST" | jget "[0]['to']")" "alpha:client"

step "criterion 7 - lookalike names coexist"
SC_TOKEN=$(api -X POST "$U/wallets" -d '{"agentId":"orch:scammer","fundVee":5,"kind":"agent"}' | jget "['walletToken']")
api -X POST "$U/aliases" -d '{"agentId":"orch:scammer","alias":"aIpha.play"}' >/dev/null
LOOK=$(api "$U/resolve/aIpha.play"); REAL=$(api "$U/resolve/alpha.play")
echo "  aIpha.play -> $LOOK"
echo "  alpha.play -> $REAL"
[ "$(echo "$LOOK" | jget "['address']")" != "$(echo "$REAL" | jget "['address']")" ] \
  && echo "  ok   different addresses" || { echo "  FAIL same address"; FAIL=1; }
check "lookalike canonical" "$(echo "$LOOK" | jget "['canonical']")" "orch:scammer"

step "criterion 11 - authorisation (C2d)"
VICTIM=$(api -X POST "$U/wallets" -d '{"agentId":"orch:victim","fundVee":500,"kind":"agent","alias":"victim.play"}')
PERSONA=$(api -X POST "$U/wallets" -d '{"agentId":"orch:persona","fundVee":10,"kind":"agent","alias":"persona.play"}')
P_TOKEN=$(echo "$PERSONA" | jget "['walletToken']")
echo "  the drain that was demonstrated before C2d existed:"
check "sign as another wallet" "$(wcode "$P_TOKEN" -X POST "$U/sign-transfer" -d '{"fromAgentId":"orch:victim","to":"persona.play","vee":400}')" "403"
echo "    $(wbody "$P_TOKEN" -X POST "$U/sign-transfer" -d '{"fromAgentId":"orch:victim","to":"persona.play","vee":400}')"
check "victim untouched"       "$(api "$U/balance/orch%3Avictim" | jget "['vee']")" "500"
check "self-mint refused"      "$(wcode "$P_TOKEN" -X POST "$U/wallets" -d '{"agentId":"orch:selfminted","fundVee":9999,"kind":"org"}')" "403"
echo "    $(wbody "$P_TOKEN" -X POST "$U/wallets" -d '{"agentId":"orch:selfminted","fundVee":9999,"kind":"org"}')"
check "read another wallet"    "$(wcode "$P_TOKEN" "$U/balance/orch%3Avictim")" "403"
check "read own wallet"        "$(wcode "$P_TOKEN" "$U/balance/orch%3Apersona")" "200"
check "supply is platform-only" "$(wcode "$P_TOKEN" "$U/supply")" "403"

echo "  caps enforced AT CHAIN-SVC, with no wallet-mcp in the loop:"
# Funded well above max_per_stage on purpose: the wallet must run out of CAP
# before it runs out of MONEY, or the cap test proves only that the chain
# rejects an overdraft. The first version funded 400 and the fifth send failed
# 502 (insufficient balance) instead of 409 - a test that looked like a cap
# failure and was not.
CAP=$(api -X POST "$U/wallets" -d '{"agentId":"orch:capcheck","fundVee":1000,"kind":"agent","alias":"capcheck.play"}')
C_TOKEN=$(echo "$CAP" | jget "['walletToken']")
check "max_per_tx 100, send 300" "$(wcode "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":300}')" "409"
echo "    $(wbody "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":300}')"
check "balance untouched"        "$(api "$U/balance/orch%3Acapcheck" | jget "['vee']")" "1000"
check "denied counterparty"      "$(wcode "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"treasury.play","vee":1}')" "409"
echo "    $(wbody "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"treasury.play","vee":1}')"

# Criterion 4's exact arithmetic: 50 + 4x100 = 450, under max_per_stage 500;
# the next 100 would reach 550 and is refused.
echo "  stage cap (max_per_stage 500), platform POST /stage drives the stage:"
api -X POST "$U/stage" -d '{"stage":"s1"}' >/dev/null
check "opening send of 50"       "$(wcode "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":50}')" "200"
for i in 1 2 3 4; do
  R=$(wcode "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":100}')
  echo "    send $i of 100 -> $R  (stage total $((50 + i * 100)))"
  [ "$R" != 200 ] && { echo "  FAIL send $i should have been accepted"; FAIL=1; FAILED_CHECKS="$FAILED_CHECKS
    - stage send $i: got '$R' want '200'"; }
done
check "next 100 trips the cap"   "$(wcode "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":100}')" "409"
echo "    $(wbody "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":100}')"
api -X POST "$U/stage" -d '{"stage":"s2"}' >/dev/null
check "new stage resets the cap"  "$(wcode "$C_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"persona.play","vee":1}')" "200"

echo "  rotation revokes the old credential:"
NEW=$(api -X POST "$U/wallets/orch%3Apersona/rotate" | jget "['walletToken']")
check "old token rejected"       "$(wcode "$P_TOKEN" "$U/balance/orch%3Apersona")" "401"
check "new token works"          "$(wcode "$NEW" "$U/balance/orch%3Apersona")" "200"

step "criterion 8 - retirement"
# RETIREMENT, NOT A FREEZE, as of v0.8.0 - and these three rows were asserting
# the old shape against the new service, which is why they had been red since
# that release with nobody to see it.
#
#   the reply       {"frozen": true}     ->  {"retired": true}
#   a retired spend  409 wallet_frozen   ->  404 wallet_retired (a retired
#                                            wallet is GONE, not busy)
#   the policy file  carried `frozen`    ->  carries no such field, and a wallet
#                                            spawned without rules has no file
#                                            at all. The store's own table is
#                                            the record now, so the row that
#                                            read the file is replaced by the
#                                            one that asks the service.
check "delete"             "$(api -X DELETE "$U/wallets/orch%3Ascammer" | jget "['retired']")" "True"
check "spend refused"      "$(wcode "$SC_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"alpha.play","vee":1,"intentId":"z1"}')" "404"
echo "    $(wbody "$SC_TOKEN" -X POST "$U/sign-transfer" -d '{"to":"alpha.play","vee":1,"intentId":"z2"}')"
check "alias stops resolving" "$(code "$U/resolve/aIpha.play")" "404"
check "canonical survives"    "$(code "$U/resolve/orch%3Ascammer")" "200"
check "the wallet row says retired" "$(api "$U/wallets/orch%3Ascammer" | jget "['retired']")" "True"
check "delete is idempotent"  "$(api -X DELETE "$U/wallets/orch%3Ascammer" | jget "['retired']")" "True"

step "verdict"

if [ "$FAIL" = 0 ]; then
  echo "PASS: criteria 3, 7, 8, 11 and the chain-svc half of 9"
else
  # Name the failing checks here rather than only inline, so a load flake in CI
  # or on a busy host is diagnosable from the tail of the log alone.
  echo "FAIL. Checks that failed:$FAILED_CHECKS"
  exit 1
fi
