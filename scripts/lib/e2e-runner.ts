#!/usr/bin/env tsx
/*
 * e2e-runner.ts — operator-driven scenario runner.
 *
 * Drives one full live-submit cycle per crank against the bootstrapped
 * localhost validator, feeding `BotConfig.sendTx = true` so each crank
 * actually lands its on-chain ix. Designed for hands-on E2E verification
 * of Layers 8-10 wiring once the cranks pass their unit tests.
 *
 * Layer 9 legacy scenarios (per-flow):
 *   full          — every flow that's gate-clean
 *   revenue-only  — just revenue-crank
 *   yield-only    — just yield-claim-crank
 *   convert-only  — just convert-and-fund-crank
 *   nexus-only    — just nexus-manager (gated on R57)
 *   lh-drain      — opt-in YD::withdraw_liquidity_holding (gated on R20)
 *
 * Layer 10 named scenarios (D35 — one file per scenario):
 *   scenario-1    — Happy Path (mint_rwt + admin_mint + revenue→yield→claim)
 *   scenario-2    — Governance (Futarchy proposal lifecycle)
 *   scenario-3    — DEX Standard (LP/swap/zap/remove + OT-pair fee)
 *   scenario-4    — Concentrated                                (placeholder)
 *   scenario-5    — Nexus 14-step                               (placeholder)
 *   scenario-6    — Emergency / Authority Closure               (placeholder)
 *   all           — Master orchestrator runs S1..S6 in sequence (D35)
 *
 * Scenario 1/2/3 inline-exec mode
 * --------------------------------
 * Default: structured `manual-run` notice (operator drives the test file).
 * Opt-in: set `SCENARIO_<N>_INLINE_EXEC=1` and the runner shells out to
 *   `npx tsx --test bots/.e2e/layer-10-scenario-<N>-<name>.test.ts`,
 * forwarding the bootstrap artifact path + RPC env. Exit code propagates.
 * Scenarios 4/5/6 remain manual-run placeholders until Substeps 7/8 land.
 *
 * Pre-flight:
 *   Reads `init_skipped[]` + `init_failed[]` from the bootstrap artifact and
 *   refuses scenarios whose contract precondition is missing — a clear
 *   "gated on Rxx" error is friendlier than a SendTransactionError dance.
 *
 * Not in scope:
 *   - LP-fee claiming via dashboard (manual TX path; covered by parity tests).
 *   - Long-running daemons (call cranks' `runOnce` / `runCycle` once).
 *
 * Output:
 *   - Console log per scenario step.
 *   - JSON artifact at data/e2e-runner-<scenario>-<UTC>.json containing the
 *     per-flow decision summary (no secrets).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, 'data');

// --------------------------------------------------------------------------
// Bootstrap state shape (minimum we need; mirrors bootstrap-init.ts).
// --------------------------------------------------------------------------

interface BootstrapOt {
  ot_mint: string;
  yd_distributor_pda?: string;
  yd_accumulator_pda?: string;
  reward_vault?: string;
  accumulator_usdc_ata?: string;
}

interface BootstrapState {
  schema_version: number;
  bootstrap_target: 'localhost' | 'devnet';
  rpc_url: string;
  ws_url?: string;
  deployer_keypair_path: string;
  programs: {
    ownership_token: string;
    native_dex: string;
    rwt_engine: string;
    yield_distribution: string;
  };
  mints?: { usdc_test_mint: string; rwt_mint?: string; arl_ot_mint?: string };
  pdas?: {
    dex_config?: string;
    rwt_vault?: string;
    liquidity_holding?: string;
    liquidity_nexus?: string;
    master_pool?: string;
  };
  ots?: BootstrapOt[];
  bots?: Record<string, { keypair_path: string; pubkey: string }>;
  init_skipped?: string[];
  init_failed?: { phase: string; error: string }[];
}

function loadBootstrap(path: string): BootstrapState {
  if (!existsSync(path)) {
    throw new Error(`bootstrap artifact missing at ${path} — run e2e-bootstrap.sh first`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as BootstrapState;
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(scope: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[e2e-runner][${scope}] ${msg}`;
  if (extra) console.log(line, JSON.stringify(extra));
  else console.log(line);
}

function warn(scope: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[e2e-runner][${scope}] WARN: ${msg}`;
  if (extra) console.warn(line, JSON.stringify(extra));
  else console.warn(line);
}

// --------------------------------------------------------------------------
// Scenario gating
// --------------------------------------------------------------------------

type Scenario =
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

const VALID_SCENARIOS: readonly Scenario[] = [
  'full',
  'revenue-only',
  'yield-only',
  'convert-only',
  'nexus-only',
  'lh-drain',
  'scenario-1',
  'scenario-2',
  'scenario-3',
  'scenario-4',
  'scenario-5',
  'scenario-6',
  'all',
];


interface GateCheck {
  ok: boolean;
  reason?: string;
}

function checkR57(state: BootstrapState): GateCheck {
  const failed = (state.init_failed ?? []).some((f) => f.phase.includes('initialize_nexus'));
  const skipped = (state.init_skipped ?? []).some((p) => p.includes('initialize_nexus'));
  if (failed || skipped || !state.pdas?.liquidity_nexus) {
    return { ok: false, reason: 'gated on R57 — Liquidity Nexus not initialized' };
  }
  return { ok: true };
}

function checkR20(state: BootstrapState): GateCheck {
  // T-32: align needle with bootstrap-init.ts canonical phase string
  // (`YD::initialize_liquidity_holding` — see bootstrap-init.ts:807-817).
  // Both init_skipped[] and init_failed[] entries match the same prefix.
  const failed = (state.init_failed ?? []).some((f) =>
    f.phase.includes('initialize_liquidity_holding'),
  );
  const skipped = (state.init_skipped ?? []).some((p) =>
    p.includes('initialize_liquidity_holding'),
  );
  if (failed || skipped || !state.pdas?.liquidity_holding) {
    return { ok: false, reason: 'gated on R20 — RWT mint pin migration / LiquidityHolding init pending' };
  }
  return { ok: true };
}

function gateScenario(scenario: Scenario, state: BootstrapState): GateCheck {
  switch (scenario) {
    case 'nexus-only':
      return checkR57(state);
    case 'lh-drain':
      return checkR20(state);
    case 'full':
      // 'full' degrades gracefully — runs only flows whose gate is clean.
      return { ok: true };
    default:
      return { ok: true };
  }
}

// --------------------------------------------------------------------------
// Per-flow runners
// --------------------------------------------------------------------------

interface FlowResult {
  flow: string;
  status: 'ok' | 'skipped' | 'error';
  reason?: string;
  details?: Record<string, unknown>;
}

async function runRevenue(state: BootstrapState): Promise<FlowResult> {
  // Direct in-process invocation of revenue-crank's runOnce is intentionally
  // NOT done here. The crank's BotConfig schema is owned by the workspace
  // (config.ts, EnvSchema) and constructing it from this script would freeze
  // a brittle copy of the schema. The supported operator path is:
  //
  //   1. `npx --prefix bots tsx scripts/lib/render-env.ts --bot revenue-crank`
  //   2. `npm -w revenue-crank run start` (with SEND_TX=true in .env)
  //
  // The runner's job is to gate-check + record the scenario; per-flow
  // execution stays in the bot's own daemon path.
  const otProjects = (state.ots ?? []).map((o) => new PublicKey(o.ot_mint));
  if (otProjects.length === 0) {
    return { flow: 'revenue', status: 'skipped', reason: 'no OTs in bootstrap' };
  }
  // Touch deployer to surface a config error early — every flow needs it.
  // Sec L-3: existsSync only — avoid loading the keypair into V8 heap when
  // we don't actually use the secret bytes for this gate-check.
  if (!existsSync(state.deployer_keypair_path)) {
    return {
      flow: 'revenue',
      status: 'skipped',
      reason: `deployer keypair missing at ${state.deployer_keypair_path}`,
    };
  }
  return {
    flow: 'revenue',
    status: 'skipped',
    reason: 'manual-run — `npm -w revenue-crank run start` after `render-env.ts --bot revenue-crank`',
    details: { otsBootstrapped: otProjects.length },
  };
}

async function runConvert(state: BootstrapState): Promise<FlowResult> {
  // We don't import the convert-and-fund-crank's runOnce directly because its
  // BotConfig requires more wiring (pool snapshot + slippage knobs) than
  // we can reasonably synthesise from the bootstrap. Instead we surface the
  // wiring gap — operators run the crank directly with its rendered .env.
  const hasMasterPool = !!state.pdas?.master_pool;
  if (!hasMasterPool) {
    return { flow: 'convert', status: 'skipped', reason: 'master_pool not bootstrapped' };
  }
  return {
    flow: 'convert',
    status: 'skipped',
    reason: 'manual-run — `npm -w convert-and-fund-crank run start` after `render-env.ts`',
  };
}

async function runYieldClaim(state: BootstrapState): Promise<FlowResult> {
  // Yield-claim-crank requires a fresh merkle proof per OT, which must come
  // from the publisher. The runner can't fabricate proofs — it surfaces the
  // wiring gap and points at the publisher mock instead.
  const distributorReady = (state.ots ?? []).some((o) => !!o.yd_distributor_pda);
  if (!distributorReady) {
    return {
      flow: 'yield-claim',
      status: 'skipped',
      reason: 'no YD distributors bootstrapped (OT[*].yd_distributor_pda missing)',
    };
  }
  return {
    flow: 'yield-claim',
    status: 'skipped',
    reason: 'manual-run — needs proofs from merkle-publisher; see bots/.e2e/README.md',
  };
}

async function runNexus(state: BootstrapState): Promise<FlowResult> {
  const gate = checkR57(state);
  if (!gate.ok) {
    return { flow: 'nexus', status: 'skipped', reason: gate.reason };
  }
  return {
    flow: 'nexus',
    status: 'skipped',
    reason: 'manual-run — `npm -w nexus-manager run start` after `render-env.ts`',
  };
}

async function runLhDrain(state: BootstrapState): Promise<FlowResult> {
  const gate = checkR20(state);
  if (!gate.ok) {
    return { flow: 'lh-drain', status: 'skipped', reason: gate.reason };
  }
  return {
    flow: 'lh-drain',
    status: 'skipped',
    reason: 'manual-run — operator-only (R-58 / SD-29 deferred)',
  };
}

// --------------------------------------------------------------------------
// Layer 10 scenario runners (D35 — one file per scenario)
// --------------------------------------------------------------------------

/**
 * Resolves the absolute path to the workspace `bots/` directory + the
 * scenario test file. Defensive against repository moves.
 */
function scenarioTestFile(scenarioNum: 1 | 2 | 3 | 4 | 5 | 6, name: string): string {
  return join(REPO_ROOT, 'bots', '.e2e', `layer-10-scenario-${scenarioNum}-${name}.test.ts`);
}

/**
 * Inline-exec hook for Scenario 1 (D35 + per-task-brief flag
 * `SCENARIO_1_INLINE_EXEC=1`). When enabled and targeting localhost, shells
 * out to the workspace's tsx test runner so the per-step assertions run
 * in-band with the runner's output. When disabled, returns a structured
 * `manual-run` notice matching the legacy per-flow runners.
 */
async function runScenario1(state: BootstrapState, artifactPath: string): Promise<FlowResult> {
  const testPath = scenarioTestFile(1, 'happy-path');
  if (!existsSync(testPath)) {
    return {
      flow: 'scenario-1',
      status: 'skipped',
      reason: `test file missing: ${testPath}`,
    };
  }

  const inlineExec = process.env.SCENARIO_1_INLINE_EXEC === '1';
  if (!inlineExec) {
    return {
      flow: 'scenario-1',
      status: 'skipped',
      reason:
        `manual-run — set SCENARIO_1_INLINE_EXEC=1 to drive in-process, ` +
        `or run \`npx tsx --test ${testPath}\``,
      details: { test_file: testPath },
    };
  }
  // Inline-exec: only meaningful for localhost target. Refuse devnet to keep
  // the runner from inadvertently driving live state from a CI runner.
  // (Localhost check + spawn are factored into runScenarioInlineExec so S1/S2/
  // S3 share one implementation — keeps the env-passthrough + tsxBin discovery
  // fix-once.)
  return runScenarioInlineExec(1, testPath, state, artifactPath);
}

/**
 * Shared inline-exec body for Layer 10 scenarios. Centralizes the
 * localhost-only check + narrow env passthrough + spawn pattern that S1/S2/S3
 * all share. Returns a FlowResult; callers prepend `flow=scenario-N`.
 *
 * SEC: env is built explicitly (not via shell expansion) to avoid quoting
 * issues with paths containing spaces.
 */
async function runScenarioInlineExec(
  scenarioNum: 1 | 2 | 3,
  testPath: string,
  state: BootstrapState,
  artifactPath: string,
): Promise<FlowResult> {
  const flow = `scenario-${scenarioNum}` as const;

  if (state.bootstrap_target !== 'localhost') {
    return {
      flow,
      status: 'skipped',
      reason: `inline-exec restricted to localhost (got ${state.bootstrap_target})`,
    };
  }

  log(flow, `inline-exec → tsx --test ${testPath}`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_BOOTSTRAP_ARTIFACT: artifactPath,
    RPC_URL: state.rpc_url,
  };
  const tsxBin = join(REPO_ROOT, 'bots', 'node_modules', '.bin', 'tsx');
  const tsxResolved = existsSync(tsxBin) ? tsxBin : 'tsx';
  const result = spawnSync(tsxResolved, ['--test', testPath], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    return { flow, status: 'error', reason: `spawn failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      flow,
      status: 'error',
      reason: `test process exited with code=${result.status} (signal=${result.signal ?? 'none'})`,
    };
  }
  return {
    flow,
    status: 'ok',
    reason: 'inline-exec passed',
    details: { test_file: testPath },
  };
}

/**
 * Inline-exec hook for Scenario 2 — Governance (Futarchy proposal lifecycle).
 * Mirrors `runScenario1` shape; opt-in via `SCENARIO_2_INLINE_EXEC=1`.
 */
async function runScenario2(state: BootstrapState, artifactPath: string): Promise<FlowResult> {
  const testPath = scenarioTestFile(2, 'governance');
  if (!existsSync(testPath)) {
    return {
      flow: 'scenario-2',
      status: 'skipped',
      reason: `test file missing: ${testPath}`,
    };
  }
  const inlineExec = process.env.SCENARIO_2_INLINE_EXEC === '1';
  if (!inlineExec) {
    return {
      flow: 'scenario-2',
      status: 'skipped',
      reason:
        `manual-run — set SCENARIO_2_INLINE_EXEC=1 to drive in-process, ` +
        `or run \`npx tsx --test ${testPath}\``,
      details: { test_file: testPath },
    };
  }
  return runScenarioInlineExec(2, testPath, state, artifactPath);
}

/**
 * Inline-exec hook for Scenario 3 — DEX Standard (StandardCurve LP/swap/zap/
 * remove + OT pair fee). Mirrors `runScenario1` shape; opt-in via
 * `SCENARIO_3_INLINE_EXEC=1`.
 */
async function runScenario3(state: BootstrapState, artifactPath: string): Promise<FlowResult> {
  const testPath = scenarioTestFile(3, 'dex');
  if (!existsSync(testPath)) {
    return {
      flow: 'scenario-3',
      status: 'skipped',
      reason: `test file missing: ${testPath}`,
    };
  }
  const inlineExec = process.env.SCENARIO_3_INLINE_EXEC === '1';
  if (!inlineExec) {
    return {
      flow: 'scenario-3',
      status: 'skipped',
      reason:
        `manual-run — set SCENARIO_3_INLINE_EXEC=1 to drive in-process, ` +
        `or run \`npx tsx --test ${testPath}\``,
      details: { test_file: testPath },
    };
  }
  return runScenarioInlineExec(3, testPath, state, artifactPath);
}

/**
 * Placeholder for Scenarios 4-6 — per D35, each scenario gets its own test
 * file. Substeps 7/8 ship those files; until then, return a structured
 * `manual-run` notice that points to the corresponding (yet-unshipped) path.
 */
function runScenarioPlaceholder(
  num: 4 | 5 | 6,
  name: string,
): FlowResult {
  const testPath = scenarioTestFile(num, name);
  return {
    flow: `scenario-${num}`,
    status: 'skipped',
    reason: existsSync(testPath)
      ? `test file present but inline-exec hook not implemented (Substep 7/8 lands per scenario)`
      : `test file not yet shipped: ${testPath}`,
    details: { test_file: testPath },
  };
}

// --------------------------------------------------------------------------
// Orchestrator
// --------------------------------------------------------------------------

interface RunReport {
  generated_at_utc: string;
  scenario: Scenario;
  bootstrap_path: string;
  rpc_url: string;
  flows: FlowResult[];
}

async function runScenario(
  scenario: Scenario,
  state: BootstrapState,
  artifactPath: string,
): Promise<FlowResult[]> {
  const flows: FlowResult[] = [];

  if (scenario === 'full' || scenario === 'revenue-only') {
    log('orch', 'flow=revenue (live-submit)');
    flows.push(await runRevenue(state));
  }
  if (scenario === 'full' || scenario === 'convert-only') {
    log('orch', 'flow=convert');
    flows.push(await runConvert(state));
  }
  if (scenario === 'full' || scenario === 'yield-only') {
    log('orch', 'flow=yield-claim');
    flows.push(await runYieldClaim(state));
  }
  if (scenario === 'full' || scenario === 'nexus-only') {
    log('orch', 'flow=nexus');
    flows.push(await runNexus(state));
  }
  if (scenario === 'lh-drain') {
    log('orch', 'flow=lh-drain');
    flows.push(await runLhDrain(state));
  }

  // Layer 10 named scenarios (D35).
  if (scenario === 'scenario-1' || scenario === 'all') {
    log('orch', 'flow=scenario-1');
    const s1Result = await runScenario1(state, artifactPath);
    flows.push(s1Result);
    // T-34 / SEC-78: halting --scenario all after a hard failure — running the
    // remaining scenarios against a half-broken happy path tends to mask the
    // root cause and burns CI time. Fail-fast is the safer default for ops;
    // operators who want to keep going can re-run individual scenarios. The
    // halt extends to S2/S3 since they share the same on-chain state and any
    // S1 fault would surface as cascading false-negatives downstream.
    if (scenario === 'all' && s1Result.status === 'error') {
      warn('orch', 'halt-after-error — Scenario 1 failed; skipping S2..S6');
      return flows;
    }
  }
  if (scenario === 'scenario-2' || scenario === 'all') {
    log('orch', 'flow=scenario-2');
    const s2Result = await runScenario2(state, artifactPath);
    flows.push(s2Result);
    if (scenario === 'all' && s2Result.status === 'error') {
      warn('orch', 'halt-after-error — Scenario 2 failed; skipping S3..S6');
      return flows;
    }
  }
  if (scenario === 'scenario-3' || scenario === 'all') {
    log('orch', 'flow=scenario-3');
    const s3Result = await runScenario3(state, artifactPath);
    flows.push(s3Result);
    if (scenario === 'all' && s3Result.status === 'error') {
      warn('orch', 'halt-after-error — Scenario 3 failed; skipping S4..S6');
      return flows;
    }
  }
  if (scenario === 'scenario-4' || scenario === 'all') {
    log('orch', 'flow=scenario-4');
    flows.push(runScenarioPlaceholder(4, 'concentrated'));
  }
  if (scenario === 'scenario-5' || scenario === 'all') {
    log('orch', 'flow=scenario-5');
    flows.push(runScenarioPlaceholder(5, 'nexus'));
  }
  if (scenario === 'scenario-6' || scenario === 'all') {
    log('orch', 'flow=scenario-6');
    flows.push(runScenarioPlaceholder(6, 'emergency'));
  }

  return flows;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Argv {
  scenario: Scenario;
  artifact: string;
  outputDir: string;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let scenario: Scenario = 'full';
  let artifact = DEFAULT_ARTIFACT_PATH;
  let outputDir = DEFAULT_OUTPUT_DIR;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if ((a === '--scenario' || a === '-s') && next !== undefined) {
      if ((VALID_SCENARIOS as readonly string[]).includes(next)) {
        scenario = next as Scenario;
      } else {
        throw new Error(`invalid scenario "${next}"; valid: ${VALID_SCENARIOS.join(', ')}`);
      }
      i++;
    } else if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--output-dir' && next !== undefined) {
      outputDir = next;
      i++;
    }
  }
  return { scenario, artifact, outputDir };
}

async function main(): Promise<void> {
  const argv = parseArgv();
  log('main', `loading bootstrap from ${argv.artifact}`);
  const state = loadBootstrap(argv.artifact);

  if (state.bootstrap_target !== 'localhost') {
    throw new Error(
      `e2e-runner only supports localhost (got ${state.bootstrap_target})`,
    );
  }

  const gate = gateScenario(argv.scenario, state);
  if (!gate.ok) {
    warn('main', `scenario=${argv.scenario} ${gate.reason}`);
    process.exit(2);
  }

  log('main', `running scenario="${argv.scenario}"`);
  // Resolve the artifact path so scenario test processes get the same
  // canonical path the runner used (avoids races with relative resolution
  // when shells out to a different cwd).
  const artifactAbs = resolve(argv.artifact);
  const flows = await runScenario(argv.scenario, state, artifactAbs);

  const report: RunReport = {
    generated_at_utc: new Date().toISOString(),
    scenario: argv.scenario,
    bootstrap_path: argv.artifact,
    rpc_url: state.rpc_url,
    flows,
  };

  mkdirSync(argv.outputDir, { recursive: true });
  const stamp = report.generated_at_utc.replace(/[:.]/g, '-');
  const outPath = join(argv.outputDir, `e2e-runner-${argv.scenario}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  log('main', `wrote ${outPath}`);

  for (const f of flows) {
    log('main', `  ${f.flow}: ${f.status}${f.reason ? ` — ${f.reason}` : ''}`);
  }

  // Surface a non-zero exit if any flow errored.
  const anyError = flows.some((f) => f.status === 'error');
  process.exit(anyError ? 1 : 0);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(`[e2e-runner] FATAL: ${msg}`);
  process.exit(1);
});
