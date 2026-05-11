#!/usr/bin/env tsx
/*
 * zero-out-dex-fee.ts — Testnet workaround.
 *
 * On Testnet, `DexConfig.areal_fee_destination` was bootstrapped to the
 * deployer's USDC ATA, but the native-dex `swap` ix transfers protocol
 * fees from the RWT vault to this account. SPL Token rejects the
 * Transfer with `MintMismatch` (custom 0x3) → every swap with a
 * non-zero base fee reverts on the 3rd internal CPI.
 *
 * `areal_fee_destination` is immutable after `initialize_dex`. The only
 * non-destructive path is to set `base_fee_bps = 0` so the fee transfer
 * never runs (`if fee_protocol > 0` guards the branch). All swaps then
 * pass through fee-free.
 *
 * Proper fix is to redeploy DEX with the correct fee destination; this
 * script unblocks Testnet swap demo in the meantime.
 *
 * Usage (from <repo>/bots, inheriting node_modules):
 *   cp ../scripts/lib/zero-out-dex-fee.ts ./_z.ts && \
 *     REPO_ROOT=/Users/blackmesa/Documents/areal.newera \
 *     npx tsx ./_z.ts && rm _z.ts
 *
 * Flags:
 *   --rpc <url>         default https://rpc.areal.finance
 *   --deployer <path>   default <repo>/data/init-deployer.json
 *   --dry-run           print intent, don't submit
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	Connection,
	Keypair,
	PublicKey,
	Transaction
} from '@solana/web3.js';
import { ArlexClient } from '@arlex/client';

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
	const idx = argv.indexOf(`--${name}`);
	return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : fallback;
}
function flag(name: string): boolean {
	return argv.includes(`--${name}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT =
	process.env.REPO_ROOT ||
	(argv.includes('--repo-root') ? arg('repo-root', '') : '') ||
	resolve(__dirname, '..', '..');

const RPC_URL = arg('rpc', 'https://rpc.areal.finance');
const DEPLOYER_PATH = arg('deployer', resolve(REPO_ROOT, 'data', 'init-deployer.json'));
const DRY_RUN = flag('dry-run');

const NATIVE_DEX_PROGRAM_ID = new PublicKey(
	'DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL'
);

function loadKeypair(path: string): Keypair {
	const data = JSON.parse(readFileSync(path, 'utf8')) as number[];
	return Keypair.fromSecretKey(new Uint8Array(data));
}

async function sendAndConfirm(
	conn: Connection,
	tx: Transaction,
	signers: Keypair[]
): Promise<string> {
	const { blockhash } = await conn.getLatestBlockhash('confirmed');
	tx.recentBlockhash = blockhash;
	tx.feePayer = signers[0]!.publicKey;
	tx.sign(...signers);
	const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const { value } = await conn.getSignatureStatuses([sig], {
			searchTransactionHistory: false
		});
		const st = value[0];
		if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
			if (st.err) throw new Error(`tx ${sig} on-chain error: ${JSON.stringify(st.err)}`);
			return sig;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`tx ${sig} not confirmed within 60s`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIdl(idl: any): any {
	const out = JSON.parse(JSON.stringify(idl));
	for (const ix of out.instructions ?? []) {
		for (const acc of ix.accounts ?? []) {
			const writable = acc.writable ?? acc.isMut ?? false;
			const signer = acc.signer ?? acc.isSigner ?? false;
			// `dex_config` is mutated by update_dex_config — IDL has it
			// `isMut: false` because the writable attribute lives on a
			// multi-line account block the emitter dropped. Same override
			// pattern as bootstrap-init.ts.
			if (ix.name === 'update_dex_config' && acc.name === 'dex_config') {
				acc.isMut = true;
			} else {
				acc.isMut = writable;
			}
			acc.isSigner = signer;
		}
	}
	return out;
}

async function loadDexIdl(): Promise<any> {
	const path = join(REPO_ROOT, 'sdk', 'idl', 'native-dex.json');
	return normalizeIdl(JSON.parse(readFileSync(path, 'utf8')));
}

interface DexConfigView {
	authority: PublicKey;
	baseFeeBps: number;
	lpFeeShareBps: number;
	rebalancer: number[];
	isActive: boolean;
}

function parseDexConfig(raw: Buffer): DexConfigView {
	const d = raw.subarray(8);
	const authority = new PublicKey(d.subarray(0, 32));
	// 32 authority + 32 pending + 1 has_pending + 32 pause_authority = 97
	const baseFeeBps = d.readUInt16LE(97);
	const lpFeeShareBps = d.readUInt16LE(99);
	// areal_fee_destination is at 101..133
	const rebalancer = Array.from(d.subarray(133, 165));
	const isActive = d.readUInt8(165) === 1;
	return { authority, baseFeeBps, lpFeeShareBps, rebalancer, isActive };
}

async function main(): Promise<void> {
	const conn = new Connection(RPC_URL, 'confirmed');
	const deployer = loadKeypair(DEPLOYER_PATH);
	console.log(`▶ zero-out dex fee — rpc ${RPC_URL}`);
	console.log(`  deployer: ${deployer.publicKey.toBase58()}`);

	// Derive dex_config PDA.
	const [dexConfigPda] = PublicKey.findProgramAddressSync(
		[Buffer.from('dex_config')],
		NATIVE_DEX_PROGRAM_ID
	);
	console.log(`  dex_config: ${dexConfigPda.toBase58()}`);

	const cfgInfo = await conn.getAccountInfo(dexConfigPda, 'confirmed');
	if (!cfgInfo) throw new Error('DexConfig not found');
	const cfg = parseDexConfig(cfgInfo.data);
	console.log(`  current base_fee_bps:     ${cfg.baseFeeBps}`);
	console.log(`  current lp_fee_share_bps: ${cfg.lpFeeShareBps}`);
	console.log(`  current is_active:        ${cfg.isActive}`);
	console.log(`  current authority:        ${cfg.authority.toBase58()}`);

	if (!cfg.authority.equals(deployer.publicKey)) {
		throw new Error(
			`deployer ${deployer.publicKey.toBase58()} is NOT the dex authority ${cfg.authority.toBase58()}`
		);
	}

	if (cfg.baseFeeBps === 0) {
		console.log('✓ base_fee_bps already 0 — nothing to do.');
		return;
	}

	if (DRY_RUN) {
		console.log('[dry-run] would call update_dex_config(0, 0, <preserve>, true)');
		return;
	}

	const idl = await loadDexIdl();
	const client = new ArlexClient(idl, NATIVE_DEX_PROGRAM_ID, conn);
	const tx = client.buildTransaction('update_dex_config', {
		accounts: {
			authority: deployer.publicKey,
			dex_config: dexConfigPda
		},
		args: {
			base_fee_bps: 0,
			lp_fee_share_bps: cfg.lpFeeShareBps, // preserve
			rebalancer: cfg.rebalancer, // preserve
			is_active: cfg.isActive // preserve
		}
	}) as Transaction;

	console.log('⏳ submitting update_dex_config (base_fee_bps=0)...');
	const sig = await sendAndConfirm(conn, tx, [deployer]);
	console.log(`✓ updated — sig ${sig}`);
}

main().catch((err) => {
	console.error('\x1b[31mzero-out failed:\x1b[0m', err);
	process.exit(1);
});
