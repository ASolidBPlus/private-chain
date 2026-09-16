#!/bin/sh
set -eu

# ANVIL_MNEMONIC derives account 0, which is the deployer AND the treasury key
# for the whole game (spec S2). It is a per-deployment secret from the hub .env
# (spec S10) and must never acquire a default here: a defaulted phrase means
# every deployment shares one treasury key, and the "secret" is a constant.
if [ -z "${ANVIL_MNEMONIC:-}" ]; then
  echo "anvil: ANVIL_MNEMONIC is unset - refusing to start rather than derive the treasury key from a default" >&2
  echo "anvil: generate one with: cast wallet new-mnemonic" >&2
  exit 1
fi

# BIP-39 phrases are 12 or 24 words. Checked here because a truncated phrase -
# the shape a .env quoting mistake produces - otherwise reaches anvil as an
# invalid-checksum error that reads like a bug in this script.
words=$(printf '%s' "$ANVIL_MNEMONIC" | wc -w)
if [ "$words" -ne 12 ] && [ "$words" -ne 24 ]; then
  echo "anvil: ANVIL_MNEMONIC must be a 12- or 24-word BIP-39 phrase; got $words words" >&2
  echo "anvil: if it is quoted correctly in .env, generate a new one with: cast wallet new-mnemonic" >&2
  exit 1
fi

STATE_FILE="${ANVIL_STATE_FILE:-/state/anvil.json}"

# FINDING 9: ONE ORIGIN, NOT ALL OF THEM.
#
# anvil's default is `--allow-origin *`, which sets
# `Access-Control-Allow-Origin: *` on the JSON-RPC endpoint - so ANY page the
# facilitator's browser loads can make RPC calls to this node. The node is bound
# to 127.0.0.1 by compose, and that is exactly the reach a browser has: a
# same-machine origin is not a barrier to it. On a chain where the treasury key
# signs, "any web page may call eth_sendTransaction" is worth one flag.
#
# THE VALUE IS MEASURED, not chosen: Otterscan is the one browser client, and
# compose publishes it at `127.0.0.1:5100:80` - so `http://127.0.0.1:5100` is
# the origin its pages actually carry. Overridable, because a deployment that
# serves it elsewhere needs to say so, and a wrong value here fails visibly (the
# block explorer stops loading) rather than silently.
ALLOW_ORIGIN="${ANVIL_ALLOW_ORIGIN:-http://127.0.0.1:5100}"

# --state both LOADS the file when it exists and DUMPS to it, so there is no
# separate --load-state branch to write; a cold start with no file just begins
# empty. --state-interval 5 leaves up to 5s of writes in memory only: anvil
# dumps on a clean SIGTERM (docker stop, compose restart), but `docker kill`
# can lose that window. Spec S2 documents and accepts this for a classroom.
#
# NOTE: spec S2 originally listed `--block-time 0` for instant mining. Anvil
# 1.8.1 rejects it ("Duration must be greater than 0") - instant mining is what
# anvil does by DEFAULT when --block-time is omitted, which is why it is omitted
# here. ruled; S2 corrected.
# -q because anvil's startup banner prints the MNEMONIC and every derived
# PRIVATE KEY to stdout, and account 0 is the treasury - the one key that can
# mint. `docker logs` is not a secret store: it is readable by anyone on the
# host with docker access, shipped wholesale by any log collector, and kept
# after the container is gone. Measured on this image: without -q the banner
# matches /private key|mnemonic|0x[0-9a-f]{64}/ three times; with it, zero, and
# the node still serves (the S2 healthcheck is `cast block-number`, not a log
# scrape). The cost is losing the "Listening on" line, which is the right trade.
exec anvil \
  -q \
  --host 0.0.0.0 \
  --port 8545 \
  --chain-id 31337 \
  --gas-price 0 \
  --base-fee 0 \
  --accounts 1 \
  --balance 1000000 \
  --mnemonic "$ANVIL_MNEMONIC" \
  --state "$STATE_FILE" \
  --state-interval 5 \
  --allow-origin "$ALLOW_ORIGIN" \
  "$@"
