/*
 * gate-resolver.ts — R-66 extraction.
 *
 * Pure (no I/O) helpers that decide whether a Layer 8/9/10 scenario is
 * runnable given the current bootstrap artifact state, and that shape the
 * per-flow JSON entries the runner emits.
 *
 * Extracted out of `scripts/lib/e2e-runner.ts` so the inline gate logic
 * has a single source of truth — multiple downstream callers (verify-
 * deployment.sh, future CI bots, ad-hoc checks) need the same `gated:r20`
 * / `gated:r57` semantics without re-implementing them.
 *
 * Behavior is deliberately a 1:1 mirror of the inline e2e-runner code so
 * gate-resolver.test.ts can pin byte-equivalence on representative cases.
 * Extending coverage (more gates, more scenarios) goes here, NOT into the
 * runner orchestrator.
 */

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

/** Reason a scenario / flow is gated. `null` = not gated. */
export type GateReason = 'r20' | 'r57' | 'init_failed' | 'precondition' | null;

/**
 * Names recognised by the resolver. The `legacy` aliases stay supported
 * because the existing per-flow runners (`full`, `revenue-only`, ...) still
 * dispatch through here.
 */
export type ScenarioName =
  | 'full'
  | 'revenue-only'
  | 'yield-only'
  | 'convert-only'
  | 'nexus-only'
  | 'lh-drain'
  | 'scenario-1'
  | 'scenario-2'
  | 'scenario-3'
  | 'scenario-4'
  | 'scenario-5'
  | 'scenario-6'
  | 'all';

/**
 * Per-flow names emitted by the runner — the union of "shape this flow"
 * targets. Kept narrow (string) to avoid churn when new cranks land.
 */
export type FlowName = string;

/**
 * Minimum subset of the bootstrap artifact this resolver needs. Defining it
 * locally (vs importing from bootstrap-init.ts) keeps the resolver decoupled
 * from the larger artifact shape — anything callers can stuff into these
 * fields works.
 */
export interface BootstrapArtifact {
  init_skipped?: string[];
  init_failed?: { phase: string; error: string }[];
  pdas?: {
    liquidity_holding?: string;
    liquidity_nexus?: string;
    [key: string]: string | undefined;
  };
  /** Optional flag — set when migrate-mints.sh has not been completed. */
  rwt_mint_placeholder?: boolean;
  [key: string]: unknown;
}

export interface ScenarioGateVerdict {
  allowed: boolean;
  reason: GateReason;
  details?: string;
}

export interface FlowEntryJson {
  flow: FlowName;
  status: 'pass' | 'fail' | 'skipped' | 'gated';
  reason?: string;
  gate_reason?: GateReason;
  error?: string;
  duration_ms?: number;
}

// --------------------------------------------------------------------------
// Internal predicates
// --------------------------------------------------------------------------

/**
 * R57 predicate — Liquidity Nexus must be initialized. The needle matches
 * bootstrap-init.ts:807-817 + the Layer 9 Substep 1 init phase.
 *
 * Mirrors `e2e-runner.ts::checkR57`.
 */
function r57Blocked(art: BootstrapArtifact): boolean {
  const failed = (art.init_failed ?? []).some((f) => f.phase.includes('initialize_nexus'));
  const skipped = (art.init_skipped ?? []).some((p) => p.includes('initialize_nexus'));
  return failed || skipped || !art.pdas?.liquidity_nexus;
}

/**
 * R20 predicate — RWT mint pin migration + LiquidityHolding init must be
 * complete. Three signals all of which trip the gate:
 *   1. `rwt_mint_placeholder` flag (set by check-public-repo-readiness.sh
 *      consumers / the migrate-mints.sh sentinel reader).
 *   2. `init_failed[]` contains an `initialize_liquidity_holding` entry.
 *   3. `init_skipped[]` contains an `initialize_liquidity_holding` entry,
 *      OR the artifact lacks a `pdas.liquidity_holding` PDA.
 *
 * Mirrors `e2e-runner.ts::checkR20` exactly + the explicit
 * `rwt_mint_placeholder` short-circuit (used by direct callers that don't
 * read the `init_failed[]` / phase strings — e.g. unit tests asserting
 * `gated:r20` from an artifact that only sets `rwt_mint_placeholder=true`).
 */
function r20Blocked(art: BootstrapArtifact): boolean {
  if (art.rwt_mint_placeholder === true) return true;
  const failed = (art.init_failed ?? []).some((f) =>
    f.phase.includes('initialize_liquidity_holding'),
  );
  const skipped = (art.init_skipped ?? []).some((p) =>
    p.includes('initialize_liquidity_holding'),
  );
  return failed || skipped || !art.pdas?.liquidity_holding;
}

/**
 * Generic init-failure predicate — any phase the caller cares about appears
 * in `init_failed[]`. Returns the matching phase string for diagnostics.
 */
function findInitFailure(art: BootstrapArtifact, needles: string[]): string | null {
  const failed = art.init_failed ?? [];
  for (const f of failed) {
    for (const needle of needles) {
      if (f.phase.includes(needle)) return f.phase;
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Public API — resolveScenarioGate
// --------------------------------------------------------------------------

/**
 * Decide whether `scenario` can run against `bootstrap`. Returns a verdict
 * with `allowed=false` and a `reason` populated when blocked; consumer
 * decides whether to halt or log + skip.
 *
 * Behavior matches e2e-runner.ts::gateScenario byte-for-byte for the
 * legacy scenarios (`full`, `revenue-only`, `yield-only`, `convert-only`,
 * `nexus-only`, `lh-drain`). The Layer 10 named scenarios extend the table:
 *   - scenario-3 (DEX) gates on R20 (RWT mint pin needs to be real before
 *     swap math hits the on-chain RWT_MINT bytes).
 *   - scenario-5 (Nexus) gates on R57 + any `initialize_nexus` failure.
 *   - scenario-1/2/4/6 are not gated at runner level (their preconditions
 *     are inline-checked by each scenario test file).
 */
export function resolveScenarioGate(
  scenario: ScenarioName,
  bootstrap: BootstrapArtifact,
): ScenarioGateVerdict {
  // R20 — short-circuit on placeholder flag for any scenario that touches
  // RWT mint state.
  const r20Sensitive: ScenarioName[] = ['scenario-3', 'scenario-5', 'lh-drain'];
  if (r20Sensitive.includes(scenario) && bootstrap.rwt_mint_placeholder === true) {
    return {
      allowed: false,
      reason: 'r20',
      details: 'gated on R20 — RWT mint pin migration pending (rwt_mint_placeholder=true)',
    };
  }

  switch (scenario) {
    case 'nexus-only': {
      // Mirrors `e2e-runner.ts::checkR57` exactly — string + ordering
      // preserved so log scrapers don't drift.
      if (r57Blocked(bootstrap)) {
        return {
          allowed: false,
          reason: 'r57',
          details: 'gated on R57 — Liquidity Nexus not initialized',
        };
      }
      const phase = findInitFailure(bootstrap, ['initialize_nexus']);
      if (phase) {
        return {
          allowed: false,
          reason: 'init_failed',
          details: `init_failed: ${phase}`,
        };
      }
      return { allowed: true, reason: null };
    }

    case 'scenario-5': {
      // Layer 10 named scenario — the inline runner doesn't gate at top
      // level (the test file does its own precondition assertion), but
      // direct callers asking the resolver still get a useful verdict.
      // The verdict's `details` is descriptive; runners that prefer the
      // legacy "manual-run" surface should NOT propagate the verdict to
      // the user-facing flow result (see runScenario5 in e2e-runner.ts).
      const phase = findInitFailure(bootstrap, ['initialize_nexus']);
      if (phase) {
        return {
          allowed: false,
          reason: 'init_failed',
          details: `init_failed: ${phase}`,
        };
      }
      if (r57Blocked(bootstrap)) {
        return {
          allowed: false,
          reason: 'r57',
          details: 'gated on R57 — Liquidity Nexus not initialized',
        };
      }
      return { allowed: true, reason: null };
    }

    case 'lh-drain': {
      // Order: R20 short-circuit first (matches the inline e2e-runner check
      // that did not separately surface init_failed[] for this scenario).
      // The detail string is byte-equivalent to the legacy
      // `e2e-runner.ts::checkR20` reason so downstream log scrapers don't
      // break on the rename to gate-resolver.
      if (r20Blocked(bootstrap)) {
        return {
          allowed: false,
          reason: 'r20',
          details:
            'gated on R20 — RWT mint pin migration / LiquidityHolding init pending',
        };
      }
      const phase = findInitFailure(bootstrap, ['initialize_liquidity_holding']);
      if (phase) {
        return {
          allowed: false,
          reason: 'init_failed',
          details: `init_failed: ${phase}`,
        };
      }
      return { allowed: true, reason: null };
    }

    case 'scenario-3': {
      // DEX scenario doesn't strictly require Nexus, but a failed init for
      // anything DEX-touching surfaces here for ops visibility.
      if (r20Blocked(bootstrap)) {
        return {
          allowed: false,
          reason: 'r20',
          details: 'gated on R20 — RWT mint pin pending',
        };
      }
      return { allowed: true, reason: null };
    }

    case 'full':
    case 'revenue-only':
    case 'yield-only':
    case 'convert-only':
    case 'scenario-1':
    case 'scenario-2':
    case 'scenario-4':
    case 'scenario-6':
    case 'all':
      return { allowed: true, reason: null };

    default: {
      // Exhaustiveness fall-through — TS compile time ensures we cover the
      // union; at runtime an unknown scenario reads as `precondition` so the
      // caller halts rather than running undefined behavior.
      return {
        allowed: false,
        reason: 'precondition',
        details: `unknown scenario: ${String(scenario)}`,
      };
    }
  }
}

// --------------------------------------------------------------------------
// Public API — shapeFlowEntry
// --------------------------------------------------------------------------

/**
 * Build a JSON-serialisable flow entry consumed by `e2e-runner.ts` and
 * downstream CI tooling. Centralises the field naming so a future schema
 * bump has one place to land.
 *
 * Status mapping:
 *   - `pass`    → `status: 'pass'`     (test ran and asserted)
 *   - `fail`    → `status: 'fail'`     (test ran but asserted false / threw)
 *   - `skipped` → `status: 'skipped'`  (manual-run or unbuilt)
 *   - `gated`   → `status: 'skipped' + gate_reason: <r20|r57|...>`
 *
 * Note: per the runner's existing convention (Layer 8/9 carry-over) `gated`
 * collapses to `status: 'skipped'` in the JSON; the distinction lives in
 * the `gate_reason` field. This mirrors how operators already grep the
 * runner output and how dashboards consume the runner's artifact.
 */
export function shapeFlowEntry(
  flow: FlowName,
  outcome: 'pass' | 'fail' | 'skipped' | 'gated',
  meta: {
    reason?: string;
    error?: string;
    durationMs?: number;
    gateReason?: GateReason;
  } = {},
): FlowEntryJson {
  const base: FlowEntryJson = {
    flow,
    status: outcome === 'gated' ? 'skipped' : outcome,
  };
  if (meta.reason !== undefined) base.reason = meta.reason;
  if (meta.error !== undefined) base.error = meta.error;
  if (meta.durationMs !== undefined) base.duration_ms = meta.durationMs;
  if (outcome === 'gated' && meta.gateReason !== undefined) {
    base.gate_reason = meta.gateReason;
  }
  return base;
}
