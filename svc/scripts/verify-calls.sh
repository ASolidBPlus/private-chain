#!/usr/bin/env bash
# §8.9. Runnable evidence for the generic call op, against a REAL chain.
#
# Everything below is reachable from a unit test except the things that are the
# point: that `forge script --broadcast` and the service agree about where the
# Converter is, that viem encodes a call the contract actually accepts, that a
# whole-unit amount arrives as the right number of smallest units, and that a
# revert comes back as a revert rather than as a receipt nobody read. Needs
# Docker and Foundry, so it cannot run in this repo's CI - run it by hand and
# paste the output:
#   ./svc/scripts/verify-calls.sh
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
NAME=${NAME:-agent-chain-anvil-calls-verify}
VOLUME=${VOLUME:-agent-chain-state-calls-verify}
RPC=${RPC:-http://127.0.0.1:8545}
PORT=${PORT:-7003}
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

A=(-H "Authorization: Bearer $TOKEN" -H 'content-type: application/json')
api()  { curl -fsS "${A[@]}" "$@"; }
body() { curl -s "${A[@]}" "$@"; }
wbody() { local t=$1; shift; curl -s -H "Authorization: Bearer $t" -H 'content-type: application/json' "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(d$1)"; }

step "chain up + deploy two tokens, names and a converter"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" \
  -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break; sleep 1
done
rm -f "$DEPLOYMENTS/local.json"
# THE SHIPPED EXAMPLE, not a manifest written for this script. A smoke that
# deploys its own hand-built shape proves that shape works and says nothing
# about the one an operator would actually use.
cp "$DEPLOYMENTS/examples/two-tokens.json" "$DEPLOYMENTS/manifest.json"
# DERIVED FROM THE MNEMONIC, not scraped from `docker logs`. The image runs
# anvil with -q precisely so the banner's private keys never reach the log, so
# the scrape the older verify scripts still use finds nothing and the deploy
# fails with an unhelpful envUint parse error. Deriving it also checks the thing
# that matters: that this mnemonic really does control account 0 on this chain.
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

PLAY=$(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m.get('key')=='play'][0]['address'])")
GOLD=$(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m.get('key')=='gold'][0]['address'])")
CONV=$(python3 -c "import json;print([m for m in json.load(open('$DEPLOYMENTS/local.json'))['modules'] if m['kind']=='converter'][0]['address'])")
echo "  play=$PLAY gold=$GOLD converter=$CONV"

step "the allowlist"
mkdir -p "$WORK/policies"
# §2's example, rewritten at v0.8.0. NO `admin` ENTRIES: the field is refused at
# load now, and `admin-call` reaches any function of any registered contract
# with or without an entry - so `setPair`, `setPaused` and `setFrozen` are
# simply absent here and the smoke calls them anyway.
#
# `kinds` is written on the entries that MEAN a restriction and omitted where
# any kind may call. Absent means any kind; a written `kinds: []` is refused.
#
# No `perTxCap`: retired at the multi-token increment.
cat > "$WORK/policies/calls.json" <<'CALLS_JSON'
{
  "schema": 1,
  "calls": [
    { "contract": "converter", "function": "convert",
      "kinds": ["org", "agent"],
      "amount": { "arg": 2, "token": { "arg": 0 } },
      "intentArg": 3,
      "maxPerStage": 20,
      "addressArgs": { "0": "token", "1": "token" } },
    { "contract": "converter", "function": "quote", "read": true, "kinds": ["org", "agent", "burner"],
      "addressArgs": { "0": "token", "1": "token" } },
    { "contract": "converter", "function": "pair",  "read": true, "kinds": ["org", "agent", "burner"],
      "addressArgs": { "0": "token", "1": "token" } },
    { "contract": "play", "function": "frozen", "read": true,
      "addressArgs": { "0": "name" } },
    { "contract": "gold", "function": "frozen", "read": true,
      "addressArgs": { "0": "name" } }
  ]
}
CALLS_JSON

( cd "$SVC" && RPC_URL="$RPC" CHAIN_SVC_TOKEN="$TOKEN" KEYSTORE_SECRET=verify-secret \
    ANVIL_MNEMONIC="$MNEMONIC" DEPLOYMENTS_DIR="$DEPLOYMENTS" KEYSTORE_DIR="$WORK/keystore" \
    POLICY_DIR="$WORK/policies" STORE_PATH="$WORK/store/db.sqlite" PORT="$PORT" \
    bun run src/index.ts ) >"$WORK/svc.log" 2>&1 &
SVC_PID=$!
for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25
done
BASE="http://127.0.0.1:$PORT"

step "the registry reports the converter and both tokens"
check "contracts" \
  "$(body "$BASE/modules" | python3 -c "import sys,json;print(','.join(c['key'] for c in json.load(sys.stdin)['contracts']))")" \
  "play,gold,names,converter"

step "spawn an org wallet with 100 PLAY, and a burner"
ORG=$(api -X POST "$BASE/wallets" -d '{"agentId":"orch:org","kind":"org","fundVee":"100"}' | jget "['walletToken']")
BURNER=$(api -X POST "$BASE/wallets" -d '{"agentId":"orch:burn","kind":"burner","fundVee":"10"}' | jget "['walletToken']")
# A NAMED DESTINATION for the freeze section's sends. `orch:burn` is a BURNER and
# registers no name by design, so a send to it fails at resolution with
# `unknown_name` - which looks exactly like a freeze refusal if you are only
# checking that the send failed. Cost one red smoke run to notice.
api -X POST "$BASE/wallets" -d '{"agentId":"orch:dest","kind":"agent"}' >/dev/null
check "org balance before" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "100"

step "the menu a persona reads"
check "org sees convert" \
  "$(wbody "$ORG" "$BASE/calls" | python3 -c "import sys,json;print(any(c['function']=='convert' for c in json.load(sys.stdin)['calls']))")" \
  "True"
check "burner does not" \
  "$(wbody "$BURNER" "$BASE/calls" | python3 -c "import sys,json;print(any(c['function']=='convert' for c in json.load(sys.stdin)['calls']))")" \
  "False"

step "read a view, free and signing nothing"
# THE RATE THE MANIFEST DECLARED, read back off the chain. 0.75 at 18 places.
check "pair(play,gold).rate" \
  "$(wbody "$ORG" -X POST "$BASE/read" -d '{"contract":"converter","function":"pair","args":[{"token":"play"},{"token":"gold"}]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result'].get('rate','NOT-KEYED-BY-NAME'))")" \
  "750000000000000000"

step "convert 40 PLAY to GOLD"
CALL=$(wbody "$ORG" -X POST "$BASE/call" \
  -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"40"],"intentId":"smoke-1"}')
check "call returned a tx" "$(echo "$CALL" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"
# THE WHOLE-UNITS QUESTION, answered against a real chain: "40" must leave 60,
# not 100 and not 0. A scale error anywhere in the path shows up here and
# nowhere in a unit test that asserts the reply.
check "org balance after" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "60"

step "a replay of the same call sends nothing"
AGAIN=$(wbody "$ORG" -X POST "$BASE/call" \
  -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"40"],"intentId":"smoke-1"}')
check "same txHash" \
  "$(python3 -c "import json,sys;a=json.loads('''$CALL''');b=json.loads('''$AGAIN''');print(a['txHash']==b['txHash'])")" \
  "True"
check "balance unchanged" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "60"

step "the same id with different arguments is refused"
check "invalid_request" \
  "$(wbody "$ORG" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"41"],"intentId":"smoke-1"}' | jget "['error']")" \
  "invalid_request"

step "a burner may not convert"
check "function_not_allowed" \
  "$(wbody "$BURNER" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"1"],"intentId":"smoke-b"}' | jget "['error']")" \
  "function_not_allowed"

step "a wallet may not pass a raw address"
check "bad_args" \
  "$(wbody "$ORG" -X POST "$BASE/call" -d "{\"contract\":\"converter\",\"function\":\"convert\",\"args\":[\"$PLAY\",{\"token\":\"gold\"},\"1\"],\"intentId\":\"smoke-raw\"}" | jget "['error']")" \
  "bad_args"

step "admin-call: the hub sets a rate"
OK=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPair\",\"args\":[\"$GOLD\",\"$PLAY\",\"1000000000000000000\"],\"intentId\":\"smoke-rate\"}")
check "admin-call returned a tx" "$(echo "$OK" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"
check "the new rate is on chain" \
  "$(wbody "$ORG" -X POST "$BASE/read" -d '{"contract":"converter","function":"pair","args":[{"token":"gold"},{"token":"play"}]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['result'].get('rate','NOT-KEYED-BY-NAME'))")" \
  "1000000000000000000"

step "admin-call: the loop guard refuses a rate that mints value round the loop"
# 1.5e18 gold->play against the existing 0.75e18 play->gold mints value round
# the loop, and the Converter refuses it. The REASON must be in chain-svc's log
# and NOT in the reply.
REV=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPair\",\"args\":[\"$GOLD\",\"$PLAY\",\"1500000000000000000\"],\"intentId\":\"smoke-admin\"}")
check "revert" "$(echo "$REV" | jget "['error']")" "revert"
check "no reason in the reply" "$(echo "$REV" | grep -ci 'loop' || true)" "0"
check "reason in the log" "$(grep -c 'setPair on converter reverted' "$WORK/svc.log" || true)" "1"

step "a wallet's call on a PAUSED pair is a revert, with no reason"
# THE BLOCKING DEFECT'S OWN CASE, on the persona-facing op. The rejection
# happens at GAS ESTIMATION inside prepareTransactionRequest - ZERO_FEES sets
# fees, not gas - so it never reaches a receipt, and under asChainError it came
# back as 502 chain_error carrying the revert reason. No unit test reaches it:
# a fake signer does not simulate.
body -X POST "$BASE/admin-call" \
  -d "{\"contract\":\"converter\",\"function\":\"setPaused\",\"args\":[\"$PLAY\",\"$GOLD\",true],\"intentId\":\"smoke-pause\"}" >/dev/null
PAUSED=$(wbody "$ORG" -X POST "$BASE/call" \
  -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"1"],"intentId":"smoke-paused"}')
check "revert, not chain_error" "$(echo "$PAUSED" | jget "['error']")" "revert"
check "no reason in the reply" "$(echo "$PAUSED" | grep -ci 'paus' || true)" "0"
check "the balance is untouched" "$(wbody "$ORG" "$BASE/balance/orch:org" | jget "['vee']")" "60"

step "a wallet credential may not admin-call"
check "wrong_scope" \
  "$(wbody "$ORG" -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPair\",\"args\":[\"$GOLD\",\"$PLAY\",\"1\"],\"intentId\":\"smoke-x\"}" | jget "['error']")" \
  "wrong_scope"

step "the event feed carries the call, with the names the caller used"
# A CHECK THAT COMPARES A VALUE TO ITSELF IS NOT A CHECK - the first draft of
# this one grepped the same file on both sides and could not fail.
#
# chain-svc has no /events endpoint: events go to the OUTBOX and are delivered
# to hub-core, which does not exist yet. So the outbox is read where it lives,
# which is also the honest thing to assert - the feed is what an operator
# will receive, not what a log line says.
sleep 2
check "agent.call carries the caller's words, not addresses" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [r[0] for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
calls = [json.loads(p) for p in rows]
calls = [c for c in calls if c.get("kind") == "agent.call"]
if not calls:
    print("no-agent.call-event")
else:
    c = calls[0]
    problems = []
    if c.get("contract") != "converter": problems.append("contract=%s" % c.get("contract"))
    if c.get("function") != "convert": problems.append("function=%s" % c.get("function"))
    if c.get("args") != [{"token": "play"}, {"token": "gold"}, "40"]: problems.append("args=%s" % c.get("args"))
    if c.get("status") != "ok": problems.append("status=%s" % c.get("status"))
    if c.get("amount") != {"value": "40", "token": "play"}: problems.append("amount=%s" % c.get("amount"))
    # THE RULE THE EVENT EXISTS TO KEEP: names and keys, never addresses.
    if "$PLAY".lower() in json.dumps(c).lower(): problems.append("leaks the play address")
    print("True" if not problems else ", ".join(problems))
PYEOF
)" \
  "True"

step "hub.call is emitted for the operator's action too"
# THE SUCCESSFUL one; the refused case is below. Both are ruled and
# implemented: a call that was never mined emits status "refused" with a null
# hash, because a null hash under "reverted" would lie about what happened and
# silence would hide the operator's refused action.
check "hub.call recorded" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
hub = [r for r in rows if r.get("kind") == "hub.call"]
if not hub:
    print("no-hub.call-event")
else:
    h = hub[0]
    print("%s/%s/%s" % (h.get("contract"), h.get("function"), h.get("status")))
PYEOF
)" \
  "converter/setPair/ok"

step "the hub's REFUSED action reaches the feed too"
# Ruled: a simulation-refused admin-call emits hub.call with a null hash and
# status "refused" - a third value beside ok and reverted. Nothing was mined, so
# a null hash under "reverted" would lie; silence would hide the hub trying
# something the chain would not accept.
check "hub.call refused" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
hub = [r for r in rows if r.get("kind") == "hub.call" and r.get("status") == "refused"]
if not hub:
    print("no-refused-event")
else:
    print("%s/%s" % (hub[0].get("function"), hub[0].get("txHash")))
PYEOF
)" \
  "setPair/None"

step "the allowlist is the persona surface; the platform is the game"
# `setPaused` has NO ENTRY in this file at all - the `admin` field is gone and
# admin-call reaches any function of any registered contract.
#
# IT IS ALSO THE PRECONDITION for everything below: the paused-pair step above
# left play->gold paused, and the converts that follow need it lifted. So this
# check is load-bearing rather than decorative - if admin-call could not reach
# an un-allowlisted function, every check after it would fail too.
UNPAUSE=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"converter\",\"function\":\"setPaused\",\"args\":[\"$PLAY\",\"$GOLD\",false],\"intentId\":\"open-5\"}")
check "admin-call reaches a function with no entry" "$(echo "$UNPAUSE" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"

step "policy is opt-in: a wallet nobody wrote rules for is unbounded"
# §5.4. THE WHOLE INCREMENT IN ONE SEQUENCE. No POLICY_DEFAULTS_FILE is set, so
# there are no kind defaults; this wallet is spawned without `policy`, so there
# is no file either. Nothing has been written about it anywhere.
OPEN=$(api -X POST "$BASE/wallets" -d '{"agentId":"orch:open","kind":"org","fund":[{"token":"play","amount":"5000"}]}' | jget "['walletToken']")
check "no rules anywhere" "$(api "$BASE/wallets/orch:open" | jget "['policySource']")" "none"

# 2000 in ONE call. Under the old rule this wallet had the agent kind defaults
# baked into a file at spawn and this would have refused over_max_per_tx.
BIG=$(wbody "$OPEN" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"2000"],"intentId":"open-1"}')
check "an unbounded wallet converts 2000" "$(echo "$BIG" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"

step "a written bound binds, and clearing it unbinds"
api -X PATCH "$BASE/wallets/orch:open/policy" -d '{"max_per_tx":"100"}' >/dev/null
check "now it has its own rules" "$(api "$BASE/wallets/orch:open" | jget "['policySource']")" "wallet"
CAPPED=$(wbody "$OPEN" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"2000"],"intentId":"open-2"}')
check "the same call now refuses" "$(echo "$CAPPED" | jget "['error']")" "over_max_per_tx"

api -X PATCH "$BASE/wallets/orch:open/policy" -d '{"clear":true}' >/dev/null
check "cleared, and the source says so" "$(api "$BASE/wallets/orch:open" | jget "['policySource']")" "none"
AGAIN=$(wbody "$OPEN" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"2000"],"intentId":"open-3"}')
check "and it is unbounded again" "$(echo "$AGAIN" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"

step "fail closed on garbage, open on silence"
# A cap that is WRITTEN and unreadable. Silence is no bound; a typo is not
# silence, and this is the one direction that still refuses.
python3 - <<PYEOF
import json, pathlib
p = pathlib.Path("$WORK/policies/orch%3Aopen.json")
p.write_text(json.dumps({"agentId": "orch:open", "caps": {"play": {"max_per_tx": "unlimted"}}}))
PYEOF
TYPO=$(wbody "$OPEN" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"1"],"intentId":"open-4"}')
check "a typo'd cap refuses" "$(echo "$TYPO" | jget "['error']")" "no_cap_set"
# GARBAGE IS SCOPED TO THE FIELD IT TOUCHES (ruled). The detail names the FIELD
# and the token, not the file: the document still reads, and the refusal happens
# at the point of use for that token alone. Bricking a two-token wallet over one
# mistyped field would be the service deciding more than it was told.
#
# This check asserted the opposite until v0.8.0 - 'unreadable' in the detail -
# and it was right when it was written: `isTokenCaps` checked VALUES, so one bad
# cap failed `isPolicy` and the whole file came back as the marker. Relaxing that
# predicate to SHAPE ONLY moved this answer, and the smoke was the only thing
# that noticed, because it is the only instrument that reads the detail a
# persona actually receives.
check "and says WHICH field, not that the file is bad" "$(echo "$TYPO" | python3 -c "import sys,json;print(json.load(sys.stdin).get('detail',''))")" "max_per_tx for play is not a usable amount"

# THE OTHER SIDE OF THE SAME RULING, so the row above cannot be read as "nothing
# is ever file-level". A document whose SHAPE is wrong - not a value in it - is
# unreadable, and every token refuses with the fixed sentence.
python3 - <<PYEOF
import pathlib
pathlib.Path("$WORK/policies/orch%3Aopen.json").write_text('{"caps": []}')
PYEOF
SHAPE=$(wbody "$OPEN" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"1"],"intentId":"open-5"}')
check "a wrong-SHAPE document is file-level" "$(echo "$SHAPE" | jget "['error']")" "no_cap_set"
check "and the detail is the fixed sentence" "$(echo "$SHAPE" | jget "['detail']")" "policy file unreadable"
check "without quoting the file back" "$(echo "$TYPO" | grep -ci 'unlimted' || true)" "0"
rm -f "$WORK/policies/orch%3Aopen.json"

step "the rail's rules hold for the platform too"
# Push-only is a property of the
# money, not a permission, so it is refused at REQUEST time for the platform
# exactly as it is refused at LOAD for an entry.
OPEN_ADDR=$(api "$BASE/wallets/orch:open" | jget "['address']")
APPROVE=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"play\",\"function\":\"approve\",\"args\":[\"$OPEN_ADDR\",\"1\"],\"intentId\":\"open-6\"}")
check "approve is refused whoever asks" "$(echo "$APPROVE" | jget "['error']")" "invalid_request"
check "and says why" "$(echo "$APPROVE" | python3 -c "import sys,json;print('push-only' in str(json.load(sys.stdin).get('detail','')))")" "True"

step "retirement, not a freeze"
api -X DELETE "$BASE/wallets/orch:open" >/dev/null
check "the wallet reports retired" "$(api "$BASE/wallets/orch:open" | jget "['retired']")" "True"
GONE=$(wbody "$OPEN" -X POST "$BASE/sign-transfer" -d '{"to":"orch:dest","amount":"1","intentId":"open-7"}')
check "a retired wallet cannot spend" "$(echo "$GONE" | jget "['error']")" "wallet_retired"

step "the on-chain send freeze"
# §5.3. The freeze is a CONTRACT primitive operated by admin-call, so every
# assertion here goes through the ordinary ops - no new endpoint exists to test.
#
# The wallet's ADDRESS, not its name: `setFrozen` is an admin entry and admin
# entries pass raw addresses (an operator writing a hub script has the address;
# the name resolution is for personas). `frozen` is the persona-facing READ and
# takes a name, which is why its entry carries addressArgs and setFrozen's does
# not - the asymmetry is the two audiences, not an oversight.
ORG_ADDR=$(api "$BASE/wallets/orch:org" | jget "['address']")
check "the org has an address to freeze" "$(printf %s "$ORG_ADDR" | head -c2)" "0x"

FRZ=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"play\",\"function\":\"setFrozen\",\"args\":[\"$ORG_ADDR\",true],\"intentId\":\"smoke-freeze\"}")
check "setFrozen returned a tx" "$(echo "$FRZ" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"

# The persona-facing READ, by NAME, answering the state the operator just set.
check "read frozen(name) is true" \
  "$(wbody "$ORG" -X POST "$BASE/read" -d '{"contract":"play","function":"frozen","args":[{"name":"orch:org"}]}' | jget "['result']")" \
  "True"

# A SIGNED SEND FROM THE FROZEN WALLET. This is the consequence §3 says is
# stated and not hidden: it comes back as the existing `revert` refusal, not as
# `frozen` with a reason, because chain-svc does not read the freeze before
# signing. The rejection happens at gas estimation, like the paused-pair case.
SEND=$(wbody "$ORG" -X POST "$BASE/sign-transfer" -d '{"to":"orch:dest","amount":"1","intentId":"smoke-frozen-send"}')
# PRINTED, not only asserted. The leak this section found was invisible until
# the reply was shown: the assertions said "not a revert" and "no reason", and
# the second was grepping for a string that could never appear. A verbatim line
# costs nothing on a green run and is the thing that shows a reply changing
# shape underneath assertions that still pass.
echo "    send reply: $SEND"
check "a frozen wallet's send is a revert" "$(echo "$SEND" | jget "['error']")" "revert"
# THE REASON MUST NOT CROSS. Greps for the DECODED name only ('AccountFrozen')
# would pass on a reply carrying the raw selector and its hex payload, which is
# what viem produces for a custom error - the contract's internal state talking,
# in a form that looks like noise rather than like a leak.
check "no revert data in the reply" "$(echo "$SEND" | grep -ci 'custom error\|0x[0-9a-f]\{16,\}' || true)" "0"

# A BURN IS A SPEND: the Converter takes the source token out of supply, so a
# frozen account cannot convert either. This is the contract-to-contract bypass
# the primitive exists to close, and it is the reason the hook is in `_update`
# rather than in `transfer`.
CONV=$(wbody "$ORG" -X POST "$BASE/call" -d '{"contract":"converter","function":"convert","args":[{"token":"play"},{"token":"gold"},"1"],"intentId":"smoke-frozen-convert"}')
check "a frozen wallet's convert is a revert" "$(echo "$CONV" | jget "['error']")" "revert"

# RECEIVING IS UNAFFECTED. A freeze bars SENDING and nothing else, so the
# operator can still fund a frozen wallet - which is the first thing an operator
# wants to do to one. (`mint`'s own exemption, from == address(0), is asserted in
# Token.t.sol; there is no mint entry in this allowlist.)
FUND=$(body -X POST "$BASE/fund" -d '{"to":"orch:org","amount":"5","reason":"while frozen","intentId":"smoke-frozen-fund"}')
check "a frozen wallet still receives" "$(echo "$FUND" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"

# THE FEED CARRIES BOTH: the operator's action as hub.call, and the contract's
# own event through the generic chain.event decoding already shipped. No new
# event kind.
# WAIT FOR THE POLLER, bounded, rather than sleeping a guessed interval.
# `hub.call` is enqueued synchronously by the treasury; a `chain.event` comes
# from the event tail's 1s poll, so checking the outbox immediately tests the
# clock rather than the decoding. Cost one red run: hub.call True, Frozen False.
for _ in $(seq 1 20); do
  FOUND=$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM outbox")]
print(any(r.get("kind") == "chain.event" and r.get("event") == "Frozen" for r in rows))
PYEOF
)
  [ "$FOUND" = "True" ] && break
  sleep 0.5
done

check "the feed carries hub.call setFrozen and the Frozen event" \
  "$(python3 - <<PYEOF
import json, sqlite3
db = sqlite3.connect("$WORK/store/db.sqlite")
rows = [json.loads(r[0]) for r in db.execute("SELECT payload FROM outbox ORDER BY id")]
hub = any(r.get("kind") == "hub.call" and r.get("function") == "setFrozen" for r in rows)
ev = any(r.get("kind") == "chain.event" and r.get("event") == "Frozen" for r in rows)
print("%s/%s" % (hub, ev))
PYEOF
)" \
  "True/True"

# UNFREEZE RESTORES IT. Compare to a value on both sides of the same operation,
# or "the send failed" proves nothing about the freeze being why.
UNF=$(body -X POST "$BASE/admin-call" -d "{\"contract\":\"play\",\"function\":\"setFrozen\",\"args\":[\"$ORG_ADDR\",false],\"intentId\":\"smoke-unfreeze\"}")
check "setFrozen(false) returned a tx" "$(echo "$UNF" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"
check "read frozen(name) is false again" \
  "$(wbody "$ORG" -X POST "$BASE/read" -d '{"contract":"play","function":"frozen","args":[{"name":"orch:org"}]}' | jget "['result']")" \
  "False"
AFTER=$(wbody "$ORG" -X POST "$BASE/sign-transfer" -d '{"to":"orch:dest","amount":"1","intentId":"smoke-thawed-send"}')
check "the send succeeds once thawed" "$(echo "$AFTER" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get('txHash','')).startswith('0x'))")" "True"

printf '\n'
if [ "$FAIL" = 0 ]; then
  echo "ALL CHECKS PASSED"
else
  echo "FAILURES:$FAILED_CHECKS"
  echo
  echo "--- chain-svc log ---"
  tail -40 "$WORK/svc.log"
fi
exit "$FAIL"
