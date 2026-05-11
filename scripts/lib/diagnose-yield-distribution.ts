#!/usr/bin/env node
/**
 * Yield-Distribution diagnostic — read-only Testnet status check.
 *
 * Reports the on-chain state of the YD pipeline so we know exactly what's
 * missing before bootstrapping rewards for SPRK (and verifying RWT):
 *
 *   1. DistributionConfig         (`["dist_config"]`, YD program)
 *   2. MerkleDistributor for each OT (`["merkle_dist", ot_mint]`)
 *      + Accumulator                 (`["accumulator", ot_mint]`)
 *      + reward_vault RWT ATA / accumulator USDC ATA
 *   3. Per-distributor balances (RWT in reward vault, USDC in accumulator)
 *
 * Pure read — no transactions, no keypairs needed. Safe to run against
 * production. Usage:
 *
 *   npx tsx scripts/lib/diagnose-yield-distribution.ts \
 *     --rpc https://rpc.areal.finance
 *
 * Output is plain text. Exit code is always 0; consumers should grep
 * the report for `MISSING`/`OK` markers.
 */
import { Connection, PublicKey } from '@solana/web3.js';

const YIELD_DISTRIBUTION_PROGRAM_ID = new PublicKey(
	'YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF'
);
const OWNERSHIP_TOKEN_PROGRAM_ID = new PublicKey(
	'oWnqbNwmEdjNS5KVbxz8xeuGNjKMd1aiNF89d7qdARL'
);

// Testnet mints — sourced from app endpoints + create-sparkles-ot.ts.
const RWT_MINT = new PublicKey('3pBtHBiBwh4agqghTYuDQnZV1po5YahbaBGywtiZooRr');
const USDC_MINT = new PublicKey('F9NVj8dFsqxbCfytfmrEWDjdDhmpV1YrjRuxiusGr9Ys');
const SPRK_MINT_FILE = 'data/sparkles-mint.json';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

// ─────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────

function arg(name: string, fallback: string): string {
	const idx = process.argv.indexOf(`--${name}`);
	return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}
const RPC_URL = arg('rpc', 'https://rpc.areal.finance');

// ─────────────────────────────────────────────────────────────────────────
// PDAs / ATA derivation (no @solana/spl-token dep — keep this script
// portable across the monorepo)
// ─────────────────────────────────────────────────────────────────────────

function findPda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
	return PublicKey.findProgramAddressSync(seeds, programId);
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
	const [ata] = PublicKey.findProgramAddressSync(
		[owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
		ASSOCIATED_TOKEN_PROGRAM_ID
	);
	return ata;
}

// ─────────────────────────────────────────────────────────────────────────
// On-chain readers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Read SPL token account balance (u64 LE @ offset 64). Returns null when
 * the account doesn't exist or has the wrong size.
 */
async function readAtaBalance(conn: Connection, ata: PublicKey): Promise<bigint | null> {
	const info = await conn.getAccountInfo(ata, 'confirmed');
	if (!info || info.data.length < 72) return null;
	return info.data.readBigUInt64LE(64);
}

/**
 * Parse the bits we care about out of MerkleDistributor. Layout per
 * contracts/yield-distribution/src/state.rs (Layer 10 confirmed).
 * Offsets (within data, AFTER 8-byte arlex discriminator):
 *   0  : ot_mint            [32]
 *   32 : reward_vault       [32]
 *   64 : accumulator        [32]
 *   96 : merkle_root        [32]
 *   128: max_total_claim    u128
 *   144: total_claimed      u128
 *   160: total_funded       u128
 *   176: locked_vested      u128
 *   192: last_fund_ts       i64
 *   200: vesting_period_secs i64
 *   208: epoch              u64
 *   216: is_active          u8
 *   217: bump               u8
 */
interface MerkleDistributorView {
	otMint: PublicKey;
	rewardVault: PublicKey;
	accumulator: PublicKey;
	merkleRoot: string; // hex
	maxTotalClaim: bigint;
	totalClaimed: bigint;
	totalFunded: bigint;
	epoch: bigint;
	lastFundTs: bigint;
	vestingPeriodSecs: bigint;
	isActive: boolean;
}

function parseMerkleDistributor(raw: Buffer): MerkleDistributorView | null {
	if (raw.length < 8 + 218) return null;
	const data = raw.subarray(8); // skip discriminator
	return {
		otMint: new PublicKey(data.subarray(0, 32)),
		rewardVault: new PublicKey(data.subarray(32, 64)),
		accumulator: new PublicKey(data.subarray(64, 96)),
		merkleRoot: data.subarray(96, 128).toString('hex'),
		maxTotalClaim: data.readBigUInt64LE(128) + (data.readBigUInt64LE(136) << 64n),
		totalClaimed: data.readBigUInt64LE(144) + (data.readBigUInt64LE(152) << 64n),
		totalFunded: data.readBigUInt64LE(160) + (data.readBigUInt64LE(168) << 64n),
		// locked_vested at 176..192 — skipped for brevity.
		lastFundTs: data.readBigInt64LE(192),
		vestingPeriodSecs: data.readBigInt64LE(200),
		epoch: data.readBigUInt64LE(208),
		isActive: data.readUInt8(216) === 1
	};
}

// ─────────────────────────────────────────────────────────────────────────
// Report helpers
// ─────────────────────────────────────────────────────────────────────────

function line(prefix: string, msg: string): void {
	console.log(`${prefix}  ${msg}`);
}

function ok(msg: string): void {
	line('\x1b[32m✓ OK    \x1b[0m', msg);
}

function missing(msg: string): void {
	line('\x1b[31m✗ MISSING\x1b[0m', msg);
}

function info(msg: string): void {
	line('\x1b[36m  INFO  \x1b[0m', msg);
}

function header(title: string): void {
	console.log('');
	console.log(`\x1b[1m── ${title} ─────────────────────────────────────────\x1b[0m`);
}

async function inspectAta(
	conn: Connection,
	label: string,
	ata: PublicKey,
	decimals: number
): Promise<void> {
	const bal = await readAtaBalance(conn, ata);
	if (bal === null) {
		missing(`${label} ATA ${ata.toBase58()} — not initialised`);
	} else {
		const human = Number(bal) / 10 ** decimals;
		ok(`${label} ATA ${ata.toBase58()} — balance ${human.toFixed(4)} (raw ${bal})`);
	}
}

async function inspectDistributor(
	conn: Connection,
	label: string,
	otMint: PublicKey
): Promise<MerkleDistributorView | null> {
	const [distPda] = findPda(
		[Buffer.from('merkle_dist'), otMint.toBuffer()],
		YIELD_DISTRIBUTION_PROGRAM_ID
	);
	const [accPda] = findPda(
		[Buffer.from('accumulator'), otMint.toBuffer()],
		YIELD_DISTRIBUTION_PROGRAM_ID
	);
	info(`${label} ot_mint:       ${otMint.toBase58()}`);
	info(`${label} distributor:   ${distPda.toBase58()}`);
	info(`${label} accumulator:   ${accPda.toBase58()}`);

	const distInfo = await conn.getAccountInfo(distPda, 'confirmed');
	if (!distInfo) {
		missing(`${label} MerkleDistributor PDA — not created (run YD::create_distributor)`);
		return null;
	}
	const dist = parseMerkleDistributor(distInfo.data);
	if (!dist) {
		missing(`${label} MerkleDistributor parse failed (data len=${distInfo.data.length})`);
		return null;
	}
	ok(
		`${label} MerkleDistributor — epoch=${dist.epoch} totalFunded=${dist.totalFunded} ` +
			`totalClaimed=${dist.totalClaimed} active=${dist.isActive}`
	);
	const rootHasData = dist.merkleRoot !== '00'.repeat(32);
	if (rootHasData) {
		ok(`${label} merkle_root published: 0x${dist.merkleRoot.slice(0, 16)}…`);
	} else {
		missing(`${label} merkle_root is all-zero — merkle-publisher hasn't run yet`);
	}

	// Reward vault + accumulator USDC ATA balances.
	await inspectAta(conn, `${label} reward_vault (RWT)`, dist.rewardVault, 6);
	const accUsdcAta = findAta(accPda, USDC_MINT);
	await inspectAta(conn, `${label} accumulator USDC`, accUsdcAta, 6);
	// Some flows also fund the accumulator with RWT (after `convert_to_rwt`).
	const accRwtAta = findAta(accPda, RWT_MINT);
	const accRwtInfo = await conn.getAccountInfo(accRwtAta, 'confirmed');
	if (accRwtInfo) {
		await inspectAta(conn, `${label} accumulator RWT`, accRwtAta, 6);
	}

	return dist;
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`\x1b[1m▶ YD diagnostic — RPC ${RPC_URL}\x1b[0m`);
	const conn = new Connection(RPC_URL, 'confirmed');

	// Sanity: program account exists at all.
	header('Programs');
	for (const [name, id] of [
		['yield-distribution', YIELD_DISTRIBUTION_PROGRAM_ID],
		['ownership-token', OWNERSHIP_TOKEN_PROGRAM_ID]
	] as const) {
		const acc = await conn.getAccountInfo(id, 'confirmed');
		if (acc?.executable) {
			ok(`${name} deployed at ${id.toBase58()}`);
		} else {
			missing(`${name} program not deployed at ${id.toBase58()}`);
		}
	}

	// DistributionConfig — must exist before any create_distributor TX.
	header('DistributionConfig');
	const [configPda] = findPda(
		[Buffer.from('dist_config')],
		YIELD_DISTRIBUTION_PROGRAM_ID
	);
	info(`dist_config: ${configPda.toBase58()}`);
	const configInfo = await conn.getAccountInfo(configPda, 'confirmed');
	if (!configInfo) {
		missing('DistributionConfig — not initialised. Run YD::initialize_config first.');
	} else {
		ok(`DistributionConfig OK (data len=${configInfo.data.length})`);
	}

	// Per-OT distributors.
	header('RWT distributor (self-referential)');
	await inspectDistributor(conn, 'RWT', RWT_MINT);

	header('SPRK distributor');
	let sprkMint: PublicKey | null = null;
	try {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = path.dirname(__filename);
		const REPO_ROOT = path.resolve(__dirname, '..', '..');
		const sprkFile = path.join(REPO_ROOT, SPRK_MINT_FILE);
		if (fs.existsSync(sprkFile)) {
			const raw = JSON.parse(fs.readFileSync(sprkFile, 'utf8'));
			if (Array.isArray(raw) && raw.length >= 32) {
				const kp = Buffer.from(raw.slice(32, 64));
				sprkMint = new PublicKey(kp);
			} else if (raw?.publicKey) {
				sprkMint = new PublicKey(raw.publicKey);
			}
		}
	} catch (e) {
		info(`Could not read ${SPRK_MINT_FILE}: ${e instanceof Error ? e.message : String(e)}`);
	}
	if (!sprkMint) {
		missing(
			`Cannot locate SPRK mint — checked ${SPRK_MINT_FILE}. ` +
				'Pass --sprk-mint <pubkey> or rerun after create-sparkles-ot.ts wrote it.'
		);
		const sprkOverride = arg('sprk-mint', '');
		if (sprkOverride) sprkMint = new PublicKey(sprkOverride);
	}
	if (sprkMint) {
		await inspectDistributor(conn, 'SPRK', sprkMint);
	}

	// Final next-step hint based on what's missing.
	header('Next steps');
	console.log(
		'  - DistributionConfig MISSING → bootstrap-yield-distribution.ts step 1 (initialize_config).\n' +
			'  - distributor MISSING        → bootstrap-yield-distribution.ts step 2 (create_distributor per OT).\n' +
			'  - merkle_root all-zero       → start merkle-publisher bot. Needs distributor + funded reward vault first.\n' +
			'  - reward_vault empty         → start revenue-crank + convert-and-fund-crank to convert pool fees → RWT.\n' +
			'  - proof-store missing        → deploy nginx static serving <proofDir> and set PUBLIC_PROOF_STORE_URL.\n'
	);
}

main().catch((err) => {
	console.error('\x1b[31mDiagnostic failed:\x1b[0m', err);
	process.exit(1);
});
