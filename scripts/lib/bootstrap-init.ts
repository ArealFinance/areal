#!/usr/bin/env tsx
/*
 * bootstrap-init.ts — Layer 9 Substep 12 on-chain init driver.
 *
 * Heavy on-chain initialization for the localhost E2E bootstrap. Driven by
 * scripts/e2e-bootstrap.sh (stage 6). Reads program IDs + deployer keypair
 * from data/e2e-bootstrap.json (already populated by stages 1-5) and runs
 * the seven init phases:
 *
 *   a) Test mints                : USDC test mint, ARL OT mint
 *   b) Singleton configs         : DEX initialize_dex, YD initialize_config
 *   c) RWT vault                 : RWT::initialize_vault (mint authority -> vault PDA)
 *   d) YD liquidity holding      : YD::initialize_liquidity_holding (best-effort)
 *   e) DEX Liquidity Nexus       : DEX::initialize_nexus (best-effort, Layer 9)
 *   f) Master RWT/USDC pool      : DEX::create_pool + add_liquidity
 *   g) Per-OT (count=OT_TEST_COUNT, default 3):
 *        OT::initialize_ot, YD::create_distributor, optional batch_update_destinations
 *   h) USDC supply mints to: deployer, publisher mock, accumulator USDC ATAs
 *
 * Idempotency: PDA presence is read first; if already initialized, the step is
 * skipped and the existing on-chain state is reflected back into the artifact
 * map (mirrors dashboard/src/lib/stores/e2e-runner.ts).
 *
 * Idempotency caveat: test mint Keypairs are RANDOM per run unless reseeded
 * from data/e2e-bootstrap.json. On warm restarts (KEEP_LEDGER=1) the previous
 * mints are reused via the artifact map.
 *
 * Output: writes data/e2e-bootstrap.json with all created addresses (mints,
 * PDAs, ATAs, distributors, bot keypair paths if generated separately).
 *
 * Usage:
 *   npx tsx scripts/lib/bootstrap-init.ts \
 *       [--artifact data/e2e-bootstrap.json] \
 *       [--ot-count 3]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — local ESM with .d.mts sibling, resolves at runtime via tsx.
import { ArlexClient } from '../../dashboard/src/lib/arlex-client/index.mjs';

// --------------------------------------------------------------------------
// Constants & paths
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');
const DEFAULT_OT_COUNT = parseInt(process.env.OT_TEST_COUNT ?? '3', 10);

/**
 * Substep 12 sec M-2 — secret-file split.
 *
 * The single artifact embeds three flavors of state:
 *   1. Public  — program IDs, PDAs, init flags, slot. Safe to share.
 *   2. Secret  — keypair bytes (`*_keypair_b64`), RPC tokens, deployer paths.
 *   3. Public-but-derivable — addresses derived from secret values.
 *
 * For a clean public-repo demo, we split the on-disk representation: the
 * primary artifact stays human-readable + safe; secrets live in a sibling
 * `<basename>.secrets.json` with the same 0o600 perms that the merged file
 * had. Loading is symmetric — `loadArtifact` re-merges so callers see the
 * pre-split shape.
 */
function secretsPathFor(artifactPath: string): string {
  const ext = artifactPath.endsWith('.json') ? '.json' : '';
  const base = ext ? artifactPath.slice(0, -ext.length) : artifactPath;
  return `${base}.secrets${ext || '.json'}`;
}

/** Top-level artifact keys that contain secret material. */
type SecretMintKey =
  | 'usdc_test_mint_keypair_b64'
  | 'arl_ot_mint_keypair_b64'
  | 'rwt_mint_keypair_b64';
const SECRET_MINT_KEYS: ReadonlyArray<SecretMintKey> = [
  'usdc_test_mint_keypair_b64',
  'arl_ot_mint_keypair_b64',
  'rwt_mint_keypair_b64',
];

type SecretOtKey = 'ot_mint_keypair_b64';
const SECRET_OT_KEYS: ReadonlyArray<SecretOtKey> = ['ot_mint_keypair_b64'];

interface SecretsFile {
  /** Schema version mirrors the public artifact's version. */
  schema_version: number;
  /** Optional deployer keypair path — duplicated here so secrets file is self-contained. */
  deployer_keypair_path?: string;
  /** Subset of `mints` containing only `*_keypair_b64` fields. */
  mints?: Partial<Record<SecretMintKey, string>>;
  /** Per-OT keypair bytes, keyed by OT mint pubkey (base58). */
  ots?: Record<string, { ot_mint_keypair_b64: string }>;
  /** Per-bot keypair paths (already kept here for completeness). */
  bots?: Artifact['bots'];
}

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[bootstrap-init] [${stage}] ${msg}`;
  if (extra) {
    console.log(line, JSON.stringify(extra));
  } else {
    console.log(line);
  }
}

function warn(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[bootstrap-init] [${stage}] WARN: ${msg}`;
  if (extra) {
    console.warn(line, JSON.stringify(extra));
  } else {
    console.warn(line);
  }
}

// --------------------------------------------------------------------------
// Artifact map I/O
// --------------------------------------------------------------------------

interface OtRecord {
  ot_mint: string;
  ot_mint_keypair_b64: string;
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
  // Layer 10 substep 2 — ARL OT bootstrap extras (Phase 3 plan §63-77).
  // Populated only for the first OT (ARL) by phaseFutarchy / phaseDestinations
  // / phaseArlMint. Optional so non-ARL test OTs keep the existing shape.
  futarchy_config_pda?: string;
  treasury_usdc_ata?: string;
  destinations_set?: boolean;
  initial_supply_minted?: string;
}

// Schema version for the artifact JSON. Bumped when fields are added,
// removed, or repurposed so downstream consumers (Substep 13 E2E harness,
// cu-profile.sh) can break-detect drift cleanly.
export const ARTIFACT_SCHEMA_VERSION = 1 as const;

interface Artifact {
  schema_version: number;
  bootstrap_target: 'localhost' | 'devnet';
  rpc_url: string;
  ws_url?: string;
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
    usdc_test_mint: string;
    usdc_test_mint_keypair_b64: string;
    arl_ot_mint?: string;
    arl_ot_mint_keypair_b64?: string;
    rwt_mint?: string;
    rwt_mint_keypair_b64?: string;
  };
  pdas?: {
    dex_config: string;
    pool_creators: string;
    yd_dist_config: string;
    rwt_vault: string;
    rwt_dist_config: string;
    rwt_capital_accumulator_ata: string;
    areal_fee_ata: string;
    liquidity_holding?: string;
    liquidity_holding_ata?: string;
    liquidity_nexus?: string;
    master_pool?: string;
    master_pool_vault_a?: string;
    master_pool_vault_b?: string;
    // Layer 10 substep 2 — concentrated master pool BinArray PDA + ARL/RWT
    // governance pool. The master pool now uses POOL_TYPE_CONCENTRATED (D40 +
    // SD-4); the bin array PDA is required for any subsequent add_liquidity /
    // swap CPI on it.
    master_pool_bin_array?: string;
    arl_rwt_pool?: string;
    arl_rwt_pool_vault_a?: string;
    arl_rwt_pool_vault_b?: string;
    // Layer 10 substep 2 — Crank wallet USDC ATA used by ARL OT destinations
    // (10% Nexus-via-Crank slot per plan §74). This is an ATA owned by the
    // deployer keypair, NOT a separate crank wallet — devnet pseudo-multisig
    // pattern (D32). Mainnet runbook overrides this with a dedicated crank
    // bot wallet.
    crank_usdc_ata?: string;
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
  /** Phases skipped because a precondition wasn't met (IDL stale, R20 pin pending). */
  init_skipped?: string[];
  /** Phases that attempted but threw at runtime — distinct from preconditioned skips
   *  so the Substep 13 harness can gate "didn't try" vs "tried and failed" differently. */
  init_failed?: { phase: string; error: string }[];
  init_completed_at?: string;
}

function loadArtifact(path: string): Artifact {
  if (!existsSync(path)) {
    throw new Error(`artifact not found: ${path}`);
  }
  const merged = JSON.parse(readFileSync(path, 'utf8')) as Artifact;

  // Sec M-2: re-merge secrets file (if present) into the in-memory artifact.
  // Older runs that wrote a single combined file still load cleanly because
  // the public file already carries every key — the secrets file is purely
  // additive on first split, then takes over on subsequent saves.
  const secretsPath = secretsPathFor(path);
  if (existsSync(secretsPath)) {
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as SecretsFile;
    if (secrets.deployer_keypair_path && !merged.deployer_keypair_path) {
      merged.deployer_keypair_path = secrets.deployer_keypair_path;
    }
    if (secrets.mints) {
      merged.mints = { ...(merged.mints ?? {}), ...secrets.mints } as Artifact['mints'];
    }
    if (secrets.bots) {
      merged.bots = { ...(merged.bots ?? {}), ...secrets.bots };
    }
    if (secrets.ots && Array.isArray(merged.ots)) {
      merged.ots = merged.ots.map((rec) => {
        const sec = secrets.ots?.[rec.ot_mint];
        return sec ? { ...rec, ...sec } : rec;
      });
    }
  }
  return merged;
}

function saveArtifact(path: string, art: Artifact): void {
  // Always re-stamp the schema version on save so partially-written artifacts
  // from older script versions get re-tagged on the next run.
  art.schema_version = ARTIFACT_SCHEMA_VERSION;
  mkdirSync(dirname(path), { recursive: true });

  // ---------------------------------------------------------------------------
  // Sec M-2: split the artifact into a public file (no secrets) and a sibling
  // `.secrets.json` that holds keypair bytes + deployer path. Both files keep
  // 0o600 perms — the secrets file because it's a secret, the public file
  // because Substep 12 still embeds session-level state we don't want random
  // local users tampering with mid-bootstrap.
  // ---------------------------------------------------------------------------
  const secrets: SecretsFile = { schema_version: ARTIFACT_SCHEMA_VERSION };

  // Deployer keypair path — referenced by every consumer; safe to keep in the
  // public file IF the file path itself isn't sensitive. Bootstrap writes it
  // to a local `keys/` directory, so we keep it in BOTH for compatibility.
  if (art.deployer_keypair_path) {
    secrets.deployer_keypair_path = art.deployer_keypair_path;
  }

  // SD-32 fix: build a public-side serialization that strips secrets WITHOUT
  // mutating `art` in-memory. Prior to this fix, saveArtifact would
  // delete `*_keypair_b64` from `art.mints` (and `art.ots`) after writing the
  // public file. Subsequent phases that read `art.mints.rwt_mint_keypair_b64`
  // (e.g. phaseRwtVault's warm-restart path) would see undefined and
  // generate a fresh keypair, breaking the chain when verify-fresh-deploy.sh
  // pre-genned a keypair via stage_pregen_keypairs and bootstrap-init was
  // expected to reuse it.

  // Mint keypair bytes — copy to secrets, strip from public-only view.
  let publicMints: Artifact['mints'] | undefined = art.mints;
  if (art.mints) {
    publicMints = { ...art.mints };
    secrets.mints = {};
    for (const k of SECRET_MINT_KEYS) {
      const v = (publicMints as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length > 0) {
        secrets.mints[k] = v;
        delete (publicMints as Record<string, unknown>)[k];
      }
    }
  }

  // OT mint keypair bytes — same pattern.
  let publicOts: Artifact['ots'] = art.ots;
  if (Array.isArray(art.ots)) {
    secrets.ots = {};
    publicOts = art.ots.map((rec) => {
      const copy = { ...rec };
      for (const k of SECRET_OT_KEYS) {
        const v = (copy as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.length > 0) {
          (secrets.ots as Record<string, { ot_mint_keypair_b64: string }>)[rec.ot_mint] = {
            ot_mint_keypair_b64: v,
          };
          delete (copy as Record<string, unknown>)[k];
        }
      }
      return copy;
    });
  }

  // Bots — keypair paths land in BOTH files. The path itself is non-sensitive;
  // the keypair file at that path is. We mirror to keep the secrets file
  // self-contained.
  if (art.bots) {
    secrets.bots = art.bots;
  }

  const publicArt = { ...art, mints: publicMints, ots: publicOts };
  writeFileSync(path, JSON.stringify(publicArt, null, 2) + '\n', 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystem — best-effort.
  }

  // Skip the secrets file entirely if we have nothing secret to store (e.g.
  // pre-init artifact with only programs[]). Avoids a confusing empty file.
  const hasSecrets =
    !!secrets.deployer_keypair_path ||
    Object.keys(secrets.mints ?? {}).length > 0 ||
    Object.keys(secrets.ots ?? {}).length > 0 ||
    Object.keys(secrets.bots ?? {}).length > 0;

  const secretsPath = secretsPathFor(path);
  if (hasSecrets) {
    writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + '\n', 'utf8');
    try {
      chmodSync(secretsPath, 0o600);
    } catch {
      // Best-effort.
    }
  }
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function keypairToB64(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString('base64');
}

function keypairFromB64(b64: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

// --------------------------------------------------------------------------
// PDA derivation (mirrors dashboard/src/lib/utils/pda.ts)
// --------------------------------------------------------------------------

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return findPda(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

// --------------------------------------------------------------------------
// SPL helpers (no-deps reimplementation of dashboard/src/lib/utils/spl.ts)
// --------------------------------------------------------------------------

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
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  // Simple confirmation poll (test-validator is fast; 60s ceiling).
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const status = value?.[0];
    if (status?.err) {
      throw new Error(`tx failed: ${JSON.stringify(status.err)} (sig=${sig})`);
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`confirmation timeout: sig=${sig}`);
}

async function createMintIxs(
  conn: Connection,
  payer: Keypair,
  mintKeypair: Keypair,
  decimals: number,
  authority: PublicKey,
): Promise<Transaction> {
  const lamports = await conn.getMinimumBalanceForRentExemption(82);

  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports,
    space: 82,
    programId: TOKEN_PROGRAM_ID,
  });

  // InitializeMint2: [20, decimals(1), authority(32), 0(1)]
  const data = Buffer.alloc(67);
  data.writeUInt8(20, 0);
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34);

  const initMintIx = new TransactionInstruction({
    keys: [{ pubkey: mintKeypair.publicKey, isSigner: false, isWritable: true }],
    programId: TOKEN_PROGRAM_ID,
    data,
  });

  return new Transaction().add(createAccountIx, initMintIx);
}

async function ensureMint(
  conn: Connection,
  payer: Keypair,
  decimals: number,
  existingKeypair?: Keypair,
): Promise<{ mint: PublicKey; keypair: Keypair; created: boolean }> {
  const kp = existingKeypair ?? Keypair.generate();
  const info = await conn.getAccountInfo(kp.publicKey);
  if (info) {
    return { mint: kp.publicKey, keypair: kp, created: false };
  }
  const tx = await createMintIxs(conn, payer, kp, decimals, payer.publicKey);
  await sendAndConfirm(conn, tx, [payer, kp]);
  return { mint: kp.publicKey, keypair: kp, created: true };
}

async function ensureAta(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = findAta(owner, mint);
  const info = await conn.getAccountInfo(ata);
  if (info) return ata;
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
  await sendAndConfirm(conn, new Transaction().add(ix), [payer]);
  return ata;
}

async function mintTo(
  conn: Connection,
  authority: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint,
): Promise<string> {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  const ix = new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
  return sendAndConfirm(conn, new Transaction().add(ix), [authority]);
}

async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

// --------------------------------------------------------------------------
// IDL loading
// --------------------------------------------------------------------------

// Loose IDL shape — the dashboard arlex-client validates the full schema at
// runtime; we only need name + instructions[].name for branch detection. The
// returned object is passed through to ArlexClient as `any` because the
// dashboard's `Idl` type is structurally-typed but stricter than what we
// declare here.
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
// String helpers (mirror dashboard/src/lib/utils/format.ts)
// --------------------------------------------------------------------------

function stringToFixedBytes(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const buf = Buffer.from(s, 'utf8');
  out.set(buf.subarray(0, Math.min(buf.length, len)), 0);
  return out;
}

// --------------------------------------------------------------------------
// Init phases
// --------------------------------------------------------------------------

async function phaseMints(conn: Connection, deployer: Keypair, art: Artifact): Promise<void> {
  log('phase-a', 'creating test mints (USDC + ARL OT)');

  // Reuse existing mints if artifact already has them (KEEP_LEDGER scenario).
  let usdcKp: Keypair;
  let usdcCreated = false;
  if (art.mints?.usdc_test_mint_keypair_b64) {
    usdcKp = keypairFromB64(art.mints.usdc_test_mint_keypair_b64);
    const info = await conn.getAccountInfo(usdcKp.publicKey);
    if (!info) {
      const r = await ensureMint(conn, deployer, 6, usdcKp);
      usdcCreated = r.created;
    }
  } else {
    const r = await ensureMint(conn, deployer, 6);
    usdcKp = r.keypair;
    usdcCreated = r.created;
  }
  log('phase-a', `usdc_test_mint=${usdcKp.publicKey.toBase58()}`, { created: usdcCreated });

  let otKp: Keypair;
  let otCreated = false;
  if (art.mints?.arl_ot_mint_keypair_b64) {
    otKp = keypairFromB64(art.mints.arl_ot_mint_keypair_b64);
    const info = await conn.getAccountInfo(otKp.publicKey);
    if (!info) {
      const r = await ensureMint(conn, deployer, 6, otKp);
      otCreated = r.created;
    }
  } else {
    const r = await ensureMint(conn, deployer, 6);
    otKp = r.keypair;
    otCreated = r.created;
  }
  log('phase-a', `arl_ot_mint=${otKp.publicKey.toBase58()}`, { created: otCreated });

  art.mints = {
    ...(art.mints ?? {}),
    usdc_test_mint: usdcKp.publicKey.toBase58(),
    usdc_test_mint_keypair_b64: keypairToB64(usdcKp),
    arl_ot_mint: otKp.publicKey.toBase58(),
    arl_ot_mint_keypair_b64: keypairToB64(otKp),
  };
}

async function phaseSingletons(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-b', 'initializing DEX + YD singletons');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const dexIdl = loadIdl('native-dex');
  const ydIdl = loadIdl('yield-distribution');

  if (!art.mints?.usdc_test_mint) {
    throw new Error('phase-a must run first');
  }
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);

  // Areal-fee ATA (USDC, owned by deployer) — used by both singletons.
  const arealFeeAta = await ensureAta(conn, deployer, usdcMint, deployer.publicKey);
  log('phase-b', `areal_fee_ata=${arealFeeAta.toBase58()}`);

  const [dexConfigPda] = findPda([Buffer.from('dex_config')], dexProgramId);
  const [poolCreatorsPda] = findPda([Buffer.from('pool_creators')], dexProgramId);
  const [ydDistConfigPda] = findPda([Buffer.from('dist_config')], ydProgramId);

  const skipped: string[] = art.init_skipped ?? [];

  // --- DEX initialize_dex ---
  const dexConfigInfo = await conn.getAccountInfo(dexConfigPda);
  if (dexConfigInfo) {
    log('phase-b', 'DEX::initialize_dex skip (already initialized)');
  } else if (!ixExists(dexIdl, 'initialize_dex')) {
    warn('phase-b', 'DEX IDL missing initialize_dex; skipping (regenerate IDL after Layer 9 build)');
    skipped.push('DEX::initialize_dex');
  } else {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('initialize_dex', {
      accounts: {
        deployer: deployer.publicKey,
        dex_config: dexConfigPda,
        pool_creators: poolCreatorsPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        areal_fee_destination: Array.from(arealFeeAta.toBytes()),
        pause_authority: Array.from(deployer.publicKey.toBytes()),
        rebalancer: Array.from(deployer.publicKey.toBytes()),
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-b', `DEX::initialize_dex OK (config=${dexConfigPda.toBase58()})`);
  }

  // --- YD initialize_config ---
  const ydConfigInfo = await conn.getAccountInfo(ydDistConfigPda);
  if (ydConfigInfo) {
    log('phase-b', 'YD::initialize_config skip (already initialized)');
  } else if (!ixExists(ydIdl, 'initialize_config')) {
    warn('phase-b', 'YD IDL missing initialize_config; skipping');
    skipped.push('YD::initialize_config');
  } else {
    const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
    const tx = ydClient.buildTransaction('initialize_config', {
      accounts: {
        deployer: deployer.publicKey,
        config: ydDistConfigPda,
        areal_fee_destination_account: arealFeeAta,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        publish_authority: Array.from(deployer.publicKey.toBytes()),
        protocol_fee_bps: 25,
        min_distribution_amount: 1_000_000,
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-b', `YD::initialize_config OK (config=${ydDistConfigPda.toBase58()})`);
  }

  art.pdas = {
    ...(art.pdas ?? {} as NonNullable<Artifact['pdas']>),
    dex_config: dexConfigPda.toBase58(),
    pool_creators: poolCreatorsPda.toBase58(),
    yd_dist_config: ydDistConfigPda.toBase58(),
    rwt_vault: art.pdas?.rwt_vault ?? '',
    rwt_dist_config: art.pdas?.rwt_dist_config ?? '',
    rwt_capital_accumulator_ata: art.pdas?.rwt_capital_accumulator_ata ?? '',
    areal_fee_ata: arealFeeAta.toBase58(),
  };
  art.init_skipped = skipped;
}

async function phaseRwtVault(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-c', 'initializing RWT vault (creates RWT mint)');

  const rwtProgramId = new PublicKey(art.programs.rwt_engine);
  const rwtIdl = loadIdl('rwt-engine');
  const usdcMint = new PublicKey(art.mints!.usdc_test_mint);
  const arealFeeAta = new PublicKey(art.pdas!.areal_fee_ata);

  const [vaultPda] = findPda([Buffer.from('rwt_vault')], rwtProgramId);
  const [distConfigPda] = findPda([Buffer.from('dist_config_rwt')], rwtProgramId);
  const skipped = art.init_skipped ?? [];

  const existing = await conn.getAccountInfo(vaultPda);
  if (existing) {
    // Read RWT mint from vault data layout (offset 72..104 per dashboard runner).
    const rwtMint = new PublicKey(existing.data.subarray(72, 104));
    const capAta = findAta(vaultPda, usdcMint);
    log('phase-c', `RWT::initialize_vault skip (rwt_mint=${rwtMint.toBase58()})`);
    art.pdas = {
      ...art.pdas!,
      rwt_vault: vaultPda.toBase58(),
      rwt_dist_config: distConfigPda.toBase58(),
      rwt_capital_accumulator_ata: capAta.toBase58(),
    };
    art.mints = {
      ...art.mints!,
      rwt_mint: rwtMint.toBase58(),
      rwt_mint_keypair_b64: art.mints?.rwt_mint_keypair_b64 ?? '',
    };
    return;
  }

  if (!ixExists(rwtIdl, 'initialize_vault')) {
    warn('phase-c', 'RWT IDL missing initialize_vault; skipping');
    skipped.push('RWT::initialize_vault');
    art.init_skipped = skipped;
    return;
  }

  // Reuse RWT mint kp from artifact if present (warm restart support).
  let rwtMintKp: Keypair;
  if (art.mints?.rwt_mint_keypair_b64) {
    rwtMintKp = keypairFromB64(art.mints.rwt_mint_keypair_b64);
  } else {
    rwtMintKp = Keypair.generate();
  }
  const capAta = findAta(vaultPda, usdcMint);

  const rwtClient = new ArlexClient(loadIdlForClient('rwt-engine'), rwtProgramId, conn);
  const tx = rwtClient.buildTransaction('initialize_vault', {
    accounts: {
      deployer: deployer.publicKey,
      rwt_vault: vaultPda,
      dist_config: distConfigPda,
      rwt_mint: rwtMintKp.publicKey,
      usdc_mint: usdcMint,
      capital_accumulator_ata: capAta,
      areal_fee_destination_account: arealFeeAta,
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
      ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
    },
    args: {
      initial_authority: Array.from(deployer.publicKey.toBytes()),
      pause_authority: Array.from(deployer.publicKey.toBytes()),
      liquidity_destination: Array.from(deployer.publicKey.toBytes()),
      protocol_revenue_destination: Array.from(deployer.publicKey.toBytes()),
    },
    computeUnits: 300_000,
  });
  await sendAndConfirm(conn, tx, [deployer, rwtMintKp]);
  log('phase-c', `RWT::initialize_vault OK (vault=${vaultPda.toBase58()}, rwt=${rwtMintKp.publicKey.toBase58()})`);

  art.pdas = {
    ...art.pdas!,
    rwt_vault: vaultPda.toBase58(),
    rwt_dist_config: distConfigPda.toBase58(),
    rwt_capital_accumulator_ata: capAta.toBase58(),
  };
  art.mints = {
    ...art.mints!,
    rwt_mint: rwtMintKp.publicKey.toBase58(),
    rwt_mint_keypair_b64: keypairToB64(rwtMintKp),
  };
}

async function phaseLiquidityHolding(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-d', 'initializing YD LiquidityHolding (best-effort — pinned RWT_MINT match)');

  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const ydIdl = loadIdl('yield-distribution');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(ydIdl, 'initialize_liquidity_holding')) {
    warn('phase-d', 'YD IDL missing initialize_liquidity_holding; skipping (regenerate IDL after Layer 8 build)');
    skipped.push('YD::initialize_liquidity_holding');
    art.init_skipped = skipped;
    return;
  }

  if (!art.mints?.rwt_mint) {
    warn('phase-d', 'rwt_mint not set; skipping LiquidityHolding init');
    skipped.push('YD::initialize_liquidity_holding (no rwt_mint)');
    art.init_skipped = skipped;
    return;
  }

  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const [holdingPda] = findPda([Buffer.from('liq_holding')], ydProgramId);
  const holdingAta = findAta(holdingPda, rwtMint);

  const existing = await conn.getAccountInfo(holdingPda);
  if (existing) {
    log('phase-d', `YD::initialize_liquidity_holding skip (already initialized)`);
    art.pdas = {
      ...art.pdas!,
      liquidity_holding: holdingPda.toBase58(),
      liquidity_holding_ata: holdingAta.toBase58(),
    };
    return;
  }

  // Best-effort: YD pins RWT_MINT in constants.rs at compile time. If the
  // freshly created RWT mint doesn't match the pinned bytes, the program will
  // reject with InvalidTokenAccount. We try, and on failure log + skip to keep
  // bootstrap moving. Operator must run the R20 migration runbook (rebuild YD
  // with the canonical RWT mint pinned) for a clean init.
  try {
    const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
    const tx = ydClient.buildTransaction('initialize_liquidity_holding', {
      accounts: {
        payer: deployer.publicKey,
        liquidity_holding: holdingPda,
        rwt_mint: rwtMint,
        liquidity_holding_ata: holdingAta,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      args: {},
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-d', `YD::initialize_liquidity_holding OK (pda=${holdingPda.toBase58()})`);
    art.pdas = {
      ...art.pdas!,
      liquidity_holding: holdingPda.toBase58(),
      liquidity_holding_ata: holdingAta.toBase58(),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-d', `initialize_liquidity_holding failed (likely RWT_MINT pin mismatch — see R20 runbook): ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    // tester M-3 — runtime failure (NOT a precondition skip). Substep 13
    // E2E gating logic must distinguish "didn't try" from "tried + reverted".
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'YD::initialize_liquidity_holding', error: head });
    art.init_failed = failed;
  }
}

async function phaseNexus(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-e', 'initializing DEX LiquidityNexus (Layer 10 — required)');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');

  // Layer 10 Substep 1 — R57 closure (2026-04-27): the dashboard IDL was
  // regenerated to include the 9 Nexus instructions, so the previous
  // best-effort `ixExists` skip is gone. If `initialize_nexus` is still
  // missing here, the IDL on disk is stale — fail LOUDLY rather than
  // silently recording a skip and letting downstream phases run against a
  // half-bootstrapped Nexus.
  if (!ixExists(dexIdl, 'initialize_nexus')) {
    throw new Error(
      'DEX IDL missing initialize_nexus — IDL regeneration (R57) is incomplete. ' +
        'Re-run `arlex-cli idl native-dex` and rebuild the dashboard before ' +
        'continuing the bootstrap.',
    );
  }

  const [nexusPda] = findPda([Buffer.from('liquidity_nexus')], dexProgramId);
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);

  const existing = await conn.getAccountInfo(nexusPda);
  if (existing) {
    log('phase-e', 'DEX::initialize_nexus skip (already initialized)');
    art.pdas = { ...art.pdas!, liquidity_nexus: nexusPda.toBase58() };
    return;
  }

  try {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('initialize_nexus', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: dexConfigPda,
        liquidity_nexus: nexusPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        manager: Array.from(deployer.publicKey.toBytes()),
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-e', `DEX::initialize_nexus OK (nexus=${nexusPda.toBase58()})`);
    art.pdas = { ...art.pdas!, liquidity_nexus: nexusPda.toBase58() };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-e', `initialize_nexus failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    // tester M-3 — runtime failure recorded distinctly from precondition skip.
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::initialize_nexus', error: head });
    art.init_failed = failed;
  }
}

// Layer 10 substep 2 — pool seed + ARL bootstrap constants.
//
// The plan (§Phase 4) calls for a concentrated RWT/USDC pool with balanced
// seed liquidity. We pick 10_000 USDC + 10_000 RWT (10_000_000_000 base units
// at 6 decimals) as the canonical devnet seed — matches the layer-10 plan note
// "10_000 USDC + equivalent RWT" and gives Scenario 1/4/5 enough depth to
// exercise multi-bin swaps without dust artifacts.
//
// SEC-25 — every seed amount is env-overridable for the mainnet runbook. The
// helper accepts a base-unit bigint string and rejects non-positive values or
// anything > 1e15 (sanity ceiling: 1e15 base units == 1e9 tokens at 6 dec).
function parseSeedAmount(envName: string, fallback: bigint): bigint {
  const raw = process.env[envName];
  if (raw === undefined || raw === '') return fallback;
  let v: bigint;
  try {
    v = BigInt(raw);
  } catch {
    throw new Error(`bootstrap-init: ${envName}="${raw}" is not a valid integer`);
  }
  if (v <= 0n || v >= 1_000_000_000_000_000n) {
    throw new Error(
      `bootstrap-init: ${envName}=${v.toString()} out of range (0 < x < 1e15)`,
    );
  }
  return v;
}

const MASTER_POOL_SEED_USDC: bigint = parseSeedAmount(
  'MASTER_POOL_SEED_USDC_BASE',
  10_000_000_000n,
);
const MASTER_POOL_SEED_RWT: bigint = parseSeedAmount(
  'MASTER_POOL_SEED_RWT_BASE',
  10_000_000_000n,
);

// ARL/RWT governance pool seed: smaller than master pool (governance pair sees
// far less volume than the protocol's main RWT/USDC pair). 1_000 RWT + 1_000
// ARL OT — balanced 50/50 split per plan §Phase 4 step 4.
const ARL_RWT_POOL_SEED_RWT: bigint = parseSeedAmount(
  'ARL_RWT_POOL_SEED_RWT_BASE',
  1_000_000_000n,
);
const ARL_RWT_POOL_SEED_ARL: bigint = parseSeedAmount(
  'ARL_RWT_POOL_SEED_ARL_BASE',
  1_000_000_000n,
);

// ARL OT bootstrap constants. Hoisted above phaseOts so phaseOts can specialize
// the ARL OT distributor with the 365-day vesting period required by plan §70
// (the rest of the test OTs use the 1-day default).
const ARL_OT_INDEX = 0; // First test OT becomes the ARL governance token.
const ARL_VESTING_PERIOD_SECS = 31_536_000; // 365 days per plan §70.
const DEFAULT_OT_VESTING_PERIOD_SECS = 86_400; // 1 day for non-ARL test OTs.
const ARL_INITIAL_SUPPLY: bigint = parseSeedAmount(
  'ARL_INITIAL_SUPPLY_BASE',
  1_000_000_000_000n, // 1_000_000 ARL @ 6 decimals.
);

// Concentrated pool parameters per layer-10 plan §86: bin_step=10 (0.1%),
// initial_active_bin=0. With MAX_BINS=70 and lower_bin = active - 35, the pool
// covers bins -35..+34 around the initial price.
const MASTER_POOL_BIN_STEP_BPS = 10;
const MASTER_POOL_INITIAL_ACTIVE_BIN = 0;

async function phaseMasterPool(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-f', 'creating master RWT/USDC concentrated pool + seeding liquidity');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  const skipped = art.init_skipped ?? [];

  if (!art.mints?.rwt_mint || !art.mints?.usdc_test_mint) {
    warn('phase-f', 'rwt_mint or usdc_test_mint missing; skipping master pool');
    skipped.push('DEX::create_concentrated_pool master (mints missing)');
    art.init_skipped = skipped;
    return;
  }

  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const rwtMint = new PublicKey(art.mints.rwt_mint);

  // Canonical pool order: a < b
  const [tokenA, tokenB] = usdcMint.toBuffer().compare(rwtMint.toBuffer()) < 0
    ? [usdcMint, rwtMint]
    : [rwtMint, usdcMint];

  const [poolPda] = findPda(
    [Buffer.from('pool'), tokenA.toBuffer(), tokenB.toBuffer()],
    dexProgramId,
  );
  const [binArrayPda] = findPda(
    [Buffer.from('bins'), poolPda.toBuffer()],
    dexProgramId,
  );
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  // pool_creators must contain the deployer; phaseDeployerPoolCreator (called
  // before this phase) handles the whitelist update. Re-running is idempotent.
  await ensureDeployerPoolCreator(conn, deployer, art);

  const existing = await conn.getAccountInfo(poolPda);
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let isConcentrated = false;

  if (existing) {
    // PoolState layout per dashboard:
    //   8 disc + 1 pool_type + 32 mint_a + 32 mint_b + 32 vault_a + 32 vault_b + ...
    const poolType = existing.data.readUInt8(8);
    isConcentrated = poolType === 1; // POOL_TYPE_CONCENTRATED
    vaultA = new PublicKey(existing.data.subarray(73, 105));
    vaultB = new PublicKey(existing.data.subarray(105, 137));
    log(
      'phase-f',
      `master pool already exists (pool_type=${poolType}, expected concentrated=1)`,
    );
    if (!isConcentrated) {
      // Pre-Layer-10 bootstrap created a StandardCurve master pool; the same
      // PDA cannot host both types simultaneously. Operator must restart from
      // a fresh ledger to pick up the Layer 10 concentrated master pool
      // (D6 + D36 — fresh-deploy is the canonical path).
      warn(
        'phase-f',
        'master pool exists as StandardCurve but Layer 10 expects concentrated; ' +
          'restart with KEEP_LEDGER=0 to migrate (D6 + SD-4)',
      );
      skipped.push('DEX::create_concentrated_pool master (pre-existing StandardCurve)');
    }
  } else {
    if (!ixExists(dexIdl, 'create_concentrated_pool')) {
      warn('phase-f', 'DEX IDL missing create_concentrated_pool; skipping');
      skipped.push('DEX::create_concentrated_pool master');
      art.init_skipped = skipped;
      return;
    }
    const vaultAKp = Keypair.generate();
    const vaultBKp = Keypair.generate();

    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('create_concentrated_pool', {
      accounts: {
        creator: deployer.publicKey,
        dex_config: dexConfigPda,
        pool_creators: poolCreatorsPda,
        pool_state: poolPda,
        bin_array: binArrayPda,
        token_a_mint: tokenA,
        token_b_mint: tokenB,
        vault_a: vaultAKp.publicKey,
        vault_b: vaultBKp.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {
        bin_step_bps: MASTER_POOL_BIN_STEP_BPS,
        initial_active_bin: MASTER_POOL_INITIAL_ACTIVE_BIN,
      },
      computeUnits: 300_000,
    });
    await sendAndConfirm(conn, tx, [deployer, vaultAKp, vaultBKp]);
    vaultA = vaultAKp.publicKey;
    vaultB = vaultBKp.publicKey;
    isConcentrated = true;
    log(
      'phase-f',
      `master concentrated pool created (pool=${poolPda.toBase58()}, bin_step=${MASTER_POOL_BIN_STEP_BPS}, initial_bin=${MASTER_POOL_INITIAL_ACTIVE_BIN})`,
    );
  }

  art.pdas = {
    ...art.pdas!,
    master_pool: poolPda.toBase58(),
    master_pool_vault_a: vaultA.toBase58(),
    master_pool_vault_b: vaultB.toBase58(),
    master_pool_bin_array: binArrayPda.toBase58(),
  };

  // Seed liquidity only if pool is concentrated AND not yet seeded. If a
  // pre-existing StandardCurve pool blocks the upgrade, leave it alone — the
  // skip warning above is the operator's signal.
  if (!isConcentrated) {
    art.init_skipped = skipped;
    return;
  }

  const existingLiquidity = await getTokenBalance(conn, vaultA);
  if (existingLiquidity > 0n) {
    log('phase-f', `pool already seeded (vaultA=${existingLiquidity.toString()})`);
    return;
  }

  if (!ixExists(dexIdl, 'add_liquidity')) {
    warn('phase-f', 'DEX IDL missing add_liquidity; skipping seed');
    skipped.push('DEX::add_liquidity master seed');
    art.init_skipped = skipped;
    return;
  }

  // Provider needs USDC + RWT in their ATAs. The deployer is the bootstrap
  // signer, but RWT mint authority is the vault PDA, so we need admin_mint_rwt
  // to obtain RWT for the seed.
  const deployerUsdcAta = await ensureAta(conn, deployer, usdcMint, deployer.publicKey);
  const deployerRwtAta = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);

  // Top up deployer USDC ATA to the seed amount (idempotent: only mints the
  // delta).
  const usdcBal = await getTokenBalance(conn, deployerUsdcAta);
  if (usdcBal < MASTER_POOL_SEED_USDC) {
    await mintTo(conn, deployer, usdcMint, deployerUsdcAta, MASTER_POOL_SEED_USDC - usdcBal);
    log(
      'phase-f',
      `deployer USDC topped up to ${MASTER_POOL_SEED_USDC.toString()} for master pool seed`,
    );
  }

  const rwtIdl = loadIdl('rwt-engine');
  const rwtVaultPda = new PublicKey(art.pdas!.rwt_vault);
  if (ixExists(rwtIdl, 'admin_mint_rwt')) {
    const rwtBal = await getTokenBalance(conn, deployerRwtAta);
    if (rwtBal < MASTER_POOL_SEED_RWT) {
      try {
        const rwtClient = new ArlexClient(
          loadIdlForClient('rwt-engine'),
          new PublicKey(art.programs.rwt_engine),
          conn,
        );
        const need = MASTER_POOL_SEED_RWT - rwtBal;
        const adminTx = rwtClient.buildTransaction('admin_mint_rwt', {
          accounts: {
            authority: deployer.publicKey,
            rwt_vault: rwtVaultPda,
            rwt_mint: rwtMint,
            recipient_rwt: deployerRwtAta,
            token_program: TOKEN_PROGRAM_ID,
          },
          args: {
            rwt_amount: Number(need),
            backing_capital_usd: Number(need),
          },
        });
        await sendAndConfirm(conn, adminTx, [deployer]);
        log(
          'phase-f',
          `admin_mint_rwt: minted ${need.toString()} RWT to deployer ATA`,
        );
      } catch (e: unknown) {
        warn(
          'phase-f',
          `admin_mint_rwt failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        skipped.push('DEX master pool seed (admin_mint_rwt failed)');
        art.init_skipped = skipped;
        return;
      }
    }
  } else {
    warn('phase-f', 'RWT IDL missing admin_mint_rwt; skipping pool seed');
    skipped.push('DEX master pool seed (no admin_mint_rwt in IDL)');
    art.init_skipped = skipped;
    return;
  }

  // Map provider ATAs to vault sides based on canonical token order.
  const providerTokenA = tokenA.equals(usdcMint) ? deployerUsdcAta : deployerRwtAta;
  const providerTokenB = tokenB.equals(usdcMint) ? deployerUsdcAta : deployerRwtAta;
  const amountA = tokenA.equals(usdcMint) ? MASTER_POOL_SEED_USDC : MASTER_POOL_SEED_RWT;
  const amountB = tokenB.equals(usdcMint) ? MASTER_POOL_SEED_USDC : MASTER_POOL_SEED_RWT;

  const [lpPda] = findPda(
    [Buffer.from('lp'), poolPda.toBuffer(), deployer.publicKey.toBuffer()],
    dexProgramId,
  );

  // SEC-26 — sandwich protection. `min_shares: 0` is only safe on a first-add
  // (vault_a == 0) because the share calc is deterministic for the first LP.
  // When the pool already has prior liquidity, an adversary can sandwich the
  // re-seed to drain proportional value. The interim policy: refuse to re-seed
  // a non-empty master pool unless ALLOW_NONEMPTY_POOL_RESEED=1 is explicitly
  // set. The proper fix (compute expected shares client-side and pass
  // min_shares = floor(expected * 99 / 100)) requires the share-math reader
  // and lands in SD-3 backlog.
  const vaultABalance = await getTokenBalance(conn, vaultA);
  if (vaultABalance > 0n) {
    if (process.env.ALLOW_NONEMPTY_POOL_RESEED !== '1') {
      throw new Error(
        `phase-f FATAL: master pool vault_a is non-empty ` +
          `(balance=${vaultABalance.toString()} base units). Re-seeding with ` +
          `min_shares=0 is sandwichable. Set ALLOW_NONEMPTY_POOL_RESEED=1 to ` +
          `bypass with explicit operator consent (SEC-26).`,
      );
    }
    warn(
      'phase-f',
      `ALLOW_NONEMPTY_POOL_RESEED=1 — re-seeding non-empty master pool with min_shares=0 (SEC-26 bypass)`,
    );
  }

  const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
  // SD-6 (filed by Layer 10 substep 2): D40 calls for a 5-bin Gaussian seed
  // (10/20/40/20/10% across bins -2..+2). The current contract logic
  // (`concentrated::distribute_to_bins` is_first branch) spreads liquidity
  // UNIFORMLY across the full 70-bin range with no bin-list argument. So a
  // single first-add cannot produce a Gaussian shape on-chain.
  //
  // For Layer 10 substep 2 we seed a single uniform first-add (matching what
  // the contract supports) and flag SD-6 for Architect: either the contract
  // gains a per-bin distribution argument (preferred) or D40 is corrected to
  // "uniform first-add, Scenario 4 walks via subsequent swaps that displace
  // active_bin and rebalance via shift_liquidity". The plan-vs-contract
  // mismatch does NOT block deployment; Scenario 4 acceptance criteria need
  // updating once the verdict lands.
  //
  // SEC-26 — first-add deterministic share calc means min_shares: 0 is safe
  // only when vault_a == 0 (asserted above).
  const seedTx = dexClient.buildTransaction('add_liquidity', {
    accounts: {
      provider: deployer.publicKey,
      payer: deployer.publicKey,
      dex_config: dexConfigPda,
      pool_state: poolPda,
      lp_position: lpPda,
      provider_token_a: providerTokenA,
      provider_token_b: providerTokenB,
      vault_a: vaultA,
      vault_b: vaultB,
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
    },
    args: { amount_a: Number(amountA), amount_b: Number(amountB), min_shares: 0 },
    remainingAccounts: [{ pubkey: binArrayPda, isSigner: false, isWritable: true }],
    computeUnits: 400_000,
  });
  // T-10 — match rest-of-file pattern: record send failures as init_failed and
  // continue rather than aborting. The crank-startup gate downstream checks
  // init_failed before launch.
  try {
    await sendAndConfirm(conn, seedTx, [deployer]);
    log(
      'phase-f',
      `master concentrated pool seeded (${amountA.toString()}/${amountB.toString()} base units, uniform — SD-6)`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-f', `master pool add_liquidity failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::add_liquidity master', error: head });
    art.init_failed = failed;
  }
}

// ---------------------------------------------------------------------------
// Layer 10 substep 2 — pool creator whitelist helper.
//
// `update_pool_creators` (action=ADD) is required before any create_pool /
// create_concentrated_pool call. Idempotent: re-running for an already-listed
// creator returns CreatorAlreadyExists, which we treat as success.
// ---------------------------------------------------------------------------
async function ensureDeployerPoolCreator(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  if (!ixExists(dexIdl, 'update_pool_creators')) {
    warn('phase-f', 'DEX IDL missing update_pool_creators; skipping whitelist update');
    return;
  }
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  // Read current pool_creators state to check if deployer is already listed.
  // PoolCreators layout (DEX state.rs:74):
  //   8  discriminator
  //   32 authority
  //   10 * 32 = 320 creators slots
  //   1  active_count
  //   1  bump
  const CREATORS_OFFSET = 8 + 32;
  const ACTIVE_COUNT_OFFSET = CREATORS_OFFSET + 10 * 32; // 360
  const info = await conn.getAccountInfo(poolCreatorsPda);
  if (info && info.data.length >= ACTIVE_COUNT_OFFSET + 1) {
    const activeCount = info.data.readUInt8(ACTIVE_COUNT_OFFSET);
    const deployerBytes = deployer.publicKey.toBuffer();
    for (let i = 0; i < activeCount; i++) {
      const slot = info.data.subarray(
        CREATORS_OFFSET + i * 32,
        CREATORS_OFFSET + (i + 1) * 32,
      );
      if (Buffer.from(slot).equals(deployerBytes)) {
        log('phase-f', 'deployer already on pool_creators whitelist; skipping update');
        return;
      }
    }
  }

  const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
  try {
    const tx = dexClient.buildTransaction('update_pool_creators', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: dexConfigPda,
        pool_creators: poolCreatorsPda,
      },
      args: {
        wallet: Array.from(deployer.publicKey.toBytes()),
        action: 0, // ACTION_ADD
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-f', `pool_creators: added deployer ${deployer.publicKey.toBase58()}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // CreatorAlreadyExists is benign; everything else propagates.
    if (msg.includes('CreatorAlreadyExists') || msg.includes('0x1771')) {
      log('phase-f', 'pool_creators: deployer already listed (idempotent skip)');
      return;
    }
    throw e;
  }
}

async function phaseOts(conn: Connection, deployer: Keypair, art: Artifact, count: number): Promise<void> {
  log('phase-g', `creating ${count} test OT(s) + distributors`);

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const otIdl = loadIdl('ownership-token');
  const ydIdl = loadIdl('yield-distribution');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(otIdl, 'initialize_ot')) {
    warn('phase-g', 'OT IDL missing initialize_ot; skipping all OT creation');
    skipped.push('OT::initialize_ot (all)');
    art.init_skipped = skipped;
    return;
  }

  const usdcMint = new PublicKey(art.mints!.usdc_test_mint);
  const arealFeeAta = new PublicKey(art.pdas!.areal_fee_ata);

  const existing: OtRecord[] = art.ots ?? [];
  const out: OtRecord[] = [...existing];

  for (let i = 0; i < count; i++) {
    let otKp: Keypair;
    const existingRec = existing[i];
    if (existingRec?.ot_mint_keypair_b64) {
      otKp = keypairFromB64(existingRec.ot_mint_keypair_b64);
    } else {
      otKp = Keypair.generate();
    }
    const otMint = otKp.publicKey;

    const [otConfig] = findPda([Buffer.from('ot_config'), otMint.toBuffer()], otProgramId);
    const [revAcc] = findPda([Buffer.from('revenue'), otMint.toBuffer()], otProgramId);
    const [revCfg] = findPda([Buffer.from('revenue_config'), otMint.toBuffer()], otProgramId);
    const [otGov] = findPda([Buffer.from('ot_governance'), otMint.toBuffer()], otProgramId);
    const [otTreas] = findPda([Buffer.from('ot_treasury'), otMint.toBuffer()], otProgramId);
    const revTokAcc = findAta(revAcc, usdcMint);

    const otRec: OtRecord = {
      ot_mint: otMint.toBase58(),
      ot_mint_keypair_b64: keypairToB64(otKp),
      ot_config_pda: otConfig.toBase58(),
      revenue_account_pda: revAcc.toBase58(),
      revenue_config_pda: revCfg.toBase58(),
      ot_governance_pda: otGov.toBase58(),
      ot_treasury_pda: otTreas.toBase58(),
      revenue_token_account: revTokAcc.toBase58(),
    };

    // Step 1: ensure OT mint account exists.
    const mintInfo = await conn.getAccountInfo(otMint);
    if (!mintInfo) {
      await ensureMint(conn, deployer, 6, otKp);
      log('phase-g', `OT[${i}] mint created: ${otMint.toBase58()}`);
    }

    // Step 2: initialize_ot if not already.
    const otConfigInfo = await conn.getAccountInfo(otConfig);
    if (!otConfigInfo) {
      try {
        const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
        const tx = otClient.buildTransaction('initialize_ot', {
          accounts: {
            deployer: deployer.publicKey,
            ot_mint: otMint,
            usdc_mint: usdcMint,
            ot_config: otConfig,
            revenue_account: revAcc,
            revenue_token_account: revTokAcc,
            revenue_config: revCfg,
            ot_governance: otGov,
            ot_treasury: otTreas,
            areal_fee_destination_account: arealFeeAta,
            token_program: TOKEN_PROGRAM_ID,
            system_program: SYSTEM_PROGRAM_ID,
            ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
          },
          args: {
            name: Array.from(stringToFixedBytes(`Test OT ${i}`, 32)),
            symbol: Array.from(stringToFixedBytes(`TOT${i}`, 10)),
            uri: Array.from(stringToFixedBytes(`https://test.areal.finance/tot${i}`, 200)),
            initial_authority: Array.from(deployer.publicKey.toBytes()),
          },
        });
        await sendAndConfirm(conn, tx, [deployer]);
        log('phase-g', `OT[${i}]::initialize_ot OK`);
      } catch (e: unknown) {
        warn('phase-g', `OT[${i}] initialize_ot failed: ${e instanceof Error ? e.message : String(e)}`);
        skipped.push(`OT[${i}]::initialize_ot`);
        out.push(otRec);
        continue;
      }
    } else {
      log('phase-g', `OT[${i}]::initialize_ot skip (already initialized)`);
    }

    // Step 3: create_distributor (YD) — only if RWT vault is initialized + RWT mint match.
    if (
      ixExists(ydIdl, 'create_distributor') &&
      art.mints?.rwt_mint &&
      art.pdas?.rwt_vault
    ) {
      const rwtMint = new PublicKey(art.mints.rwt_mint);
      const [distributor] = findPda(
        [Buffer.from('merkle_dist'), otMint.toBuffer()],
        ydProgramId,
      );
      const [accumulator] = findPda(
        [Buffer.from('accumulator'), otMint.toBuffer()],
        ydProgramId,
      );
      const rewardVault = findAta(distributor, rwtMint);
      const accUsdcAta = findAta(accumulator, usdcMint);

      otRec.yd_distributor_pda = distributor.toBase58();
      otRec.yd_accumulator_pda = accumulator.toBase58();
      otRec.reward_vault = rewardVault.toBase58();
      otRec.accumulator_usdc_ata = accUsdcAta.toBase58();

      const distInfo = await conn.getAccountInfo(distributor);
      if (!distInfo) {
        try {
          const ydConfigPda = new PublicKey(art.pdas.yd_dist_config);
          const ydClient = new ArlexClient(loadIdlForClient('yield-distribution'), ydProgramId, conn);
          // A-14 — ARL OT (index ARL_OT_INDEX) gets the 365-day vesting period
          // required by plan §70. Every other test OT uses the 1-day default.
          // phaseArlDistributor downstream verifies the on-chain vesting matches
          // plan §70 and FAILS LOUDLY on mismatch.
          const vestingSecs =
            i === ARL_OT_INDEX ? ARL_VESTING_PERIOD_SECS : DEFAULT_OT_VESTING_PERIOD_SECS;
          const tx = ydClient.buildTransaction('create_distributor', {
            accounts: {
              authority: deployer.publicKey,
              config: ydConfigPda,
              ot_mint: otMint,
              distributor,
              accumulator,
              rwt_mint: rwtMint,
              usdc_mint: usdcMint,
              reward_vault: rewardVault,
              accumulator_usdc_ata: accUsdcAta,
              token_program: TOKEN_PROGRAM_ID,
              system_program: SYSTEM_PROGRAM_ID,
              ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            },
            args: { vesting_period_secs: vestingSecs },
          });
          await sendAndConfirm(conn, tx, [deployer]);
          log('phase-g', `OT[${i}]::create_distributor OK`);
        } catch (e: unknown) {
          warn('phase-g', `OT[${i}] create_distributor failed: ${e instanceof Error ? e.message : String(e)}`);
          skipped.push(`YD::create_distributor[${i}]`);
        }
      } else {
        log('phase-g', `OT[${i}]::create_distributor skip (already initialized)`);
      }
    }

    out[i] = otRec;
  }

  art.ots = out;
  art.init_skipped = skipped;
}

async function phaseUsdcSupply(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-h', 'minting test USDC to deployer + accumulator ATAs');

  const usdcMint = new PublicKey(art.mints!.usdc_test_mint);

  // Deployer USDC ATA — already minted in phase-f, top-up to 10000 USDC.
  const deployerAta = await ensureAta(conn, deployer, usdcMint, deployer.publicKey);
  const balance = await getTokenBalance(conn, deployerAta);
  if (balance < 10_000_000_000n) {
    const topUp = 10_000_000_000n - balance;
    await mintTo(conn, deployer, usdcMint, deployerAta, topUp);
    log('phase-h', `deployer USDC topped up by ${topUp.toString()}`);
  }

  // Accumulator USDC ATA per OT — mint 100 USDC each so revenue-crank has
  // something to distribute on first tick.
  for (const ot of art.ots ?? []) {
    if (!ot.accumulator_usdc_ata) continue;
    const accAta = new PublicKey(ot.accumulator_usdc_ata);
    const accInfo = await conn.getAccountInfo(accAta);
    if (!accInfo) {
      log('phase-h', `accumulator ATA ${accAta.toBase58()} not yet present, skipping mint`);
      continue;
    }
    const bal = await getTokenBalance(conn, accAta);
    if (bal < 100_000_000n) {
      await mintTo(conn, deployer, usdcMint, accAta, 100_000_000n - bal);
      log('phase-h', `OT(${ot.ot_mint}) accumulator topped up to 100 USDC`);
    }
  }
}

// ===========================================================================
// Layer 10 substep 2 — ARL OT bootstrap (Phase 3 plan §63-77)
// ===========================================================================
//
// Phase 3 of the layer-10 plan calls for 6 steps after Phase 2 / Phase 5:
//   1. Create ARL SPL Mint                  (already in phaseMints)
//   2. OT::initialize_ot                    (already in phaseOts step 2)
//   3. Futarchy::initialize_futarchy        (← phaseFutarchy below)
//   4. YD::create_distributor               (already in phaseOts step 3)
//   5. OT::batch_update_destinations 70/20/10 (← phaseDestinations below)
//   6. OT::mint_ot(initial_supply)          (← phaseArlMint below)
//
// `phaseOts` covers steps 1, 2, 4 for every test OT. Layer 10 substep 2
// specializes ots[ARL_OT_INDEX] inside phaseOts itself by passing the 365-day
// vesting_period_secs (constant ARL_VESTING_PERIOD_SECS hoisted alongside the
// pool seed amounts). phaseArlDistributor below verifies the on-chain vesting
// matches plan §70 and FAILS LOUDLY on mismatch. The remaining ARL-specific
// phases live below: Futarchy init, destinations 70/20/10, initial supply
// mint.
//
// HARD CONSTRAINT (plan line 79 + R-B): mint_ot MUST run before Phase 7.
// After Futarchy claims OT governance, deployer cannot mint anymore. The
// orchestration in `main()` enforces this by calling phaseArlMint before
// any authority-transfer phase (substep 3 wires that). phaseArlMint also
// runs a defensive precheck that the deployer is still OT governance
// authority and aborts the run if not (SEC-23).

async function phaseFutarchy(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-i', 'initializing Futarchy for ARL OT');

  if (!art.ots || art.ots.length === 0) {
    warn('phase-i', 'no OTs in artifact; skipping Futarchy init');
    return;
  }
  const arlOt = art.ots[ARL_OT_INDEX];
  if (!arlOt) {
    warn('phase-i', `ots[${ARL_OT_INDEX}] missing; skipping Futarchy init`);
    return;
  }

  const futProgramId = new PublicKey(art.programs.futarchy);
  const futIdl = loadIdl('futarchy');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(futIdl, 'initialize_futarchy')) {
    warn('phase-i', 'Futarchy IDL missing initialize_futarchy; skipping');
    skipped.push('Futarchy::initialize_futarchy');
    art.init_skipped = skipped;
    return;
  }

  const arlMint = new PublicKey(arlOt.ot_mint);
  const otGovernancePda = new PublicKey(arlOt.ot_governance_pda);

  const [futarchyConfigPda] = findPda(
    [Buffer.from('futarchy_config'), arlMint.toBuffer()],
    futProgramId,
  );

  const existing = await conn.getAccountInfo(futarchyConfigPda);
  if (existing) {
    log('phase-i', `Futarchy already initialized for ARL (config=${futarchyConfigPda.toBase58()})`);
    arlOt.futarchy_config_pda = futarchyConfigPda.toBase58();
    return;
  }

  try {
    const futClient = new ArlexClient(loadIdlForClient('futarchy'), futProgramId, conn);
    const tx = futClient.buildTransaction('initialize_futarchy', {
      accounts: {
        deployer: deployer.publicKey,
        ot_mint: arlMint,
        ot_governance: otGovernancePda,
        config: futarchyConfigPda,
        system_program: SYSTEM_PROGRAM_ID,
      },
      args: {},
    });
    await sendAndConfirm(conn, tx, [deployer]);
    arlOt.futarchy_config_pda = futarchyConfigPda.toBase58();
    log('phase-i', `Futarchy::initialize_futarchy OK (config=${futarchyConfigPda.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-i', `initialize_futarchy failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'Futarchy::initialize_futarchy', error: head });
    art.init_failed = failed;
  }
}

async function phaseArlDistributor(
  conn: Connection,
  _deployer: Keypair,
  art: Artifact,
): Promise<void> {
  // A-14 — verification only. phaseOts now creates the ARL OT distributor with
  // ARL_VESTING_PERIOD_SECS already (no recreation possible mid-run anyway —
  // close_distributor is a separate authority path). This phase reads the
  // on-chain `vesting_period_secs` field and FAILS LOUDLY if it doesn't match
  // plan §70.
  //
  // MerkleDistributor layout (yield-distribution/src/state.rs):
  //   8   discriminator
  //   8   ot_mint            [u8; 32]   offset 8
  //   40  reward_vault       [u8; 32]   offset 40
  //   72  accumulator        [u8; 32]   offset 72
  //   104 merkle_root        [u8; 32]   offset 104
  //   136 max_total_claim    u64        offset 136
  //   144 total_claimed      u64        offset 144
  //   152 total_funded       u64        offset 152
  //   160 locked_vested      u64        offset 160
  //   168 last_fund_ts       i64        offset 168
  //   176 vesting_period_secs i64       offset 176  ← read this
  //   184 epoch              u64        offset 184
  //   192 is_active          bool       offset 192
  //   193 bump               u8         offset 193
  if (!art.ots || art.ots.length === 0) return;
  const arlOt = art.ots[ARL_OT_INDEX];
  if (!arlOt?.yd_distributor_pda) {
    log('phase-i', 'ARL distributor not yet created; skipping vesting verification');
    return;
  }
  const distInfo = await conn.getAccountInfo(new PublicKey(arlOt.yd_distributor_pda));
  if (!distInfo) {
    log('phase-i', 'ARL distributor account missing; skipping vesting verification');
    return;
  }
  const VESTING_PERIOD_SECS_OFFSET = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8;
  if (distInfo.data.length < VESTING_PERIOD_SECS_OFFSET + 8) {
    throw new Error(
      `phase-i FATAL: ARL distributor account too small ` +
        `(${distInfo.data.length} bytes, need >= ${VESTING_PERIOD_SECS_OFFSET + 8}) — IDL drift?`,
    );
  }
  // i64 little-endian. readBigInt64LE returns bigint.
  const onChainVesting = distInfo.data.readBigInt64LE(VESTING_PERIOD_SECS_OFFSET);
  const expected = BigInt(ARL_VESTING_PERIOD_SECS);
  if (onChainVesting !== expected) {
    throw new Error(
      `phase-i FATAL: ARL distributor vesting_period_secs=${onChainVesting.toString()}s ` +
        `but plan §70 requires ${expected.toString()}s (365 days). ` +
        `phaseOts must specialize ARL OT (index ${ARL_OT_INDEX}) — ` +
        `check the i===ARL_OT_INDEX branch in phaseOts. ` +
        `Existing distributor cannot be patched in-place; restart with KEEP_LEDGER=0.`,
    );
  }
  log(
    'phase-i',
    `ARL distributor vesting verified: ${onChainVesting.toString()}s (plan §70 OK)`,
  );
}

async function phaseDestinations(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-j', 'configuring ARL OT revenue destinations (70/20/10)');

  if (!art.ots || art.ots.length === 0) {
    warn('phase-j', 'no OTs in artifact; skipping destinations');
    return;
  }
  const arlOt = art.ots[ARL_OT_INDEX];
  if (!arlOt) {
    warn('phase-j', `ots[${ARL_OT_INDEX}] missing; skipping destinations`);
    return;
  }
  if (arlOt.destinations_set === true) {
    log('phase-j', 'ARL destinations already configured (artifact flag); skipping');
    return;
  }
  if (!arlOt.accumulator_usdc_ata) {
    warn(
      'phase-j',
      'ARL accumulator_usdc_ata missing — phaseOts/create_distributor likely did not run',
    );
    return;
  }
  if (!art.mints?.usdc_test_mint) {
    warn('phase-j', 'usdc_test_mint missing; skipping destinations');
    return;
  }

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const otIdl = loadIdl('ownership-token');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(otIdl, 'batch_update_destinations')) {
    warn('phase-j', 'OT IDL missing batch_update_destinations; skipping');
    skipped.push('OT::batch_update_destinations');
    art.init_skipped = skipped;
    return;
  }

  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const arlMint = new PublicKey(arlOt.ot_mint);
  const otGovernancePda = new PublicKey(arlOt.ot_governance_pda);
  const revenueConfigPda = new PublicKey(arlOt.revenue_config_pda);

  // Destination 1: YD accumulator USDC ATA (already created by phaseOts via
  // create_distributor CPI).
  const ydAccUsdcAta = new PublicKey(arlOt.accumulator_usdc_ata);

  // Destination 2: OT treasury USDC ATA (owned by ot_treasury PDA).
  const otTreasuryPda = new PublicKey(arlOt.ot_treasury_pda);
  const treasuryUsdcAta = await ensureAta(conn, deployer, usdcMint, otTreasuryPda);
  arlOt.treasury_usdc_ata = treasuryUsdcAta.toBase58();

  // Destination 3: Crank wallet USDC ATA. SEC-24 — the deployer key is the
  // mainnet root and must NEVER be hot-funded with revenue, so non-localhost
  // bootstraps MUST set CRANK_USDC_OWNER_PUBKEY to the dedicated forwarder /
  // multisig wallet that owns this ATA. On localhost (devnet rehearsal) we
  // fall back to deployer-ownership for convenience.
  let crankOwner: PublicKey;
  const overrideOwner = process.env.CRANK_USDC_OWNER_PUBKEY;
  if (overrideOwner) {
    try {
      crankOwner = new PublicKey(overrideOwner);
    } catch {
      throw new Error(
        `phase-j FATAL: CRANK_USDC_OWNER_PUBKEY="${overrideOwner}" is not a valid base58 pubkey`,
      );
    }
    log('phase-j', `crank USDC owner override: ${crankOwner.toBase58()}`);
  } else {
    if (art.bootstrap_target !== 'localhost') {
      throw new Error(
        `phase-j FATAL: CRANK_USDC_OWNER_PUBKEY env var is required on non-localhost ` +
          `bootstrap_target="${art.bootstrap_target}". Defaulting to deployer would route ` +
          `10% of OT revenue into the mainnet root key.`,
      );
    }
    crankOwner = deployer.publicKey;
  }
  const crankUsdcAta = await ensureAta(conn, deployer, usdcMint, crankOwner);
  art.pdas = {
    ...art.pdas!,
    crank_usdc_ata: crankUsdcAta.toBase58(),
  };

  const destinations = [
    {
      address: Array.from(ydAccUsdcAta.toBytes()),
      allocation_bps: 7000,
      label: Array.from(stringToFixedBytes('YD Accumulator', 32)),
    },
    {
      address: Array.from(treasuryUsdcAta.toBytes()),
      allocation_bps: 2000,
      label: Array.from(stringToFixedBytes('Treasury', 32)),
    },
    {
      address: Array.from(crankUsdcAta.toBytes()),
      allocation_bps: 1000,
      label: Array.from(stringToFixedBytes('Nexus via Crank', 32)),
    },
  ];

  try {
    const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
    const tx = otClient.buildTransaction('batch_update_destinations', {
      accounts: {
        authority: deployer.publicKey,
        ot_mint: arlMint,
        ot_governance: otGovernancePda,
        revenue_config: revenueConfigPda,
      },
      args: { destinations },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    arlOt.destinations_set = true;
    log(
      'phase-j',
      `ARL destinations set 70/20/10 (yd=${ydAccUsdcAta.toBase58()}, treasury=${treasuryUsdcAta.toBase58()}, crank=${crankUsdcAta.toBase58()})`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-j', `batch_update_destinations failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'OT::batch_update_destinations', error: head });
    art.init_failed = failed;
  }
}

async function phaseArlMint(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-k', `minting initial ARL OT supply (${ARL_INITIAL_SUPPLY.toString()} base units)`);

  if (!art.ots || art.ots.length === 0) {
    warn('phase-k', 'no OTs in artifact; skipping ARL mint');
    return;
  }
  const arlOt = art.ots[ARL_OT_INDEX];
  if (!arlOt) {
    warn('phase-k', `ots[${ARL_OT_INDEX}] missing; skipping ARL mint`);
    return;
  }

  const otProgramId = new PublicKey(art.programs.ownership_token);
  const otIdl = loadIdl('ownership-token');
  const skipped = art.init_skipped ?? [];

  if (!ixExists(otIdl, 'mint_ot')) {
    warn('phase-k', 'OT IDL missing mint_ot; skipping');
    skipped.push('OT::mint_ot');
    art.init_skipped = skipped;
    return;
  }

  const arlMint = new PublicKey(arlOt.ot_mint);
  const otGovernancePda = new PublicKey(arlOt.ot_governance_pda);
  const otConfigPda = new PublicKey(arlOt.ot_config_pda);

  // Idempotency check 1: artifact flag.
  if (arlOt.initial_supply_minted) {
    log('phase-k', `ARL initial supply already minted (${arlOt.initial_supply_minted}); skipping`);
    return;
  }

  // Idempotency check 2: deployer's ARL ATA balance. If it's already at-or-
  // above the initial supply, treat the mint as done (warm-restart safety).
  const recipientAta = await ensureAta(conn, deployer, arlMint, deployer.publicKey);
  const balance = await getTokenBalance(conn, recipientAta);
  if (balance >= ARL_INITIAL_SUPPLY) {
    log('phase-k', `deployer ARL ATA balance ${balance.toString()} >= initial supply; skipping mint`);
    arlOt.initial_supply_minted = ARL_INITIAL_SUPPLY.toString();
    return;
  }

  // SEC-23 — defensive R-B precheck. Reads the OtGovernance.authority field
  // and aborts the run if the deployer is no longer authority. mint_ot has
  // `has_one = authority`, so if Phase 7 has already transferred ownership to
  // Futarchy or Multisig, this call would fail with `OwnerMismatch` and the
  // ARL initial supply would be permanently unmintable (R-B catastrophe).
  //
  // OtGovernance layout (ownership-token/src/state.rs):
  //   0  discriminator        [u8; 8]
  //   8  ot_mint              [u8; 32]
  //   40 authority            [u8; 32]   ← read target
  //   72 pending_authority    [u8; 32]
  //   ...
  // Total = 107 bytes (8 disc + 99 data).
  const OT_GOV_AUTHORITY_OFFSET = 40;
  const OT_GOV_MIN_SIZE = OT_GOV_AUTHORITY_OFFSET + 32;
  const govInfo = await conn.getAccountInfo(otGovernancePda);
  if (govInfo && govInfo.data.length >= OT_GOV_MIN_SIZE) {
    const onChainAuthority = govInfo.data.subarray(
      OT_GOV_AUTHORITY_OFFSET,
      OT_GOV_AUTHORITY_OFFSET + 32,
    );
    if (!Buffer.from(onChainAuthority).equals(deployer.publicKey.toBuffer())) {
      const actual = new PublicKey(onChainAuthority).toBase58();
      throw new Error(
        `phase-k FATAL: deployer is no longer OT governance authority — ` +
          `Phase 7 ran already. mint_ot must precede authority transfer (R-B). ` +
          `on-chain authority=${actual}, deployer=${deployer.publicKey.toBase58()}.`,
      );
    }
  }

  try {
    const otClient = new ArlexClient(loadIdlForClient('ownership-token'), otProgramId, conn);
    const tx = otClient.buildTransaction('mint_ot', {
      accounts: {
        authority: deployer.publicKey,
        ot_governance: otGovernancePda,
        ot_config: otConfigPda,
        ot_mint: arlMint,
        recipient_token_account: recipientAta,
        recipient: deployer.publicKey,
        payer: deployer.publicKey,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SYSTEM_PROGRAM_ID,
        ata_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      },
      args: { amount: Number(ARL_INITIAL_SUPPLY) },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    arlOt.initial_supply_minted = ARL_INITIAL_SUPPLY.toString();
    log(
      'phase-k',
      `OT::mint_ot OK (recipient=${recipientAta.toBase58()}, amount=${ARL_INITIAL_SUPPLY.toString()})`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-k', `mint_ot failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'OT::mint_ot', error: head });
    art.init_failed = failed;
  }
}

// ===========================================================================
// Layer 10 substep 2 — ARL/RWT governance pool (Phase 4 plan §85)
// ===========================================================================
//
// Plan §Phase 4 step 2 calls for an ARL_OT/RWT StandardCurve pool. This is the
// "OT pair with treasury fee" slot — when users swap ARL for RWT (or vice
// versa), the OT treasury collects a portion of the fee via the
// `has_ot_treasury` PoolState branch (handled inside swap.rs).
//
// Pool PDA seed: ["pool", min(arl, rwt), max(arl, rwt)]. The pool requires RWT
// as one mint (DEX validation::token_a_is_rwt enforces). Seed: 1_000 RWT +
// 1_000 ARL OT = balanced 50/50 (per plan §88).

async function phaseArlRwtPool(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-l', 'creating ARL_OT/RWT StandardCurve pool + seeding liquidity');

  if (!art.ots || art.ots.length === 0) {
    warn('phase-l', 'no OTs in artifact; skipping ARL/RWT pool');
    return;
  }
  const arlOt = art.ots[ARL_OT_INDEX];
  if (!arlOt) {
    warn('phase-l', `ots[${ARL_OT_INDEX}] missing; skipping ARL/RWT pool`);
    return;
  }
  if (!art.mints?.rwt_mint) {
    warn('phase-l', 'rwt_mint missing; skipping ARL/RWT pool');
    return;
  }
  if (!arlOt.initial_supply_minted) {
    warn('phase-l', 'ARL initial supply not yet minted; skipping ARL/RWT pool seed');
    return;
  }

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  const skipped = art.init_skipped ?? [];

  const arlMint = new PublicKey(arlOt.ot_mint);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const otTreasuryPda = new PublicKey(arlOt.ot_treasury_pda);

  // Canonical pool order: a < b
  const [tokenA, tokenB] = arlMint.toBuffer().compare(rwtMint.toBuffer()) < 0
    ? [arlMint, rwtMint]
    : [rwtMint, arlMint];

  const [poolPda] = findPda(
    [Buffer.from('pool'), tokenA.toBuffer(), tokenB.toBuffer()],
    dexProgramId,
  );
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  // OT pair pools require remaining_accounts[0..2] = (ot_treasury_pda,
  // treasury_rwt_ata) for fee routing. The treasury RWT ATA is owned by the
  // ot_treasury PDA.
  const treasuryRwtAta = await ensureAta(conn, deployer, rwtMint, otTreasuryPda);

  await ensureDeployerPoolCreator(conn, deployer, art);

  const existing = await conn.getAccountInfo(poolPda);
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  if (existing) {
    log('phase-l', 'ARL/RWT pool already exists, reading vaults from state');
    vaultA = new PublicKey(existing.data.subarray(73, 105));
    vaultB = new PublicKey(existing.data.subarray(105, 137));
  } else {
    if (!ixExists(dexIdl, 'create_pool')) {
      warn('phase-l', 'DEX IDL missing create_pool; skipping ARL/RWT pool');
      skipped.push('DEX::create_pool ARL/RWT');
      art.init_skipped = skipped;
      return;
    }
    const vaultAKp = Keypair.generate();
    const vaultBKp = Keypair.generate();

    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    try {
      const tx = dexClient.buildTransaction('create_pool', {
        accounts: {
          creator: deployer.publicKey,
          dex_config: dexConfigPda,
          pool_creators: poolCreatorsPda,
          pool_state: poolPda,
          token_a_mint: tokenA,
          token_b_mint: tokenB,
          vault_a: vaultAKp.publicKey,
          vault_b: vaultBKp.publicKey,
          token_program: TOKEN_PROGRAM_ID,
          system_program: SYSTEM_PROGRAM_ID,
        },
        args: {},
        // OT-pair fee accounts — DEX detects via remaining_accounts[0..2].
        remainingAccounts: [
          { pubkey: otTreasuryPda, isSigner: false, isWritable: false },
          { pubkey: treasuryRwtAta, isSigner: false, isWritable: false },
        ],
        computeUnits: 300_000,
      });
      await sendAndConfirm(conn, tx, [deployer, vaultAKp, vaultBKp]);
      vaultA = vaultAKp.publicKey;
      vaultB = vaultBKp.publicKey;
      log('phase-l', `ARL/RWT pool created (pool=${poolPda.toBase58()}, has_ot_treasury=true)`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      warn('phase-l', `create_pool ARL/RWT failed: ${msg}`);
      const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
      const failed = art.init_failed ?? [];
      failed.push({ phase: 'DEX::create_pool ARL/RWT', error: head });
      art.init_failed = failed;
      return;
    }
  }

  art.pdas = {
    ...art.pdas!,
    arl_rwt_pool: poolPda.toBase58(),
    arl_rwt_pool_vault_a: vaultA.toBase58(),
    arl_rwt_pool_vault_b: vaultB.toBase58(),
  };

  // Seed liquidity if not already seeded.
  const existingLiquidity = await getTokenBalance(conn, vaultA);
  if (existingLiquidity > 0n) {
    log('phase-l', `ARL/RWT pool already seeded (vaultA=${existingLiquidity.toString()})`);
    return;
  }

  if (!ixExists(dexIdl, 'add_liquidity')) {
    warn('phase-l', 'DEX IDL missing add_liquidity; skipping ARL/RWT pool seed');
    skipped.push('DEX::add_liquidity ARL/RWT');
    art.init_skipped = skipped;
    return;
  }

  // Provider has 1_000_000 ARL minted in phaseArlMint. RWT comes from
  // admin_mint_rwt (idempotent: only top-up the delta).
  const deployerArlAta = await ensureAta(conn, deployer, arlMint, deployer.publicKey);
  const deployerRwtAta = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);

  const arlBal = await getTokenBalance(conn, deployerArlAta);
  if (arlBal < ARL_RWT_POOL_SEED_ARL) {
    warn(
      'phase-l',
      `deployer ARL balance ${arlBal.toString()} < seed ${ARL_RWT_POOL_SEED_ARL.toString()}; skipping pool seed`,
    );
    skipped.push('DEX::add_liquidity ARL/RWT (insufficient ARL)');
    art.init_skipped = skipped;
    return;
  }

  const rwtBal = await getTokenBalance(conn, deployerRwtAta);
  if (rwtBal < ARL_RWT_POOL_SEED_RWT) {
    const rwtIdl = loadIdl('rwt-engine');
    if (ixExists(rwtIdl, 'admin_mint_rwt')) {
      try {
        const rwtClient = new ArlexClient(
          loadIdlForClient('rwt-engine'),
          new PublicKey(art.programs.rwt_engine),
          conn,
        );
        const need = ARL_RWT_POOL_SEED_RWT - rwtBal;
        const adminTx = rwtClient.buildTransaction('admin_mint_rwt', {
          accounts: {
            authority: deployer.publicKey,
            rwt_vault: new PublicKey(art.pdas!.rwt_vault),
            rwt_mint: rwtMint,
            recipient_rwt: deployerRwtAta,
            token_program: TOKEN_PROGRAM_ID,
          },
          args: {
            rwt_amount: Number(need),
            backing_capital_usd: Number(need),
          },
        });
        await sendAndConfirm(conn, adminTx, [deployer]);
        log('phase-l', `admin_mint_rwt: minted ${need.toString()} RWT for ARL/RWT pool seed`);
      } catch (e: unknown) {
        warn(
          'phase-l',
          `admin_mint_rwt for ARL/RWT seed failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        skipped.push('DEX::add_liquidity ARL/RWT (admin_mint_rwt failed)');
        art.init_skipped = skipped;
        return;
      }
    } else {
      warn('phase-l', 'RWT IDL missing admin_mint_rwt; skipping ARL/RWT pool seed');
      skipped.push('DEX::add_liquidity ARL/RWT (no admin_mint_rwt)');
      art.init_skipped = skipped;
      return;
    }
  }

  // Map ATAs and amounts to canonical token order.
  const providerTokenA = tokenA.equals(arlMint) ? deployerArlAta : deployerRwtAta;
  const providerTokenB = tokenB.equals(arlMint) ? deployerArlAta : deployerRwtAta;
  const amountA = tokenA.equals(arlMint) ? ARL_RWT_POOL_SEED_ARL : ARL_RWT_POOL_SEED_RWT;
  const amountB = tokenB.equals(arlMint) ? ARL_RWT_POOL_SEED_ARL : ARL_RWT_POOL_SEED_RWT;

  const [lpPda] = findPda(
    [Buffer.from('lp'), poolPda.toBuffer(), deployer.publicKey.toBuffer()],
    dexProgramId,
  );

  // SEC-26 — sandwich protection. The early-return above (existingLiquidity
  // check) means vaultA must be empty at this point. Re-assert defensively in
  // case a future refactor drops that guard, and let operator opt-in via the
  // ALLOW_NONEMPTY_POOL_RESEED env when re-seeding is the explicit intent.
  const arlVaultABalance = await getTokenBalance(conn, vaultA);
  if (arlVaultABalance > 0n) {
    if (process.env.ALLOW_NONEMPTY_POOL_RESEED !== '1') {
      throw new Error(
        `phase-l FATAL: ARL/RWT pool vault_a is non-empty ` +
          `(balance=${arlVaultABalance.toString()} base units). Re-seeding with ` +
          `min_shares=0 is sandwichable. Set ALLOW_NONEMPTY_POOL_RESEED=1 to ` +
          `bypass with explicit operator consent (SEC-26).`,
      );
    }
    warn(
      'phase-l',
      `ALLOW_NONEMPTY_POOL_RESEED=1 — re-seeding non-empty ARL/RWT pool with min_shares=0 (SEC-26 bypass)`,
    );
  }

  const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
  const seedTx = dexClient.buildTransaction('add_liquidity', {
    accounts: {
      provider: deployer.publicKey,
      payer: deployer.publicKey,
      dex_config: dexConfigPda,
      pool_state: poolPda,
      lp_position: lpPda,
      provider_token_a: providerTokenA,
      provider_token_b: providerTokenB,
      vault_a: vaultA,
      vault_b: vaultB,
      token_program: TOKEN_PROGRAM_ID,
      system_program: SYSTEM_PROGRAM_ID,
    },
    // SEC-26 — first-add deterministic share calc means min_shares: 0 is safe
    // only when the early-return + re-assert above proved vaultA == 0.
    args: { amount_a: Number(amountA), amount_b: Number(amountB), min_shares: 0 },
  });
  // T-10 — match rest-of-file pattern: record send failures as init_failed and
  // continue.
  try {
    await sendAndConfirm(conn, seedTx, [deployer]);
    log(
      'phase-l',
      `ARL/RWT pool seeded (${amountA.toString()}/${amountB.toString()} base units, balanced)`,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-l', `ARL/RWT pool add_liquidity failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::add_liquidity ARL/RWT', error: head });
    art.init_failed = failed;
  }
}

// ===========================================================================
// Layer 10 substep 2 — Phase 6 bot wallet registration (plan §98-105)
// ===========================================================================
//
// Plan §Phase 6 specifies:
//   1. RWT::update_vault_manager(manager=ai_agent_wallet)         ← rwt-manager bot
//   2. DEX::update_dex_config(rebalancer=rebalancer_wallet)       ← pool-rebalancer bot
//   3. YD::publish_authority already set at Phase 2               (verified — no-op)
//   4. nexus.manager already set at Phase 5                       (verified — no-op)
//
// Each registration is idempotent: read current state, skip if already-set to
// the expected pubkey. R-J closure verifies pool-rebalancer + rwt-manager
// keypairs exist (added in stage_bots of e2e-bootstrap.sh).

async function phaseRegisterBots(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-m', 'registering bot wallets in contracts (Phase 6)');

  const skipped = art.init_skipped ?? [];
  const bots = art.bots ?? {};

  // ---- Sub-phase 1: RWT::update_vault_manager(rwt-manager.pubkey) ----
  await registerRwtManager(conn, deployer, art, bots, skipped);

  // ---- Sub-phase 2: DEX::update_dex_config(rebalancer=pool-rebalancer.pubkey) ----
  await registerDexRebalancer(conn, deployer, art, bots, skipped);

  // ---- Sub-phase 3: verify YD publish_authority (no-op confirmation) ----
  await verifyYdPublishAuthority(conn, art);

  // ---- Sub-phase 4: verify nexus.manager (no-op confirmation) ----
  await verifyNexusManager(conn, art);

  art.init_skipped = skipped;
}

async function registerRwtManager(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  bots: NonNullable<Artifact['bots']>,
  skipped: string[],
): Promise<void> {
  const rwtBot = bots['rwt-manager'];
  if (!rwtBot) {
    warn('phase-m', 'rwt-manager bot keypair not generated yet; skipping update_vault_manager');
    skipped.push('RWT::update_vault_manager (no rwt-manager keypair)');
    return;
  }
  const rwtIdl = loadIdl('rwt-engine');
  if (!ixExists(rwtIdl, 'update_vault_manager')) {
    warn('phase-m', 'RWT IDL missing update_vault_manager; skipping');
    skipped.push('RWT::update_vault_manager');
    return;
  }
  const rwtProgramId = new PublicKey(art.programs.rwt_engine);
  const rwtVaultPda = new PublicKey(art.pdas!.rwt_vault);
  const targetPubkey = new PublicKey(rwtBot.pubkey);

  // SEC-20 — verified RwtVault layout (rwt-engine/src/state.rs):
  //   0   discriminator              [u8; 8]
  //   8   total_invested_capital     u128         (16 bytes — first u128 in project)
  //   24  total_rwt_supply           u64
  //   32  nav_book_value             u64
  //   40  capital_accumulator_ata    [u8; 32]
  //   72  rwt_mint                   [u8; 32]
  //   104 authority                  [u8; 32]
  //   136 pending_authority          [u8; 32]
  //   168 has_pending                bool         (1 byte)
  //   169 manager                    [u8; 32]     ← read target
  //   201 pause_authority            [u8; 32]
  //   233 mint_paused                bool
  //   234 areal_fee_destination      [u8; 32]
  //   266 bump                       u8
  // Total = 267 bytes (8 disc + 259 data). Pre-Layer-10 offset was 161 — that
  // missed the extra 8 bytes of total_invested_capital (u128 not u64).
  const MANAGER_OFFSET = 169;
  const RWT_VAULT_MIN_SIZE = MANAGER_OFFSET + 32;

  const vaultInfo = await conn.getAccountInfo(rwtVaultPda);
  if (vaultInfo) {
    if (vaultInfo.data.length >= RWT_VAULT_MIN_SIZE) {
      const current = vaultInfo.data.subarray(MANAGER_OFFSET, MANAGER_OFFSET + 32);
      if (Buffer.from(current).equals(targetPubkey.toBuffer())) {
        log('phase-m', `RWT vault.manager already = rwt-manager (${targetPubkey.toBase58()}); skipping`);
        return;
      }
    }
  }

  try {
    const rwtClient = new ArlexClient(loadIdlForClient('rwt-engine'), rwtProgramId, conn);
    const tx = rwtClient.buildTransaction('update_vault_manager', {
      accounts: {
        authority: deployer.publicKey,
        rwt_vault: rwtVaultPda,
      },
      args: {
        new_manager: Array.from(targetPubkey.toBytes()),
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-m', `RWT::update_vault_manager OK (manager=${targetPubkey.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-m', `update_vault_manager failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'RWT::update_vault_manager', error: head });
    art.init_failed = failed;
  }
}

async function registerDexRebalancer(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
  bots: NonNullable<Artifact['bots']>,
  skipped: string[],
): Promise<void> {
  const rebBot = bots['pool-rebalancer'];
  if (!rebBot) {
    warn('phase-m', 'pool-rebalancer bot keypair not generated yet; skipping update_dex_config');
    skipped.push('DEX::update_dex_config (no pool-rebalancer keypair)');
    return;
  }
  const dexIdl = loadIdl('native-dex');
  if (!ixExists(dexIdl, 'update_dex_config')) {
    warn('phase-m', 'DEX IDL missing update_dex_config; skipping');
    skipped.push('DEX::update_dex_config');
    return;
  }
  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const targetPubkey = new PublicKey(rebBot.pubkey);

  // SEC-19 — verified DexConfig layout (native-dex/src/state.rs):
  //   0   discriminator           [u8; 8]
  //   8   authority               [u8; 32]
  //   40  pending_authority       [u8; 32]
  //   72  has_pending             bool          (1 byte)
  //   73  pause_authority         [u8; 32]
  //   105 base_fee_bps            u16 LE
  //   107 lp_fee_share_bps        u16 LE
  //   109 areal_fee_destination   [u8; 32]
  //   141 rebalancer              [u8; 32]      ← read/write target
  //   173 is_active               bool          (1 byte)
  //   174 bump                    u8
  // Total = 175 bytes (8 disc + 167 data). Pre-Layer-10 offsets were stale.
  const BASE_FEE_BPS_OFFSET = 105;
  const LP_FEE_SHARE_BPS_OFFSET = 107;
  const REBALANCER_OFFSET = 141;
  const IS_ACTIVE_OFFSET = 173;
  const DEX_CONFIG_MIN_SIZE = REBALANCER_OFFSET + 32;

  const configInfo = await conn.getAccountInfo(dexConfigPda);
  if (configInfo) {
    if (configInfo.data.length >= DEX_CONFIG_MIN_SIZE) {
      const current = configInfo.data.subarray(REBALANCER_OFFSET, REBALANCER_OFFSET + 32);
      if (Buffer.from(current).equals(targetPubkey.toBuffer())) {
        log('phase-m', `DEX rebalancer already = pool-rebalancer (${targetPubkey.toBase58()}); skipping`);
        return;
      }
    }
  }

  // Read existing fee bps + is_active so the update preserves them (only the
  // rebalancer changes). Fall back to canonical defaults (30 / 5000 / true)
  // if the read fails or the account is unexpectedly small.
  let baseFeeBps = 30;
  let lpFeeShareBps = 5000;
  let isActive = true;
  if (configInfo && configInfo.data.length >= IS_ACTIVE_OFFSET + 1) {
    baseFeeBps = configInfo.data.readUInt16LE(BASE_FEE_BPS_OFFSET);
    lpFeeShareBps = configInfo.data.readUInt16LE(LP_FEE_SHARE_BPS_OFFSET);
    isActive = configInfo.data.readUInt8(IS_ACTIVE_OFFSET) === 1;
  }

  try {
    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
    const tx = dexClient.buildTransaction('update_dex_config', {
      accounts: {
        authority: deployer.publicKey,
        dex_config: dexConfigPda,
      },
      args: {
        base_fee_bps: baseFeeBps,
        lp_fee_share_bps: lpFeeShareBps,
        rebalancer: Array.from(targetPubkey.toBytes()),
        is_active: isActive,
      },
    });
    await sendAndConfirm(conn, tx, [deployer]);
    log('phase-m', `DEX::update_dex_config OK (rebalancer=${targetPubkey.toBase58()})`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    warn('phase-m', `update_dex_config failed: ${msg}`);
    const head = (msg.split('\n')[0] ?? msg).slice(0, 120);
    const failed = art.init_failed ?? [];
    failed.push({ phase: 'DEX::update_dex_config', error: head });
    art.init_failed = failed;
  }
}

async function verifyYdPublishAuthority(conn: Connection, art: Artifact): Promise<void> {
  if (!art.pdas?.yd_dist_config) return;
  const info = await conn.getAccountInfo(new PublicKey(art.pdas.yd_dist_config));
  if (!info) {
    warn('phase-m', 'YD dist_config not found; cannot verify publish_authority');
    return;
  }
  // SEC-22 — verified DistributionConfig layout (yield-distribution/src/state.rs):
  //   0   discriminator        [u8; 8]
  //   8   authority            [u8; 32]
  //   40  pending_authority    [u8; 32]
  //   72  has_pending          bool       (1 byte) ← previously missed
  //   73  publish_authority    [u8; 32]   ← read target
  //   ...
  const PA_OFFSET = 73;
  if (info.data.length < PA_OFFSET + 32) {
    warn('phase-m', 'YD dist_config too small; cannot verify publish_authority');
    return;
  }
  const current = info.data.subarray(PA_OFFSET, PA_OFFSET + 32);
  const pubkey = new PublicKey(current);
  log('phase-m', `YD publish_authority = ${pubkey.toBase58()} (set at Phase 2; rotate via update_publish_authority)`);
}

async function verifyNexusManager(conn: Connection, art: Artifact): Promise<void> {
  if (!art.pdas?.liquidity_nexus) return;
  const info = await conn.getAccountInfo(new PublicKey(art.pdas.liquidity_nexus));
  if (!info) {
    warn('phase-m', 'LiquidityNexus not found; cannot verify manager');
    return;
  }
  // LiquidityNexus layout (Layer 9): 8 disc + 32 manager + ...
  if (info.data.length < 8 + 32) {
    warn('phase-m', 'LiquidityNexus too small; cannot verify manager');
    return;
  }
  const current = info.data.subarray(8, 8 + 32);
  const pubkey = new PublicKey(current);
  log('phase-m', `Nexus manager = ${pubkey.toBase58()} (set at Phase 5; rotate via update_nexus_manager)`);
}

// --------------------------------------------------------------------------
// Argv parsing
// --------------------------------------------------------------------------

interface Argv {
  artifact: string;
  otCount: number;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let artifact = DEFAULT_ARTIFACT_PATH;
  let otCount = DEFAULT_OT_COUNT;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--ot-count' && next !== undefined) {
      otCount = parseInt(next, 10);
      i++;
    }
  }
  if (!Number.isFinite(otCount) || otCount < 0) otCount = DEFAULT_OT_COUNT;
  return { artifact, otCount };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = parseArgv();
  log('main', `loading artifact ${argv.artifact}`);
  const art = loadArtifact(argv.artifact);

  if (art.bootstrap_target !== 'localhost') {
    throw new Error(
      `bootstrap-init.ts only supports localhost, got ${art.bootstrap_target}`,
    );
  }

  const conn = new Connection(art.rpc_url, 'confirmed');
  const deployer = loadKeypair(art.deployer_keypair_path);
  log('main', `deployer=${deployer.publicKey.toBase58()}, rpc=${art.rpc_url}`);

  const t0 = Date.now();

  await phaseMints(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseSingletons(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseRwtVault(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseLiquidityHolding(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseNexus(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseMasterPool(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseOts(conn, deployer, art, argv.otCount);
  saveArtifact(argv.artifact, art);

  await phaseUsdcSupply(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  // ---------------------------------------------------------------------
  // Layer 10 substep 2 — Phase 3 ARL OT bootstrap (plan §63-77).
  // Runs AFTER phaseOts so the ARL OT config / governance / distributor
  // accounts exist, and BEFORE any authority-transfer phase (R-B
  // mitigation: mint_ot must happen while deployer is still OT authority).
  // ---------------------------------------------------------------------
  await phaseFutarchy(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseArlDistributor(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseDestinations(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  await phaseArlMint(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  // ---------------------------------------------------------------------
  // Layer 10 substep 2 — Phase 4 step 2 (ARL/RWT StandardCurve pool).
  // Master RWT/USDC concentrated pool was created in phaseMasterPool above
  // (Phase 4 step 3 + 4); the ARL/RWT pair pool is the second pool of
  // Phase 4. Seeding requires ARL initial supply minted in phaseArlMint.
  // ---------------------------------------------------------------------
  await phaseArlRwtPool(conn, deployer, art);
  saveArtifact(argv.artifact, art);

  // ---------------------------------------------------------------------
  // Layer 10 substep 2 — Phase 6 bot wallet registration (plan §98-105).
  // Consumes pool-rebalancer + rwt-manager keypairs generated by stage_bots
  // in e2e-bootstrap.sh (R-J / D39).
  // ---------------------------------------------------------------------
  await phaseRegisterBots(conn, deployer, art);

  // ============================================================================
  // SUBSTEP 3 HARD-GATE — R-B mitigation
  // DO NOT INSERT ANY AUTHORITY-TRANSFER PHASE BEFORE THIS LINE.
  // phaseArlMint MUST run before any deployer→Futarchy / deployer→Multisig
  // authority handover, otherwise mint_ot fails with `has_one = authority`
  // and ARL initial supply is permanently unmintable.
  // ============================================================================

  art.init_completed_at = new Date().toISOString();
  saveArtifact(argv.artifact, art);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log('main', `init complete in ${elapsed}s`);
  if (art.init_skipped && art.init_skipped.length > 0) {
    log('main', `skipped phases (${art.init_skipped.length}):`);
    for (const s of art.init_skipped) {
      log('main', `  - ${s}`);
    }
  }
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  console.error(`[bootstrap-init] FATAL: ${msg}`);
  process.exit(1);
});
