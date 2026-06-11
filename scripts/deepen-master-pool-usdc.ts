#!/usr/bin/env tsx
/*
 * deepen-master-pool-usdc.ts — one-off on-chain demo op (test-validator only).
 *
 * Deepens the RWT/USDC master pool's USDC bid wall by ~100,000 USDC via the
 * protocol-correct Nexus → grow_liquidity path (NOT user LP). Mirrors
 * scripts/lib/bootstrap-init.ts::phaseMasterPool's CP-7 seed flow.
 *
 * Flow:
 *   1. Mint TARGET_USDC into the Nexus-owned USDC ATA (CRAKi = USDC mint auth).
 *   2. Temporarily rotate dex_config.rebalancer -> CRAKi (CRAKi = dex authority).
 *   3. grow_liquidity(new_nav_bin, active_zone_width=40) signed by CRAKi —
 *      drains the FULL Nexus accumulator into pool_vault_b, redistributing it
 *      across the 40-bin active zone (geometric density).
 *   4. Rotate dex_config.rebalancer back to the original pool-rebalancer bot.
 *
 * new_nav_bin is gated by:
 *   - direction gate: new_nav_bin > pool.last_rebalance_nav_bin
 *   - NAV-bin tolerance (CP-12.5): |price_at_bin(new_nav_bin) - NAV| <= 2*step
 * The script computes the highest valid bin within tolerance that also
 * satisfies the direction gate, and fails loudly if none exists.
 *
 * USAGE (from repo root):
 *   NODE_PATH=bots/node_modules bots/node_modules/.bin/tsx \
 *     scripts/deepen-master-pool-usdc.ts \
 *     --rpc http://localhost:18899 \
 *     --keypair deploy-keypair.json \
 *     --artifact data/e2e-bootstrap.json \
 *     [--usdc 100000000000] [--dry-run]
 */

import { readFileSync } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { ArlexClient } from '@arlex/client';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

const ACTIVE_ZONE_WIDTH = 40;
const BPS_DENOMINATOR = 10_000;
const CONCENTRATED_SCALE = 1_000_000_000_000; // 10^12

// ── args ──────────────────────────────────────────────────────────────────
function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const RPC = arg('rpc', 'http://localhost:18899')!;
const KEYPAIR_PATH = arg('keypair', 'deploy-keypair.json')!;
const ARTIFACT_PATH = arg('artifact', 'data/e2e-bootstrap.json')!;
const TARGET_USDC = BigInt(arg('usdc', '100000000000')!); // 100k @ 6 dec
const DRY_RUN = flag('dry-run');

// ── helpers ────────────────────────────────────────────────────────────────
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
}
function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}
async function splAmount(conn: Connection, ata: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(ata);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}
async function sendAndConfirm(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
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
    const st = value?.[0];
    if (st?.err) throw new Error(`tx failed: ${JSON.stringify(st.err)} (sig=${sig})`);
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error(`confirm timeout sig=${sig}`);
}
function mintToIx(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}

// NAV-bin tolerance — mirror contracts/native-dex/src/concentrated.rs::
// nav_bin_within_tolerance. price_at_bin(step,bin) = (1+step/1e4)^bin * SCALE.
function navBinWithinTolerance(bin: number, nav: bigint, stepBps: number): boolean {
  const navQ = Number(nav) * (CONCENTRATED_SCALE / 1_000_000);
  if (navQ === 0) return false;
  const priceQ = Math.pow(1 + stepBps / BPS_DENOMINATOR, bin) * CONCENTRATED_SCALE;
  const tol = (navQ * stepBps * 2) / BPS_DENOMINATOR;
  return Math.abs(priceQ - navQ) <= tol;
}

// IDL normalization (mirror bootstrap-init INIT_WRITABLE_OVERRIDES subset).
const INIT_WRITABLE_OVERRIDES: Record<string, string[]> = {
  update_dex_config: ['dex_config'],
  grow_liquidity: ['pool_state', 'bin_array', 'liquidity_nexus', 'nexus_usdc_ata', 'pool_vault_b'],
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadIdlForClient(): any {
  const idl = JSON.parse(readFileSync('sdk/idl/native-dex.json', 'utf8'));
  for (const ix of idl.instructions ?? []) {
    const w = new Set(INIT_WRITABLE_OVERRIDES[ix.name] ?? []);
    for (const acc of ix.accounts ?? []) {
      acc.isMut = (acc.writable ?? acc.isMut ?? false) || w.has(acc.name);
      acc.isSigner = acc.signer ?? acc.isSigner ?? false;
    }
  }
  return idl;
}

// PoolState packed reads (after 8-byte disc).
function readPool(d: Buffer) {
  const D = 8;
  return {
    poolType: d.readUInt8(D + 0),
    vaultB: new PublicKey(d.subarray(D + 97, D + 129)),
    reserveA: d.readBigUInt64LE(D + 129),
    reserveB: d.readBigUInt64LE(D + 137),
    isActive: d.readUInt8(D + 163) === 1,
    binStepBps: d.readUInt16LE(D + 172),
    leftAnchorBin: d.readInt32LE(D + 244),
    permanentTailFloorBin: d.readInt32LE(D + 248),
    lastRebalanceNavBin: d.readInt32LE(D + 252),
    activeZoneLower: d.readInt32LE(D + 256),
  };
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const craki = loadKeypair(KEYPAIR_PATH);
  const art = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8'));

  const dexProgramId = new PublicKey(art.programs.native_dex);
  const usdcMint = new PublicKey(art.mints.usdc_test_mint);
  const dexConfig = new PublicKey(art.pdas.dex_config);
  const poolState = new PublicKey(art.pdas.master_pool);
  const binArray = new PublicKey(art.pdas.master_pool_bin_array);
  const nexus = new PublicKey(art.pdas.liquidity_nexus);
  const rwtVault = new PublicKey(art.pdas.rwt_vault);
  const nexusUsdcAta = findAta(nexus, usdcMint);

  console.log(`[deepen] CRAKi=${craki.publicKey.toBase58()}`);
  console.log(`[deepen] target USDC=${TARGET_USDC} (= ${Number(TARGET_USDC) / 1e6} USDC)`);
  console.log(`[deepen] nexus_usdc_ata=${nexusUsdcAta.toBase58()} (artifact=${art.pdas.master_pool_nexus_usdc_ata})`);
  if (nexusUsdcAta.toBase58() !== art.pdas.master_pool_nexus_usdc_ata) {
    throw new Error('derived nexus USDC ATA != artifact value — aborting');
  }

  // Snapshot BEFORE.
  const poolBefore = readPool((await conn.getAccountInfo(poolState))!.data);
  const navRaw = (await conn.getAccountInfo(rwtVault))!.data.readBigUInt64LE(8 + 24);
  const vaultBBefore = await splAmount(conn, poolBefore.vaultB);
  const nexusBefore = await splAmount(conn, nexusUsdcAta);
  console.log(`[deepen] BEFORE: pool_type=${poolBefore.poolType} is_active=${poolBefore.isActive} ` +
    `bin_step=${poolBefore.binStepBps} last_rebalance_nav_bin=${poolBefore.lastRebalanceNavBin}`);
  console.log(`[deepen] BEFORE: vault_b USDC=${vaultBBefore} reserve_b=${poolBefore.reserveB} ` +
    `reserve_a(RWT)=${poolBefore.reserveA} NAV=${Number(navRaw) / 1e6}`);
  console.log(`[deepen] BEFORE: nexus USDC=${nexusBefore} left_anchor=${poolBefore.leftAnchorBin} ` +
    `tail_floor=${poolBefore.permanentTailFloorBin} active_zone_lower=${poolBefore.activeZoneLower}`);

  if (poolBefore.poolType !== 1) throw new Error('pool is not concentrated (pool_type != 1)');
  if (!poolBefore.isActive) throw new Error('pool is not active');

  // Pick new_nav_bin: highest bin within NAV tolerance that also clears the
  // direction gate (> last_rebalance_nav_bin). Scan a small window.
  let newNavBin: number | null = null;
  for (let bin = poolBefore.lastRebalanceNavBin + 10; bin > poolBefore.lastRebalanceNavBin; bin--) {
    if (navBinWithinTolerance(bin, navRaw, poolBefore.binStepBps)) {
      newNavBin = bin;
      break;
    }
  }
  if (newNavBin === null) {
    throw new Error(
      `no valid new_nav_bin: NAV=${Number(navRaw) / 1e6} maps near bin 0, ` +
      `last_rebalance_nav_bin=${poolBefore.lastRebalanceNavBin} already at/above the ` +
      `NAV tolerance ceiling. grow_liquidity is NAV-gated and cannot advance at flat NAV.`,
    );
  }
  // Geometry sanity (mirror grow_redistribute gates).
  const newZoneLower = newNavBin - ACTIVE_ZONE_WIDTH + 1;
  if (newZoneLower < poolBefore.leftAnchorBin) {
    throw new Error(`new_zone_lower=${newZoneLower} < left_anchor=${poolBefore.leftAnchorBin} (ActiveZoneOverlapsTail)`);
  }
  console.log(`[deepen] chosen new_nav_bin=${newNavBin} (new_zone_lower=${newZoneLower}, width=${ACTIVE_ZONE_WIDTH})`);

  if (DRY_RUN) {
    console.log('[deepen] --dry-run set; not submitting transactions.');
    return;
  }

  const client = new ArlexClient(loadIdlForClient(), dexProgramId, conn);

  // ── Step 1: mint TARGET_USDC into Nexus USDC ATA (idempotent top-up) ──────
  if (nexusBefore < TARGET_USDC) {
    const need = TARGET_USDC - nexusBefore;
    const sig = await sendAndConfirm(
      conn,
      new Transaction().add(mintToIx(usdcMint, nexusUsdcAta, craki.publicKey, need)),
      [craki],
    );
    console.log(`[deepen] STEP1 mint ${need} USDC -> nexus ATA, sig=${sig}`);
  } else {
    console.log(`[deepen] STEP1 nexus already holds >= target (${nexusBefore}); skip mint`);
  }
  const nexusStaged = await splAmount(conn, nexusUsdcAta);
  console.log(`[deepen] STEP1 nexus USDC staged = ${nexusStaged} (= ${Number(nexusStaged) / 1e6} USDC)`);

  const originalRebalancer = new PublicKey(
    (await conn.getAccountInfo(dexConfig))!.data.subarray(8 + 133, 8 + 165),
  );
  console.log(`[deepen] original rebalancer = ${originalRebalancer.toBase58()}`);

  let rotated = false;
  try {
    // ── Step 2: rotate rebalancer -> CRAKi ──────────────────────────────────
    if (!originalRebalancer.equals(craki.publicKey)) {
      const tx = client.buildTransaction('update_dex_config', {
        accounts: { authority: craki.publicKey, dex_config: dexConfig },
        args: {
          base_fee_bps: 50,
          lp_fee_share_bps: 5000,
          rebalancer: Array.from(craki.publicKey.toBytes()),
          is_active: true,
        },
      });
      const sig = await sendAndConfirm(conn, tx, [craki]);
      rotated = true;
      console.log(`[deepen] STEP2 rebalancer -> CRAKi, sig=${sig}`);
    } else {
      console.log('[deepen] STEP2 rebalancer already CRAKi; skip rotate');
    }

    // ── Step 3: grow_liquidity (drains full nexus accumulator) ──────────────
    const growTx = client.buildTransaction('grow_liquidity', {
      accounts: {
        rebalancer: craki.publicKey,
        dex_config: dexConfig,
        pool_state: poolState,
        bin_array: binArray,
        liquidity_nexus: nexus,
        nexus_usdc_ata: nexusUsdcAta,
        pool_vault_b: poolBefore.vaultB,
        rwt_vault: rwtVault,
        token_program: TOKEN_PROGRAM_ID,
      },
      args: { new_nav_bin: newNavBin, active_zone_width: ACTIVE_ZONE_WIDTH },
      computeUnits: 400_000,
    });
    const growSig = await sendAndConfirm(conn, growTx, [craki]);
    console.log(`[deepen] STEP3 grow_liquidity OK, sig=${growSig}`);
  } finally {
    // ── Step 4: restore original rebalancer (always, even on grow failure) ──
    if (rotated) {
      const tx = client.buildTransaction('update_dex_config', {
        accounts: { authority: craki.publicKey, dex_config: dexConfig },
        args: {
          base_fee_bps: 50,
          lp_fee_share_bps: 5000,
          rebalancer: Array.from(originalRebalancer.toBytes()),
          is_active: true,
        },
      });
      const sig = await sendAndConfirm(conn, tx, [craki]);
      console.log(`[deepen] STEP4 rebalancer restored -> ${originalRebalancer.toBase58()}, sig=${sig}`);
    }
  }

  // Snapshot AFTER.
  const poolAfter = readPool((await conn.getAccountInfo(poolState))!.data);
  const vaultBAfter = await splAmount(conn, poolAfter.vaultB);
  const nexusAfter = await splAmount(conn, nexusUsdcAta);
  const navAfter = (await conn.getAccountInfo(rwtVault))!.data.readBigUInt64LE(8 + 24);
  console.log('\n[deepen] ===== AFTER =====');
  console.log(`[deepen] vault_b USDC: ${vaultBBefore} -> ${vaultBAfter} (+${vaultBAfter - vaultBBefore})`);
  console.log(`[deepen] reserve_b:    ${poolBefore.reserveB} -> ${poolAfter.reserveB}`);
  console.log(`[deepen] reserve_a(RWT): ${poolBefore.reserveA} -> ${poolAfter.reserveA} (should be unchanged)`);
  console.log(`[deepen] nexus USDC:   ${nexusBefore} -> ${nexusAfter} (should be ~0)`);
  console.log(`[deepen] last_rebalance_nav_bin: ${poolBefore.lastRebalanceNavBin} -> ${poolAfter.lastRebalanceNavBin}`);
  console.log(`[deepen] active_zone_lower: ${poolBefore.activeZoneLower} -> ${poolAfter.activeZoneLower}`);
  console.log(`[deepen] NAV: ${Number(navRaw) / 1e6} -> ${Number(navAfter) / 1e6} (should be unchanged)`);
  console.log(`[deepen] pool is_active: ${poolAfter.isActive}`);
}

main().catch((e) => {
  console.error('[deepen] FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
