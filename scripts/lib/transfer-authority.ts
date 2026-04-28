#!/usr/bin/env tsx
/*
 * transfer-authority.ts — Layer 10 substep 3 (Phase 7) authority handover.
 *
 * Permanent on-chain transfer of authority across the 5 Areal contracts.
 * Mistakes here are unrecoverable, so the implementation layers three
 * defenses:
 *
 *   1. R-B precheck (defensive)
 *      Before issuing ANY propose ix, verifies (a) deployer is still the
 *      OtGovernance authority, and (b) the deployer's ARL OT ATA holds the
 *      initial supply. If either is false, the run aborts loud — the cost
 *      of a false alarm is a 5-second human eyeball; the cost of a missed
 *      check is a permanently-unmintable ARL supply.
 *
 *   2. Idempotency (per-step on-chain read BEFORE attempt)
 *      Each step reads the current authority field; if it already matches
 *      the desired target, the step logs "skip (already at target)" and
 *      returns. Re-running after a partial failure is safe.
 *
 *   3. R-A retry + on-chain assertion (per-step, AFTER attempt)
 *      Each TX is wrapped in `executeWithRetry(buildTx, maxRetries)`. After
 *      confirmation, we IMMEDIATELY re-read the authority field and assert
 *      the rotation took effect. If the assertion fails, the run halts
 *      before issuing the next step.
 *
 * Step sequence (D31):
 *
 *   1+2. OT → Futarchy ATOMIC                (single TX, deployer signs both ix)
 *   3.   Futarchy → Multisig PROPOSE          (deployer signs)
 *   4.   Futarchy → Multisig ACCEPT           (multisig signs)
 *   5.   RWT  → Multisig                       (devnet: 1 TX; mainnet: 2 TXs)
 *   6.   DEX  → Multisig                       (devnet: 1 TX; mainnet: 2 TXs)
 *   7.   YD   → Multisig                       (devnet: 1 TX; mainnet: 2 TXs)
 *
 * Devnet vs mainnet (D32):
 *   On devnet (Layer 10 dress rehearsal) the multisig is the deployer
 *   keypair acting as a single-sig surrogate, so steps 4/5/6/7 can collapse
 *   propose+accept into one TX (the deployer signs both ix). Mainnet uses a
 *   real multisig (Squads) — propose and accept must be separate TXs so the
 *   second one can be signed off-line by the multisig signer set. The
 *   `--two-tx-mode` flag (or `MAINNET=1` env) selects the mainnet path.
 *
 * CLI:
 *   node --enable-source-maps scripts/lib/transfer-authority.js \
 *       --artifact data/e2e-bootstrap.json \
 *       [--multisig <base58-pubkey>] \
 *       [--dry-run] [--two-tx-mode] [--max-retries N]
 *
 * Env:
 *   MULTISIG_PUBKEY   base58 pubkey overriding `--multisig`
 *   MAINNET=1         shortcut for `--two-tx-mode`
 */

import * as fs from 'node:fs';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — local ESM with .d.mts sibling, resolves at runtime via tsx.
import { ArlexClient } from '../../dashboard/src/lib/arlex-client/index.mjs';

import {
  assertAuthorityChainComplete,
  assertDeployerHasNoAuthority,
  assertDeployerZeroAuthority,
  type ZeroAuthorityArtifact,
} from './zero-authority-audit.js';

// --------------------------------------------------------------------------
// Paths + constants
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const DEFAULT_MAX_RETRIES = 3;

/** ARL OT lives at index 0 of the artifact's `ots[]` array (mirrors bootstrap-init.ts). */
const ARL_OT_INDEX = 0;

// Authority field offsets (mirrors zero-authority-audit.ts; we re-import the
// helper but also need the same offsets for in-flight reads in this module).
const OT_GOVERNANCE_AUTHORITY_OFFSET = 40;
const FUTARCHY_CONFIG_AUTHORITY_OFFSET = 40;
const DEX_CONFIG_AUTHORITY_OFFSET = 8;
const RWT_VAULT_AUTHORITY_OFFSET = 104;
const DISTRIBUTION_CONFIG_AUTHORITY_OFFSET = 8;
const AUTHORITY_FIELD_SIZE = 32;

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[transfer-authority] [${stage}] ${msg}`;
  if (extra) {
    console.log(line, JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

function warn(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[transfer-authority] [${stage}] WARN: ${msg}`;
  if (extra) {
    console.warn(line, JSON.stringify(extra));
  } else {
    console.warn(line);
  }
}

// --------------------------------------------------------------------------
// Artifact shape (minimal — only the fields this driver needs).
// --------------------------------------------------------------------------

interface OtRecord {
  ot_mint: string;
  ot_config_pda: string;
  ot_governance_pda: string;
  ot_treasury_pda: string;
  futarchy_config_pda?: string;
  initial_supply_minted?: string;
}

/** Layer 10 substep 3 — authority chain timestamps written into the artifact. */
export interface AuthorityChainArtifact {
  ot_to_futarchy_at?: string;
  futarchy_to_multisig_at?: string;
  rwt_to_multisig_at?: string;
  dex_to_multisig_at?: string;
  yd_to_multisig_at?: string;
  multisig_pubkey?: string;
  /** ISO timestamp when all 5 transfers verified end-to-end. */
  completed_at?: string;
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
    dex_config?: string;
    pool_creators?: string;
    yd_dist_config?: string;
    rwt_vault?: string;
  };
  ots?: OtRecord[];
  authority_chain?: AuthorityChainArtifact;
}

// --------------------------------------------------------------------------
// Artifact I/O — matches bootstrap-init.ts behavior (0o600, secrets sibling).
// --------------------------------------------------------------------------

function secretsPathFor(artifactPath: string): string {
  const ext = artifactPath.endsWith('.json') ? '.json' : '';
  const base = ext ? artifactPath.slice(0, -ext.length) : artifactPath;
  return `${base}.secrets${ext || '.json'}`;
}

function loadArtifact(path: string): Artifact {
  if (!existsSync(path)) {
    throw new Error(`artifact not found: ${path}`);
  }
  const merged = JSON.parse(readFileSync(path, 'utf8')) as Artifact;
  // Re-merge secrets file if present so we get the deployer keypair path.
  const secretsPath = secretsPathFor(path);
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as {
      deployer_keypair_path?: string;
    };
    if (secrets.deployer_keypair_path && !merged.deployer_keypair_path) {
      merged.deployer_keypair_path = secrets.deployer_keypair_path;
    }
  }
  return merged;
}

/**
 * Save the public artifact preserving 0o600 perms. We deliberately do NOT
 * touch the .secrets.json sibling — this driver only adds non-secret
 * `authority_chain` timestamps, never keypairs.
 *
 * SEC-44: defensively strip every secret-adjacent field from the public
 * copy (deployer_keypair_path, bots[*].keypair_path, etc.) before writing.
 * The in-memory artifact may have these fields merged from the .secrets.json
 * sibling at load time; we must not let them leak into the public artifact.
 */
function saveArtifactPublic(path: string, art: Artifact): void {
  mkdirSync(dirname(path), { recursive: true });
  // Deep-clone so we don't mutate the caller's in-memory artifact.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copy = JSON.parse(JSON.stringify(art)) as any;
  // Never leak the deployer keypair path into the public artifact (SEC-44).
  delete copy.deployer_keypair_path;
  // Bot keypair paths are also secrets-adjacent — even if the caller only
  // dropped pubkeys here, refuse to forward an unexpected `bots` blob.
  delete copy.bots;
  writeFileSync(path, JSON.stringify(copy, null, 2) + '\n', 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystem — best-effort.
  }
}

/**
 * Load a Solana keypair from a JSON file. SEC-37: refuse to read a file with
 * loose permissions (group / other readable or writable). The 0o600 contract
 * matches bootstrap-init.ts secrets handling.
 */
function loadKeypair(path: string): Keypair {
  // Permission gate — refuse to read a key file that group/other can see.
  try {
    const stat = fs.statSync(path);
    const looseBits = stat.mode & 0o077;
    if (looseBits !== 0) {
      throw new Error(
        `keypair file ${path} has loose permissions (mode ${(stat.mode & 0o777)
          .toString(8)
          .padStart(3, '0')}); expected 600 (run: chmod 600 ${path})`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('keypair file')) throw e;
    // Re-throw with context if statSync failed for other reasons (ENOENT etc).
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to stat keypair file ${path}: ${msg}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// --------------------------------------------------------------------------
// IDL loading (shared style with bootstrap-init.ts)
// --------------------------------------------------------------------------

interface MinimalIdl {
  name: string;
  instructions: Array<{ name: string }>;
}

function loadIdl(name: string): MinimalIdl {
  const path = join(REPO_ROOT, 'dashboard', 'src', 'lib', 'idl', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as MinimalIdl;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadIdlForClient(name: string): any {
  const path = join(REPO_ROOT, 'dashboard', 'src', 'lib', 'idl', `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function ixExists(idl: MinimalIdl, ixName: string): boolean {
  return idl.instructions.some((i) => i.name === ixName);
}

// --------------------------------------------------------------------------
// Tx send + retry helpers
// --------------------------------------------------------------------------

/**
 * Error type that carries the just-submitted signature so `executeWithRetry`
 * can re-poll status before deciding to retry (SEC-36 — avoid double-submit
 * when confirmation timed out but the TX actually landed).
 */
class TxSubmitError extends Error {
  signature?: string;
  constructor(message: string, signature?: string) {
    super(message);
    this.name = 'TxSubmitError';
    if (signature) this.signature = signature;
  }
}

/**
 * Send + confirm a Transaction with the given signers. Mirrors
 * bootstrap-init.ts's `sendAndConfirm` (60s confirmation poll). Pulled local
 * so this module has no runtime dependency on bootstrap-init.ts internals.
 *
 * SEC-36: on confirmation timeout we throw a `TxSubmitError` carrying the
 * signature so the retry wrapper can call `getSignatureStatus(sig)` before
 * blindly rebuilding a new TX (which would double-submit).
 */
async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  if (signers.length === 0) {
    throw new Error('sendAndConfirm: at least one signer required');
  }
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const feePayer = signers[0]!;
  tx.feePayer = feePayer.publicKey;
  tx.sign(...signers);
  let sig: string;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
  } catch (e) {
    // Submit-side failure (no signature available) — caller may retry safely.
    throw e;
  }
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value?.[0];
    if (status?.err) {
      throw new TxSubmitError(`tx failed: ${JSON.stringify(status.err)} (sig=${sig})`, sig);
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  // Confirmation timeout — keep the signature so the retry wrapper can
  // re-check status instead of double-submitting.
  throw new TxSubmitError(`confirmation timeout: sig=${sig}`, sig);
}

/** Return an ATA pubkey for (owner, mint). Pure derivation — no I/O. */
function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/** Return ATA balance in base units. 0n if the account does not exist. */
async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

/**
 * R-A retry wrapper. `buildAndSend` is a factory because each retry rebuilds
 * the Transaction with a fresh blockhash (the old one may have expired). On
 * non-final attempts we backoff linearly (1s, 2s) — fast enough for devnet,
 * gentle enough not to hammer a flaky validator.
 *
 * SEC-36 — double-submit defense:
 *   1. Before each attempt (except the first), call `idempotencyCheck()` if
 *      provided. If it returns true, the on-chain authority is already at the
 *      target — short-circuit success without rebuilding the TX.
 *   2. After a caught error, if the error is a TxSubmitError carrying a
 *      signature, poll `getSignatureStatus(sig)`. If `confirmed` or
 *      `finalized`, the TX actually landed despite the apparent failure —
 *      treat as success.
 *
 * Both gates are belt-and-braces: either alone would close the SEC-36 hole,
 * combining them keeps the helper safe even if a future caller forgets to
 * pass `idempotencyCheck`.
 */
async function executeWithRetry(
  stage: string,
  conn: Connection,
  buildAndSend: () => Promise<string>,
  maxRetries: number,
  idempotencyCheck?: () => Promise<boolean>,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // SEC-36 (gate #1) — re-check on-chain state at the START of every attempt
    // after the first, in case the previous attempt silently landed.
    if (attempt > 1 && idempotencyCheck) {
      try {
        const alreadyAtTarget = await idempotencyCheck();
        if (alreadyAtTarget) {
          log(
            stage,
            `idempotency check at start of attempt ${attempt} — already at target; treating as success`,
          );
          return '<idempotent-skip>';
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(stage, `idempotency check threw before attempt ${attempt}: ${msg}`);
      }
    }
    try {
      const sig = await buildAndSend();
      if (attempt > 1) {
        log(stage, `retry succeeded on attempt ${attempt}/${maxRetries} (sig=${sig})`);
      }
      return sig;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      warn(stage, `attempt ${attempt}/${maxRetries} failed: ${msg.split('\n')[0]?.slice(0, 200)}`);

      // SEC-36 (gate #2) — if the error carries a signature, poll status. A
      // confirmation timeout that actually landed must NOT trigger a retry.
      if (e instanceof TxSubmitError && e.signature) {
        try {
          const { value } = await conn.getSignatureStatuses([e.signature]);
          const status = value?.[0];
          if (
            status?.confirmationStatus === 'confirmed' ||
            status?.confirmationStatus === 'finalized'
          ) {
            log(
              stage,
              `signature ${e.signature} reports ${status.confirmationStatus} despite earlier error — treating as success`,
            );
            return e.signature;
          }
        } catch (statusErr) {
          const sm = statusErr instanceof Error ? statusErr.message : String(statusErr);
          warn(stage, `getSignatureStatus(${e.signature}) failed: ${sm}`);
        }
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`executeWithRetry exhausted: ${String(lastErr)}`);
}

// --------------------------------------------------------------------------
// On-chain authority readers — used both for idempotency (BEFORE) and the
// per-step assertion (AFTER) per R-A.
// --------------------------------------------------------------------------

/**
 * Read the 32-byte authority field at the given offset. Returns the raw
 * bytes or null if the account is missing / too small. Caller decides how
 * to interpret a null return (idempotency check vs hard failure).
 */
async function readAuthorityField(
  conn: Connection,
  pda: PublicKey,
  offset: number,
): Promise<Buffer | null> {
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;
  if (info.data.length < offset + AUTHORITY_FIELD_SIZE) return null;
  return Buffer.from(info.data.subarray(offset, offset + AUTHORITY_FIELD_SIZE));
}

/**
 * Wait for an on-chain authority field to match a target (R-A defensive
 * layer). Polls every ~750ms for up to 30 seconds — confirmation has already
 * happened, so this is purely a defense against stale RPC reads.
 *
 * SEC-40: bumped from 10s to 30s with soft "still propagating" logs at 10s
 * and 20s. Tightly-scoped RPC providers can lag noticeably under load; a 10s
 * hard fail was generating false R-A halts.
 */
async function waitForAuthority(
  conn: Connection,
  pda: PublicKey,
  offset: number,
  expected: PublicKey,
  stage: string,
): Promise<void> {
  const start = Date.now();
  let logged10 = false;
  let logged20 = false;
  while (Date.now() - start < 30_000) {
    const bytes = await readAuthorityField(conn, pda, offset);
    if (bytes && bytes.equals(expected.toBuffer())) {
      return;
    }
    const elapsed = Date.now() - start;
    if (!logged10 && elapsed >= 10_000) {
      logged10 = true;
      warn(stage, `authority assertion still propagating after 10s — retrying for 20 more seconds`);
    } else if (!logged20 && elapsed >= 20_000) {
      logged20 = true;
      warn(stage, `authority assertion still propagating after 20s — retrying for 10 more seconds`);
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  const last = await readAuthorityField(conn, pda, offset);
  const lastB58 = last ? new PublicKey(last).toBase58() : '<null>';
  throw new Error(
    `[${stage}] post-tx authority assertion failed: expected ${expected.toBase58()}, ` +
      `on-chain=${lastB58} after 30s. R-A halt — manual recovery required.`,
  );
}

// --------------------------------------------------------------------------
// Run options
// --------------------------------------------------------------------------

export interface TransferAuthorityOptions {
  /** Pubkey that becomes the new authority for Futarchy + RWT + DEX + YD (D32). */
  multisigPubkey: PublicKey;
  /** If true, skip TX submission. Returns the planned action list. */
  dryRun?: boolean;
  /** Max retries per TX (R-A mitigation). Default = 3. */
  maxRetries?: number;
  /**
   * If true, split each propose-and-accept flow into TWO separate TXs so the
   * second TX can be signed off-line by an external multisig (mainnet path).
   * If false, the deployer signs both ix in a single TX (devnet shortcut, D32).
   */
  twoTxMode?: boolean;
}

interface PlannedAction {
  step: string;
  description: string;
}

// --------------------------------------------------------------------------
// R-B precheck
// --------------------------------------------------------------------------

const ARL_INITIAL_SUPPLY_MIN = 1n; // any non-zero balance proves mint_ot ran

/**
 * Defensive R-B precheck — runs FIRST, before any transfer ix. Aborts loud
 * if (a) the deployer is no longer the OtGovernance authority, or (b) the
 * deployer's ARL OT ATA is empty (initial supply not minted, mint_ot would
 * fail post-transfer because of the `has_one = authority` constraint).
 *
 * The check uses the explicit byte-offset path (not the audit helper) so a
 * future refactor of the helper can't silently weaken this gate.
 */
async function runRbPrecheck(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  const stage = 'r-b-precheck';

  if (!art.ots || art.ots.length === 0) {
    throw new Error(
      `phase-7 FATAL: artifact has no OTs — phaseOts did not run (R-B violation precondition)`,
    );
  }
  const arlOt = art.ots[ARL_OT_INDEX];
  if (!arlOt) {
    throw new Error(
      `phase-7 FATAL: artifact.ots[${ARL_OT_INDEX}] missing — ARL OT not bootstrapped`,
    );
  }

  // (a) OtGovernance.authority MUST equal deployer.publicKey.
  const otGov = new PublicKey(arlOt.ot_governance_pda);
  const govAuthBytes = await readAuthorityField(
    conn,
    otGov,
    OT_GOVERNANCE_AUTHORITY_OFFSET,
  );
  if (!govAuthBytes) {
    throw new Error(
      `phase-7 FATAL: OtGovernance PDA ${otGov.toBase58()} not found or too small. ` +
        `Phase 3 (phaseOts/initialize_ot) did not complete.`,
    );
  }
  if (!govAuthBytes.equals(deployer.publicKey.toBuffer())) {
    const actualAuth = new PublicKey(govAuthBytes).toBase58();
    throw new Error(
      `phase-7 FATAL: OT governance authority is not deployer — Phase 3 transfer ` +
        `already happened, or someone else owns it. on-chain=${actualAuth}, ` +
        `deployer=${deployer.publicKey.toBase58()}. R-B halt.`,
    );
  }
  log(stage, `OtGovernance.authority == deployer (OK)`);

  // (b) Deployer ARL ATA balance MUST be > 0 — phaseArlMint must have run.
  if (!art.mints?.arl_ot_mint) {
    throw new Error(
      `phase-7 FATAL: artifact.mints.arl_ot_mint missing — ARL mint not created`,
    );
  }
  const arlMint = new PublicKey(art.mints.arl_ot_mint);
  const ata = findAta(deployer.publicKey, arlMint);
  const balance = await getTokenBalance(conn, ata);
  if (balance < ARL_INITIAL_SUPPLY_MIN) {
    throw new Error(
      `phase-7 FATAL: ARL OT supply == 0 in deployer ATA ${ata.toBase58()} — ` +
        `phaseArlMint did not run; R-B violation. Authority transfer would ` +
        `permanently strand the mint authority on Futarchy.`,
    );
  }
  log(stage, `deployer ARL ATA balance=${balance.toString()} (OK)`);

  // (c) SEC-42 — extend the precheck to read all 5 deployer-as-authority
  // states. The dual of `assertAuthorityChainComplete`: deployer-as-authority
  // expected on every contract. If ANY contract is already at a non-deployer
  // authority, Phase 7 already partially ran (or someone else owns it) — halt
  // before issuing any further ix.
  //
  // We invert the result of `assertDeployerHasNoAuthority`: that helper
  // reports `ok=true` when deployer has authority on ZERO contracts; we want
  // the opposite (deployer is authority on ALL contracts), so we expect
  // `ok=false` AND `mismatches.length === 5`.
  const dualAudit = await assertDeployerHasNoAuthority(conn, deployer.publicKey, art);
  // mismatches[] in negative mode = contracts where deployer IS still the
  // authority. We want all 5.
  const expectedAll: AuthorityContractName[] = ['OT', 'Futarchy', 'RWT', 'DEX', 'YD'];
  const missing = expectedAll.filter((c) => !dualAudit.mismatches.includes(c));
  if (missing.length > 0) {
    // Per-contract logging for triage.
    for (const c of dualAudit.checks) {
      const stillDeployer = dualAudit.mismatches.includes(c.contract);
      log(
        stage,
        `${c.contract.padEnd(8)} deployer-is-authority=${stillDeployer} ${c.detail}`,
      );
    }
    throw new Error(
      `phase-7 FATAL: deployer is NOT the authority on these contracts (Phase 7 partially ran or someone else owns them): ` +
        `${missing.join(', ')}. R-B halt — manual triage required before retrying.`,
    );
  }
  log(stage, `deployer is authority on all 5 contracts (OK)`);
}

/** Local alias to keep the precheck list's order assertion readable. */
type AuthorityContractName = 'OT' | 'Futarchy' | 'RWT' | 'DEX' | 'YD';

// --------------------------------------------------------------------------
// Step 1+2 — OT → Futarchy ATOMIC (single TX, deployer signs both ix)
// --------------------------------------------------------------------------

async function transferOtToFutarchy(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  opts: Required<Pick<TransferAuthorityOptions, 'maxRetries' | 'dryRun'>>,
  planned: PlannedAction[],
): Promise<void> {
  const stage = 'step-1+2-ot-to-futarchy';

  const arlOt = art.ots?.[ARL_OT_INDEX];
  if (!arlOt) throw new Error(`${stage}: ARL OT missing in artifact`);
  if (!arlOt.futarchy_config_pda) {
    throw new Error(
      `${stage}: arlOt.futarchy_config_pda missing — phaseFutarchy did not run`,
    );
  }
  if (!art.mints?.arl_ot_mint) {
    throw new Error(`${stage}: art.mints.arl_ot_mint missing`);
  }

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const futProgramId = new PublicKey(art.programs.futarchy);
  const arlMint = new PublicKey(art.mints.arl_ot_mint);
  const otGovPda = new PublicKey(arlOt.ot_governance_pda);
  const futConfigPda = new PublicKey(arlOt.futarchy_config_pda);

  // Idempotency — if OtGovernance.authority is already futConfigPda, skip.
  const currentAuth = await readAuthorityField(
    conn,
    otGovPda,
    OT_GOVERNANCE_AUTHORITY_OFFSET,
  );
  if (currentAuth && currentAuth.equals(futConfigPda.toBuffer())) {
    log(stage, `skip — OtGovernance.authority already = Futarchy PDA (${futConfigPda.toBase58()})`);
    art.authority_chain = {
      ...(art.authority_chain ?? {}),
      ot_to_futarchy_at: art.authority_chain?.ot_to_futarchy_at ?? new Date().toISOString(),
    };
    return;
  }

  // IDL preflight.
  const otIdl = loadIdl('ownership-token');
  const futIdl = loadIdl('futarchy');
  if (!ixExists(otIdl, 'propose_authority_transfer')) {
    throw new Error(`${stage}: OT IDL missing propose_authority_transfer`);
  }
  if (!ixExists(futIdl, 'claim_ot_governance')) {
    throw new Error(`${stage}: Futarchy IDL missing claim_ot_governance`);
  }

  if (opts.dryRun) {
    planned.push({
      step: stage,
      description: `OT::propose_authority_transfer(new=${futConfigPda.toBase58()}) + Futarchy::claim_ot_governance — single TX`,
    });
    log(stage, '(dry-run) plan recorded; no TX submitted');
    return;
  }

  const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
  const futClient = new ArlexClient(loadIdlForClient('futarchy'), futProgramId, conn);

  await executeWithRetry(
    stage,
    conn,
    async () => {
      // Build BOTH ix and bundle into a single Transaction. D31 atomicity:
      // because only the Futarchy PDA can satisfy the pending_authority gate
      // inside claim_ot_governance, there's no front-running window.
      const proposeIx: TransactionInstruction = otClient.buildInstruction(
        'propose_authority_transfer',
        {
          accounts: {
            authority: deployer.publicKey,
            ot_mint: arlMint,
            ot_governance: otGovPda,
          },
          args: { new_authority: Array.from(futConfigPda.toBytes()) },
        },
      );
      const claimIx: TransactionInstruction = futClient.buildInstruction(
        'claim_ot_governance',
        {
          accounts: {
            executor: deployer.publicKey,
            config: futConfigPda,
            ot_governance: otGovPda,
            ot_mint: arlMint,
            ot_program: otProgramId,
          },
          args: {},
        },
      );
      const tx = new Transaction().add(proposeIx, claimIx);
      const sig = await sendAndConfirm(conn, tx, [deployer]);
      log(stage, `OT::propose + Futarchy::claim_ot_governance OK (sig=${sig})`);
      return sig;
    },
    opts.maxRetries,
    // SEC-36 idempotency check — if a previous attempt landed silently,
    // OtGovernance.authority is already at futConfigPda; treat as success.
    async () => {
      const cur = await readAuthorityField(conn, otGovPda, OT_GOVERNANCE_AUTHORITY_OFFSET);
      return cur ? cur.equals(futConfigPda.toBuffer()) : false;
    },
  );

  // R-A: assert OtGovernance.authority == Futarchy PDA before continuing.
  await waitForAuthority(conn, otGovPda, OT_GOVERNANCE_AUTHORITY_OFFSET, futConfigPda, stage);
  log(stage, `on-chain assertion OK — OtGovernance.authority = Futarchy PDA`);

  art.authority_chain = {
    ...(art.authority_chain ?? {}),
    ot_to_futarchy_at: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// Step 3+4 — Futarchy → Multisig
// --------------------------------------------------------------------------

async function transferFutarchyToMultisig(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  opts: Required<TransferAuthorityOptions>,
  planned: PlannedAction[],
): Promise<void> {
  const stage = 'step-3+4-futarchy-to-multisig';

  const arlOt = art.ots?.[ARL_OT_INDEX];
  if (!arlOt) throw new Error(`${stage}: ARL OT missing in artifact`);
  if (!arlOt.futarchy_config_pda) {
    throw new Error(`${stage}: arlOt.futarchy_config_pda missing`);
  }

  const futProgramId = new PublicKey(art.programs.futarchy);
  const futConfigPda = new PublicKey(arlOt.futarchy_config_pda);
  const target = opts.multisigPubkey;

  // Idempotency — if FutarchyConfig.authority already = multisig, skip.
  // NOTE: at this point in the chain, Futarchy.authority is still the
  // deployer (Step 1+2 only rotated OtGovernance, not Futarchy itself). The
  // pre-deployer-signed propose ix has `has_one = authority` which means the
  // deployer must still be Futarchy.authority for propose to succeed.
  const currentAuth = await readAuthorityField(
    conn,
    futConfigPda,
    FUTARCHY_CONFIG_AUTHORITY_OFFSET,
  );
  if (currentAuth && currentAuth.equals(target.toBuffer())) {
    log(stage, `skip — FutarchyConfig.authority already = multisig (${target.toBase58()})`);
    art.authority_chain = {
      ...(art.authority_chain ?? {}),
      futarchy_to_multisig_at:
        art.authority_chain?.futarchy_to_multisig_at ?? new Date().toISOString(),
    };
    return;
  }

  const futIdl = loadIdl('futarchy');
  if (!ixExists(futIdl, 'propose_authority_transfer')) {
    throw new Error(`${stage}: Futarchy IDL missing propose_authority_transfer`);
  }
  if (!ixExists(futIdl, 'accept_authority_transfer')) {
    throw new Error(`${stage}: Futarchy IDL missing accept_authority_transfer`);
  }

  if (opts.dryRun) {
    planned.push({
      step: `${stage} (propose)`,
      description: `Futarchy::propose_authority_transfer(new=${target.toBase58()})`,
    });
    planned.push({
      step: `${stage} (accept)`,
      description: `Futarchy::accept_authority_transfer (signed by multisig)`,
    });
    log(stage, '(dry-run) plan recorded; no TX submitted');
    return;
  }

  const futClient = new ArlexClient(loadIdlForClient('futarchy'), futProgramId, conn);

  // For Futarchy → Multisig we ALWAYS use 2 TXs (per A-26 harmonization with
  // the singleton steps). The multisig acceptor is by definition a separate
  // signer, even when D32 reuses the deployer keypair on devnet. The
  // twoTxMode flag now controls only the "halt-if-multisig-not-local" gate
  // for accept; the propose+accept structure itself is invariant.

  // ---- Step 3: propose (deployer signs) ----
  // SEC-36 idempotency for propose: if Futarchy.pending_authority already
  // equals target AND has_pending == true, propose has already landed; the
  // retry wrapper can treat that as success and proceed to accept.
  const futPendingOffset = FUTARCHY_CONFIG_AUTHORITY_OFFSET + AUTHORITY_FIELD_SIZE; // 72
  const futHasPendingOffset = futPendingOffset + AUTHORITY_FIELD_SIZE; // 104
  await executeWithRetry(
    `${stage}/propose`,
    conn,
    async () => {
      const tx = futClient.buildTransaction('propose_authority_transfer', {
        accounts: {
          authority: deployer.publicKey,
          config: futConfigPda,
        },
        args: { new_authority: Array.from(target.toBytes()) },
      });
      const sig = await sendAndConfirm(conn, tx, [deployer]);
      log(stage, `Futarchy::propose_authority_transfer OK (sig=${sig})`);
      return sig;
    },
    opts.maxRetries,
    async () => {
      // pending_authority == target && has_pending == 1
      const pending = await readAuthorityField(conn, futConfigPda, futPendingOffset);
      if (!pending || !pending.equals(target.toBuffer())) return false;
      const info = await conn.getAccountInfo(futConfigPda);
      if (!info || info.data.length <= futHasPendingOffset) return false;
      return info.data[futHasPendingOffset] === 1;
    },
  );

  // ---- Step 4: accept (multisig signs — devnet pseudo-multisig = deployer) ----
  // On devnet (D32) the multisig is the deployer keypair acting as surrogate.
  // We refuse to proceed if the env says "multisig" but no signer is
  // available — mainnet runs this step out-of-band via the Squads UI.
  if (!isMultisigSignableLocally(deployer, target)) {
    throw new Error(
      `${stage}: cannot locally sign accept — multisig pubkey ${target.toBase58()} ` +
        `does not match deployer ${deployer.publicKey.toBase58()}. ` +
        `On mainnet, run the accept_authority_transfer ix from the multisig signer set out-of-band, ` +
        `then re-run this script with the same --multisig pubkey to verify.`,
    );
  }
  await executeWithRetry(
    `${stage}/accept`,
    conn,
    async () => {
      const tx = futClient.buildTransaction('accept_authority_transfer', {
        accounts: {
          new_authority: target,
          config: futConfigPda,
        },
        args: {},
      });
      const sig = await sendAndConfirm(conn, tx, [deployer]);
      log(stage, `Futarchy::accept_authority_transfer OK (sig=${sig})`);
      return sig;
    },
    opts.maxRetries,
    // SEC-36 idempotency: accept landed iff authority == target.
    async () => {
      const cur = await readAuthorityField(conn, futConfigPda, FUTARCHY_CONFIG_AUTHORITY_OFFSET);
      return cur ? cur.equals(target.toBuffer()) : false;
    },
  );

  // R-A assertion.
  await waitForAuthority(conn, futConfigPda, FUTARCHY_CONFIG_AUTHORITY_OFFSET, target, stage);
  log(stage, `on-chain assertion OK — FutarchyConfig.authority = multisig`);

  art.authority_chain = {
    ...(art.authority_chain ?? {}),
    futarchy_to_multisig_at: new Date().toISOString(),
  };
}

/**
 * Devnet-only: confirm we can sign as the multisig locally. On Layer 10
 * dress rehearsal the multisig pubkey == deployer.publicKey; on mainnet they
 * differ and accept must run out-of-band.
 */
function isMultisigSignableLocally(deployer: Keypair, multisig: PublicKey): boolean {
  return multisig.equals(deployer.publicKey);
}

// --------------------------------------------------------------------------
// Generic singleton transfer (RWT, DEX, YD)
// --------------------------------------------------------------------------

interface SingletonSpec {
  contract: 'RWT' | 'DEX' | 'YD';
  programIdField: 'rwt_engine' | 'native_dex' | 'yield_distribution';
  /** IDL filename (without .json). */
  idlName: 'rwt-engine' | 'native-dex' | 'yield-distribution';
  /** ProposeAuthorityTransfer / AcceptAuthorityTransfer config-account name in IDL. */
  configAccountName: 'rwt_vault' | 'dex_config' | 'config';
  /** Artifact field for the config PDA. */
  configPdaArtifactField: 'rwt_vault' | 'dex_config' | 'yd_dist_config';
  /** Byte offset of the authority field. */
  authorityOffset: number;
  /** Stage label used in logs. */
  stage: string;
  /** Artifact key to update with the timestamp. */
  artifactTimestampKey: keyof AuthorityChainArtifact;
}

async function transferSingletonToMultisig(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  opts: Required<TransferAuthorityOptions>,
  spec: SingletonSpec,
  planned: PlannedAction[],
): Promise<void> {
  const stage = spec.stage;
  const target = opts.multisigPubkey;

  const configPdaB58 =
    spec.configPdaArtifactField === 'rwt_vault'
      ? art.pdas?.rwt_vault
      : spec.configPdaArtifactField === 'dex_config'
        ? art.pdas?.dex_config
        : art.pdas?.yd_dist_config;

  if (!configPdaB58) {
    throw new Error(`${stage}: artifact.pdas.${spec.configPdaArtifactField} missing`);
  }
  const configPda = new PublicKey(configPdaB58);
  const programId = new PublicKey(art.programs[spec.programIdField]);

  // Idempotency — already at target?
  const currentAuth = await readAuthorityField(conn, configPda, spec.authorityOffset);
  if (currentAuth && currentAuth.equals(target.toBuffer())) {
    log(stage, `skip — ${spec.contract} authority already = multisig (${target.toBase58()})`);
    art.authority_chain = {
      ...(art.authority_chain ?? {}),
      [spec.artifactTimestampKey]:
        art.authority_chain?.[spec.artifactTimestampKey] ?? new Date().toISOString(),
    };
    return;
  }

  const idl = loadIdl(spec.idlName);
  if (!ixExists(idl, 'propose_authority_transfer')) {
    throw new Error(`${stage}: ${spec.idlName} IDL missing propose_authority_transfer`);
  }
  if (!ixExists(idl, 'accept_authority_transfer')) {
    throw new Error(`${stage}: ${spec.idlName} IDL missing accept_authority_transfer`);
  }

  // DEX accept ix needs pool_creators PDA (architectural surprise — DEX
  // updates BOTH PDAs in accept_handler). RWT and YD only touch the single
  // config PDA.
  let dexPoolCreators: PublicKey | null = null;
  if (spec.contract === 'DEX') {
    const pcB58 = art.pdas?.pool_creators;
    if (!pcB58) {
      throw new Error(`${stage}: artifact.pdas.pool_creators missing (required for DEX accept)`);
    }
    dexPoolCreators = new PublicKey(pcB58);
  }

  if (opts.dryRun) {
    planned.push({
      step: `${stage} (propose)`,
      description: `${spec.contract}::propose_authority_transfer(new=${target.toBase58()})`,
    });
    planned.push({
      step: `${stage} (accept)`,
      description: `${spec.contract}::accept_authority_transfer (signed by multisig)`,
    });
    log(stage, '(dry-run) plan recorded; no TX submitted');
    return;
  }

  const client = new ArlexClient(loadIdlForClient(spec.idlName), programId, conn);

  // A-26: ALL 4 downstream flows (Futarchy + 3 singletons) execute as 2-TX
  // always — matches D31's literal prose and is consistent with the Futarchy
  // step. On devnet (multisig === deployer per D32), the accept TX signs
  // locally; on mainnet, accept halts unless the local key matches the
  // multisig pubkey (real Squads ceremony runs out-of-band).
  //
  // SEC-50 / A-33: idempotency callbacks for both propose+accept mirror the
  // Futarchy pattern. All 3 singleton state structs lay out
  //   authority @ spec.authorityOffset
  //   pending_authority @ authority + 32
  //   has_pending byte @ pending + 32
  // so the relative offsets are uniform.
  const pendingOffset = spec.authorityOffset + AUTHORITY_FIELD_SIZE;
  const hasPendingOffset = pendingOffset + AUTHORITY_FIELD_SIZE;
  await executeWithRetry(
    `${stage}/propose`,
    conn,
    async () => {
      const tx = buildProposeTx(client, spec, deployer.publicKey, configPda, target);
      const sig = await sendAndConfirm(conn, tx, [deployer]);
      log(stage, `${spec.contract}::propose_authority_transfer OK (sig=${sig})`);
      return sig;
    },
    opts.maxRetries,
    async () => {
      // pending_authority == target && has_pending == 1
      const pending = await readAuthorityField(conn, configPda, pendingOffset);
      if (!pending || !pending.equals(target.toBuffer())) return false;
      const info = await conn.getAccountInfo(configPda);
      if (!info || info.data.length <= hasPendingOffset) return false;
      return info.data[hasPendingOffset] === 1;
    },
  );

  if (!isMultisigSignableLocally(deployer, target)) {
    throw new Error(
      `${stage}: propose succeeded but accept must be signed by multisig ${target.toBase58()} ` +
        `out-of-band. Re-run with the same --multisig pubkey after accept lands on-chain.`,
    );
  }
  await executeWithRetry(
    `${stage}/accept`,
    conn,
    async () => {
      const tx = buildAcceptTx(client, spec, target, configPda, dexPoolCreators);
      const sig = await sendAndConfirm(conn, tx, [deployer]);
      log(stage, `${spec.contract}::accept_authority_transfer OK (sig=${sig})`);
      return sig;
    },
    opts.maxRetries,
    async () => {
      // authority == target — accept already landed
      const auth = await readAuthorityField(conn, configPda, spec.authorityOffset);
      return !!auth && auth.equals(target.toBuffer());
    },
  );

  // R-A assertion.
  await waitForAuthority(conn, configPda, spec.authorityOffset, target, stage);
  log(stage, `on-chain assertion OK — ${spec.contract} authority = multisig`);

  art.authority_chain = {
    ...(art.authority_chain ?? {}),
    [spec.artifactTimestampKey]: new Date().toISOString(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildProposeAccounts(
  spec: SingletonSpec,
  signerPubkey: PublicKey,
  configPda: PublicKey,
): Record<string, any> {
  const baseAccounts: Record<string, PublicKey> = {
    authority: signerPubkey,
  };
  baseAccounts[spec.configAccountName] = configPda;
  return baseAccounts;
}

function buildAcceptAccounts(
  spec: SingletonSpec,
  newAuthority: PublicKey,
  configPda: PublicKey,
  dexPoolCreators: PublicKey | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  const baseAccounts: Record<string, PublicKey> = {
    new_authority: newAuthority,
  };
  baseAccounts[spec.configAccountName] = configPda;
  if (spec.contract === 'DEX') {
    if (!dexPoolCreators) {
      throw new Error(
        `buildAcceptAccounts: DEX accept requires pool_creators PDA but it is null`,
      );
    }
    baseAccounts['pool_creators'] = dexPoolCreators;
  }
  return baseAccounts;
}

function buildProposeTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  spec: SingletonSpec,
  signerPubkey: PublicKey,
  configPda: PublicKey,
  newAuthority: PublicKey,
): Transaction {
  return client.buildTransaction('propose_authority_transfer', {
    accounts: buildProposeAccounts(spec, signerPubkey, configPda),
    args: { new_authority: Array.from(newAuthority.toBytes()) },
  }) as Transaction;
}

function buildAcceptTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  spec: SingletonSpec,
  newAuthority: PublicKey,
  configPda: PublicKey,
  dexPoolCreators: PublicKey | null,
): Transaction {
  return client.buildTransaction('accept_authority_transfer', {
    accounts: buildAcceptAccounts(spec, newAuthority, configPda, dexPoolCreators),
    args: {},
  }) as Transaction;
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

export interface TransferAuthorityResult {
  /** True iff every step succeeded and final assertAuthorityChainComplete passed. */
  ok: boolean;
  /** Each step's planned action (populated on dry-run; informational on live runs). */
  planned: PlannedAction[];
  /** Final zero-authority audit verdict. */
  audit: Awaited<ReturnType<typeof assertAuthorityChainComplete>>;
}

/**
 * Top-level entry — Phase 7 authority handover.
 *
 * The caller is responsible for persisting `art` after this returns; this
 * module mutates `art.authority_chain` in-memory and the CLI wrapper at the
 * bottom of the file calls saveArtifactPublic.
 */
export async function transferAuthority(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  opts: TransferAuthorityOptions,
): Promise<TransferAuthorityResult> {
  const resolved: Required<TransferAuthorityOptions> = {
    multisigPubkey: opts.multisigPubkey,
    dryRun: opts.dryRun ?? false,
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    twoTxMode: opts.twoTxMode ?? false,
  };

  // SEC-51: defensive check at library API entry — refuse twoTxMode runs
  // where multisig === deployer. SEC-34 covers the CLI; this covers the
  // case where Scenario 6 / Substep 8 imports transferAuthority() directly.
  if (resolved.twoTxMode && resolved.multisigPubkey.equals(deployer.publicKey)) {
    throw new Error(
      `transferAuthority: twoTxMode=true requires multisigPubkey != deployer.publicKey. ` +
        `Got multisig=${resolved.multisigPubkey.toBase58()} (deployer); refusing to proceed.`,
    );
  }

  log('main', `multisig=${resolved.multisigPubkey.toBase58()}`);
  log(
    'main',
    `mode=${resolved.twoTxMode ? 'mainnet (--two-tx-mode; multisig accept out-of-band)' : 'devnet (deployer-as-multisig per D32)'}, ` +
      `dryRun=${resolved.dryRun}, maxRetries=${resolved.maxRetries}`,
  );

  // ---- R-B precheck ----
  if (!resolved.dryRun) {
    await runRbPrecheck(conn, deployer, art);
  } else {
    log('r-b-precheck', '(dry-run) skipping live R-B checks');
  }

  const planned: PlannedAction[] = [];

  // Steps 1+2.
  await transferOtToFutarchy(conn, deployer, art, resolved, planned);

  // Steps 3+4.
  await transferFutarchyToMultisig(conn, deployer, art, resolved, planned);

  // Steps 5, 6, 7.
  const singletons: SingletonSpec[] = [
    {
      contract: 'RWT',
      programIdField: 'rwt_engine',
      idlName: 'rwt-engine',
      configAccountName: 'rwt_vault',
      configPdaArtifactField: 'rwt_vault',
      authorityOffset: RWT_VAULT_AUTHORITY_OFFSET,
      stage: 'step-5-rwt-to-multisig',
      artifactTimestampKey: 'rwt_to_multisig_at',
    },
    {
      contract: 'DEX',
      programIdField: 'native_dex',
      idlName: 'native-dex',
      configAccountName: 'dex_config',
      configPdaArtifactField: 'dex_config',
      authorityOffset: DEX_CONFIG_AUTHORITY_OFFSET,
      stage: 'step-6-dex-to-multisig',
      artifactTimestampKey: 'dex_to_multisig_at',
    },
    {
      contract: 'YD',
      programIdField: 'yield_distribution',
      idlName: 'yield-distribution',
      configAccountName: 'config',
      configPdaArtifactField: 'yd_dist_config',
      authorityOffset: DISTRIBUTION_CONFIG_AUTHORITY_OFFSET,
      stage: 'step-7-yd-to-multisig',
      artifactTimestampKey: 'yd_to_multisig_at',
    },
  ];

  for (const spec of singletons) {
    await transferSingletonToMultisig(conn, deployer, art, resolved, spec, planned);
  }

  // ---- Final cross-coverage audit (R-G) ----
  // On dry-run we skip the audit because no on-chain state changed; the
  // helper would still be useful but its output would be misleading.
  if (resolved.dryRun) {
    art.authority_chain = {
      ...(art.authority_chain ?? {}),
      multisig_pubkey: resolved.multisigPubkey.toBase58(),
    };
    log('main', `(dry-run) plan: ${planned.length} actions`);
    return {
      ok: true,
      planned,
      audit: { ok: true, checks: [], mismatches: [] },
    };
  }

  // SEC-35: positive audit — assert each contract's authority equals the
  // EXPECTED target (multisig for Futarchy/RWT/DEX/YD; futarchy_config_pda
  // for OT). On devnet pseudo-multisig (D32) the expected target is the
  // deployer itself, so this passes — the old != deployer check would have
  // false-failed the entire devnet rehearsal.
  const audit = await assertAuthorityChainComplete(
    conn,
    {
      multisigPubkey: resolved.multisigPubkey,
      futarchyConfigPda: undefined, // helper resolves from art.ots[0].futarchy_config_pda
    },
    art,
  );
  for (const c of audit.checks) {
    log('audit', `${c.contract.padEnd(8)} ${c.ok ? 'OK ' : 'FAIL'} ${c.detail}`);
  }
  if (!audit.ok) {
    throw new Error(
      `phase-7 FATAL: authority chain not complete: ${audit.mismatches.join(', ')}. ` +
        `Manual recovery required — halt and triage authority chain manually (R-A).`,
    );
  }

  art.authority_chain = {
    ...(art.authority_chain ?? {}),
    multisig_pubkey: resolved.multisigPubkey.toBase58(),
    completed_at: new Date().toISOString(),
  };

  log('main', `Phase 7 complete — all 5 contracts rotated to multisig ${resolved.multisigPubkey.toBase58()}`);
  return { ok: true, planned, audit };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Argv {
  artifact: string;
  multisig: string | undefined;
  dryRun: boolean;
  twoTxMode: boolean;
  maxRetries: number;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let artifact = DEFAULT_ARTIFACT_PATH;
  let multisig: string | undefined;
  let dryRun = false;
  let twoTxMode = process.env.MAINNET === '1';
  let maxRetries = DEFAULT_MAX_RETRIES;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--multisig' && next !== undefined) {
      multisig = next;
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--two-tx-mode') {
      twoTxMode = true;
    } else if (a === '--max-retries' && next !== undefined) {
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0 && n <= 10) {
        maxRetries = n;
      }
      i++;
    }
  }
  return { artifact, multisig, dryRun, twoTxMode, maxRetries };
}

/**
 * Resolve the multisig pubkey with strict base58 validation.
 *
 * Precedence:
 *   1. `--multisig <base58>` CLI flag.
 *   2. `MULTISIG_PUBKEY` env var.
 *   3. Default to deployer.publicKey (D32 devnet pseudo-multisig).
 *
 * Any non-default source is base58-validated. Invalid input throws — never
 * silently fall back to the deployer key (that would defeat the whole point
 * of the multisig pseudo-rotation).
 */
function resolveMultisig(argv: Argv, deployer: Keypair): PublicKey {
  const raw = argv.multisig ?? process.env.MULTISIG_PUBKEY;
  const isMainnetMode = argv.twoTxMode || process.env.MAINNET === '1';

  if (!raw) {
    // SEC-34: in mainnet/two-tx mode, REFUSE to fall back to deployer pubkey.
    // Falling back would silently rotate authority "to multisig" while the new
    // authority IS the deployer — operator wouldn't notice until the post-Phase-7
    // audit fires AFTER all 4 transfers landed on-chain.
    if (isMainnetMode) {
      throw new Error(
        `MAINNET mode requires explicit non-deployer multisig pubkey. Pass via ` +
          `--multisig <base58> or MULTISIG_PUBKEY env var. Refusing to default to ` +
          `deployer pubkey in two-tx-mode/MAINNET=1.`,
      );
    }
    log('main', `multisig pubkey not provided — defaulting to deployer (D32 devnet pseudo-multisig)`);
    return deployer.publicKey;
  }

  // SEC-38: length + path-character pre-validation BEFORE constructing PublicKey.
  // PublicKey() throws on a path, but the error message is unhelpful; this gate
  // gives the operator an actionable diagnostic.
  if (raw.length < 32 || raw.length > 44) {
    throw new Error(
      `MULTISIG_PUBKEY must be 32-44 base58 chars (got length=${raw.length}). ` +
        `Did you pass a file path instead of a base58 pubkey?`,
    );
  }
  if (raw.includes('/') || raw.includes('\\') || raw.includes('.json')) {
    throw new Error(
      `MULTISIG_PUBKEY contains path-like characters; pass the base58 pubkey ` +
        `string, not a file path.`,
    );
  }

  let pk: PublicKey;
  try {
    pk = new PublicKey(raw);
    // Defense-in-depth: PublicKey(...) accepts anything decodable as 32 bytes,
    // including padded zeros. Reject the canonical zero address explicitly.
    if (pk.toBuffer().every((b) => b === 0)) {
      throw new Error('zero address rejected');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid multisig pubkey "${raw}": ${msg}`);
  }

  // SEC-34: in mainnet/two-tx mode, REJECT equality with deployer.
  if (isMainnetMode && pk.equals(deployer.publicKey)) {
    throw new Error(
      `MAINNET mode rejects multisig pubkey equal to deployer (${deployer.publicKey.toBase58()}). ` +
        `Pass a real multisig pubkey via --multisig or MULTISIG_PUBKEY env var.`,
    );
  }

  return pk;
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

  const multisigPubkey = resolveMultisig(argv, deployer);

  const result = await transferAuthority(conn, deployer, art, {
    multisigPubkey,
    dryRun: argv.dryRun,
    twoTxMode: argv.twoTxMode,
    maxRetries: argv.maxRetries,
  });

  // Persist the updated artifact (authority_chain timestamps).
  saveArtifactPublic(argv.artifact, art);

  if (argv.dryRun) {
    log('main', 'dry-run plan:');
    for (const a of result.planned) {
      log('main', `  - [${a.step}] ${a.description}`);
    }
  }

  log('main', `result.ok=${result.ok}`);
}

// --------------------------------------------------------------------------
// Entry — guard so import-side-only consumers (tests, scenarios) don't trigger main().
// --------------------------------------------------------------------------

const isCli = (() => {
  // process.argv[1] is the entry script when invoked directly. We compare
  // against this module's own file URL to avoid running main() when imported.
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
    console.error(`[transfer-authority] FATAL: ${msg}`);
    process.exit(1);
  });
}

// Re-export the audit helper so consumers can import either module.
export { assertDeployerZeroAuthority, type ZeroAuthorityArtifact };

// Silence unused-imports for SystemProgram (kept available for future ix that
// may need explicit system_program account injection by the CLI at this layer).
void SYSTEM_PROGRAM_ID;
