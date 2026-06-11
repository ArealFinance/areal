#!/usr/bin/env tsx
/*
 * devnet-fund-distributor.ts — Trigger YD::fund_distributor on devnet.
 *
 * Smoke test for the merkle-publisher → frontend proof flow:
 *   1. Reads data/e2e-bootstrap.devnet.json for distributor PDA + reward vault + ATAs
 *   2. Verifies deployer holds enough RWT (no top-up — devnet bootstrap pre-seeded it)
 *   3. Calls fund_distributor(amount) signed by deployer
 *   4. Confirms tx + prints DistributorFunded event hash for merkle-publisher pickup
 *
 * Usage:
 *   tsx scripts/lib/devnet-fund-distributor.ts [--amount 10_000_000]  (default 10 RWT)
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { ArlexClient } from '@arlex/client';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACT_PATH = join(REPO_ROOT, 'data', 'e2e-bootstrap.devnet.json');

// Default amount: 10 RWT (6 decimals = 10_000_000). Well above
// config.min_distribution_amount=1_000_000 (1 RWT).
const DEFAULT_AMOUNT = 10_000_000n;

interface Artifact {
  rpc_url: string;
  deployer_keypair_path: string;
  deployer_pubkey: string;
  programs: { yield_distribution: string };
  mints: { rwt_mint: string; sprk_ot_mint: string };
  pdas: {
    yd_dist_config: string;
    areal_fee_ata_rwt: string;
  };
  ots: Array<{
    ot_mint: string;
    yd_distributor_pda: string;
    reward_vault: string;
  }>;
}

function parseArgs(argv: string[]): { amount: bigint } {
  let amount = DEFAULT_AMOUNT;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--amount' && i + 1 < argv.length) {
      // Allow underscores in CLI for readability ("10_000_000").
      amount = BigInt(argv[++i]!.replace(/_/g, ''));
    }
  }
  return { amount };
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(readFileSync(p, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  const ATA_PROG = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROG,
  )[0];
}

async function getTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata, 'confirmed');
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}

async function sendAndConfirm(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const start = Date.now();
  while (Date.now() - start < 60_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value?.[0];
    if (s?.err) throw new Error(`tx failed: ${JSON.stringify(s.err)} (sig=${sig})`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`confirmation timeout: sig=${sig} lvb=${lastValidBlockHeight}`);
}

// Mirror the IDL flag-normalization pattern from bootstrap-init.ts. The
// arlex-client v0.3.x reads isMut/isSigner directly; some accounts with
// `seeds = [...]` blocks lose their writable bit in the IDL emitter output.
function normalizeIdlForArlexClient(idl: unknown): unknown {
  const out = JSON.parse(JSON.stringify(idl));
  const initWritable: Record<string, ReadonlyArray<string>> = {
    fund_distributor: ['distributor'],
  };
  for (const ix of out.instructions ?? []) {
    const writableSet = new Set(initWritable[ix.name] ?? []);
    for (const acc of ix.accounts ?? []) {
      const writable = acc.writable ?? acc.isMut ?? false;
      const signer = acc.signer ?? acc.isSigner ?? false;
      acc.isMut = writable || writableSet.has(acc.name);
      acc.isSigner = signer;
    }
  }
  return out;
}

function loadIdlForClient(name: string): unknown {
  const path = join(REPO_ROOT, 'sdk', 'idl', `${name}.json`);
  return normalizeIdlForArlexClient(JSON.parse(readFileSync(path, 'utf8')));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const art = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as Artifact;
  const rpcUrl = art.rpc_url;
  const deployer = loadKeypair(join(REPO_ROOT, art.deployer_keypair_path));
  if (deployer.publicKey.toBase58() !== art.deployer_pubkey) {
    throw new Error(
      `keypair pubkey ${deployer.publicKey.toBase58()} mismatches artifact ${art.deployer_pubkey}`,
    );
  }

  const conn = new Connection(rpcUrl, 'confirmed');

  // Resolve the SPRK OT distributor (only one OT in devnet artifact).
  const sprk = art.ots.find((o) => o.ot_mint === art.mints.sprk_ot_mint);
  if (!sprk) throw new Error('SPRK OT not found in artifact');

  const ydProgramId = new PublicKey(art.programs.yield_distribution);
  const ydConfig = new PublicKey(art.pdas.yd_dist_config);
  const otMint = new PublicKey(sprk.ot_mint);
  const distributor = new PublicKey(sprk.yd_distributor_pda);
  const rwtMint = new PublicKey(art.mints.rwt_mint);
  const rewardVault = new PublicKey(sprk.reward_vault);
  const feeAccount = new PublicKey(art.pdas.areal_fee_ata_rwt);
  const depositorRwtAta = findAta(deployer.publicKey, rwtMint);

  // Sanity: depositor ATA should equal the artifact fee ATA on devnet (deployer
  // is the fee destination per phase-c2 rotation). Log if not — the script
  // will still attempt the transfer, but the protocol fee will go to a
  // different account than the depositor (which is exactly the intent if
  // ever they're rotated apart, so this is informational only).
  console.log('=== devnet-fund-distributor ===');
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Deployer: ${deployer.publicKey.toBase58()}`);
  console.log(`Amount: ${args.amount} (raw 6-dec lamports — ${Number(args.amount) / 1e6} RWT)`);
  console.log(`Distributor: ${distributor.toBase58()}`);
  console.log(`OT mint: ${otMint.toBase58()}`);
  console.log(`RWT mint: ${rwtMint.toBase58()}`);
  console.log(`Reward vault: ${rewardVault.toBase58()}`);
  console.log(`Fee account: ${feeAccount.toBase58()}`);
  console.log(`Depositor RWT ATA: ${depositorRwtAta.toBase58()}`);
  console.log(`(depositor == fee_account? ${depositorRwtAta.equals(feeAccount)})`);

  // Pre-flight balance check.
  const balBefore = await getTokenBalance(conn, depositorRwtAta);
  console.log(`Depositor RWT balance before: ${balBefore} (need >= ${args.amount})`);
  if (balBefore < args.amount) {
    throw new Error(
      `Insufficient RWT: have ${balBefore}, need ${args.amount}. ` +
        `Mint more RWT via rwt-engine or admin_mint_rwt.`,
    );
  }
  const vaultBefore = await getTokenBalance(conn, rewardVault);
  const feeBefore = await getTokenBalance(conn, feeAccount);
  console.log(`Reward vault balance before: ${vaultBefore}`);
  console.log(`Fee account balance before:  ${feeBefore}`);

  // Build via ArlexClient (same pattern as bootstrap-init.ts:1984).
  const ydClient = new ArlexClient(
    loadIdlForClient('yield-distribution'),
    ydProgramId,
    conn,
  );
  const tx = ydClient.buildTransaction('fund_distributor', {
    accounts: {
      depositor: deployer.publicKey,
      config: ydConfig,
      ot_mint: otMint,
      distributor,
      depositor_token: depositorRwtAta,
      reward_vault: rewardVault,
      fee_account: feeAccount,
      token_program: TOKEN_PROGRAM_ID,
    },
    args: { amount: args.amount },
  });

  // Modest CU bump — the handler does 2 SPL Transfers + state mutation +
  // emit, comfortably under 200K but devnet preflight is conservative.
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));

  console.log('\nSubmitting fund_distributor...');
  const sig = await sendAndConfirm(conn, tx, [deployer]);

  // Fetch full tx for slot + event verification.
  const txMeta = await conn.getTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const slot = txMeta?.slot ?? 0;

  console.log(`\nTX confirmed`);
  console.log(`  signature: ${sig}`);
  console.log(`  slot:      ${slot}`);
  console.log(`  explorer:  https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // Post-flight balances.
  const balAfter = await getTokenBalance(conn, depositorRwtAta);
  const vaultAfter = await getTokenBalance(conn, rewardVault);
  const feeAfter = await getTokenBalance(conn, feeAccount);
  console.log(`\nBalance deltas:`);
  console.log(`  depositor: ${balBefore} -> ${balAfter} (delta ${balAfter - balBefore})`);
  console.log(`  vault:     ${vaultBefore} -> ${vaultAfter} (delta ${vaultAfter - vaultBefore})`);
  console.log(`  fee:       ${feeBefore} -> ${feeAfter} (delta ${feeAfter - feeBefore})`);

  // Scan logs for DistributorFunded.
  const logs = txMeta?.meta?.logMessages ?? [];
  const programDataLines = logs.filter((l) => l.startsWith('Program data:'));
  console.log(`\nProgram data lines (Anchor/Arlex event payload): ${programDataLines.length}`);
  for (const l of programDataLines) {
    console.log(`  ${l}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
