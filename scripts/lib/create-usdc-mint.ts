#!/usr/bin/env tsx
/*
 * create-usdc-mint.ts — mint a FRESH devnet USDC test mint for the clean earn
 * re-bootstrap.
 *
 * WHY A NEW USDC: the Meteora customizable-permissionless pool address derives
 * from (tokenX, tokenY) ONLY. The OLD devnet USDC (E4HJu85ZmTrfBuy9kXQpehYn-
 * JdaHKY9oaEZNRCZcW35a) is bound to the burned earn pool. A fresh USDC mint
 * (paired with the fresh earn-RWT mint that bootstrap-earn will generate) yields
 * a brand-new pool address — escaping the burned one. The deployer is the mint
 * authority so test USDC can be re-minted on demand by every downstream script.
 *
 * WHAT IT CREATES:
 *   - A new SPL Token mint: 6 decimals, mint authority = deployer, freeze
 *     authority = none. (Matches the OLD devnet USDC layout the rest of the
 *     stack assumes: 6-dec, deployer-controlled supply.)
 *   - The mint address comes from a freshly generated keypair; the keypair must
 *     co-sign the create tx (System CreateAccount on the new account).
 *
 * ARTIFACT WRITES (only under --execute):
 *   - mints.usdc            := <new mint pubkey>   (overwrites the old one)
 *   - mints.usdc_v1_devnet  := <old mint pubkey>   (preserved for reference)
 *   - mints.usdc_keypair_b64:= <new mint keypair>  (kept for completeness; the
 *                              deployer is the authority anyway)
 *   - mints.usdc_test       := <new mint pubkey>   (kept in sync — it currently
 *                              mirrors mints.usdc in the artifact)
 *
 * SAFETY: DEFAULTS TO DRY-RUN. With --dry-run (or no flag) the script generates
 * the mint keypair, prints the plan, builds the create tx and runs
 * connection.simulateTransaction (read-only). It SENDS NOTHING and WRITES
 * NOTHING. Only --execute creates the mint on-chain and journals the result.
 *
 * NOTE on idempotency: each --execute run mints a NEW USDC (fresh keypair). It
 * is NOT safe to re-run --execute blindly expecting the same mint — that would
 * orphan the previous one and re-point the artifact. Run it ONCE for the
 * re-bootstrap. A guard below refuses --execute if mints.usdc already differs
 * from the recorded usdc_v1_devnet baseline (i.e. a fresh USDC was already
 * minted), to prevent accidental double-rotation.
 *
 * Usage (from repo root, scripts run with NODE_PATH=bots/node_modules):
 *   NODE_PATH=bots/node_modules npx tsx scripts/lib/create-usdc-mint.ts            # dry-run (default)
 *   NODE_PATH=bots/node_modules npx tsx scripts/lib/create-usdc-mint.ts --execute  # actually create
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
  createInitializeMint2Instruction,
} from '@solana/spl-token';

// --------------------------------------------------------------------------
// Paths & constants
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const ADDRESSES_PATH = join(REPO_ROOT, 'data', 'devnet-addresses.json');

// Devnet USDC test mint layout the rest of the stack assumes.
const USDC_DECIMALS = 6;

// --------------------------------------------------------------------------
// Logging
// --------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>): void {
  const line = `[create-usdc-mint] [${stage}] ${msg}`;
  if (extra) console.log(line, JSON.stringify(extra));
  else console.log(line);
}

// --------------------------------------------------------------------------
// devnet-addresses.json I/O
// --------------------------------------------------------------------------

interface DevnetAddresses {
  cluster: string;
  rpc: { http: string; ws?: string; airdrop_http?: string };
  deployer: { keypair_path: string; pubkey: string };
  mints: {
    usdc: string;
    usdc_v1_devnet?: string;
    usdc_keypair_b64?: string;
    usdc_test?: string;
    [k: string]: string | undefined;
  };
  [k: string]: unknown;
}

function loadAddresses(): DevnetAddresses {
  return JSON.parse(readFileSync(ADDRESSES_PATH, 'utf8')) as DevnetAddresses;
}

/** Atomic write: tmp file in the same dir, then rename over the target. */
function saveAddresses(art: DevnetAddresses): void {
  const tmp = `${ADDRESSES_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(art, null, 2) + '\n', 'utf8');
  renameSync(tmp, ADDRESSES_PATH);
}

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(readFileSync(p, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function keypairToB64(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString('base64');
}

// --------------------------------------------------------------------------
// On-chain reads
// --------------------------------------------------------------------------

async function accountExists(conn: Connection, addr: PublicKey): Promise<boolean> {
  return (await conn.getAccountInfo(addr, 'confirmed')) !== null;
}

// --------------------------------------------------------------------------
// tx send / simulate
// --------------------------------------------------------------------------

async function simulateOrSend(
  conn: Connection,
  tx: Transaction,
  signers: Keypair[],
  execute: boolean,
  label: string,
): Promise<string | null> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);

  if (!execute) {
    const sim = await conn.simulateTransaction(tx);
    const err = sim.value.err;
    log('simulate', `${label}: ${err ? 'ERR' : 'OK'}`, {
      err: err ?? null,
      unitsConsumed: sim.value.unitsConsumed ?? null,
    });
    if (sim.value.logs) for (const l of sim.value.logs) console.log(`    | ${l}`);
    if (err) throw new Error(`simulation failed for ${label}: ${JSON.stringify(err)}`);
    return null;
  }

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value?.[0];
    if (s?.err) throw new Error(`${label} tx failed: ${JSON.stringify(s.err)} (sig=${sig})`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      log('send', `${label} OK`, { sig });
      console.log(`    explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`${label} confirmation timeout: sig=${sig}`);
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

interface Cli {
  execute: boolean;
}

function parseArgs(argv: string[]): Cli {
  let execute = false;
  for (const a of argv) {
    if (a === '--execute') execute = true;
    else if (a === '--dry-run') execute = false;
    else throw new Error(`unknown flag: ${a} (valid: --dry-run | --execute)`);
  }
  return { execute };
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main(): Promise<void> {
  const { execute } = parseArgs(process.argv.slice(2));

  const art = loadAddresses();
  if (art.cluster !== 'devnet' || !art.rpc.http.includes('devnet')) {
    throw new Error(`refusing to run on non-devnet target (cluster=${art.cluster})`);
  }

  const conn = new Connection(art.rpc.http, 'confirmed');

  const deployer = loadKeypair(join(REPO_ROOT, art.deployer.keypair_path));
  if (deployer.publicKey.toBase58() !== art.deployer.pubkey) {
    throw new Error(
      `deployer keypair ${deployer.publicKey.toBase58()} != addresses.json ${art.deployer.pubkey}`,
    );
  }

  const oldUsdc = art.mints.usdc;

  // Double-rotation guard (only meaningful under --execute): if a fresh USDC was
  // already minted (mints.usdc differs from the recorded baseline), refuse.
  if (execute && art.mints.usdc_v1_devnet && art.mints.usdc !== art.mints.usdc_v1_devnet) {
    throw new Error(
      `mints.usdc (${art.mints.usdc}) already differs from usdc_v1_devnet ` +
        `(${art.mints.usdc_v1_devnet}) — a fresh USDC appears to have been minted ` +
        `already. Refusing to double-rotate. Inspect the artifact before re-running.`,
    );
  }

  // Fresh mint keypair → fresh address.
  const mintKp = Keypair.generate();
  const newMint = mintKp.publicKey;

  // --- Plan print ---------------------------------------------------------
  console.log('\n================ create-usdc-mint PLAN ================');
  console.log(`mode:                 ${execute ? 'EXECUTE (will create)' : 'DRY-RUN (simulate only)'}`);
  console.log(`rpc:                  ${art.rpc.http}`);
  console.log(`deployer:             ${deployer.publicKey.toBase58()}`);
  console.log('--- new USDC mint ---');
  console.log(`new mint pubkey:      ${newMint.toBase58()}`);
  console.log(`decimals:             ${USDC_DECIMALS}`);
  console.log(`mint authority:       ${deployer.publicKey.toBase58()} (deployer)`);
  console.log(`freeze authority:     none`);
  console.log('--- artifact rotation ---');
  console.log(`mints.usdc (old):     ${oldUsdc}`);
  console.log(`mints.usdc (new):     ${newMint.toBase58()}`);
  console.log(`mints.usdc_v1_devnet: ${oldUsdc}  (preserved for reference)`);
  console.log('======================================================\n');

  // --- Create mint: System CreateAccount + InitializeMint2 -----------------
  // (Same primitive bootstrap-earn uses for the earn-RWT mint, so authority and
  //  decimals semantics match the rest of the stack.)
  if (await accountExists(conn, newMint)) {
    // Astronomically unlikely (fresh random keypair), but guard anyway.
    throw new Error(`generated mint ${newMint.toBase58()} already exists on-chain — regenerate`);
  }

  const lamports = await getMinimumBalanceForRentExemptMint(conn);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: deployer.publicKey,
      newAccountPubkey: newMint,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      newMint,
      USDC_DECIMALS,
      deployer.publicKey, // mint authority = deployer
      null, // no freeze authority
      TOKEN_PROGRAM_ID,
    ),
  );
  await simulateOrSend(conn, tx, [deployer, mintKp], execute, 'create USDC test mint');

  // --- Journal -------------------------------------------------------------
  if (execute) {
    // Preserve the old USDC under usdc_v1_devnet (only on first rotation, so a
    // hypothetical second run wouldn't overwrite the original baseline — the
    // guard above already blocks that, this is belt-and-suspenders).
    if (!art.mints.usdc_v1_devnet) {
      art.mints.usdc_v1_devnet = oldUsdc;
    }
    art.mints.usdc = newMint.toBase58();
    art.mints.usdc_test = newMint.toBase58(); // currently mirrors mints.usdc
    art.mints.usdc_keypair_b64 = keypairToB64(mintKp);
    saveAddresses(art);
    log('journal', `wrote new USDC mint to ${ADDRESSES_PATH}`, {
      usdc: newMint.toBase58(),
      usdc_v1_devnet: art.mints.usdc_v1_devnet,
    });
  } else {
    log('journal', 'DRY-RUN — not writing devnet-addresses.json. Would journal:', {
      'mints.usdc': newMint.toBase58(),
      'mints.usdc_v1_devnet': oldUsdc,
      'mints.usdc_test': newMint.toBase58(),
      'mints.usdc_keypair_b64': '<base64 of new mint keypair>',
    });
  }

  console.log(`\n[create-usdc-mint] DONE (${execute ? 'executed' : 'dry-run / simulate only'}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));
  process.exit(1);
});
