#!/usr/bin/env bash
# Reject literal hostnames in bots/observability/**/*.template.{yml,ini}.
# Whitelist: localhost, 127.0.0.1, 0.0.0.0, ${VAR}, docker-compose service names,
# *.svc.cluster.local. Anything else (foo.com, bot-vm-1.fornex.cloud) -> exit 1.
#
# Run from repo root.

set -euo pipefail

REPO_ROOT="$(pwd)"
TEMPLATE_DIR="${REPO_ROOT}/bots/observability"

if [[ ! -d "${TEMPLATE_DIR}" ]]; then
  # Nothing to lint.
  exit 0
fi

# Hostname pattern: at least two DNS labels separated by dots.
# Each label: [a-z0-9] with optional internal hyphens, ending in [a-z0-9].
HOSTNAME_RE='[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+'

# Whitelist (literal substrings allowed AS hostname matches).
# Note: localhost and other single-label compose service names (prometheus,
# grafana, alertmanager, node-exporter, blackbox-exporter) do NOT match
# HOSTNAME_RE because they have no dot, so they are safe by construction.
WHITELIST_LITERALS=(
  '127.0.0.1'
  '0.0.0.0'
  # Docker-host gateway alias used by prometheus to reach host-network
  # services (node-exporter on Phase 20, bots on Phase 21+). Declared via
  # `extra_hosts: ["host.docker.internal:host-gateway"]` in docker-compose.
  'host.docker.internal'
)

# Whitelist suffixes: any matched hostname ending with one of these is allowed.
WHITELIST_SUFFIXES=(
  '.svc.cluster.local'
)

# Right-hand label values that mark a match as NOT a hostname.
# - File extensions used in this repo (yml, yaml, ini, json, toml, sh, conf, log, env, txt, md).
# - Numeric tokens (version numbers like v2.55.1 -> rightmost label is "1").
# We treat a match as a hostname only if its rightmost label is purely
# alphabetic AND not in this list.
NON_HOSTNAME_TLDS=(
  yml yaml ini json toml sh conf log env txt md
)

is_likely_hostname() {
  # $1: candidate match (e.g., "bot-vm-1.fornex.cloud" or "prometheus.yml")
  local m="$1"
  local last="${m##*.}"

  # Reject if rightmost label contains digits (version numbers).
  if [[ "${last}" =~ [0-9] ]]; then
    return 1
  fi

  # Reject if rightmost label is a known non-hostname token (file ext).
  local ext
  for ext in "${NON_HOSTNAME_TLDS[@]}"; do
    if [[ "${last}" == "${ext}" ]]; then
      return 1
    fi
  done

  # Require rightmost label length >= 2.
  if [[ ${#last} -lt 2 ]]; then
    return 1
  fi

  return 0
}

violations=0

# Find all template files.
mapfile -t files < <(
  find "${TEMPLATE_DIR}" \
    -type f \
    \( -name '*.template.yml' -o -name '*.template.ini' \) \
    | sort
)

for file in "${files[@]}"; do
  # Relative path for nicer output.
  rel="${file#"${REPO_ROOT}"/}"
  lineno=0

  while IFS= read -r line; do
    lineno=$((lineno + 1))

    # Strip everything after a '#' (comment) -- approximate but good enough
    # for YAML/INI templates which use '#' for line comments.
    stripped="${line%%#*}"

    # Replace ${...} placeholders with a sentinel token so they don't trip
    # the hostname regex.
    sanitized="$(printf '%s' "${stripped}" | sed -E 's/\$\{[^}]*\}/__VAR__/g')"

    # Strip CLI-flag-style tokens like "--web.listen-address" or
    # "--config.file=..." — the dotted parts are flag names, not hostnames.
    sanitized="$(printf '%s' "${sanitized}" | sed -E 's/--[A-Za-z0-9._-]+//g')"

    # Strip INI section headers like "[auth.anonymous]" — the dotted parts
    # are namespace separators, not hostnames.
    sanitized="$(printf '%s' "${sanitized}" | sed -E 's/\[[A-Za-z0-9._-]+\]//g')"

    # Find every hostname-like match on this line.
    while IFS= read -r match; do
      [[ -z "${match}" ]] && continue

      # Filter: rightmost label heuristic (skip versions / file extensions).
      if ! is_likely_hostname "${match}"; then
        continue
      fi

      allowed=0

      # Whitelist literals (exact match).
      for w in "${WHITELIST_LITERALS[@]}"; do
        if [[ "${match}" == "${w}" ]]; then
          allowed=1
          break
        fi
      done

      # Whitelist suffix matches.
      if [[ ${allowed} -eq 0 ]]; then
        for suffix in "${WHITELIST_SUFFIXES[@]}"; do
          if [[ "${match}" == *"${suffix}" ]]; then
            allowed=1
            break
          fi
        done
      fi

      if [[ ${allowed} -eq 0 ]]; then
        echo "[hostname-lint] ${rel}:${lineno}: literal hostname \"${match}\" not allowed"
        violations=$((violations + 1))
      fi
    done < <(printf '%s\n' "${sanitized}" | grep -oE "${HOSTNAME_RE}" || true)
  done < "${file}"
done

if [[ ${violations} -gt 0 ]]; then
  echo "[hostname-lint] ${violations} violation(s) found"
  exit 1
fi

exit 0
