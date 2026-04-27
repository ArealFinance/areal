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

  // Mint keypair bytes — strip from public, mirror to secrets.
  if (art.mints) {
    const mintsCopy = { ...art.mints };
    secrets.mints = {};
    for (const k of SECRET_MINT_KEYS) {
      const v = (mintsCopy as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.length > 0) {
        secrets.mints[k] = v;
        delete (mintsCopy as Record<string, unknown>)[k];
      }
    }
    art.mints = mintsCopy as Artifact['mints'];
  }

  // OT mint keypair bytes — strip from each public OT record, mirror to secrets.
  if (Array.isArray(art.ots)) {
    secrets.ots = {};
    art.ots = art.ots.map((rec) => {
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

  writeFileSync(path, JSON.stringify(art, null, 2) + '\n', 'utf8');
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

async function phaseMasterPool(
  conn: Connection,
  deployer: Keypair,
  art: Artifact,
): Promise<void> {
  log('phase-f', 'creating master RWT/USDC pool + seeding liquidity');

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const dexIdl = loadIdl('native-dex');
  const skipped = art.init_skipped ?? [];

  if (!art.mints?.rwt_mint || !art.mints?.usdc_test_mint) {
    warn('phase-f', 'rwt_mint or usdc_test_mint missing; skipping master pool');
    skipped.push('DEX::create_pool master (mints missing)');
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
  const dexConfigPda = new PublicKey(art.pdas!.dex_config);
  const poolCreatorsPda = new PublicKey(art.pdas!.pool_creators);

  const existing = await conn.getAccountInfo(poolPda);
  let vaultA: PublicKey;
  let vaultB: PublicKey;

  if (existing) {
    log('phase-f', 'master pool already exists, reading vaults from state');
    // Layout per dashboard: vaultA @73..105, vaultB @105..137.
    vaultA = new PublicKey(existing.data.subarray(73, 105));
    vaultB = new PublicKey(existing.data.subarray(105, 137));
  } else {
    if (!ixExists(dexIdl, 'create_pool')) {
      warn('phase-f', 'DEX IDL missing create_pool; skipping');
      skipped.push('DEX::create_pool master');
      art.init_skipped = skipped;
      return;
    }
    const vaultAKp = Keypair.generate();
    const vaultBKp = Keypair.generate();

    const dexClient = new ArlexClient(loadIdlForClient('native-dex'), dexProgramId, conn);
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
    });
    await sendAndConfirm(conn, tx, [deployer, vaultAKp, vaultBKp]);
    vaultA = vaultAKp.publicKey;
    vaultB = vaultBKp.publicKey;
    log('phase-f', `master pool created (pool=${poolPda.toBase58()})`);
  }

  art.pdas = {
    ...art.pdas!,
    master_pool: poolPda.toBase58(),
    master_pool_vault_a: vaultA.toBase58(),
    master_pool_vault_b: vaultB.toBase58(),
  };

  // Seed liquidity if the pool isn't already seeded.
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
  // OR we mint USDC liberally and let the master pool start lopsided.
  // For Substep 12 minimal seed, we mint test USDC and rely on admin_mint_rwt
  // (vault.initial_authority == deployer, set during initialize_vault).
  const deployerUsdcAta = await ensureAta(conn, deployer, usdcMint, deployer.publicKey);
  const deployerRwtAta = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);

  // Mint 1000 USDC to deployer.
  await mintTo(conn, deployer, usdcMint, deployerUsdcAta, 1_000_000_000n);
  log('phase-f', 'minted 1000 USDC to deployer ATA');

  // Try admin_mint_rwt to obtain RWT for liquidity. Best-effort: if the IDL or
  // contract path doesn't allow it, skip seeding (pool exists but empty).
  const rwtIdl = loadIdl('rwt-engine');
  const rwtVaultPda = new PublicKey(art.pdas!.rwt_vault);
  const rwtMintPk = rwtMint;
  if (ixExists(rwtIdl, 'admin_mint_rwt')) {
    try {
      const rwtClient = new ArlexClient(
        loadIdlForClient('rwt-engine'),
        new PublicKey(art.programs.rwt_engine),
        conn,
      );
      const adminTx = rwtClient.buildTransaction('admin_mint_rwt', {
        accounts: {
          authority: deployer.publicKey,
          rwt_vault: rwtVaultPda,
          rwt_mint: rwtMintPk,
          recipient_rwt: deployerRwtAta,
          token_program: TOKEN_PROGRAM_ID,
        },
        args: { rwt_amount: 500_000_000, backing_capital_usd: 500_000_000 },
      });
      await sendAndConfirm(conn, adminTx, [deployer]);
      log('phase-f', 'admin_mint_rwt: minted 500 RWT to deployer ATA');
    } catch (e: unknown) {
      warn('phase-f', `admin_mint_rwt failed: ${e instanceof Error ? e.message : String(e)}`);
      skipped.push('DEX master pool seed (admin_mint_rwt failed)');
      art.init_skipped = skipped;
      return;
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

  const [lpPda] = findPda(
    [Buffer.from('lp'), poolPda.toBuffer(), deployer.publicKey.toBuffer()],
    dexProgramId,
  );

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
    args: { amount_a: 100_000_000, amount_b: 100_000_000, min_shares: 0 },
  });
  await sendAndConfirm(conn, seedTx, [deployer]);
  log('phase-f', 'master pool seeded (100M base units each side)');
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
            args: { vesting_period_secs: 86_400 },
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
