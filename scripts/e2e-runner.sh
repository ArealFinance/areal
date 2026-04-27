#!/usr/bin/env bash
#
# e2e-runner.sh — R-58 operator-driven Layer 9 scenario runner.
#
# Wraps scripts/lib/e2e-runner.ts. Reads data/e2e-bootstrap.json, picks the
# requested scenario, and exits non-zero if any flow errors or if the
# scenario is gated on an unmet contract precondition (R20 / R57).
#
# Inputs (env / args):
#   --scenario <name>          One of: full, revenue-only, yield-only,
#                              convert-only, nexus-only, lh-drain.
#                              Default: full.
#   --artifact <path>          Override the bootstrap artifact path
#                              (default: data/e2e-bootstrap.json).
#   --output-dir <path>        Where to write the per-run JSON
#                              (default: data/).
#
# Exit codes:
#   0   scenario completed (some flows may report skipped — see JSON)
#   1   one or more flows errored
#   2   scenario gated on unmet precondition (R20 / R57)
#
# Pre-flight:
#   - Bootstrap artifact must exist (run scripts/e2e-bootstrap.sh first).
#   - For nexus-only:   init_failed[] must NOT contain initialize_nexus.
#   - For lh-drain:     init_failed[] must NOT contain initialize_liquidity_holding.

set -euo pipefail

SCENARIO="full"
ARTIFACT=""
OUTPUT_DIR=""

while (( $# > 0 )); do
  case "$1" in
    --scenario|-s)
      SCENARIO="$2"
      shift 2
      ;;
    --artifact)
      ARTIFACT="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "[e2e-runner] unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT="${ARTIFACT:-$ROOT_DIR/data/e2e-bootstrap.json}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/data}"

if [[ ! -f "$ARTIFACT" ]]; then
  echo "[e2e-runner] bootstrap artifact missing: $ARTIFACT" >&2
  echo "             run scripts/e2e-bootstrap.sh first" >&2
  exit 64
fi

cd "$ROOT_DIR"
exec npx --prefix bots tsx scripts/lib/e2e-runner.ts \
  --scenario "$SCENARIO" \
  --artifact "$ARTIFACT" \
  --output-dir "$OUTPUT_DIR"
