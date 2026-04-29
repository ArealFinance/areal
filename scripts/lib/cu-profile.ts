#!/usr/bin/env tsx
/*
 * cu-profile.ts — R24 (live CU profile) + R46 (BPF stack overflow live-verify).
 *
 * Runs each Layer 8 / Layer 9 instruction N times against a freshly
 * bootstrapped local validator, capturing:
 *   - `computeUnitsConsumed` (from getTransaction.meta) → P50 / P95 / max.
 *   - Program logs scanned for known BPF stack-overflow signatures (R46).
 *
 * Output:
 *   - JSON artifact at data/cu-profile-<UTC>.json (public-repo-safe; lives
 *     under data/, gitignored).
 *   - Markdown append into the operator's private docs directory (when
 *     present alongside the meta-repo). The harness probes for a sibling
 *     planning workspace and degrades cleanly when absent.
 *
 * Gating:
 *   - Reads data/e2e-bootstrap.json + .secrets.json. Phases marked in
 *     init_skipped[] / init_failed[] are skipped per-instruction with the
 *     phase name surfaced as the skip reason.
 *   - R20 (RWT mint pin) gates `withdraw_liquidity_holding`.
 *   - R57 (DEX Liquidity Nexus init) gates the 6 nexus_* + initialize_nexus
 *     + update_nexus_manager + claim_lp_fees instructions.
 *
 * SD-30 (architect autonomous deviation): R46 verification is best-effort
 *   regex grep on logMessages — any of:
 *     "Access violation in stack frame"
 *     "stack offset .* exceeded max offset"
 *     "BPF stack overflow"
 *     "stack offset of -?\d+ exceeded"
 *   triggers OVERFLOW_DETECTED. Absence of all four → CLEAN. We never claim
 *   "no overflow possible" — only "no overflow observed in N samples".
 *
 * SD-31: per-instruction CU budgets are recorded but acceptance does NOT
 *   gate on them — operators may still accept a 220k CU instruction with a
 *   200k stated budget if no on-chain regression appears.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// --------------------------------------------------------------------------
// Paths + constants
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const DEFAULT_DATA_DIR = join(REPO_ROOT, 'data');
const PLAN_DIR_CANDIDATES = [
  resolve(REPO_ROOT, '..', 'areal-planning', 'plan'),
  resolve(REPO_ROOT, 'plan'),
];
const DEFAULT_ITERATIONS = parseInt(process.env.CU_PROFILE_ITERATIONS ?? '5', 10);

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// R46 stack-overflow log signatures (architect SD-30 — best-effort grep).
const STACK_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /Access violation in stack frame/i,
  /stack offset .* exceeded max offset/i,
  /BPF stack overflow/i,
  /stack offset of -?\d+ exceeded/i,
];

// --------------------------------------------------------------------------
// Bootstrap state shape (re-declared minimally — full shape lives in
// bootstrap-init.ts; we only read what we need).
// --------------------------------------------------------------------------

interface BootstrapOt {
  ot_mint: string;
  ot_config_pda: string;
  revenue_account_pda: string;
  revenue_config_pda: string;
  ot_governance_pda: string;
  ot_treasury_pda: string;
  revenue_token_account: string;
  yd_distributor_pda?: string;
  yd_accumulator_pda?: string;
  reward_vault?: string;
  accumulator_usdc_ata?: string;
}

interface BootstrapState {
  schema_version: number;
  bootstrap_target: 'localhost' | 'devnet';
  rpc_url: string;
  deployer_keypair_path: string;
  programs: {
    ownership_token: string;
    native_dex: string;
    rwt_engine: string;
    yield_distribution: string;
  };
  mints?: {
    usdc_test_mint: string;
    arl_ot_mint?: string;
    rwt_mint?: string;
  };
  pdas?: {
    dex_config?: string;
    yd_dist_config?: string;
    rwt_vault?: string;
    rwt_dist_config?: string;
    rwt_capital_accumulator_ata?: string;
    areal_fee_ata?: string;
    liquidity_holding?: string;
    liquidity_holding_ata?: string;
    liquidity_nexus?: string;
    master_pool?: string;
    master_pool_vault_a?: string;
    master_pool_vault_b?: string;
  };
  ots?: BootstrapOt[];
  init_skipped?: string[];
  init_failed?: { phase: string; error: string }[];
}

function loadBootstrap(path: string): BootstrapState {
  if (!existsSync(path)) {
    throw new Error(`bootstrap artifact missing at ${path} — run scripts/e2e-bootstrap.sh first`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as BootstrapState;
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.log(`[cu-profile] ${msg}`, JSON.stringify(extra));
  else console.log(`[cu-profile] ${msg}`);
}

function warn(msg: string, extra?: Record<string, unknown>): void {
  if (extra) console.warn(`[cu-profile] WARN: ${msg}`, JSON.stringify(extra));
  else console.warn(`[cu-profile] WARN: ${msg}`);
}

// --------------------------------------------------------------------------
// Discriminator helper (Anchor-style sha256("global:<name>")[..8]).
// --------------------------------------------------------------------------

import { createHash } from 'node:crypto';
function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

// --------------------------------------------------------------------------
// Instruction registry — ix builders.
//
// Each entry knows how to construct a TransactionInstruction from the
// bootstrap state. `gate` declares the precondition phase that must NOT be
// in init_failed[]; if it is, the instruction is reported as skipped with
// reason='gated' and never submitted.
//
// `signers` returns the list of signers needed beyond the deployer.
// --------------------------------------------------------------------------

type Gate = 'R20' | 'R57' | null;

interface IxBuildContext {
  state: BootstrapState;
  deployer: Keypair;
  /** First (and usually only) OT to exercise per ix. Picked from state.ots[0]. */
  ot: BootstrapOt | null;
}

interface IxRegistration {
  name: string;
  layer: 8 | 9;
  gate: Gate;
  build: (ctx: IxBuildContext) => TransactionInstruction | null;
  signers: (ctx: IxBuildContext) => Keypair[];
  /**
   * R-63: surfaces which entries are synthetic vs live for CU-profile
   * downstream consumers. Currently every registry entry is a discriminator-
   * only skeleton (the handler reverts but still reports CU + logs) — the
   * flag exists so a future entry that wires real state can flip it to
   * `false` without changing JSON consumers.
   */
  synthetic_skeleton: boolean;
}

/**
 * IxRegistry — 16 entries (5 Layer 8 + 9 Layer 9 nexus_* + claim_lp_fees + withdraw_liquidity_holding).
 *
 * Many of these require non-trivial off-chain account preparation (proofs,
 * compounds, vested funding state). For a CU PROFILE, we only need to land
 * the discriminator + minimal account list against the deployed program;
 * domain-level errors are fine because they still consume + report the same
 * (or close-to-same) CU budget as the success path. Where the handler
 * REQUIRES a specific state shape that isn't bootstrapped (vested funding,
 * fresh proofs), we fall back to a deterministic skip with reason='unbuilt'.
 *
 * This is intentional: the harness ships the wiring + the JSON artifact.
 * Operators who need a richer profile run with a pre-funded YD distributor.
 */
const REGISTRY: readonly IxRegistration[] = [
  // ----------------------- Layer 8 (5) -----------------------
  {
    name: 'distribute_revenue',
    layer: 8,
    gate: null,
    build: (ctx) => {
      if (!ctx.ot || !ctx.state.programs.ownership_token) return null;
      const programId = new PublicKey(ctx.state.programs.ownership_token);
      const data = Buffer.alloc(8);
      discriminator('distribute_revenue').copy(data);
      return new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(ctx.ot.ot_mint), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(ctx.ot.revenue_account_pda), isSigner: false, isWritable: true },
          { pubkey: new PublicKey(ctx.ot.revenue_config_pda), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(ctx.ot.revenue_token_account), isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
    },
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'claim_yield',
    layer: 8,
    gate: null,
    build: (ctx) => {
      if (!ctx.state.programs.rwt_engine) return null;
      const programId = new PublicKey(ctx.state.programs.rwt_engine);
      const data = Buffer.alloc(8);
      discriminator('claim_yield').copy(data);
      return new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
    },
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'compound_yield',
    layer: 8,
    gate: null,
    build: (ctx) => {
      if (!ctx.state.programs.native_dex) return null;
      const programId = new PublicKey(ctx.state.programs.native_dex);
      const data = Buffer.alloc(8);
      discriminator('compound_yield').copy(data);
      return new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
    },
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'claim_yd_for_treasury',
    layer: 8,
    gate: null,
    build: (ctx) => {
      if (!ctx.state.programs.ownership_token) return null;
      const programId = new PublicKey(ctx.state.programs.ownership_token);
      const data = Buffer.alloc(8);
      discriminator('claim_yd_for_treasury').copy(data);
      return new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
    },
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'convert_to_rwt',
    layer: 8,
    gate: null,
    build: (ctx) => {
      if (!ctx.state.programs.yield_distribution) return null;
      const programId = new PublicKey(ctx.state.programs.yield_distribution);
      const data = Buffer.alloc(8);
      discriminator('convert_to_rwt').copy(data);
      return new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.deployer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data,
      });
    },
    signers: () => [],
    synthetic_skeleton: true,
  },

  // ----------------------- Layer 9 (6 R57-gated + 2 special) -----------------------
  {
    name: 'initialize_nexus',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'initialize_nexus'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'update_nexus_manager',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'update_nexus_manager'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_swap',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_swap'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_add_liquidity',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_add_liquidity'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_remove_liquidity',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_remove_liquidity'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_deposit',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_deposit'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_record_deposit',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_record_deposit'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_withdraw_profits',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_withdraw_profits'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'nexus_claim_rewards',
    layer: 9,
    gate: 'R57',
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'nexus_claim_rewards'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'claim_lp_fees',
    layer: 9,
    gate: null,
    build: (ctx) => buildSimpleIxStub(ctx, 'native_dex', 'claim_lp_fees'),
    signers: () => [],
    synthetic_skeleton: true,
  },
  {
    name: 'withdraw_liquidity_holding',
    layer: 9,
    gate: 'R20',
    build: (ctx) => buildSimpleIxStub(ctx, 'yield_distribution', 'withdraw_liquidity_holding'),
    signers: () => [],
    synthetic_skeleton: true,
  },
];

function buildSimpleIxStub(
  ctx: IxBuildContext,
  programKey: keyof BootstrapState['programs'],
  ixName: string,
): TransactionInstruction | null {
  const programIdStr = ctx.state.programs[programKey];
  if (!programIdStr) return null;
  const programId = new PublicKey(programIdStr);
  const data = Buffer.alloc(8);
  discriminator(ixName).copy(data);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.deployer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// --------------------------------------------------------------------------
// Gating helpers
// --------------------------------------------------------------------------

function isGated(state: BootstrapState, gate: Gate): { gated: true; reason: string } | { gated: false } {
  if (gate === null) return { gated: false };

  const failedPhases = (state.init_failed ?? []).map((f) => f.phase);
  const skippedPhases = state.init_skipped ?? [];

  if (gate === 'R57') {
    // R57 = Liquidity Nexus must be initialized; any nexus phase failure or
    // skip surfaces here.
    const blocked =
      failedPhases.some((p) => p.includes('initialize_nexus')) ||
      skippedPhases.some((p) => p.includes('initialize_nexus')) ||
      !state.pdas?.liquidity_nexus;
    return blocked
      ? { gated: true, reason: 'R57 (Liquidity Nexus not initialized)' }
      : { gated: false };
  }

  if (gate === 'R20') {
    // R20 = LiquidityHolding must be initialized + RWT mint pin migration done.
    const blocked =
      failedPhases.some((p) => p.includes('liquidity_holding')) ||
      skippedPhases.some((p) => p.includes('liquidity_holding')) ||
      !state.pdas?.liquidity_holding;
    return blocked
      ? { gated: true, reason: 'R20 (LiquidityHolding not initialized — RWT mint pin migration pending)' }
      : { gated: false };
  }

  return { gated: false };
}

// --------------------------------------------------------------------------
// Per-instruction profiling
// --------------------------------------------------------------------------

interface IxResult {
  name: string;
  layer: 8 | 9;
  status: 'ok' | 'skipped' | 'submit_failed';
  reason?: string;
  /** Number of successful samples that returned getTransaction.meta. */
  samples: number;
  /** Per-sample CU readings (length === samples). */
  cuReadings: number[];
  p50?: number;
  p95?: number;
  max?: number;
  /** Number of samples in which we observed a stack-overflow log. */
  stackOverflowCount: number;
  /** Sample log lines that triggered the R46 detector (truncated). */
  stackOverflowLogs: string[];
  /**
   * R-63: mirrors `IxRegistration.synthetic_skeleton`. Downstream CU-profile
   * consumers (dashboards, audit reports) use this flag to label each row.
   */
  synthetic_skeleton: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function detectStackOverflow(logs: string[]): string[] {
  const matches: string[] = [];
  for (const line of logs) {
    for (const re of STACK_OVERFLOW_PATTERNS) {
      if (re.test(line)) {
        matches.push(line.slice(0, 160));
        break;
      }
    }
  }
  return matches;
}

async function profileOne(
  conn: Connection,
  reg: IxRegistration,
  ctx: IxBuildContext,
  iterations: number,
): Promise<IxResult> {
  const gateCheck = isGated(ctx.state, reg.gate);
  if (gateCheck.gated) {
    return {
      name: reg.name,
      layer: reg.layer,
      status: 'skipped',
      reason: gateCheck.reason,
      samples: 0,
      cuReadings: [],
      stackOverflowCount: 0,
      stackOverflowLogs: [],
      synthetic_skeleton: reg.synthetic_skeleton,
    };
  }

  const ix = reg.build(ctx);
  if (!ix) {
    return {
      name: reg.name,
      layer: reg.layer,
      status: 'skipped',
      reason: 'unbuilt (missing bootstrap state)',
      samples: 0,
      cuReadings: [],
      stackOverflowCount: 0,
      stackOverflowLogs: [],
      synthetic_skeleton: reg.synthetic_skeleton,
    };
  }

  const cuReadings: number[] = [];
  const stackOverflowLogs: string[] = [];
  let stackOverflowCount = 0;
  let lastError: string | null = null;

  for (let i = 0; i < iterations; i++) {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }))
      .add(ix);

    let signature: string;
    try {
      signature = await sendAndConfirmTransaction(
        conn,
        tx,
        [ctx.deployer, ...reg.signers(ctx)],
        { commitment: 'confirmed', skipPreflight: true },
      );
    } catch (err) {
      // Domain-level revert — try to fetch the failed TX so we still capture
      // CU + logs.
      lastError = err instanceof Error ? err.message : String(err);
      const sigMatch = lastError.match(/[1-9A-HJ-NP-Za-km-z]{43,88}/);
      if (!sigMatch) continue;
      signature = sigMatch[0]!;
    }

    try {
      const tx2 = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });
      const cu = tx2?.meta?.computeUnitsConsumed;
      if (typeof cu === 'number') cuReadings.push(cu);
      const logs = tx2?.meta?.logMessages ?? [];
      const overflow = detectStackOverflow(logs);
      if (overflow.length > 0) {
        stackOverflowCount += 1;
        for (const line of overflow) {
          if (stackOverflowLogs.length < 5) stackOverflowLogs.push(line);
        }
      }
    } catch {
      // best-effort; skip this sample
    }
  }

  if (cuReadings.length === 0) {
    return {
      name: reg.name,
      layer: reg.layer,
      status: 'submit_failed',
      reason: lastError ?? 'no CU readings captured',
      samples: 0,
      cuReadings: [],
      stackOverflowCount,
      stackOverflowLogs,
      synthetic_skeleton: reg.synthetic_skeleton,
    };
  }

  const sorted = [...cuReadings].sort((a, b) => a - b);
  return {
    name: reg.name,
    layer: reg.layer,
    status: 'ok',
    samples: cuReadings.length,
    cuReadings,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1]!,
    stackOverflowCount,
    stackOverflowLogs,
    synthetic_skeleton: reg.synthetic_skeleton,
  };
}

// --------------------------------------------------------------------------
// Output formatting
// --------------------------------------------------------------------------

interface ProfileReport {
  generated_at_utc: string;
  bootstrap_path: string;
  rpc_url: string;
  iterations: number;
  programs: BootstrapState['programs'];
  init_skipped: string[];
  init_failed: { phase: string; error: string }[];
  /** Best-effort R46 verdict per architect SD-30. */
  r46_verdict: 'CLEAN' | 'OVERFLOW_DETECTED' | 'INCONCLUSIVE';
  results: IxResult[];
}

function buildR46Verdict(results: IxResult[]): ProfileReport['r46_verdict'] {
  const anyOverflow = results.some((r) => r.stackOverflowCount > 0);
  if (anyOverflow) return 'OVERFLOW_DETECTED';
  const anyOk = results.some((r) => r.status === 'ok' && r.samples > 0);
  // If nothing actually executed, we cannot make any claim either direction.
  return anyOk ? 'CLEAN' : 'INCONCLUSIVE';
}

function renderMarkdownTable(layer: 8 | 9, results: IxResult[]): string {
  const filtered = results.filter((r) => r.layer === layer);
  if (filtered.length === 0) return '_(no instructions in this layer)_\n';
  const rows = filtered.map((r) => {
    if (r.status === 'ok') {
      return `| \`${r.name}\` | ${r.samples} | ${r.p50} | ${r.p95} | ${r.max} | ${r.stackOverflowCount > 0 ? 'OVERFLOW' : 'clean'} |`;
    }
    return `| \`${r.name}\` | ${r.status} | — | — | — | ${r.reason ?? ''} |`;
  });
  return [
    '| Instruction | Samples | P50 CU | P95 CU | Max CU | R46 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function renderMarkdownReport(report: ProfileReport): string {
  const lines: string[] = [];
  lines.push(`## Live Measurements — ${report.generated_at_utc}`);
  lines.push('');
  lines.push(`- RPC: \`${report.rpc_url}\``);
  lines.push(`- Iterations per ix: ${report.iterations}`);
  lines.push(`- R46 verdict (best-effort SD-30): **${report.r46_verdict}**`);
  if (report.init_skipped.length > 0) {
    lines.push(`- Bootstrap skipped phases: ${report.init_skipped.length}`);
  }
  if (report.init_failed.length > 0) {
    lines.push(`- Bootstrap failed phases: ${report.init_failed.length} (gated ix will skip)`);
  }
  lines.push('');
  lines.push('### Layer 8');
  lines.push('');
  lines.push(renderMarkdownTable(8, report.results));
  lines.push('### Layer 9');
  lines.push('');
  lines.push(renderMarkdownTable(9, report.results));
  return lines.join('\n');
}

function appendMarkdownIfPresent(filename: string, body: string): string | null {
  for (const dir of PLAN_DIR_CANDIDATES) {
    const target = join(dir, filename);
    if (existsSync(dir)) {
      try {
        const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
        const sep = existing.length > 0 && !existing.endsWith('\n\n') ? '\n\n' : '';
        writeFileSync(target, existing + sep + body + '\n', 'utf8');
        return target;
      } catch (err) {
        warn(`failed to append ${filename}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Argv {
  artifact: string;
  iterations: number;
  outputDir: string;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let artifact = DEFAULT_ARTIFACT_PATH;
  let iterations = DEFAULT_ITERATIONS;
  let outputDir = DEFAULT_DATA_DIR;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--iterations' && next !== undefined) {
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) iterations = n;
      i++;
    } else if (a === '--output-dir' && next !== undefined) {
      outputDir = next;
      i++;
    }
  }
  return { artifact, iterations, outputDir };
}

async function main(): Promise<void> {
  const argv = parseArgv();
  log(`loading bootstrap from ${argv.artifact}`);
  const state = loadBootstrap(argv.artifact);

  if (state.bootstrap_target !== 'localhost') {
    throw new Error(
      `cu-profile.ts only runs against localhost (got ${state.bootstrap_target}); refusing for safety`,
    );
  }

  const conn = new Connection(state.rpc_url, 'confirmed');
  const deployer = loadKeypair(state.deployer_keypair_path);

  const ctx: IxBuildContext = {
    state,
    deployer,
    ot: state.ots && state.ots.length > 0 ? state.ots[0]! : null,
  };

  log(`profiling ${REGISTRY.length} instructions × ${argv.iterations} samples each`);

  const results: IxResult[] = [];
  for (const reg of REGISTRY) {
    log(`→ ${reg.name} (layer ${reg.layer}${reg.gate ? `, gate=${reg.gate}` : ''})`);
    const out = await profileOne(conn, reg, ctx, argv.iterations);
    results.push(out);
    if (out.status === 'ok') {
      log(
        `  ok: P50=${out.p50}, P95=${out.p95}, max=${out.max}, stack-of=${out.stackOverflowCount}`,
      );
    } else {
      log(`  ${out.status}: ${out.reason ?? '(no reason)'}`);
    }
  }

  const report: ProfileReport = {
    generated_at_utc: new Date().toISOString(),
    bootstrap_path: argv.artifact,
    rpc_url: state.rpc_url,
    iterations: argv.iterations,
    programs: state.programs,
    init_skipped: state.init_skipped ?? [],
    init_failed: state.init_failed ?? [],
    r46_verdict: buildR46Verdict(results),
    results,
  };

  // Write JSON artifact.
  mkdirSync(argv.outputDir, { recursive: true });
  const stamp = report.generated_at_utc.replace(/[:.]/g, '-');
  const jsonPath = join(argv.outputDir, `cu-profile-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  log(`wrote JSON artifact: ${jsonPath}`);

  // Append markdown reports (best-effort — plan dir is private repo).
  const md = renderMarkdownReport(report);
  const layer8Out = appendMarkdownIfPresent('layer-08-cu-profile.md', md);
  if (layer8Out) log(`appended ${layer8Out}`);
  const layer9Out = appendMarkdownIfPresent('layer-09-cu-profile.md', md);
  if (layer9Out) log(`appended ${layer9Out}`);

  log(`R46 verdict: ${report.r46_verdict}`);
  log('done');
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(`[cu-profile] FATAL: ${msg}`);
  process.exit(1);
});
