#!/usr/bin/env bash
#
# check-public-repo-readiness.sh — Layer 10 Substep 10 public-repo gates.
#
# Grep-based pre-publication audit. For each of the 5 public submodules
# (contracts, bots, app, dashboard, docs) plus the meta-repo top-level,
# enforce 4 gates:
#
#   Gate 1: No `plan/layer-*` references — internal planning is private.
#   Gate 2: No AI / Claude / co-author markers.
#   Gate 5: No tracked `.env` files outside `.gitignore` coverage.
#   Gate 6: No hardcoded RPC URLs (https://api.{devnet,mainnet}.solana.com)
#           outside `*.example`, `*.md`, `bots/.e2e/fixtures/`.
#
# Exit 0 if every gate passes for every submodule. Tab-formatted per-gate
# per-submodule status line so output is easy to skim.

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Submodules + meta-repo top-level. Order matches .gitmodules.
TARGETS=(
  "$ROOT_DIR"
  "$ROOT_DIR/contracts"
  "$ROOT_DIR/bots"
  "$ROOT_DIR/app"
  "$ROOT_DIR/dashboard"
  "$ROOT_DIR/docs"
)

failures=0

target_label() {
  local p="$1"
  if [[ "$p" == "$ROOT_DIR" ]]; then
    echo "areal-meta"
  else
    basename "$p"
  fi
}

# Run a git-aware grep against tracked files in <repo>. Args: repo, label, gate, regex.
# Returns 0 if no match (gate PASS), 1 if any match (gate FAIL).
git_grep_gate() {
  local repo="$1"
  local label="$2"
  local gate="$3"
  local pattern="$4"
  local extra_filter="${5:-}"

  if [[ ! -d "$repo/.git" && ! -f "$repo/.git" ]]; then
    printf '%s\t%s\tSKIP\t(not a git checkout)\n' "$label" "$gate"
    return 0
  fi

  local matches
  if [[ -n "$extra_filter" ]]; then
    matches="$(git -C "$repo" ls-files | grep -vE "$extra_filter" || true)"
  else
    matches="$(git -C "$repo" ls-files || true)"
  fi
  if [[ -z "$matches" ]]; then
    printf '%s\t%s\tPASS\t(no tracked files)\n' "$label" "$gate"
    return 0
  fi

  # `xargs -I` would explode on filenames with spaces; use NUL-delimited.
  local hits
  hits="$(printf '%s\n' "$matches" \
    | (cd "$repo" && tr '\n' '\0' | xargs -0 grep -lE "$pattern" 2>/dev/null) \
    || true)"

  if [[ -n "$hits" ]]; then
    printf '%s\t%s\tFAIL\t%d hit(s)\n' "$label" "$gate" "$(echo "$hits" | wc -l | tr -d ' ')"
    echo "$hits" | sed "s|^|  $label: |" >&2
    failures=$((failures + 1))
    return 1
  fi
  printf '%s\t%s\tPASS\n' "$label" "$gate"
  return 0
}

echo "[check-public-repo-readiness] starting"
echo "target	gate	status	detail"

for target in "${TARGETS[@]}"; do
  label="$(target_label "$target")"

  # ----- Gate 1: plan/layer-* references -----
  git_grep_gate "$target" "$label" "gate1_plan_refs" 'plan/layer-' || true

  # ----- Gate 2: AI / Claude markers -----
  # Pattern is case-insensitive (-i flag baked in via ERE alternation +
  # uppercase sibling forms). We use `grep -liE` via a wrapper since
  # git_grep_gate uses -lE; flip to -liE inline.
  hits=""
  if [[ -d "$target/.git" || -f "$target/.git" ]]; then
    hits="$(git -C "$target" ls-files \
      | (cd "$target" && tr '\n' '\0' | xargs -0 grep -liE 'claude\.ai|anthropic|co-authored-by|claude-code|claude opus|claude sonnet' 2>/dev/null) \
      || true)"
  fi
  # The robot-emoji literal is the AI-attribution footer pattern, not bare
  # UI usage. Match only when 🤖 is followed by "Generated" (Claude Code
  # footer signature) — bare emoji as Mintlify Card icons is legitimate.
  hits_emoji=""
  if [[ -d "$target/.git" || -f "$target/.git" ]]; then
    hits_emoji="$(git -C "$target" ls-files \
      | (cd "$target" && tr '\n' '\0' | xargs -0 grep -lE $'\xf0\x9f\xa4\x96 Generated' 2>/dev/null) \
      || true)"
  fi
  combined="$(printf '%s\n%s\n' "$hits" "$hits_emoji" | grep -v '^$' | sort -u || true)"
  if [[ -n "$combined" ]]; then
    printf '%s\t%s\tFAIL\t%d hit(s)\n' "$label" "gate2_ai_markers" "$(echo "$combined" | wc -l | tr -d ' ')"
    echo "$combined" | sed "s|^|  $label: |" >&2
    failures=$((failures + 1))
  else
    printf '%s\t%s\tPASS\n' "$label" "gate2_ai_markers"
  fi

  # ----- Gate 5: tracked .env files outside .gitignore -----
  if [[ -d "$target/.git" || -f "$target/.git" ]]; then
    env_hits="$(git -C "$target" ls-files | grep -E '(^|/)\.env($|\.[^/]*$)' | grep -vE '\.example$|\.sample$' || true)"
    if [[ -n "$env_hits" ]]; then
      printf '%s\t%s\tFAIL\t%d tracked .env\n' "$label" "gate5_env_files" "$(echo "$env_hits" | wc -l | tr -d ' ')"
      echo "$env_hits" | sed "s|^|  $label: |" >&2
      failures=$((failures + 1))
    else
      printf '%s\t%s\tPASS\n' "$label" "gate5_env_files"
    fi
  else
    printf '%s\t%s\tSKIP\t(not a git checkout)\n' "$label" "gate5_env_files"
  fi

  # ----- Gate 6: hardcoded RPC URLs -----
  # Allow lists: *.example, *.md, bots/.e2e/fixtures/, plus three
  # documented config-default sites where the URL is operator-overridable
  # via env (zod .default() in crank configs, shared env-parser docstring
  # examples, dashboard cluster-RPC map for the network-picker UI).
  if [[ -d "$target/.git" || -f "$target/.git" ]]; then
    candidate_files="$(git -C "$target" ls-files \
      | grep -vE '(\.example$|\.md$|bots/\.e2e/fixtures/|^[^/]+-crank/src/config\.ts$|^shared/src/env\.ts$|^src/lib/stores/network\.ts$)' \
      || true)"
    if [[ -z "$candidate_files" ]]; then
      printf '%s\t%s\tPASS\t(no candidates)\n' "$label" "gate6_rpc_urls"
    else
      rpc_hits="$(printf '%s\n' "$candidate_files" \
        | (cd "$target" && tr '\n' '\0' | xargs -0 grep -lE 'https://api\.(devnet|mainnet)\.solana\.com' 2>/dev/null) \
        || true)"
      if [[ -n "$rpc_hits" ]]; then
        printf '%s\t%s\tFAIL\t%d hit(s)\n' "$label" "gate6_rpc_urls" "$(echo "$rpc_hits" | wc -l | tr -d ' ')"
        echo "$rpc_hits" | sed "s|^|  $label: |" >&2
        failures=$((failures + 1))
      else
        printf '%s\t%s\tPASS\n' "$label" "gate6_rpc_urls"
      fi
    fi
  else
    printf '%s\t%s\tSKIP\t(not a git checkout)\n' "$label" "gate6_rpc_urls"
  fi

done

echo
if (( failures > 0 )); then
  echo "[check-public-repo-readiness] FAILED — $failures gate violation(s)" >&2
  exit 1
fi
echo "[check-public-repo-readiness] OK — all gates passed"
exit 0
