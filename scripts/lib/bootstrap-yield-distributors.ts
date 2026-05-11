#!/usr/bin/env tsx
/*
 * bootstrap-yield-distributors.ts — create the MerkleDistributor +
 * Accumulator pair (plus their RWT reward vault + USDC accumulator ATA)
 * for each OT on the Areal Testnet validator. Idempotent: skips any
 * distributor that already exists on-chain.
 *
 * Why this is a separate script:
 *   `bootstrap-init.ts::phaseOts` creates a distributor for every OT it
 *   itself initialises, but `create-sparkles-ot.ts` (the post-bootstrap
 *   one-shot helper that minted SPRK) stopped after `initialize_ot` +
 *   pool seed. As a result the SPRK distributor — and on the current
 *   deployment the RWT distributor too — is still missing, and the
 *   portfolio page therefore can't surface unclaimed rewards.
 *
 *   This script picks up after `create-sparkles-ot.ts`: it reads the
 *   deployer keypair, derives the YD PDAs for every OT we know about
 *   (RWT, SPRK), and calls `YD::create_distributor` for each one that
 *   doesn't yet exist. After this runs, the merkle-publisher /
 *   revenue-crank / convert-and-fund-crank bots can take over.
 *
 * What it does:
 *   1. Loads deployer keypair (default `data/init-deployer.json`).
 *   2. Loads YD IDL and normalises it for `@arlex/client` v0.3.1.
 *   3. For each (label, ot_mint) pair:
 *        a. Derives distributor PDA `["merkle_dist", ot_mint]`,
 *           accumulator PDA `["accumulator", ot_mint]`,
 *           reward_vault (RWT ATA owner=distributor),
 *           accumulator_usdc_ata (USDC ATA owner=accumulator).
 *        b. Reads on-chain distributor account. If present, prints
 *           "skip (already initialised)" and continues.
 *        c. Otherwise builds `create_distributor` with
 *           `vesting_period_secs = 86_400` (1 day — Testnet default,
 *           matches `bootstrap-init.ts::DEFAULT_OT_VESTING_PERIOD_SECS`)
 *           and submits via deployer signature.
 *   4. Re-reads everything and prints final status.
 *
 * Usage:
 *   cd app && npx tsx ../scripts/lib/bootstrap-yield-distributors.ts
 *
 *   (Or copy into `bots/` and run from there; the script imports
 *   `@solana/web3.js`, `@arlex/client`, `@areal/sdk/network`, all of
 *   which are workspace-pinned and resolved from the cwd's
 *   `node_modules`. `app/` and `bots/` both have them installed.)
 *
 * Flags:
 *   --rpc <url>             default https://rpc.areal.finance
 *   --deployer <path>       default <repo>/data/init-deployer.json
 *   --vesting <seconds>     default 86400 (1 day)
 *   --dry-run               only print what WOULD be sent
 *
 * Costs:
 *   Per missing distributor ~0.01 SOL rent (distributor ~149 bytes +
 *   accumulator ~41 bytes + 2 ATAs ~165 bytes each) — deployer pays.
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

// ─────────────────────────────────────────────────────────────────────────
// Args & paths
// ─────────────────────────────────────────────────────────────────────────

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
// REPO_ROOT defaults to two levels up from this file (`scripts/lib/<file>`).
// When the script is copied into a sibling workspace (e.g. `bots/`) to
// inherit its `node_modules`, the relative path resolves elsewhere — pass
// `--repo-root` (or set REPO_ROOT env) to override.
const REPO_ROOT =
	process.env.REPO_ROOT ||
	(argv.includes('--repo-root') ? arg('repo-root', '') : '') ||
	resolve(__dirname, '..', '..');

const RPC_URL = arg('rpc', 'https://rpc.areal.finance');
const DEPLOYER_PATH = arg('deployer', resolve(REPO_ROOT, 'data', 'init-deployer.json'));
const VESTING_PERIOD_SECS = BigInt(arg('vesting', '86400'));
const DRY_RUN = flag('dry-run');

// ─────────────────────────────────────────────────────────────────────────
// On-chain constants (Testnet "localnet" cluster pins)
// ─────────────────────────────────────────────────────────────────────────

const YIELD_DISTRIBUTION_PROGRAM_ID = new PublicKey(
	'YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF'
);

const RWT_MINT = new PublicKey('3pBtHBiBwh4agqghTYuDQnZV1po5YahbaBGywtiZooRr');
const USDC_MINT = new PublicKey('F9NVj8dFsqxbCfytfmrEWDjdDhmpV1YrjRuxiusGr9Ys');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// ─────────────────────────────────────────────────────────────────────────
// Helpers (mirror create-sparkles-ot.ts)
// ─────────────────────────────────────────────────────────────────────────

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(seeds, programId);
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
	const [ata] = findPda(
		[owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
		ASSOCIATED_TOKEN_PROGRAM_ID
	);
	return ata;
}

function loadKeypair(path: string): Keypair {
	const data = JSON.parse(readFileSync(path, 'utf8')) as number[];
	return Keypair.fromSecretKey(new Uint8Array(data));
}

function loadKeypairPubkey(path: string): PublicKey {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as number[];
	return new PublicKey(Buffer.from(raw.slice(32, 64)));
}

/**
 * Poll-based confirmation. Areal Testnet cloudflared tunnel doesn't
 * expose port 8900 — same fix as `create-sparkles-ot.ts`.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// IDL normalisation — mirrors bootstrap-init.ts:normalizeIdlForArlexClient.
//
// The YD IDL marks `distributor`, `accumulator`, and other init-target
// accounts as `isMut: false` because the IDL emitter dropped the
// `#[account(init, ...)]` writable flag when the attribute spans
// multiple lines. ArlexClient v0.3.1 won't override that without an
// explicit allow-list per ix name.
// ─────────────────────────────────────────────────────────────────────────

const INIT_WRITABLE_OVERRIDES: Record<string, ReadonlyArray<string>> = {
	create_distributor: ['distributor', 'accumulator']
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeIdl(idl: any): any {
	const out = JSON.parse(JSON.stringify(idl));
	for (const ix of out.instructions ?? []) {
		const initWritable = new Set(INIT_WRITABLE_OVERRIDES[ix.name] ?? []);
		for (const acc of ix.accounts ?? []) {
			const writable = acc.writable ?? acc.isMut ?? false;
			const signer = acc.signer ?? acc.isSigner ?? false;
			acc.isMut = writable || initWritable.has(acc.name);
			acc.isSigner = signer;
		}
	}
	return out;
}

async function loadYdIdl(): Promise<any> {
	const path = join(REPO_ROOT, 'sdk', 'idl', 'yield-distribution.json');
	return normalizeIdl(JSON.parse(readFileSync(path, 'utf8')));
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

interface OtTarget {
	label: string;
	otMint: PublicKey;
}

async function loadOtTargets(): Promise<OtTarget[]> {
	const targets: OtTarget[] = [
		{ label: 'RWT', otMint: RWT_MINT }
	];

	// SPRK mint is persisted by create-sparkles-ot.ts as a Solana keypair
	// json (64-byte secret; bytes 32..64 = pubkey).
	const sprkPath = resolve(REPO_ROOT, 'data', 'sparkles-mint.json');
	try {
		const sprkMint = loadKeypairPubkey(sprkPath);
		targets.push({ label: 'SPRK', otMint: sprkMint });
	} catch (e) {
		console.warn(
			`⚠  Could not load SPRK mint from ${sprkPath}: ` +
				(e instanceof Error ? e.message : String(e))
		);
	}

	return targets;
}

async function bootstrap(): Promise<void> {
	console.log(`▶ YD distributor bootstrap — RPC ${RPC_URL}`);
	if (DRY_RUN) console.log('   (dry-run: no transactions will be sent)');

	const conn = new Connection(RPC_URL, 'confirmed');
	const deployer = loadKeypair(DEPLOYER_PATH);
	console.log(`   deployer: ${deployer.publicKey.toBase58()}`);

	const balance = await conn.getBalance(deployer.publicKey, 'confirmed');
	console.log(`   deployer balance: ${(balance / 1e9).toFixed(4)} SOL`);
	if (balance < 50_000_000) {
		console.warn('⚠  Deployer balance is below 0.05 SOL — may not cover rent for all distributors.');
	}

	const ydConfigPda = findPda([Buffer.from('dist_config')], YIELD_DISTRIBUTION_PROGRAM_ID)[0];
	const configInfo = await conn.getAccountInfo(ydConfigPda, 'confirmed');
	if (!configInfo) {
		throw new Error(
			`DistributionConfig not found at ${ydConfigPda.toBase58()} — run YD::initialize_config first.`
		);
	}
	console.log(`   YD config OK at ${ydConfigPda.toBase58()}`);

	const ydClient = new ArlexClient(await loadYdIdl(), YIELD_DISTRIBUTION_PROGRAM_ID, conn);
	const targets = await loadOtTargets();

	for (const { label, otMint } of targets) {
		console.log(`\n── ${label} (${otMint.toBase58()})`);
		const [distributor] = findPda(
			[Buffer.from('merkle_dist'), otMint.toBuffer()],
			YIELD_DISTRIBUTION_PROGRAM_ID
		);
		const [accumulator] = findPda(
			[Buffer.from('accumulator'), otMint.toBuffer()],
			YIELD_DISTRIBUTION_PROGRAM_ID
		);
		const rewardVault = findAta(distributor, RWT_MINT);
		const accumulatorUsdcAta = findAta(accumulator, USDC_MINT);

		console.log(`   distributor:          ${distributor.toBase58()}`);
		console.log(`   accumulator:          ${accumulator.toBase58()}`);
		console.log(`   reward_vault (RWT):   ${rewardVault.toBase58()}`);
		console.log(`   accumulator_usdc_ata: ${accumulatorUsdcAta.toBase58()}`);

		const existing = await conn.getAccountInfo(distributor, 'confirmed');
		if (existing) {
			console.log(`   ✓ already initialised — skip`);
			continue;
		}

		if (DRY_RUN) {
			console.log(`   [dry-run] would submit create_distributor with vesting=${VESTING_PERIOD_SECS}s`);
			continue;
		}

		console.log(`   ⏳ submitting create_distributor (vesting=${VESTING_PERIOD_SECS}s)...`);
		const tx = ydClient.buildTransaction('create_distributor', {
			accounts: {
				authority: deployer.publicKey,
				config: ydConfigPda,
				ot_mint: otMint,
				distributor,
				accumulator,
				rwt_mint: RWT_MINT,
				usdc_mint: USDC_MINT,
				reward_vault: rewardVault,
				accumulator_usdc_ata: accumulatorUsdcAta,
				token_program: TOKEN_PROGRAM_ID,
				system_program: SYSTEM_PROGRAM_ID,
				ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
			},
			args: { vesting_period_secs: VESTING_PERIOD_SECS }
		}) as Transaction;

		const sig = await sendAndConfirm(conn, tx, [deployer]);
		console.log(`   ✓ created — sig ${sig}`);
	}

	console.log('\n✓ Bootstrap complete. Re-run diagnose-yield-distribution.ts to verify.');
}

bootstrap().catch((err) => {
	console.error('\x1b[31mBootstrap failed:\x1b[0m', err);
	process.exit(1);
});
