#!/usr/bin/env bash
# Runnable evidence for spec S8 criterion 2, Anvil half: a cold start deploys,
# a second run is idempotent, and balances survive `docker restart`.
#
# Not a unit test - it needs a Docker daemon, so it cannot run in the repo's CI.
# Run it by hand and paste the output into the PR:  ./docker/verify-chain.sh
set -euo pipefail

IMAGE=${IMAGE:-agent-chain-anvil:dev}
NAME=${NAME:-agent-chain-anvil-verify}
VOLUME=${VOLUME:-agent-chain-state-verify}
RPC=${RPC:-http://127.0.0.1:8545}
# The canonical, publicly-published Foundry/Hardhat test phrase, for an ephemeral
# container destroyed on exit. Deliberately a WELL-KNOWN value so nobody mistakes
# it for a secret: the real ANVIL_MNEMONIC lives in the hub .env (spec S10) and
# is generated with `cast wallet new-mnemonic`.
MNEMONIC=${ANVIL_MNEMONIC:-"test test test test test test test test test test test junk"}
# RESOLVED BEFORE ANY `cd`, both of them. `$0` is relative when the script is
# invoked as `./docker/verify-chain.sh` - which is what the header tells you to
# do - and the deploy section cd's into contracts/, after which
# `$(dirname "$0")` names a directory that does not exist. The sibling script it
# needs was then unfindable, and only in the one invocation the header
# documents.
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS_DIR="$(cd "$HERE/../contracts" && pwd)"

# FINDING 29: THIS SCRIPT STAGES INTO A TEMP DIRECTORY AND NEVER INTO THE REPO.
#
# It used to `rm -f deployments/local.json`, overwrite `deployments/manifest.json`
# with its own, and move the result about - so running the verification destroyed
# the manifest of whatever the developer had deployed, and left THIS script's
# two-module manifest behind as if it were theirs. A verification that edits the
# tree it is verifying is one nobody can run twice with confidence.
#
# `DEPLOYMENTS_DIR` is already a parameter of Deploy.s.sol's `run()`, so pointing
# it at a staging directory needs no change to the contracts - only for this
# script to stop assuming `../deployments`.
STAGE="$(mktemp -d)"
export DEPLOYMENTS_DIR="$STAGE"

step() { printf '\n=== %s\n' "$1"; }
cleanup() {
  docker rm -f "$NAME" "$NAME-noq" "$NAME-argv" "$NAME-argv-control" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  # The staging directory, which exists only for this run. The container and the
  # volume above are this script's own by name; the repo's deployments/ is no
  # longer touched at all, which is what finding 29 was about.
  [ -n "${STAGE:-}" ] && rm -rf "$STAGE"
}
trap cleanup EXIT

# THE IMAGE MUST EXIST FIRST. Without it the two leading checks - "refuses
# without a mnemonic", "refuses a truncated phrase" - PASS VACUOUSLY: `docker
# run` fails because there is nothing to run, and a check that asserts a
# non-zero exit cannot tell that from the refusal it is testing. The first two
# rows of this script would report a working guard on an image that does not
# exist.
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "FAIL: no image $IMAGE - build it first:"
  echo "  docker build -t $IMAGE docker -f docker/anvil.Dockerfile"
  exit 1
}

cleanup

step "the entrypoint refuses to start without a mnemonic"
if docker run --rm "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: started with ANVIL_MNEMONIC unset"; exit 1
fi
docker run --rm "$IMAGE" 2>&1 | head -1 || true

step "the entrypoint refuses a truncated phrase (the .env quoting mistake)"
if docker run --rm -e ANVIL_MNEMONIC="test test test" "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: started with a 3-word ANVIL_MNEMONIC"; exit 1
fi
docker run --rm -e ANVIL_MNEMONIC="test test test" "$IMAGE" 2>&1 | head -1 || true

step "cold start"
docker volume create "$VOLUME" >/dev/null
docker run -d --name "$NAME" -e ANVIL_MNEMONIC="$MNEMONIC" \
  -v "$VOLUME:/state" -p 127.0.0.1:8545:8545 "$IMAGE" >/dev/null

for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
echo "health: $(docker inspect -f '{{.State.Health.Status}}' "$NAME")  (the S2 healthcheck: cast block-number)"
echo "chain-id: $(cast chain-id --rpc-url "$RPC")"

# Account 0 is the deployer AND the treasury (spec S2). Derived from the
# mnemonic, the same way chain-svc derives it - NOT scraped from the node's
# startup banner, which is both a secret in `docker logs` and a dependency on
# output the node no longer produces now that it runs with -q. Deriving it also
# makes this script check the thing that matters: that the mnemonic really does
# control account 0 on the running chain.
KEY=$(cast wallet private-key --mnemonic "$MNEMONIC")
export DEPLOYER_PRIVATE_KEY="$KEY"
echo "treasury: $(cast wallet address --private-key "$KEY")"

step "deploy"
cd "$CONTRACTS_DIR"
# The manifest this script's deployment declares. chain-deploy requires one and
# has no built-in default, so a script that deploys must say what it deploys --
# and the TLD here is the suffix every name below is registered under. Without
# this the deploy refuses and every check afterwards is testing nothing.
cat > "$STAGE/manifest.json" <<'MANIFEST_JSON'
{
  "schema": 1,
  "modules": [
    { "kind": "token", "key": "play", "name": "Play Token", "symbol": "PLAY", "initialSupply": "1000000" },
    { "kind": "names", "tld": "play" }
  ]
}
MANIFEST_JSON
# ALLOW_FRESH_DEPLOY and the PROMOTION are what the container's one-shot does;
# this script drives `forge script` directly, so it has to do both itself. The
# script writes local.json.pending and never local.json - a simulation must not
# be able to hand the rest of the system a manifest of contracts nobody mined.
ALLOW_FRESH_DEPLOY=1 forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1 | grep -E "Deploy:|Compiler run|ONCHAIN EXECUTION|Error" | head -10
[ -f "$STAGE/local.json" ] && { echo "FAIL: the script wrote local.json; promotion is the caller's"; exit 1; }
mv "$STAGE/local.json.pending" "$STAGE/local.json"
cat "$STAGE/local.json"

VEE=$(python3 -c "import json;print([m for m in json.load(open('$STAGE/local.json'))['modules'] if m['kind']=='token'][0]['address'])")
REG=$(python3 -c "import json;print([m for m in json.load(open('$STAGE/local.json'))['modules'] if m['kind']=='names'][0]['address'])")
TREASURY=$(cast wallet address --private-key "$KEY")

supply_before=$(cast call "$VEE" "totalSupply()(uint256)" --rpc-url "$RPC")
balance_before=$(cast call "$VEE" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC")
resolve_before=$(cast call "$REG" "resolve(string)(address)" "treasury.play" --rpc-url "$RPC")
echo "totalSupply: $supply_before"
echo "treasury balance: $balance_before"
echo "resolve(treasury.play): $resolve_before"

step "second run is idempotent (must NOT redeploy)"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast 2>&1 | grep -E "Deploy:|nothing to do" | head -5
# THE SKIP PATH WRITES NOTHING, which is the direct statement of "deployed
# nothing new" - stronger than comparing addresses, because CREATE2 with the
# same salt and init code gives the same address either way.
[ -f "$STAGE/local.json.pending" ] && { echo "FAIL: the second run wrote a manifest"; exit 1; }
VEE2=$(python3 -c "import json;print([m for m in json.load(open('$STAGE/local.json'))['modules'] if m['kind']=='token'][0]['address'])")
[ "$VEE" = "$VEE2" ] || { echo "FAIL: token address changed: $VEE -> $VEE2"; exit 1; }
echo "token address unchanged: $VEE2"

step "the OTHER idempotence direction: local.json gone, chain intact (must REFUSE)"
# ./deployments is a bind mount and chain-state is a named volume, so either can
# outlive the other. Without this guard the script below deploys a SECOND token
# and writes it over the file, orphaning the first with every balance in it.
mv "$STAGE/local.json" "$STAGE/local.json.hidden"
# WITHOUT the flag, which is the whole point: the one-shot sets it only on a
# volume that has never held a deployment, and this volume has.
if forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast >/tmp/redeploy.log 2>&1; then
  mv "$STAGE/local.json.hidden" "$STAGE/local.json"
  echo "FAIL: redeployed with no local.json - the live token has been orphaned"; exit 1
fi
# ASSERTED, NOT GREPPED FOR ITS EXIT STATUS. Under `set -e` a grep that finds
# nothing kills the script with no FAIL line at all - so a CHANGED REFUSAL
# MESSAGE looks identical to a crash, on correct behaviour. Capture, test, and
# say which.
refusal=$(grep -oE "Deploy: refusing to deploy with no [^\"]*" /tmp/redeploy.log | head -1 || true)
if [ -z "$refusal" ]; then
  echo "FAIL: it refused, but not with the no-manifest message. What it said:"
  grep -oE "Deploy: [^\"]*" /tmp/redeploy.log | head -3
  exit 1
fi
echo "$refusal"
[ -f "$STAGE/local.json" ] && { echo "FAIL: it wrote a local.json anyway"; exit 1; }
[ -f "$STAGE/local.json.pending" ] && { echo "FAIL: it wrote a pending manifest anyway"; exit 1; }
echo "refused, and wrote nothing"
mv "$STAGE/local.json.hidden" "$STAGE/local.json"

step "a run WITHOUT --broadcast leaves the manifest alone (finding 6)"
# The reviewer's probe. `forge script` simulates when --broadcast is absent,
# computing real CREATE2 addresses for contracts it never mines - so a
# simulation that wrote local.json handed every service downstream a manifest of
# contracts that do not exist.
before=$(cat "$STAGE/local.json")
ALLOW_FRESH_DEPLOY=1 forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" >/tmp/simulate.log 2>&1 || true
[ "$(cat "$STAGE/local.json")" = "$before" ] || { echo "FAIL: a simulation changed local.json"; exit 1; }
rm -f "$STAGE/local.json.pending"
echo "local.json unchanged by a simulated run"

step "the one-shot never puts the mnemonic on a command line (finding 25)"
# THE GATING TEST IS docker/test-mnemonic-argv.sh, which stubs `cast` and needs
# no Docker at all - deterministic, and the thing CI could run.
#
# What follows is a NON-GATING VIEW of the same property through the real image,
# kept because it is the only place the container's own process table is
# visible. It samples /proc via `docker top`, and a process that exits in
# milliseconds may not be caught either way - which is exactly why it does not
# gate: an unobserved run here would otherwise read as a pass.
sh "$HERE/test-mnemonic-argv.sh" || { echo "FAIL: the argv test failed"; exit 1; }

docker run -d --rm --name "$NAME-argv" --entrypoint /bin/sh "$IMAGE" \
  -c "umask 077; f=\$(mktemp); printf '%s' '$MNEMONIC' > \$f; cast wallet private-key --mnemonic \$f >/dev/null; sleep 3" >/dev/null
sleep 1
if docker top "$NAME-argv" -o args 2>/dev/null | grep -q "junk"; then
  docker rm -f "$NAME-argv" >/dev/null 2>&1 || true
  echo "FAIL: the phrase is on the command line in the real image"; exit 1
fi
docker rm -f "$NAME-argv" >/dev/null 2>&1 || true
echo "view: nothing observed on the container's argv (non-gating; see the test above)"

step "the startup banner does not leak the treasury key"
# anvil prints the mnemonic and every private key unless -q. Account 0 is the
# treasury, and docker logs is not a secret store.
# Greps for the TWO LITERAL SECRETS, not for a shape. This used to match
# /private key|mnemonic|0x[0-9a-f]{64}/, which also matches every transaction
# and block hash anvil logs - so the number counted things that are not secrets
# (8 in a full run: 3 banner lines plus 5 from the deploy), and, worse, it would
# go quietly green the day anvil stopped printing the key banner for ANY reason,
# because it was measuring the shape of a log line rather than the presence of a
# credential. A control that can only fail loudly when things are fine is the
# thing this check exists to prevent.
secrets() { docker logs "$1" 2>&1 | grep -cF -e "$MNEMONIC" -e "$KEY" || true; }

leaks=$(secrets "$NAME")
[ "$leaks" = 0 ] || { echo "FAIL: the mnemonic or the treasury key appears $leaks times in docker logs"; exit 1; }
echo "mnemonic/treasury-key occurrences in docker logs: 0"
# The control, so that zero means something: the same grep against an
# unsuppressed banner must be non-zero.
docker run --rm -d --name "$NAME-noq" --entrypoint anvil "$IMAGE" \
  --host 0.0.0.0 --port 8545 --accounts 1 --mnemonic "$MNEMONIC" >/dev/null 2>&1
sleep 3
control=$(secrets "$NAME-noq")
docker rm -f "$NAME-noq" >/dev/null 2>&1
[ "$control" -gt 0 ] || { echo "FAIL: control found no leak either - the grep proves nothing"; exit 1; }
echo "control (same grep, no -q): $control"

step "restart (the S8 criterion 2 persistence check)"
docker restart "$NAME" >/dev/null
for i in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME")" = healthy ] && break
  sleep 1
done
echo "health after restart: $(docker inspect -f '{{.State.Health.Status}}' "$NAME")"

code_len=$(cast code "$VEE" --rpc-url "$RPC" | wc -c)
supply_after=$(cast call "$VEE" "totalSupply()(uint256)" --rpc-url "$RPC")
balance_after=$(cast call "$VEE" "balanceOf(address)(uint256)" "$TREASURY" --rpc-url "$RPC")
resolve_after=$(cast call "$REG" "resolve(string)(address)" "treasury.play" --rpc-url "$RPC")
echo "token code bytes after restart: $code_len"
echo "totalSupply: $supply_after"
echo "treasury balance: $balance_after"
echo "resolve(treasury.play): $resolve_after"

step "verdict"
fail=0
[ "$supply_before"  = "$supply_after"  ] || { echo "FAIL: totalSupply changed"; fail=1; }
[ "$balance_before" = "$balance_after" ] || { echo "FAIL: treasury balance changed"; fail=1; }
[ "$resolve_before" = "$resolve_after" ] || { echo "FAIL: treasury.play resolution changed"; fail=1; }
[ "$code_len" -gt 10 ] || { echo "FAIL: token has no code after restart"; fail=1; }
[ "$fail" = 0 ] && echo "PASS: state survived the restart" || exit 1
