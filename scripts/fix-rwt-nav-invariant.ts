#!/usr/bin/env tsx
/**
 * fix-rwt-nav-invariant.ts — one-off live-state correction for the RWT
 * NAV invariant. Restores NAV ≈ $1.0 on an already-deployed RWT vault
 * whose `total_rwt_supply` exceeds `total_invested_capital` (the bug
 * introduced by an earlier bootstrap that called `admin_mint_rwt`
 * without a matching `backing_capital_usd`).
 *
 * Mechanism
 * ---------
 * The on-chain `rwt-engine` exposes two state-mutating ix that touch
 * `total_invested_capital`:
 *
 *   - `admin_mint_rwt(rwt_amount, backing_capital_usd)`
 *       Adds `rwt_amount` to `total_rwt_supply` AND adds
 *       `backing_capital_usd` to `total_invested_capital`. Authority-gated.
 *
 *   - `adjust_capital(writedown_amount)`
 *       SUBTRACTS `writedown_amount` from `total_invested_capital`.
 *       This is a writedown-only ix — there is NO direction field and
 *       NO instruction in the IDL that adds capital independently of
 *       supply. Using it here would push NAV *further* from $1.0.
 *
 * So the only viable on-chain path to lift capital up to match supply
 * (without a contract redeploy) is `admin_mint_rwt` with a tiny
 * `rwt_amount` and a large `backing_capital_usd`:
 *
 *   want: new_capital == new_supply  (NAV = capital * NAV_SCALE / supply = $1.0)
 *   with: new_supply  = supply  + rwt_amount
 *         new_capital = capital + backing_capital_usd
 *   solve: backing_capital_usd = supply - capital + rwt_amount  = delta + rwt_amount
 *
 * Both args must be > 0 (contract guard). We pick `rwt_amount = 1` raw
 * (0.000001 RWT) to keep the residual supply bump negligible.
 *
 * Future deploys self-correct via the fixed `scripts/lib/bootstrap-init.ts`,
 * which now pairs every `admin_mint_rwt(rwt_amount=N)` with
 * `backing_capital_usd=N` and asserts the NAV invariant after init.
 *
 * Usage
 * -----
 *   tsx scripts/fix-rwt-nav-invariant.ts [--artifact PATH] [--dry-run]
 *
 * Pre-flight
 * ----------
 *   - The RPC URL in the artifact must be reachable from this host. For
 *     the VPS validator behind SSH, open the tunnel first:
 *       ssh -L 8899:127.0.0.1:8899 deploy@vps.areal.finance
 *     and set `rpc_url` to `http://127.0.0.1:8899` in the artifact (or
 *     run the script on the VPS directly).
 *   - The deployer keypair at `art.deployer_keypair_path` must still be
 *     the vault `authority` (this script does not handle a rotated key).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import { ArlexClient } from '@arlex/client';

// --------------------------------------------------------------------------
// Constants & paths
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

const DEFAULT_ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.json');

// 6-decimal NAV scale (matches contracts/rwt-engine/src/constants.rs::NAV_SCALE).
const NAV_SCALE = 1_000_000n;
// $1.00 in raw NAV (NAV_SCALE × $1.0).
const INITIAL_NAV = NAV_SCALE;
// Tolerance for the post-fix check. The fix targets exact NAV=$1.0 but
// integer division can drop sub-raw-unit dust; ±10 bps is a comfortable
// margin that still catches every observed bug case.
const POST_FIX_TOLERANCE_BPS = 10n;

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string): void {
  // Match bootstrap-init's plain stderr log format so output lines up in
  // mixed-tool deploy logs.
  // eslint-disable-next-line no-console
  console.log(`[${new Date().toISOString()}] [${stage}] ${msg}`);
}

function warn(stage: string, msg: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[${new Date().toISOString()}] [${stage}] WARN ${msg}`);
}

// --------------------------------------------------------------------------
// Artifact loading (minimal — only the fields this script touches)
// --------------------------------------------------------------------------

interface MinimalArtifact {
  rpc_url: string;
  deployer_keypair_path: string;
  programs: {
    rwt_engine: string;
  };
  pdas?: {
    rwt_vault?: string;
    rwt_mint?: string;
  };
  rwt_mint?: string;
}

function loadArtifact(path: string): MinimalArtifact {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as MinimalArtifact;
  if (!raw.rpc_url) throw new Error(`artifact missing rpc_url: ${path}`);
  if (!raw.deployer_keypair_path) {
    throw new Error(`artifact missing deployer_keypair_path: ${path}`);
  }
  if (!raw.programs?.rwt_engine) {
    throw new Error(`artifact missing programs.rwt_engine: ${path}`);
  }
  if (!raw.pdas?.rwt_vault) {
    throw new Error(`artifact missing pdas.rwt_vault: ${path}`);
  }
  return raw;
}

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

// --------------------------------------------------------------------------
// IDL loader (mirrors bootstrap-init.ts::loadIdlForClient)
// --------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadIdlForClient(name: string): any {
  const path = join(REPO_ROOT, 'sdk', 'idl', `${name}.json`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const idl = JSON.parse(readFileSync(path, 'utf8')) as any;
  // ArlexClient is strict about a few cosmetic IDL fields; bootstrap-init.ts
  // has a `normalizeIdlForArlexClient` helper. We don't need it here because
  // we only build one ix (`admin_mint_rwt`) whose shape is stable across all
  // post-Layer-7 IDL revisions, but if the client complains in the future,
  // re-import the normalizer from `scripts/lib/bootstrap-init.ts`.
  return idl;
}

// --------------------------------------------------------------------------
// RwtVault on-chain reader
// --------------------------------------------------------------------------

/**
 * Decodes the three NAV-relevant fields of the singleton `RwtVault` account.
 *
 * Account layout (contracts/rwt-engine/src/state.rs, repr(C, packed) with
 * an 8-byte Arlex discriminator prefix):
 *   bytes  0..8   discriminator
 *   bytes  8..24  total_invested_capital (u128, little-endian)
 *   bytes 24..32  total_rwt_supply       (u64,  little-endian)
 *   bytes 32..40  nav_book_value         (u64,  little-endian)
 *   bytes 40..    ATAs / authorities / flags (not needed here)
 */
interface RwtVaultSnapshot {
  totalInvestedCapital: bigint;
  totalRwtSupply: bigint;
  navBookValue: bigint;
}

async function readRwtVaultSnapshot(
  conn: Connection,
  vaultPda: PublicKey,
): Promise<RwtVaultSnapshot> {
  const info = await conn.getAccountInfo(vaultPda, 'confirmed');
  if (!info) {
    throw new Error(
      `rwt_vault account not found at ${vaultPda.toBase58()} — wrong RPC or vault not initialized`,
    );
  }
  const buf = Buffer.from(info.data);
  if (buf.length < 40) {
    throw new Error(
      `rwt_vault account too small: ${buf.length} bytes (want >= 40)`,
    );
  }
  const lo = buf.readBigUInt64LE(8);
  const hi = buf.readBigUInt64LE(16);
  const totalInvestedCapital = lo + (hi << 64n);
  const totalRwtSupply = buf.readBigUInt64LE(24);
  const navBookValue = buf.readBigUInt64LE(32);
  return { totalInvestedCapital, totalRwtSupply, navBookValue };
}

/**
 * Decode the vault's `authority` Pubkey from the account data. Offset
 * comes from the same packed layout:
 *   bytes 40..72   capital_accumulator_ata
 *   bytes 72..104  rwt_mint
 *   bytes 104..136 authority   ← we want this
 */
async function readRwtVaultAuthority(
  conn: Connection,
  vaultPda: PublicKey,
): Promise<PublicKey> {
  const info = await conn.getAccountInfo(vaultPda, 'confirmed');
  if (!info) {
    throw new Error(`rwt_vault account not found at ${vaultPda.toBase58()}`);
  }
  const buf = Buffer.from(info.data);
  if (buf.length < 136) {
    throw new Error(
      `rwt_vault account too small to read authority: ${buf.length} bytes`,
    );
  }
  return new PublicKey(buf.subarray(104, 136));
}

// --------------------------------------------------------------------------
// ATA helpers (no-deps reimplementation, mirrors bootstrap-init.ts)
// --------------------------------------------------------------------------

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

async function ensureAta(
  conn: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = findAta(owner, mint);
  const info = await conn.getAccountInfo(ata, 'confirmed');
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
  const tx = new Transaction().add(ix);
  await sendAndConfirm(conn, tx, [payer]);
  log('ata', `created ATA ${ata.toBase58()} for ${owner.toBase58()}/${mint.toBase58()}`);
  return ata;
}

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

// --------------------------------------------------------------------------
// Argv parsing
// --------------------------------------------------------------------------

interface Argv {
  artifact: string;
  dryRun: boolean;
}

function parseArgv(): Argv {
  const args = process.argv.slice(2);
  let artifact = DEFAULT_ARTIFACT_PATH;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--artifact' && next !== undefined) {
      artifact = next;
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '-h' || a === '--help') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: tsx scripts/fix-rwt-nav-invariant.ts [--artifact PATH] [--dry-run]',
      );
      process.exit(0);
    }
  }
  return { artifact, dryRun };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function formatNav(navRaw: bigint): string {
  return (Number(navRaw) / Number(NAV_SCALE)).toFixed(6);
}

function formatTokenAmount(raw: bigint): string {
  return (Number(raw) / Number(NAV_SCALE)).toFixed(6);
}

async function main(): Promise<void> {
  const argv = parseArgv();
  log('main', `loading artifact ${argv.artifact}${argv.dryRun ? ' (dry-run)' : ''}`);
  const art = loadArtifact(argv.artifact);

  const conn = new Connection(art.rpc_url, 'confirmed');
  const deployer = loadKeypair(art.deployer_keypair_path);
  const vaultPda = new PublicKey(art.pdas!.rwt_vault!);
  const rwtProgramId = new PublicKey(art.programs.rwt_engine);

  log(
    'main',
    `deployer=${deployer.publicKey.toBase58()}, rpc=${art.rpc_url}, vault=${vaultPda.toBase58()}`,
  );

  // ----- Read current state -----
  const before = await readRwtVaultSnapshot(conn, vaultPda);
  const navBefore =
    before.totalRwtSupply === 0n
      ? INITIAL_NAV
      : (before.totalInvestedCapital * NAV_SCALE) / before.totalRwtSupply;
  log(
    'state',
    `BEFORE: supply=${formatTokenAmount(before.totalRwtSupply)} RWT (raw ${before.totalRwtSupply.toString()}), ` +
      `capital=${formatTokenAmount(before.totalInvestedCapital)} USDC (raw ${before.totalInvestedCapital.toString()}), ` +
      `NAV=$${formatNav(navBefore)} (nav_book=${before.navBookValue.toString()})`,
  );

  // ----- Short-circuit: nothing to fix -----
  if (before.totalRwtSupply === 0n) {
    log('main', 'supply=0 — NAV is $1.0 by zero-supply short-circuit; nothing to fix');
    return;
  }

  if (before.totalInvestedCapital >= BigInt(before.totalRwtSupply)) {
    log(
      'main',
      `capital >= supply already — NAV >= $1.0; no on-chain instruction can lower supply, refusing to act`,
    );
    return;
  }

  const supplyBig = before.totalRwtSupply;
  const delta = supplyBig - before.totalInvestedCapital; // > 0, fits in u64 if supply fits
  if (delta + 1n > 0xffff_ffff_ffff_ffffn) {
    throw new Error(
      `delta ${delta.toString()} + 1 overflows u64 — would need multi-step fix; aborting`,
    );
  }
  if (supplyBig + 1n > 0xffff_ffff_ffff_ffffn) {
    throw new Error(
      `total_rwt_supply ${supplyBig.toString()} + 1 overflows u64 — refusing to bump`,
    );
  }

  // ----- Validate authority matches the deployer keypair -----
  const onChainAuthority = await readRwtVaultAuthority(conn, vaultPda);
  if (!onChainAuthority.equals(deployer.publicKey)) {
    throw new Error(
      `vault authority=${onChainAuthority.toBase58()} != deployer=${deployer.publicKey.toBase58()} — ` +
        `this script only handles the un-rotated authority case`,
    );
  }

  // ----- Resolve RWT mint -----
  // Prefer pdas.rwt_mint; fall back to top-level rwt_mint for older artifacts.
  const rwtMintStr = art.pdas?.rwt_mint ?? art.rwt_mint;
  if (!rwtMintStr) {
    throw new Error('artifact missing pdas.rwt_mint (and top-level rwt_mint)');
  }
  const rwtMint = new PublicKey(rwtMintStr);

  // ----- Compute the corrective admin_mint_rwt args -----
  // rwt_amount = 1 raw RWT (0.000001 RWT). Negligible supply bump.
  // backing_capital_usd = delta + 1, so post-fix capital == post-fix supply.
  const rwtAmount = 1n;
  const backingCapital = delta + rwtAmount;
  log(
    'plan',
    `delta = supply - capital = ${delta.toString()} raw USDC`,
  );
  log(
    'plan',
    `will call admin_mint_rwt(rwt_amount=${rwtAmount.toString()}, backing_capital_usd=${backingCapital.toString()}) ` +
      `→ new_supply=${(supplyBig + rwtAmount).toString()}, new_capital=${(supplyBig + rwtAmount).toString()}, NAV=$1.000000`,
  );

  if (argv.dryRun) {
    log('main', 'dry-run mode — exiting before sending tx');
    return;
  }

  // ----- Ensure recipient ATA (deployer's RWT ATA) exists -----
  const recipientRwt = await ensureAta(conn, deployer, rwtMint, deployer.publicKey);

  // ----- Build + send admin_mint_rwt -----
  // ArlexClient is intentionally typed `any` here — the IDL shape is loaded
  // at runtime from sdk/idl/rwt-engine.json and the client validates it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rwtClient: any = new ArlexClient(
    loadIdlForClient('rwt-engine'),
    rwtProgramId,
    conn,
  );
  const tx = rwtClient.buildTransaction('admin_mint_rwt', {
    accounts: {
      authority: deployer.publicKey,
      rwt_vault: vaultPda,
      rwt_mint: rwtMint,
      recipient_rwt: recipientRwt,
      token_program: TOKEN_PROGRAM_ID,
    },
    args: {
      // Numeric cast: rwt_amount=1 always fits; backing_capital is u64
      // raw USDC = supply - capital + 1, bounded by current supply
      // (~10^10 in the observed bug, well below Number.MAX_SAFE_INTEGER 2^53).
      rwt_amount: Number(rwtAmount),
      backing_capital_usd: Number(backingCapital),
    },
  });
  const sig = await sendAndConfirm(conn, tx, [deployer]);
  log('tx', `admin_mint_rwt confirmed sig=${sig}`);

  // ----- Verify post-fix state -----
  const after = await readRwtVaultSnapshot(conn, vaultPda);
  const navAfter =
    after.totalRwtSupply === 0n
      ? INITIAL_NAV
      : (after.totalInvestedCapital * NAV_SCALE) / after.totalRwtSupply;
  log(
    'state',
    `AFTER : supply=${formatTokenAmount(after.totalRwtSupply)} RWT (raw ${after.totalRwtSupply.toString()}), ` +
      `capital=${formatTokenAmount(after.totalInvestedCapital)} USDC (raw ${after.totalInvestedCapital.toString()}), ` +
      `NAV=$${formatNav(navAfter)} (nav_book=${after.navBookValue.toString()})`,
  );

  const lower = INITIAL_NAV - (INITIAL_NAV * POST_FIX_TOLERANCE_BPS) / 10_000n;
  const upper = INITIAL_NAV + (INITIAL_NAV * POST_FIX_TOLERANCE_BPS) / 10_000n;
  if (navAfter < lower || navAfter > upper) {
    throw new Error(
      `post-fix NAV $${formatNav(navAfter)} is outside ±${POST_FIX_TOLERANCE_BPS.toString()} bps of $1.00 — manual review required`,
    );
  }
  log('main', `NAV restored to $${formatNav(navAfter)} — invariant satisfied`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.stack ?? e.message : String(e);
  warn('main', `fix failed: ${msg}`);
  process.exit(1);
});
