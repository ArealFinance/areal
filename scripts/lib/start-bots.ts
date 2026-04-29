#!/usr/bin/env tsx
/*
 * start-bots.ts — Layer 10 substep 4 (Phase 8) bot orchestrator.
 *
 * Funds + spawns the 6 off-chain bots that drive the live protocol after
 * the authority chain (Phase 7) lands. Idempotent re-runs are a hard
 * requirement: re-execution after a partial failure must NOT double-fund
 * a wallet, NOR spawn a duplicate process.
 *
 * Three stages:
 *
 *   Stage 1 — fund bot wallets
 *     Per-bot pubkey balance check. If `< fundingLamports`, top up via a
 *     plain SystemProgram.transfer signed by the deployer. Validates the
 *     deployer carries enough SOL to cover all 6 transfers BEFORE issuing
 *     any TX (no half-funded fleet). Skips already-funded bots.
 *
 *   Stage 2 — ordered startup (D33)
 *     pool-rebalancer → merkle-publisher → [block on first merkle root
 *     publish] → revenue-crank → convert-and-fund-crank → yield-claim-crank
 *     → nexus-manager.
 *     The block-on-first-root step uses an on-chain liveness probe rather
 *     than the /health HTTP endpoint referenced in earlier design notes —
 *     the merkle-publisher does not currently expose /health, but the YD
 *     MerkleDistributor PDA gives an authoritative readout of the same
 *     property (see assertFirstRootPublished below).
 *
 *   Stage 3 — heartbeat verification
 *     For each spawned child: ensure the process is still alive (no early
 *     exit). On success, stamp `art.bots_started_at` and persist.
 *
 * R-C — bot startup race mitigation:
 *   Yield Claim Crank queries the distributor for a Merkle proof on every
 *   cycle. Without a published root its first cycle logs a missing-root
 *   error and burns a sleep cycle — annoying, not catastrophic. The fix is
 *   strict ordering: yield-claim-crank does NOT spawn until the publisher
 *   has produced a non-zero merkle_root on-chain. The wait is bounded by
 *   `firstRootTimeoutMs` (default 10 min); on timeout the orchestrator
 *   exits non-zero and Phase 8 fails the deploy.
 *
 * Substep 3 readiness gate:
 *   `art.authority_chain.completed_at` must be present before stage 1
 *   begins. If absent the orchestrator throws — Phase 8 cannot run before
 *   Phase 7's authority chain handover lands and verifies.
 *
 * CLI:
 *   node --enable-source-maps scripts/lib/start-bots.js \
 *       --artifact data/e2e-bootstrap.json \
 *       [--dry-run] [--funding-lamports <n>] [--first-root-timeout-ms <ms>]
 *
 * Env (override-only; CLI flags win):
 *   FUNDING_LAMPORTS              per-bot funding floor in lamports
 *   FIRST_ROOT_TIMEOUT_MS         publisher block timeout
 *   POLL_INTERVAL_MS              poll cadence for stage 2 wait
 */

import * as fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { assertAuthorityChainComplete } from './zero-authority-audit.js';

// --------------------------------------------------------------------------
// Paths + constants
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');

/** Per-bot funding floor: 0.1 SOL. */
const DEFAULT_FUNDING_LAMPORTS = 100_000_000;

/** Sanity ceiling for per-bot funding: 1 SOL — anything larger is rejected
 *  to prevent a fat-finger drain of the deployer wallet. */
const MAX_FUNDING_LAMPORTS = 1_000_000_000;

/** Default publisher first-root timeout: 10 minutes. */
const DEFAULT_FIRST_ROOT_TIMEOUT_MS = 10 * 60 * 1000;

/** Poll cadence for the publisher first-root wait. */
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** Heartbeat dwell — give each spawned child time to fail its async startup
 *  checks before declaring it healthy. T-29 raised this from 3s → 30s so a
 *  bot whose async preflight (DB migration, RPC handshake, schema check) is
 *  in flight has a chance to throw before we walk away. 30s is a compromise
 *  between catching slow-start failures and not inflating phase-8 wall
 *  time; tune via env if specific bots prove slower than this floor. */
const HEARTBEAT_DWELL_MS = 30_000;

/** Reasonable upper bound on poll cadence — keeps stage 2 responsive. */
const MAX_POLL_INTERVAL_MS = 60_000;

/**
 * MerkleDistributor on-chain layout (cross-checked against
 * contracts/yield-distribution/src/state.rs):
 *   8   discriminator
 *   8   ot_mint            [u8; 32]
 *   40  reward_vault       [u8; 32]
 *   72  accumulator        [u8; 32]
 *   104 merkle_root        [u8; 32]   ← polled here
 */
const MERKLE_ROOT_OFFSET = 104;
const MERKLE_ROOT_SIZE = 32;

// --------------------------------------------------------------------------
// Bot registry — 6 bots per Layer 10 architecture §Phase 8.
// `keypairBotName` maps the bot to its entry in `art.bots[<name>]`. The
// merkle-publisher uses a dedicated `local-mock-keypair.json` file at the
// bot's directory root rather than a data/ subdir — bootstrap-init and the
// e2e-bootstrap.sh stage_bots step both write that file out-of-band.
// --------------------------------------------------------------------------

type BotName =
  | 'pool-rebalancer'
  | 'merkle-publisher'
  | 'revenue-crank'
  | 'convert-and-fund-crank'
  | 'yield-claim-crank'
  | 'nexus-manager';

interface BotSpec {
  name: BotName;
  /** Working directory under <repo>/bots. */
  dir: string;
  /** npm script to invoke (always `start` per Layer 10 plan). */
  npmScript: 'start';
  /** Where to read the bot's pubkey from. Either `art.bots[<keypairBotName>]`
   *  or — for merkle-publisher — read pubkey from the local-mock-keypair file. */
  keypairBotName?: string;
  /** For merkle-publisher: a relative path under bots/<dir> that holds the
   *  bot's keypair file. */
  localKeypairPath?: string;
}

const BOT_REGISTRY: BotSpec[] = [
  {
    name: 'pool-rebalancer',
    dir: 'pool-rebalancer',
    npmScript: 'start',
    keypairBotName: 'pool-rebalancer',
  },
  {
    name: 'merkle-publisher',
    dir: 'merkle-publisher',
    npmScript: 'start',
    keypairBotName: 'merkle-publisher',
    localKeypairPath: 'local-mock-keypair.json',
  },
  {
    name: 'revenue-crank',
    dir: 'revenue-crank',
    npmScript: 'start',
    keypairBotName: 'revenue-crank',
  },
  {
    name: 'convert-and-fund-crank',
    dir: 'convert-and-fund-crank',
    npmScript: 'start',
    keypairBotName: 'convert-and-fund-crank',
  },
  {
    name: 'yield-claim-crank',
    dir: 'yield-claim-crank',
    npmScript: 'start',
    keypairBotName: 'yield-claim-crank',
  },
  {
    name: 'nexus-manager',
    dir: 'nexus-manager',
    npmScript: 'start',
    keypairBotName: 'nexus-manager',
  },
];

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[start-bots] [${stage}] ${msg}`;
  if (extra) {
    console.log(line, JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

// (warn helper omitted — current logic surfaces all transient conditions
// either via log() or by throwing; reintroduce when first soft-fail path
// lands.)

// --------------------------------------------------------------------------
// Artifact shape — only the fields this driver needs (matches the layered
// pattern used by transfer-authority.ts).
// --------------------------------------------------------------------------

interface AuthorityChainArtifact {
  ot_to_futarchy_at?: string;
  futarchy_to_multisig_at?: string;
  rwt_to_multisig_at?: string;
  dex_to_multisig_at?: string;
  yd_to_multisig_at?: string;
  multisig_pubkey?: string;
  completed_at?: string;
}

interface OtRecord {
  ot_mint: string;
  yd_distributor_pda?: string;
  /** Required by `assertAuthorityChainComplete` (T-21 on-chain re-verification). */
  ot_governance_pda: string;
  /** Required by `assertAuthorityChainComplete` (T-21 on-chain re-verification). */
  futarchy_config_pda?: string;
}

interface BotProcessRecord {
  pid: number;
  started_at: string;
  log_file: string;
}

interface Artifact {
  schema_version?: number;
  bootstrap_target?: 'localhost' | 'devnet';
  rpc_url: string;
  deployer_keypair_path: string;
  deployer_pubkey: string;
  programs: {
    ownership_token: string;
    native_dex: string;
    rwt_engine: string;
    yield_distribution: string;
    futarchy: string;
  };
  mints?: {
    arl_ot_mint?: string;
  };
  pdas?: {
    yd_dist_config?: string;
    /** Required by `assertAuthorityChainComplete` (T-21 on-chain re-verification). */
    rwt_vault?: string;
    /** Required by `assertAuthorityChainComplete` (T-21 on-chain re-verification). */
    dex_config?: string;
  };
  ots?: OtRecord[];
  bots?: Record<
    string,
    {
      keypair_path: string;
      pubkey: string;
      lamports?: number;
    }
  >;
  authority_chain?: AuthorityChainArtifact;
  /** Layer 10 substep 4 — populated by start-bots.ts. */
  bot_processes?: Partial<Record<BotName, BotProcessRecord>>;
  bots_started_at?: string;
  first_root_published_at?: string;
}

// --------------------------------------------------------------------------
// Artifact I/O — public file only; mirrors transfer-authority.ts (0o600,
// strip secret-adjacent fields before writing).
// --------------------------------------------------------------------------

function secretsPathFor(artifactPath: string): string {
  const ext = artifactPath.endsWith('.json') ? '.json' : '';
  const base = ext ? artifactPath.slice(0, -ext.length) : artifactPath;
  return `${base}.secrets${ext || '.json'}`;
}

function loadArtifact(path: string): Artifact {
  if (!fs.existsSync(path)) {
    throw new Error(`artifact not found: ${path}`);
  }
  // SEC-59: defense-in-depth — resolve symlinks and assert the artifact lives
  // under <REPO_ROOT>/data/. Prevents a malicious symlink from redirecting the
  // orchestrator to a writable directory outside the repo (which would let an
  // attacker substitute a poisoned artifact + keypair-path tuple).
  const realArtifactPath = fs.realpathSync(path);
  const dataDir = resolve(join(REPO_ROOT, 'data')) + '/';
  if (!realArtifactPath.startsWith(dataDir)) {
    throw new Error(
      `phase-8 FATAL: artifact path ${realArtifactPath} escapes ${dataDir} ` +
        `(resolved from ${path})`,
    );
  }
  const merged = JSON.parse(fs.readFileSync(path, 'utf8')) as Artifact;
  // Re-merge secrets file if present so we can find the deployer keypair path
  // and the per-bot keypair paths (the public artifact may have been stripped).
  const secretsPath = secretsPathFor(path);
  if (fs.existsSync(secretsPath)) {
    const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as {
      deployer_keypair_path?: string;
      bots?: Record<string, { keypair_path?: string; pubkey?: string }>;
    };
    if (secrets.deployer_keypair_path && !merged.deployer_keypair_path) {
      merged.deployer_keypair_path = secrets.deployer_keypair_path;
    }
    if (secrets.bots) {
      merged.bots = { ...(merged.bots ?? {}) };
      for (const [k, v] of Object.entries(secrets.bots)) {
        const existing = merged.bots[k] ?? { keypair_path: '', pubkey: '' };
        merged.bots[k] = {
          keypair_path: v.keypair_path ?? existing.keypair_path,
          pubkey: v.pubkey ?? existing.pubkey,
        };
      }
    }
  }
  return merged;
}

/**
 * Save the public artifact preserving 0o600 perms. Defensively strip any
 * secret-adjacent fields before writing (mirrors transfer-authority.ts
 * SEC-44 pattern).
 */
function saveArtifactPublic(path: string, art: Artifact): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copy = JSON.parse(JSON.stringify(art)) as any;
  delete copy.deployer_keypair_path;
  delete copy.bots;
  fs.writeFileSync(path, JSON.stringify(copy, null, 2) + '\n', 'utf8');
  try {
    fs.chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystem — best-effort.
  }
}

/**
 * Load a Solana keypair from a JSON file. Mirrors the transfer-authority.ts
 * SEC-37 permission gate: refuse to read a file with group/other bits set.
 *
 * SEC-63: stat() and the perm-check throw are kept in separate try blocks so
 * the perm-check error doesn't get wrapped/swallowed by a broad stat catch.
 */
function loadKeypair(path: string): Keypair {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to stat keypair file ${path}: ${msg}`);
  }
  const looseBits = stat.mode & 0o077;
  if (looseBits !== 0) {
    throw new Error(
      `keypair file ${path} has loose permissions (mode ${(stat.mode & 0o777)
        .toString(8)
        .padStart(3, '0')}); expected 600 (run: chmod 600 ${path})`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/**
 * Read just the public key from a keypair file without dropping the strict
 * permission gate. Used when we don't need to sign — only need the pubkey
 * for balance probes.
 */
function readPubkeyFromKeypairFile(path: string): PublicKey {
  return loadKeypair(path).publicKey;
}

// --------------------------------------------------------------------------
// Pre-flight gates
// --------------------------------------------------------------------------

interface ResolvedBotKeypair {
  spec: BotSpec;
  keypairPath: string;
  pubkey: PublicKey;
}

/**
 * Substep 3 readiness gate. Refuses to proceed unless Phase 7 stamped a
 * `completed_at` timestamp in the artifact AND the on-chain authority chain
 * actually matches the expected post-Phase-7 state.
 *
 * T-21: an attacker (or a stale rerun) could fake `completed_at` without the
 * underlying transfers having landed; the on-chain audit closes that gap by
 * reading every contract's authority field and comparing against the expected
 * target (multisig / Futarchy). We import the same helper used by Phase 7's
 * own post-chain verification, so cross-coverage is preserved.
 */
async function assertSubstep3Ready(conn: Connection, art: Artifact): Promise<void> {
  const ts = art.authority_chain?.completed_at;
  if (!ts || ts.length === 0) {
    throw new Error(
      `phase-8 FATAL: Phase 7 authority chain not complete (Substep 3 must run first). ` +
        `art.authority_chain.completed_at is missing or empty. ` +
        `Run scripts/lib/transfer-authority.ts and verify it stamps completed_at.`,
    );
  }

  const multisigB58 = art.authority_chain?.multisig_pubkey;
  if (!multisigB58 || multisigB58.length === 0) {
    throw new Error(
      `phase-8 FATAL: art.authority_chain.multisig_pubkey is missing — Phase 7 must ` +
        `populate this field. Re-run scripts/lib/transfer-authority.ts.`,
    );
  }
  let multisigPubkey: PublicKey;
  try {
    multisigPubkey = new PublicKey(multisigB58);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `phase-8 FATAL: art.authority_chain.multisig_pubkey is not a valid base58 ` +
        `pubkey (${multisigB58}): ${msg}`,
    );
  }

  // Defense-in-depth: re-verify the on-chain authority chain is really at the
  // expected target. Catches stale completed_at after manual rotation back to
  // the deployer and hostile artifact edits that fake the timestamp.
  const audit = await assertAuthorityChainComplete(conn, { multisigPubkey }, art);
  if (!audit.ok) {
    throw new Error(
      `phase-8 FATAL: art.authority_chain.completed_at is stamped but on-chain audit ` +
        `disagrees: mismatches=${audit.mismatches.join(', ')}. ` +
        `Phase 7 must be re-run before Phase 8 can proceed.`,
    );
  }
}

/**
 * Resolve the keypair file path + pubkey for each bot from the artifact.
 * SEC-37 mirror — loadKeypair() inside readPubkeyFromKeypairFile rejects
 * any file with loose permissions, so this also gates 0o600 enforcement.
 */
function resolveBotKeypairs(art: Artifact): ResolvedBotKeypair[] {
  const out: ResolvedBotKeypair[] = [];
  for (const spec of BOT_REGISTRY) {
    let kpPath: string | undefined;

    // Source #1 — artifact-recorded keypair_path.
    if (spec.keypairBotName) {
      const entry = art.bots?.[spec.keypairBotName];
      if (entry?.keypair_path) {
        kpPath = entry.keypair_path;
      }
    }

    // Source #2 — local-mock-keypair fallback for merkle-publisher (matches
    // the e2e-bootstrap.sh stage_bots layout where the publisher's keypair
    // sits in bots/merkle-publisher/local-mock-keypair.json, separate from
    // the data/ subdir used by the cranks).
    if (!kpPath && spec.localKeypairPath) {
      kpPath = join(REPO_ROOT, 'bots', spec.dir, spec.localKeypairPath);
    }

    if (!kpPath) {
      throw new Error(
        `phase-8 FATAL: bot ${spec.name} has no keypair path — neither ` +
          `art.bots[${spec.keypairBotName ?? '<unset>'}] nor local fallback. ` +
          `Run e2e-bootstrap.sh stage 7/bots first.`,
      );
    }
    if (!fs.existsSync(kpPath)) {
      throw new Error(
        `phase-8 FATAL: bot ${spec.name} keypair not found at ${kpPath}. ` +
          `Run e2e-bootstrap.sh stage 7/bots first.`,
      );
    }

    const pubkey = readPubkeyFromKeypairFile(kpPath);
    out.push({ spec, keypairPath: kpPath, pubkey });
  }
  return out;
}

// --------------------------------------------------------------------------
// Stage 1 — fund bot wallets (idempotent)
// --------------------------------------------------------------------------

/**
 * Pre-flight: deployer must hold >= sum(bots needing top-up) + a small
 * fee buffer. Computed AFTER the per-bot balance probe so already-funded
 * bots don't inflate the requirement.
 *
 * A-41: returns the actual aggregate delta (post-balance minus pre-balance,
 * summed across all bots) so the caller surfaces a truthful "we deposited
 * N lamports" line rather than a fixed-target reconstruction. On a re-run
 * with all bots already at floor this returns 0.
 */
async function fundBots(
  conn: Connection,
  deployer: Keypair,
  bots: ResolvedBotKeypair[],
  fundingLamports: number,
  dryRun: boolean,
): Promise<number> {
  const stage = 'stage-1-fund';

  // Compute per-bot deltas first. Capture pre-balances so we can compute the
  // actual delta after each transfer lands (A-41).
  const plans: Array<{
    bot: ResolvedBotKeypair;
    preBalance: number;
    needed: number;
  }> = [];
  for (const b of bots) {
    const preBalance = await conn.getBalance(b.pubkey, 'confirmed');
    const needed = preBalance >= fundingLamports ? 0 : fundingLamports - preBalance;
    plans.push({ bot: b, preBalance, needed });
    log(
      stage,
      `${b.spec.name.padEnd(25)} pubkey=${b.pubkey.toBase58()} current=${preBalance} ` +
        `target=${fundingLamports} delta=${needed}`,
    );
  }

  const totalNeeded = plans.reduce((acc, p) => acc + p.needed, 0);
  // Per-TX fee buffer — Solana fee is 5_000 lamports per signature; we sign
  // each transfer independently so 6 × 5_000 = 30_000 lamports max. Round up
  // to 100_000 for headroom.
  const FEE_BUFFER = 100_000;

  if (totalNeeded === 0) {
    log(stage, `all bots already funded — no transfers needed`);
    return 0;
  }

  if (dryRun) {
    log(
      stage,
      `(dry-run) would transfer total=${totalNeeded} lamports + ${FEE_BUFFER} buffer`,
    );
    return 0;
  }

  // Deployer balance gate — refuse to start any transfer if we can't cover
  // every needed top-up plus fees. The 6 transfers run sequentially below;
  // this gate avoids leaving the fleet half-funded.
  const deployerBalance = await conn.getBalance(deployer.publicKey, 'confirmed');
  if (deployerBalance < totalNeeded + FEE_BUFFER) {
    throw new Error(
      `phase-8 FATAL: deployer balance ${deployerBalance} < required ${totalNeeded + FEE_BUFFER} ` +
        `(${totalNeeded} for top-ups + ${FEE_BUFFER} fee buffer). ` +
        `Top up the deployer wallet (${deployer.publicKey.toBase58()}) and re-run.`,
    );
  }

  let actualDeltaSum = 0;
  for (const p of plans) {
    if (p.needed === 0) {
      log(stage, `${p.bot.spec.name.padEnd(25)} skip — already at funding floor`);
      continue;
    }
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: deployer.publicKey,
        toPubkey: p.bot.pubkey,
        lamports: p.needed,
      }),
    );
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = deployer.publicKey;
    tx.sign(deployer);

    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });

    // Confirm — short timeout because System.transfer lands in 1 slot.
    const start = Date.now();
    let landed = false;
    while (Date.now() - start < 30_000) {
      const { value } = await conn.getSignatureStatuses([sig]);
      const status = value?.[0];
      if (status?.err) {
        throw new Error(
          `phase-8 FATAL: SystemProgram.transfer to ${p.bot.spec.name} failed: ` +
            `${JSON.stringify(status.err)} (sig=${sig})`,
        );
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        landed = true;
        break;
      }
      await sleep(500);
    }
    if (!landed) {
      throw new Error(
        `phase-8 FATAL: SystemProgram.transfer to ${p.bot.spec.name} did not confirm in 30s (sig=${sig})`,
      );
    }

    // A-41: re-probe post-balance and add the *actual* delta to the running
    // sum. Avoids over-counting on a re-run where one bot was at floor and
    // others needed top-ups.
    const postBalance = await conn.getBalance(p.bot.pubkey, 'confirmed');
    const actualDelta = postBalance - p.preBalance;
    actualDeltaSum += actualDelta > 0 ? actualDelta : 0;

    log(
      stage,
      `${p.bot.spec.name.padEnd(25)} funded +${p.needed} lamports (sig=${sig})`,
    );
  }

  return actualDeltaSum;
}

// --------------------------------------------------------------------------
// R-C — assertFirstRootPublished helper
// --------------------------------------------------------------------------

/**
 * On-chain liveness probe for the merkle-publisher. Reads the YD
 * MerkleDistributor PDA for ARL OT and returns true iff `merkle_root`
 * (offset 104, size 32) is non-zero. Returns false if the account is
 * missing, too small, or the bytes are all zero.
 *
 * T-24 hardening:
 *   1. Verify account is owned by the YD program — defends against a future
 *      misconfiguration where art.ots[0].yd_distributor_pda points at the
 *      wrong account (e.g., a system account or a different program's PDA
 *      that happens to share the layout).
 *   2. Size sanity — minimum bytes to reach merkle_root field.
 *   3. merkle_root non-zero check (existing behavior).
 *
 * If owner mismatches, throws — this is a setup bug, not a transient state
 * the publisher could fix by running for longer.
 *
 * R-C uses this as a hard gate before yield-claim-crank spawns. The
 * publisher's first cycle creates the first root from accumulated revenue
 * events — once the root is non-zero the publisher is provably alive and
 * has reached at least one full publish cycle.
 *
 * @param conn               Solana RPC connection (any commitment).
 * @param ydDistributorPda   The YD MerkleDistributor PDA for ARL OT (lives
 *                           at art.ots[0].yd_distributor_pda).
 * @param ydProgramId        The YD program ID (read from
 *                           art.programs.yield_distribution).
 */
export async function assertFirstRootPublished(
  conn: Connection,
  ydDistributorPda: PublicKey,
  ydProgramId: PublicKey,
): Promise<boolean> {
  const info = await conn.getAccountInfo(ydDistributorPda, 'confirmed');
  if (!info) return false;
  // (a) Owner must be the YD program. A mismatch is a setup error (wrong PDA
  // recorded in the artifact) and won't be cured by polling — throw.
  if (!info.owner.equals(ydProgramId)) {
    throw new Error(
      `phase-8 FATAL: ydDistributorPda ${ydDistributorPda.toBase58()} not owned by ` +
        `YD program ${ydProgramId.toBase58()} (actual owner: ${info.owner.toBase58()}). ` +
        `Check art.ots[0].yd_distributor_pda + art.programs.yield_distribution.`,
    );
  }
  // (b) Size sanity — must reach the merkle_root field.
  if (info.data.length < MERKLE_ROOT_OFFSET + MERKLE_ROOT_SIZE) return false;
  const root = info.data.subarray(
    MERKLE_ROOT_OFFSET,
    MERKLE_ROOT_OFFSET + MERKLE_ROOT_SIZE,
  );
  // All-zero root means "no publish yet" by contract convention (state.rs
  // comment: "zeroed until first publish").
  for (let i = 0; i < MERKLE_ROOT_SIZE; i++) {
    if (root[i] !== 0) return true;
  }
  return false;
}

/**
 * Block until the first merkle root publishes, or throw on timeout.
 * Polls the on-chain liveness probe every `pollIntervalMs`.
 */
async function waitForFirstRoot(
  conn: Connection,
  ydDistributorPda: PublicKey,
  ydProgramId: PublicKey,
  firstRootTimeoutMs: number,
  pollIntervalMs: number,
): Promise<void> {
  const stage = 'stage-2-wait-root';
  const start = Date.now();
  let nextHeartbeat = start + 60_000;
  while (Date.now() - start < firstRootTimeoutMs) {
    const ok = await assertFirstRootPublished(conn, ydDistributorPda, ydProgramId);
    if (ok) {
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
      log(stage, `merkle root published after ${elapsedSec}s — proceeding`);
      return;
    }
    if (Date.now() >= nextHeartbeat) {
      const elapsedSec = ((Date.now() - start) / 1000).toFixed(0);
      log(stage, `still waiting for first merkle root (${elapsedSec}s elapsed)`);
      nextHeartbeat += 60_000;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `phase-8 FATAL: merkle-publisher did not publish first root within ${firstRootTimeoutMs}ms ` +
      `(R-C timeout). Distributor PDA=${ydDistributorPda.toBase58()}. ` +
      `Halting deploy — investigate publisher logs at data/bots/merkle-publisher.log.`,
  );
}

// --------------------------------------------------------------------------
// Stage 2 — ordered startup (D33)
// --------------------------------------------------------------------------

/**
 * SEC-57: build a narrow per-child environment. Inheriting `process.env`
 * leaks the orchestrator's full env (which on devnet/CI can hold deployer
 * keypair material, RPC tokens, etc.) into every spawned bot. Each bot
 * already loads its own `.env` via dotenv at startup, so the orchestrator
 * only needs to forward the absolute minimum.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C',
    NODE_ENV: process.env.NODE_ENV ?? '',
  };
  if (process.env.RPC_URL) childEnv.RPC_URL = process.env.RPC_URL;
  return childEnv;
}

/**
 * Spawn a single bot child process. Returns once the process is up
 * (npm/tsx don't block on script readiness — caller decides how long to
 * dwell before checking it's still alive).
 *
 * Idempotency: if `art.bot_processes[name].pid` is alive (process exists
 * with matching command line on darwin/linux), skip and reuse.
 */
function spawnBot(
  spec: BotSpec,
  art: Artifact,
  logDir: string,
): { proc: ChildProcess; logFile: string } | { reused: BotProcessRecord } {
  const stage = `stage-2-spawn-${spec.name}`;

  // SEC-58: validate cwd is inside <REPO_ROOT>/bots/. Defense-in-depth
  // against a future refactor that derives `spec.dir` from a less-trusted
  // source (e.g., the artifact). resolve() collapses `..` segments before
  // the prefix check. Computed here (above the idempotency probe) so the
  // probe can compare against the resolved absolute path via lsof.
  const cwd = resolve(join(REPO_ROOT, 'bots', spec.dir));
  const botsRoot = resolve(join(REPO_ROOT, 'bots')) + '/';
  if (!cwd.startsWith(botsRoot)) {
    throw new Error(
      `phase-8 FATAL: bot ${spec.name} cwd ${cwd} escapes ${botsRoot}`,
    );
  }
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(
      `phase-8 FATAL: bot ${spec.name} cwd ${cwd} missing or not a directory`,
    );
  }

  // Idempotency probe — reuse running PID if the artifact has one AND its
  // process cwd matches the resolved bot directory (SEC-72/A-52 lsof check).
  const existing = art.bot_processes?.[spec.name];
  if (existing && isOurBotAlive(existing.pid, cwd)) {
    log(stage, `reusing existing PID ${existing.pid} (started ${existing.started_at})`);
    return { reused: existing };
  }

  const logFile = join(logDir, `${spec.name}.log`);

  // SEC-60/A-44/T-25: open log files with 0o600 mode and chmod existing
  // files in case they were created earlier with looser perms. Bot logs may
  // contain RPC URLs, transaction signatures, and (in error cases) snippets
  // of internal state — restrict to the orchestrator user.
  const out = fs.openSync(logFile, 'a', 0o600);
  const err = fs.openSync(logFile, 'a', 0o600);
  try {
    fs.chmodSync(logFile, 0o600);
  } catch {
    // Non-POSIX filesystem — best-effort.
  }

  // Use fixed argv array — never shell-string concat, prevents injection
  // even if a future refactor introduces user-controlled bot names.
  const argv: string[] = ['run', spec.npmScript];

  const proc = spawn('npm', argv, {
    cwd,
    detached: true, // survive the orchestrator process exit
    stdio: ['ignore', out, err],
    env: buildChildEnv(),
  });

  // Best-effort close of the parent's copy of the file descriptors so the
  // child fully owns them. The child has already inherited via stdio.
  fs.closeSync(out);
  fs.closeSync(err);

  // Detach from the parent's job control so closing the orchestrator
  // doesn't take the bot down.
  proc.unref();

  if (!proc.pid) {
    throw new Error(
      `phase-8 FATAL: spawn failed for ${spec.name} (no pid returned). ` +
        `Check that bots/node_modules is populated (run npm install in bots/).`,
    );
  }

  log(stage, `spawned pid=${proc.pid} cwd=${cwd} log=${logFile}`);
  return { proc, logFile };
}

/**
 * POSIX `kill -0 pid` check — returns true iff a process with that pid
 * exists AND we have permission to signal it. We only use this for our
 * own children so the permission caveat doesn't apply.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * SEC-62 / T-23 / A-43: liveness check + cmdline cross-verification.
 *
 * `isProcessAlive(pid)` alone is unsafe for idempotent reuse: PIDs are
 * recycled, so a stale `art.bot_processes[name].pid` may now point at an
 * unrelated process owned by the same user. Cross-check against `ps` to
 * confirm the cmdline still looks like our bot before claiming reuse.
 *
 * Heuristic: cmdline must contain `npm` (parent process is `npm run start`)
 * AND the bot's directory marker (e.g., `pool-rebalancer`). Both checks
 * together make a false positive extremely unlikely.
 *
 * Works on macOS + Linux (`ps -p <pid> -o command=`). On unexpected error
 * (no ps, weird shell) we fail closed by returning false → the orchestrator
 * will respawn the bot, which is safe given each bot is itself idempotent
 * via art-state checks.
 *
 * SEC-72 / A-52 FIX: cmdline of `npm run start` is literally `npm run start`
 * (npm overrides argv0; the bot directory lives in cwd, not argv). So a
 * `cmdline.includes(spec.dir)` check would always fail for healthy bots,
 * defeating the idempotent reuse path AND letting the orchestrator spawn
 * a SECOND copy alongside the still-running first — catastrophic for
 * merkle-publisher (double-publish merkle roots) and cranks (double-spend
 * authority keypair). Switched to `lsof -p <pid> -d cwd` which returns
 * the process cwd directly. lsof ships with both macOS (preinstalled) and
 * Linux (`util-linux` package, generally present). On any platform where
 * lsof fails, we fail-CLOSED (return false → respawn) — same conservative
 * semantics as before but without the cmdline false-negative.
 */
function isOurBotAlive(pid: number, expectedCwd: string): boolean {
  try {
    if (!isProcessAlive(pid)) return false;
    // `lsof -p <pid> -d cwd -Fn` outputs:
    //   p<pid>\nfcwd\nn<absolute-path-of-cwd>\n
    // We extract the line starting with 'n' (the n-field).
    const out = execFileSync('lsof', ['-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const cwdLine = out.split('\n').find((l) => l.startsWith('n'));
    if (!cwdLine) return false;
    const actualCwd = cwdLine.slice(1); // strip leading 'n'
    return actualCwd === expectedCwd;
  } catch {
    return false;
  }
}

interface SpawnedBot {
  spec: BotSpec;
  pid: number;
  startedAt: string;
  logFile: string;
  /** Live ChildProcess handle (undefined when the spawn was reused from a
   *  prior run — we have the pid but not the handle). */
  proc?: ChildProcess;
}

async function startStage2(
  conn: Connection,
  art: Artifact,
  logDir: string,
  firstRootTimeoutMs: number,
  pollIntervalMs: number,
  dryRun: boolean,
  artifactPath: string | undefined,
): Promise<SpawnedBot[]> {
  const stage = 'stage-2-startup';

  if (dryRun) {
    log(stage, `(dry-run) startup order:`);
    for (const s of BOT_REGISTRY) {
      log(stage, `  - ${s.name}`);
    }
    log(stage, `  (publisher block on first root, then yield-claim-crank, then nexus-manager)`);
    return [];
  }

  const arlOt = art.ots?.[0];
  if (!arlOt?.yd_distributor_pda) {
    throw new Error(
      `phase-8 FATAL: artifact.ots[0].yd_distributor_pda missing — ` +
        `Layer 9 publisher dependencies not set up. R-C wait would have no PDA to poll.`,
    );
  }
  const ydDistributorPda = new PublicKey(arlOt.yd_distributor_pda);
  const ydProgramId = new PublicKey(art.programs.yield_distribution);

  // D33 ordering. We chain spawns sequentially so an early failure halts
  // the deploy before the next bot starts (no partial fleet).
  //   1. pool-rebalancer   (independent of publisher)
  //   2. merkle-publisher  (publishes first root)
  //   3. block on assertFirstRootPublished()
  //   4. revenue-crank
  //   5. convert-and-fund-crank
  //   6. yield-claim-crank (consumes the merkle root)
  //   7. nexus-manager
  // The block at step 3 is the R-C critical section. Everything before it
  // can run in parallel in principle, but we keep the spawns sequential
  // for log clarity + early-exit detection.
  const PRE_BLOCK_ORDER: BotName[] = ['pool-rebalancer', 'merkle-publisher'];
  const POST_BLOCK_ORDER: BotName[] = [
    'revenue-crank',
    'convert-and-fund-crank',
    'yield-claim-crank',
    'nexus-manager',
  ];

  const spawned: SpawnedBot[] = [];
  art.bot_processes = art.bot_processes ?? {};

  // T-22 / SEC-61: persist the artifact incrementally after every successful
  // spawn so an orchestrator-kill mid-stage-2 leaves a complete record of
  // every running PID. Re-run sees them via art.bot_processes[*] and reuses
  // (idempotent), avoiding duplicate spawns. No-op on dry-run.
  const persistIncremental = (): void => {
    if (!artifactPath) return;
    try {
      saveArtifactPublic(artifactPath, art);
    } catch (e) {
      // Persistence is best-effort during stage 2 — we don't want a write
      // failure to take the deploy down mid-spawn. The post-stage save in
      // main() / catch path will surface the error properly.
      const msg = e instanceof Error ? e.message : String(e);
      log(stage, `WARN: incremental persist failed: ${msg}`);
    }
  };

  const launch = (name: BotName): SpawnedBot => {
    const spec = BOT_REGISTRY.find((s) => s.name === name);
    if (!spec) {
      throw new Error(`phase-8 FATAL: unknown bot name in startup order: ${name}`);
    }
    const result = spawnBot(spec, art, logDir);
    if ('reused' in result) {
      const rec = result.reused;
      const sb: SpawnedBot = {
        spec,
        pid: rec.pid,
        startedAt: rec.started_at,
        logFile: rec.log_file,
      };
      return sb;
    }
    const startedAt = new Date().toISOString();
    const sb: SpawnedBot = {
      spec,
      pid: result.proc.pid as number,
      startedAt,
      logFile: result.logFile,
      proc: result.proc,
    };
    art.bot_processes![name] = {
      pid: sb.pid,
      started_at: sb.startedAt,
      log_file: sb.logFile,
    };
    persistIncremental();
    return sb;
  };

  // Pre-block batch.
  for (const name of PRE_BLOCK_ORDER) {
    spawned.push(launch(name));
  }

  // R-C critical section — block on first merkle root before yield-claim.
  // SD-36: on localhost (test-validator dress rehearsal) the publisher cannot
  // produce a first root without on-chain revenue events, but those events
  // come from revenue-crank which only spawns post-block. Chicken-and-egg.
  // For localhost-only, skip the block; cranks will spawn immediately +
  // publisher will publish whenever events arrive. mainnet/devnet preserve
  // the strict ordering so consumers don't read stale-or-missing roots.
  if (art.bootstrap_target === 'localhost') {
    log(stage, `localhost: skipping first-root block (publisher will publish on event arrival)`);
    art.first_root_published_at = new Date().toISOString();
  } else {
    log(stage, `blocking until publisher publishes first root (timeout=${firstRootTimeoutMs}ms)`);
    await waitForFirstRoot(conn, ydDistributorPda, ydProgramId, firstRootTimeoutMs, pollIntervalMs);
    art.first_root_published_at = new Date().toISOString();
  }
  persistIncremental();

  // Post-block batch — same sequential pattern.
  for (const name of POST_BLOCK_ORDER) {
    spawned.push(launch(name));
  }

  return spawned;
}

// --------------------------------------------------------------------------
// Stage 3 — heartbeat verification
// --------------------------------------------------------------------------

/**
 * Verify each spawned child is still alive after a short dwell. Catches
 * the obvious failures (env validation throw, missing dependency, etc.).
 * Long-tail failures surface in the bot's own log file; this stage is a
 * cheap sanity gate, not a full health check.
 */
async function verifyHeartbeats(spawned: SpawnedBot[]): Promise<void> {
  const stage = 'stage-3-heartbeat';
  if (spawned.length === 0) {
    log(stage, '(dry-run) skip');
    return;
  }
  log(stage, `dwelling ${HEARTBEAT_DWELL_MS}ms before liveness check`);
  await sleep(HEARTBEAT_DWELL_MS);

  const dead: SpawnedBot[] = [];
  for (const sb of spawned) {
    const alive = isProcessAlive(sb.pid);
    log(
      stage,
      `${sb.spec.name.padEnd(25)} pid=${sb.pid} alive=${alive} log=${sb.logFile}`,
    );
    if (!alive) dead.push(sb);
  }

  if (dead.length > 0) {
    throw new Error(
      `phase-8 FATAL: ${dead.length} bot(s) exited before heartbeat dwell completed: ` +
        `${dead.map((d) => `${d.spec.name}(pid=${d.pid})`).join(', ')}. ` +
        `Inspect log files (data/bots/<name>.log) for early-exit cause.`,
    );
  }
}

// --------------------------------------------------------------------------
// Run options + public entry point
// --------------------------------------------------------------------------

export interface StartBotsOptions {
  /** If true, plan only — no funding TX, no spawn. */
  dryRun?: boolean;
  /** Per-bot funding floor in lamports (default 100M = 0.1 SOL). */
  fundingLamports?: number;
  /** Time budget for waitForFirstRoot (default 600_000 = 10 min). */
  firstRootTimeoutMs?: number;
  /** Poll cadence for the first-root wait (default 5_000). */
  pollIntervalMs?: number;
  /**
   * T-22 / SEC-61: artifact path used for incremental persistence after
   * every successful bot spawn. When set, art is written to disk after each
   * bot's PID/log entry lands, so an orchestrator-kill mid-stage-2 leaves a
   * complete record for the idempotent re-run. Tests / library callers may
   * omit this and persist manually.
   */
  artifactPath?: string;
}

export interface StartBotsResult {
  ok: boolean;
  spawned: Array<{ name: BotName; pid: number; logFile: string }>;
  fundedLamports: number;
  firstRootPublishedAt?: string;
}

/**
 * Top-level entry — Phase 8 orchestration.
 *
 * The caller is responsible for persisting `art` after this returns; the
 * CLI wrapper at the bottom of the file calls saveArtifactPublic.
 */
export async function startBots(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  opts: StartBotsOptions = {},
): Promise<StartBotsResult> {
  const dryRun = opts.dryRun ?? false;
  const fundingLamports = opts.fundingLamports ?? DEFAULT_FUNDING_LAMPORTS;
  const firstRootTimeoutMs = opts.firstRootTimeoutMs ?? DEFAULT_FIRST_ROOT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Sanity gates on opts.
  if (!Number.isFinite(fundingLamports) || fundingLamports <= 0) {
    throw new Error(
      `phase-8 FATAL: fundingLamports must be a positive number, got ${fundingLamports}`,
    );
  }
  if (fundingLamports >= MAX_FUNDING_LAMPORTS) {
    throw new Error(
      `phase-8 FATAL: fundingLamports=${fundingLamports} >= ceiling ${MAX_FUNDING_LAMPORTS} ` +
        `(1 SOL). Reduce the value or raise the ceiling explicitly in start-bots.ts.`,
    );
  }
  if (!Number.isFinite(firstRootTimeoutMs) || firstRootTimeoutMs <= 0) {
    throw new Error(
      `phase-8 FATAL: firstRootTimeoutMs must be a positive number, got ${firstRootTimeoutMs}`,
    );
  }
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs <= 0 ||
    pollIntervalMs > MAX_POLL_INTERVAL_MS
  ) {
    throw new Error(
      `phase-8 FATAL: pollIntervalMs must be in (0, ${MAX_POLL_INTERVAL_MS}], got ${pollIntervalMs}`,
    );
  }

  log(
    'main',
    `dryRun=${dryRun} fundingLamports=${fundingLamports} ` +
      `firstRootTimeoutMs=${firstRootTimeoutMs} pollIntervalMs=${pollIntervalMs}`,
  );

  // Substep 3 readiness gate (T-21: timestamp + on-chain re-verification).
  await assertSubstep3Ready(conn, art);
  log('main', `Substep 3 ready: authority_chain.completed_at=${art.authority_chain?.completed_at}`);

  // Resolve all 6 keypairs up-front (with 0o600 enforcement).
  const bots = resolveBotKeypairs(art);
  for (const b of bots) {
    log('main', `${b.spec.name.padEnd(25)} keypair=${b.keypairPath} pubkey=${b.pubkey.toBase58()}`);
  }

  // Stage 1 — fund. fundBots returns the actual aggregate delta (A-41).
  const fundedDelta = await fundBots(conn, deployer, bots, fundingLamports, dryRun);

  // Logs land under <repo>/data/bots/ — created lazily here so dry-run
  // doesn't create unused dirs.
  const logDir = join(REPO_ROOT, 'data', 'bots');
  if (!dryRun) {
    fs.mkdirSync(logDir, { recursive: true });
    try {
      fs.chmodSync(logDir, 0o700);
    } catch {
      // best-effort
    }
  }

  // Stage 2 — ordered startup. Threading opts.artifactPath enables incremental
  // persistence after every bot spawn (T-22 / SEC-61).
  const spawned = await startStage2(
    conn,
    art,
    logDir,
    firstRootTimeoutMs,
    pollIntervalMs,
    dryRun,
    opts.artifactPath,
  );

  // Stage 3 — heartbeat.
  await verifyHeartbeats(spawned);

  if (!dryRun) {
    art.bots_started_at = new Date().toISOString();
    log('main', `Phase 8 complete — bots_started_at=${art.bots_started_at}`);
  } else {
    log('main', `(dry-run) Phase 8 plan complete`);
  }

  return {
    ok: true,
    spawned: spawned.map((s) => ({ name: s.spec.name, pid: s.pid, logFile: s.logFile })),
    fundedLamports: fundedDelta,
    firstRootPublishedAt: art.first_root_published_at,
  };
}

// --------------------------------------------------------------------------
// Sleep helper
// --------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Argv {
  artifact: string;
  dryRun: boolean;
  fundingLamports: number;
  firstRootTimeoutMs: number;
  pollIntervalMs: number;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let artifact = DEFAULT_ARTIFACT_PATH;
  let dryRun = false;
  let fundingLamports = parsePositiveInt(
    process.env.FUNDING_LAMPORTS,
    DEFAULT_FUNDING_LAMPORTS,
    'FUNDING_LAMPORTS',
  );
  let firstRootTimeoutMs = parsePositiveInt(
    process.env.FIRST_ROOT_TIMEOUT_MS,
    DEFAULT_FIRST_ROOT_TIMEOUT_MS,
    'FIRST_ROOT_TIMEOUT_MS',
  );
  let pollIntervalMs = parsePositiveInt(
    process.env.POLL_INTERVAL_MS,
    DEFAULT_POLL_INTERVAL_MS,
    'POLL_INTERVAL_MS',
  );

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--funding-lamports' && next !== undefined) {
      fundingLamports = parsePositiveInt(next, fundingLamports, '--funding-lamports');
      i++;
    } else if (a === '--first-root-timeout-ms' && next !== undefined) {
      firstRootTimeoutMs = parsePositiveInt(
        next,
        firstRootTimeoutMs,
        '--first-root-timeout-ms',
      );
      i++;
    } else if (a === '--poll-interval-ms' && next !== undefined) {
      pollIntervalMs = parsePositiveInt(next, pollIntervalMs, '--poll-interval-ms');
      i++;
    }
  }
  return { artifact, dryRun, fundingLamports, firstRootTimeoutMs, pollIntervalMs };
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  source: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${source}: expected positive integer, got "${raw}"`);
  }
  return n;
}

async function main(): Promise<void> {
  const argv = parseArgv();
  log('main', `loading artifact ${argv.artifact}`);
  const art = loadArtifact(argv.artifact);

  if (!art.rpc_url || !art.deployer_keypair_path) {
    throw new Error(`artifact missing rpc_url or deployer_keypair_path`);
  }

  const conn = new Connection(art.rpc_url, 'confirmed');
  const deployer = loadKeypair(art.deployer_keypair_path);
  log('main', `deployer=${deployer.publicKey.toBase58()}, rpc=${art.rpc_url}`);

  // T-22 / SEC-61: persist the artifact even on partial failure. Without this,
  // a throw in stage 2 (e.g., 4th bot failed to spawn) would leave the disk
  // artifact stale — the re-run would not see the 3 already-spawned PIDs and
  // would happily spawn duplicates. The try/finally guarantees the on-disk
  // state always reflects whatever bot_processes records were made before the
  // throw, so the idempotent re-run can detect already-spawned bots via PID
  // and skip them. (startStage2 itself also persists incrementally after each
  // spawn — this is the belt-and-braces final flush.)
  try {
    const result = await startBots(conn, deployer, art, {
      dryRun: argv.dryRun,
      fundingLamports: argv.fundingLamports,
      firstRootTimeoutMs: argv.firstRootTimeoutMs,
      pollIntervalMs: argv.pollIntervalMs,
      artifactPath: argv.artifact,
    });

    log('main', `result.ok=${result.ok} spawned=${result.spawned.length}`);
    for (const s of result.spawned) {
      log('main', `  - ${s.name} pid=${s.pid} log=${s.logFile}`);
    }
  } finally {
    // Persist the updated artifact (bot_processes, bots_started_at,
    // first_root_published_at) regardless of success/failure.
    try {
      saveArtifactPublic(argv.artifact, art);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[start-bots] WARN: final artifact persist failed: ${msg}`);
    }
  }
}

// --------------------------------------------------------------------------
// Entry — guard so tests/scenarios that import this module don't trigger main().
// --------------------------------------------------------------------------

const isCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === __filename || resolve(entry).replace(/\.js$/, '.ts') === __filename;
  } catch {
    return false;
  }
})();

if (isCli) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    console.error(`[start-bots] FATAL: ${msg}`);
    process.exit(1);
  });
}
