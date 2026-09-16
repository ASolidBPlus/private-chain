#!/usr/bin/env bash
# Typecheck every package in the repo, DISCOVERED rather than enumerated.
#
# `bun run typecheck` runs the ROOT tsconfig, whose include is src/test/types.
# Anything outside that is not typechecked, and nothing says so: a package with
# its own tsconfig and a genuine type error passes CI green at the root and
# fails only when someone runs tsc inside it. Measured, before this existed:
#
#     bun run typecheck            -> exit 0
#     tsc --noEmit -p chain/svc    -> exit 2
#
# A directory with no tsconfig was the first instance of this class, fixed by
# building EVERY file in it rather than a hand-picked entry list. Same fix one
# level up: discover every tsconfig, so package N+1 is covered by construction
# instead of by somebody remembering to add it to a list. An enumerated include
# silently stops covering what comes next, which is the whole failure mode.
#
# Deliberately names no package. It works on a repo that has only the root
# tsconfig today and covers new ones the moment they land.
set -uo pipefail
cd "$(dirname "$0")/../.."

# ── CAPTURE THE STATE THAT CAUSED IT, AT THE MOMENT IT HAPPENS (#47) ─────────
#
# This script exited 1 on the first run in a fresh worktree and 0 on every run
# after, with no change in between. Seen twice, both on cold trees, and NOT
# reproducible in eight deliberate attempts across three hypotheses. The first
# filed cause was a hypothesis someone wrote down as a finding and has since been
# retracted by measurement.
#
# So this is not another attempt to reproduce it. Eight failures say another
# attempt is not the move; what made every previous one useless is that the
# reconstruction happened AFTERWARDS, by which time the state that caused it was
# gone. This fires on the failure path, needs nobody to remember to turn it on,
# and records the things that cannot be recovered later:
#
#   the tree      — exact SHA, and whether the working tree was dirty
#   the call      — cwd, the full argv, and the env vars that select behaviour
#   the tools     — RESOLVED versions, not the requested ones
#   the failure   — the step's output verbatim, not summarised
#
# Written to a file AND echoed: a CI run keeps the log, a local run keeps the
# file, and neither depends on somebody thinking to scroll.
DIAG="${TYPECHECK_DIAG:-.typecheck-failure.log}"

_diag() {
  {
    echo "=== typecheck:all failure diagnostic ==="
    echo "when            : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "cwd             : $PWD"
    echo "argv            : $0 $*"
    # The TREE, not the branch: a branch name does not identify a tree, and this
    # failure is suspected to be about tree state.
    echo "git HEAD        : $(git rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "git describe    : $(git describe --always --dirty --broken 2>/dev/null || echo unknown)"
    echo "working tree    : $(if [ -n "$(git status --porcelain 2>/dev/null)" ]; then echo DIRTY; else echo clean; fi)"
    echo "untracked count : $(git status --porcelain --untracked-files=all 2>/dev/null | grep -c '^??' || echo unknown)"
    # RESOLVED versions. "bun 1.x" from a lockfile is the requested version; this
    # is what actually ran, which is the only one that can explain a difference
    # between two runs on one machine.
    echo "bun             : $(bun --version 2>/dev/null || echo absent)"
    echo "tsc (bunx)      : $(bunx tsc --version 2>/dev/null || echo absent)"
    echo "node            : $(node --version 2>/dev/null || echo absent)"
    echo "git             : $(git --version 2>/dev/null || echo absent)"
    # The variables that SELECT behaviour, named rather than dumped: a full env
    # dump on a failure path is how a secret reaches a log.
    #
    # BUT NAMING A VARIABLE MAKES THE NAME SAFE AND SAYS NOTHING ABOUT THE VALUE.
    # This loop reasoned about WHICH NAMES get printed — correctly — and the
    # residual is WHAT A PRINTED VALUE CAN CONTAIN. Two of the nine named here
    # are documented places to put `https://user:token@host`, and the value was
    # printed verbatim to the file AND the CI log. Measured with a planted
    # credential: two occurrences, both destinations. The comment above named the
    # hazard and guarded the wrong half of it, which reads to the next person as
    # though it were handled.
    #
    # REDACTED, NOT DROPPED. A wrong registry is a plausible cause of a
    # cold-tree install difference, which is this defect's whole shape, so the
    # host has to survive — only the userinfo goes.
    # FINDING 30: SET-OR-UNSET, AND FOR A REGISTRY THE HOST.
    #
    # The values went in whole, with only URL userinfo redacted. That guarded
    # the one shape somebody had thought of: `NODE_OPTIONS` carries arbitrary
    # flags including `--require /path/to/anything`, `BUN_INSTALL` and `TMPDIR`
    # are filesystem paths that describe a machine, and a registry URL can carry
    # a token in a query string rather than in userinfo - where the sed above
    # does not look. This file is printed to the CI log, which is a published
    # surface.
    #
    # WHAT THE DIAGNOSTIC IS FOR decides what it needs: it exists to explain why
    # a cold tree installs differently from a warm one, and for that "was this
    # set at all" answers nearly every question. The exception is the registry
    # pair, where a WRONG HOST is itself the plausible cause - so those keep
    # their host, and nothing else.
    for v in CI GITHUB_ACTIONS NODE_ENV NODE_OPTIONS TSC_COMPILE_ON_ERROR \
             BUN_INSTALL TMPDIR; do
      echo "env $v = $([ -n "${!v:-}" ] && echo set || echo '<unset>')"
    done
    for v in BUN_CONFIG_REGISTRY npm_config_registry; do
      # The host alone: scheme, userinfo, path and query all go. `<unset>` and
      # `set-but-unparseable` are different answers and both are worth having.
      if [ -z "${!v:-}" ]; then
        echo "env $v = <unset>"
      else
        _host=$(printf '%s' "${!v}" | sed -n 's|^[a-zA-Z][a-zA-Z0-9+.-]*://\([^/@]*@\)\?\([^/:?#]*\).*|\2|p')
        echo "env $v = host ${_host:-<unparseable>}"
      fi
    done
    echo "node_modules    : $([ -d node_modules ] && echo present || echo ABSENT)"
    echo "per-package node_modules:"
    for d in $(find . -name tsconfig.json -not -path '*/node_modules/*' -printf '%h\n' 2>/dev/null | sort -u); do
      [ "$d" = "." ] && continue
      echo "  $d: $([ -d "$d/node_modules" ] && echo present || echo ABSENT)"
    done
    echo
    # NB the per-package outputs are captured to temp files and printed in order
    # rather than streamed live, so on a long run the CONTENT is identical and
    # the INTERLEAVING is not. Stated because "byte-for-byte unchanged" is a
    # claim someone will check, and it is true of each step's text and not of
    # how two steps' text would have overlapped.
    echo "--- verbatim output of the failing run ---"
    cat "$1"
  } | tee -a "$DIAG" >&2
  echo "agent-chain: diagnostic written to $DIAG" >&2
}

fails=0
STEP_OUTPUTS=(); FAILED_CFGS=()
mapfile -t CONFIGS < <(find . -name tsconfig.json -not -path '*/node_modules/*' | sort)

# A discovery step that discovers nothing must not report success. This is the
# false-zero the rest of the file exists to prevent: if the find breaks — a
# renamed directory, a changed layout, a bad -not clause — an empty list would
# otherwise sail through as "everything passed".
if [ "${#CONFIGS[@]}" -eq 0 ]; then
  echo "FAIL: no tsconfig.json found anywhere. Either the repo has no TypeScript"
  echo "      (it does) or this discovery is broken. Refusing to report success."
  _nc=$(mktemp)
  echo "discovery found no tsconfig.json under $PWD" > "$_nc"
  _diag "$_nc"
  rm -f "$_nc"
  exit 1
fi

echo "discovered ${#CONFIGS[@]} tsconfig(s):"
printf '  %s\n' "${CONFIGS[@]}"
echo

for cfg in "${CONFIGS[@]}"; do
  dir=$(dirname "$cfg")
  # A package with its own package.json needs its own dependency tree before it
  # can typecheck. Skipped rather than guessed at when absent — a missing
  # node_modules produces cannot-find-module noise that reads like a type error
  # and sends whoever debugs it to the wrong place.
  if [ "$dir" != "." ] && [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    echo "-- $cfg: installing package deps"
    (cd "$dir" && bun install --frozen-lockfile --ignore-scripts) || {
      echo "FAIL: $cfg — could not install its dependencies"; fails=$((fails+1)); continue; }
  fi
  echo "-- $cfg"
  # Output captured, not just streamed: the diagnostic needs it VERBATIM, and a
  # summary of what tsc said is precisely what made the previous reconstructions
  # useless. Still echoed, so a passing run reads exactly as before.
  _out=$(mktemp); STEP_OUTPUTS+=("$_out")
  if bunx tsc --noEmit -p "$dir" >"$_out" 2>&1; then cat "$_out"; echo "   ok"
  else cat "$_out"; echo "   FAIL: $cfg"; fails=$((fails+1)); FAILED_CFGS+=("$cfg"); fi
done

echo
# ── Coverage: keyed on what tsc ACTUALLY PARSES, not on what declares itself ──
#
# Discovering "every directory with a tsconfig" would not have found the
# founding member of this class — it has no tsconfig and no package.json, and
# having none is WHY it was uncovered. A discovery keyed on a declaration only
# finds members that opted in, and the ones worth hunting are precisely those
# that never did. Worse, it would leave that directory behind a control named
# "every package", which reads as exhaustive: a documented gap replaced by a
# rule that appears to cover it is worse than the documented gap.
#
# So the real question is not "which packages declared themselves" but "which
# files does no program parse". Asked of tsc directly via --listFiles, rather
# than inferred from directory layout.
#
# The file set comes from `git ls-files`, NOT from walking the directory. Two
# reasons, and the first is a mistake this check made before it shipped:
#   1. A working tree carries untracked scratch — gitignored scenario dirs, local
#      probes — that is not part of the repo. Walking the directory reported
#      those as uncovered, which is a finding about one developer's disk rather
#      than about the repo, and would red a tree that is clean on a fresh clone.
#   2. It makes a local run and a CI run ask the same question. CI checks out
#      tracked files only; anything else is a check that behaves differently in
#      the place it matters.
mapfile -t ALL_TS < <(git ls-files '*.ts' | sort)

# A PROBE THAT COULD NOT MEASURE IS NOT A MEASUREMENT OF ABSENCE.
#
# This loop used to be `bunx tsc ... --listFiles 2>/dev/null | ... || true`, which
# threw away the probe's error, swallowed its failure, and left a probe that
# produced NO list indistinguishable from a package that contains no files. The
# files under that tsconfig then fell out of the covered set and the script failed
# the build with "parsed by NO tsconfig, so nothing typechecks them" — about files
# it had simply failed to look at.
#
# Reproduced deterministically by making one tsconfig unreadable: 30 correctly
# covered files were reported as covered by nothing, and because this refusal path
# wrote no diagnostic, the state was gone by the time anyone read the output.
#
# So coverage is THREE-VALUED now: covered, uncovered, or unknown. `--listFiles`
# prints the file set even when tsc exits non-zero on type errors, so a probe that
# lists files has measured coverage whether or not the package typechecks; a probe
# that lists NOTHING has measured nothing, and says so.
: > /tmp/tc-covered.$$
PROBE_FAILED=()
for cfg in "${CONFIGS[@]}"; do
  _out=$(mktemp); _err=$(mktemp)
  bunx tsc --noEmit -p "$(dirname "$cfg")" --listFiles >"$_out" 2>"$_err"
  _st=$?
  _listed=$(grep -v node_modules "$_out" | grep -c '\.ts$' || true)
  if [ "${_listed:-0}" -eq 0 ]; then
    # Every tsconfig in this repo parses at least its own sources, so zero listed
    # files means the probe did not run, not that the package is empty.
    PROBE_FAILED+=("$cfg (tsc exit $_st): $(tr '\n' ' ' < "$_err" | cut -c1-200)")
  else
    grep -v node_modules "$_out" | sed "s|^$PWD/||" | grep '\.ts$' >> /tmp/tc-covered.$$
  fi
  rm -f "$_out" "$_err"
done

if [ "${#PROBE_FAILED[@]}" -ne 0 ]; then
  echo "COVERAGE UNKNOWN: ${#PROBE_FAILED[@]} coverage probe(s) did not complete, so this"
  echo "                  run cannot say which files are typechecked. NOT reporting them"
  echo "                  as uncovered — that would be a failed measurement dressed as a"
  echo "                  finding."
  printf '  %s\n' "${PROBE_FAILED[@]}"
  _pf=$(mktemp)
  { echo "coverage probes that did not complete:"; printf '  %s\n' "${PROBE_FAILED[@]}"; } > "$_pf"
  _diag "$_pf"
  rm -f "$_pf" /tmp/tc-covered.$$
  exit 1
fi

sort -u /tmp/tc-covered.$$ -o /tmp/tc-covered.$$
mapfile -t UNCOVERED < <(printf '%s\n' "${ALL_TS[@]}" | comm -13 /tmp/tc-covered.$$ -)
rm -f /tmp/tc-covered.$$

if [ "${#UNCOVERED[@]}" -ne 0 ]; then
  echo "FAIL: ${#UNCOVERED[@]} TypeScript file(s) are parsed by NO tsconfig, so nothing typechecks them:"
  printf '  %s\n' "${UNCOVERED[@]}"
  echo
  echo "Add them to a tsconfig 'include', or give their directory its own tsconfig."
  echo "Note that being built (e.g. by 'bun build') is NOT type coverage: a build"
  echo "transpiles and STRIPS types without checking them, so a type error there"
  echo "still reaches main. That is exactly how such a directory looked covered."
  # ON THIS PATH TOO. The diagnostic exists because the state is gone by the time
  # anyone looks, and a refusal about the SHAPE of the repo is exactly where that
  # bites — it was written only on the tsc-failure path, so the two refusals that
  # are hardest to reconstruct were the two that recorded nothing.
  _uc=$(mktemp)
  { echo "files parsed by no tsconfig:"; printf '  %s\n' "${UNCOVERED[@]}"; } > "$_uc"
  _diag "$_uc"
  rm -f "$_uc"
  exit 1
fi
echo "coverage: all ${#ALL_TS[@]} .ts files are parsed by at least one tsconfig"

if [ "$fails" -ne 0 ]; then
  echo "TYPECHECK FAIL ($fails package(s))"
  # The diagnostic fires HERE, on the failure path, without anyone remembering
  # to enable it. That is the whole design: #47 was seen twice and reconstructed
  # never, because by the time anyone looked the state was gone.
  _all=$(mktemp)
  { echo "failing configs: ${FAILED_CFGS[*]}"; echo
    for f in "${STEP_OUTPUTS[@]}"; do echo "--- $f ---"; cat "$f"; done; } > "$_all"
  _diag "$_all"
  rm -f "$_all" "${STEP_OUTPUTS[@]}"
  exit 1
fi
rm -f "${STEP_OUTPUTS[@]}" 2>/dev/null || true
echo "TYPECHECK PASS (${#CONFIGS[@]} package(s), ${#ALL_TS[@]} files covered)"
