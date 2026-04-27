#!/usr/bin/env bash
#
# cu-profile.sh — R24 acceptance harness for Layer 8.
#
# Captures `computeUnitsConsumed` from getTransaction RPC for each Layer 8
# instruction and emits a P50 / P95 / max table to stdout.
#
# Inputs (env):
#   RPC_URL                    Solana RPC endpoint with the 5 programs deployed.
#   CRANK_KEYPAIR              Path to a funded keypair (~5 SOL minimum).
#   YD_PROGRAM_ID, RWT_ENGINE_PROGRAM_ID, DEX_PROGRAM_ID,
#   OT_PROGRAM_ID, FUTARCHY_PROGRAM_ID
#                              Program addresses (must match canonical vanity).
#   E2E_BOOTSTRAP_DONE=1       Marker that the validator state is seeded.
#
# Output: appends a "## Live Measurements (<UTC date>)" block to
#   ../areal-planning/plan/layer-08-cu-profile.md
#
# Status: scaffolded. The TX-submitter harness is left as an exercise for
#   Layer 9 polish, when the bootstrap script lands. This file checks the
#   environment and prints the methodology so operators know exactly what's
#   needed; without bootstrap it exits 0 with a clear "needs bootstrap"
#   message rather than failing CI.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_FILE="$ROOT_DIR/../areal-planning/plan/layer-08-cu-profile.md"

required_env=(
  RPC_URL
  CRANK_KEYPAIR
  YD_PROGRAM_ID
  RWT_ENGINE_PROGRAM_ID
  DEX_PROGRAM_ID
  OT_PROGRAM_ID
)

missing=()
for v in "${required_env[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    missing+=("$v")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "[cu-profile] env not set, skipping live profiling." >&2
  echo "             missing: ${missing[*]}" >&2
  echo "             see scripts/README.md for the harness contract." >&2
  exit 0
fi

if [[ "${E2E_BOOTSTRAP_DONE:-0}" != "1" ]]; then
  echo "[cu-profile] E2E_BOOTSTRAP_DONE not set — bootstrap required." >&2
  echo "             Run scripts/e2e-bootstrap.sh first to seed the localhost" >&2
  echo "             validator state. See plan/layer-09-architecture.md §13." >&2
  exit 0
fi

# Layer 9 Substep 14: live harness wired. Reads the bootstrap artifact at
# data/e2e-bootstrap.json (+ secrets file), submits each registered ix N
# times, captures CU + log signatures, writes JSON to data/cu-profile-*.json,
# and appends Markdown to plan/layer-08-cu-profile.md + plan/layer-09-cu-profile.md
# (when the private docs repo is present).
ARTIFACT="${E2E_BOOTSTRAP_ARTIFACT:-$ROOT_DIR/data/e2e-bootstrap.json}"
ITERATIONS="${CU_PROFILE_ITERATIONS:-5}"
OUTPUT_DIR="${CU_PROFILE_OUTPUT_DIR:-$ROOT_DIR/data}"

cd "$ROOT_DIR"
exec npx --prefix bots tsx scripts/lib/cu-profile.ts \
  --artifact "$ARTIFACT" \
  --iterations "$ITERATIONS" \
  --output-dir "$OUTPUT_DIR"
