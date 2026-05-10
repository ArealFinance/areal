#!/usr/bin/env tsx
/*
 * create-sparkles-ot.ts — one-shot helper to deploy the SPRK / Sparkles
 * Ownership Token on the Areal Testnet validator (rpc.areal.finance).
 *
 * What it does:
 *   1. Loads the bootstrap-time deployer keypair (`data/init-deployer.json`,
 *      pubkey VHixj…), which already owns the USDC mint authority and the
 *      OT-program-side `initialize_ot` admin role on this cluster.
 *   2. Generates (or reuses) a fresh SPL mint for SPRK (6 decimals,
 *      mint-authority = deployer). Persists the keypair to
 *      `data/sparkles-mint.json` so re-runs are idempotent.
 *   3. Calls the ownership-token program's `initialize_ot` instruction
 *      with name="Sparkles", symbol="SPRK", uri="" — the OtConfig PDA
 *      then becomes visible to `getMarketsSnapshot` and the SDK's
 *      `deriveCategory` heuristic auto-tags it as `'stock'`, so the app's
 *      /markets list and detail page will surface it without any other
 *      front-end code change.
 *
 * Uses the same on-chain primitives as `bootstrap-init.ts::phaseOts` —
 * inline-copied here so this script doesn't have to re-import the whole
 * bootstrap pipeline.
 *
 * Usage:
 *   npx tsx scripts/lib/create-sparkles-ot.ts
 *
 * Env / flags:
 *   --rpc <url>             Override RPC URL (default: https://rpc.areal.finance)
 *   --deployer <path>       Override deployer keypair (default: data/init-deployer.json)
 *   --mint-out <path>       Where to persist the SPRK mint keypair
 *                           (default: data/sparkles-mint.json)
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
	TransactionInstruction
} from '@solana/web3.js';
import { ArlexClient } from '@arlex/client';
import { PROGRAM_IDS, USDC_MINTS } from '@areal/sdk/network';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name: string, fallback: string): string {
	const idx = argv.indexOf(`--${name}`);
	return idx >= 0 && argv[idx + 1] ? argv[idx + 1]! : fallback;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const RPC_URL = arg('rpc', 'https://rpc.areal.finance');
const DEPLOYER_PATH = arg('deployer', resolve(REPO_ROOT, 'data', 'init-deployer.json'));
const MINT_OUT_PATH = arg('mint-out', resolve(REPO_ROOT, 'data', 'sparkles-mint.json'));

// On Areal Testnet (`localnet` cluster id) the bootstrap-init.ts run created
// a non-canonical USDC mint that we use across the protocol. SDK's
// USDC_MINTS.localnet table points at the R20 default — we want the
// override that endpoints.ts exposes. Pin explicitly here.
const USDC_MINT_OVERRIDE = new PublicKey('F9NVj8dFsqxbCfytfmrEWDjdDhmpV1YrjRuxiusGr9Ys');

// DEX dex_config + pool_creators PDAs (single per-cluster, written by the
// initial bootstrap into init-artifact.json). Hardcoded here so this script
// doesn't need to read the artifact.
const DEX_CONFIG_PDA = new PublicKey('CXjqgExZQmxkg9wtW5HSagB3HNKyTedmZNw4hrPc9oTy');
const POOL_CREATORS_PDA = new PublicKey('8oSJwQz7dubGeiw5h5x3jyWbEed56kvpvnpM5ZgBpBSF');

// Initial SPRK/RWT pool seed — 10_000 of each token at 6 decimals each.
// Implies a starting price of 1 SPRK = 1 RWT (≈ \$1 → TVL ≈ \$20K through
// RWT's NAV). The native-dex program hardcodes "one side must be RWT_MINT"
// (`0x1781 — Neither token is RWT_MINT`), so SPRK/USDC isn't allowed; we
// pair against RWT and let the markets snapshot pricing chain
// SPRK→RWT→USDC do the rest.
const POOL_SEED_AMOUNT_BASE = 10_000n * 1_000_000n;
const RWT_MINT = new PublicKey('3pBtHBiBwh4agqghTYuDQnZV1po5YahbaBGywtiZooRr');

// ---------------------------------------------------------------------------
// SPL token program constants
// ---------------------------------------------------------------------------

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// ---------------------------------------------------------------------------
// Helpers (copied from bootstrap-init.ts; kept inline so this is standalone)
// ---------------------------------------------------------------------------

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

function saveKeypair(path: string, kp: Keypair): void {
	writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
	chmodSync(path, 0o600);
}

function stringToFixedBytes(s: string, len: number): Uint8Array {
	const enc = new TextEncoder().encode(s);
	const out = new Uint8Array(len);
	out.set(enc.subarray(0, Math.min(enc.length, len)));
	return out;
}

/**
 * Poll-based confirmation (no WS). Areal Testnet's cloudflared tunnel
 * doesn't expose port 8900, so web3.js's `confirmTransaction` (which
 * subscribes via wss) loops until block-height-exceeded. Switch to a
 * `getSignatureStatuses` poll loop with a 60s ceiling — same effective
 * behaviour at HTTP-only.
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
		const { value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false });
		const st = value[0];
		if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
			if (st.err) throw new Error(`tx ${sig} on-chain error: ${JSON.stringify(st.err)}`);
			return sig;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`tx ${sig} not confirmed within 60s`);
}

async function createMintIxs(
	conn: Connection,
	payer: Keypair,
	mintKp: Keypair,
	decimals: number,
	mintAuthority: PublicKey
): Promise<Transaction> {
	const lamports = await conn.getMinimumBalanceForRentExemption(82);
	const tx = new Transaction();
	tx.add(
		SystemProgram.createAccount({
			fromPubkey: payer.publicKey,
			newAccountPubkey: mintKp.publicKey,
			space: 82,
			lamports,
			programId: TOKEN_PROGRAM_ID
		})
	);
	// SPL Token InitializeMint2 (instruction code 20)
	const data = Buffer.alloc(1 + 1 + 32 + 1 + 32);
	data.writeUInt8(20, 0); // ix code
	data.writeUInt8(decimals, 1);
	mintAuthority.toBuffer().copy(data, 2);
	data.writeUInt8(0, 34); // freezeAuthority option = none
	tx.add(
		new TransactionInstruction({
			keys: [{ pubkey: mintKp.publicKey, isSigner: false, isWritable: true }],
			programId: TOKEN_PROGRAM_ID,
			data
		})
	);
	return tx;
}

async function ensureMint(
	conn: Connection,
	payer: Keypair,
	decimals: number,
	mintKp: Keypair
): Promise<{ mint: PublicKey; created: boolean }> {
	const info = await conn.getAccountInfo(mintKp.publicKey);
	if (info) return { mint: mintKp.publicKey, created: false };
	const tx = await createMintIxs(conn, payer, mintKp, decimals, payer.publicKey);
	await sendAndConfirm(conn, tx, [payer, mintKp]);
	return { mint: mintKp.publicKey, created: true };
}

// ---------------------------------------------------------------------------
// IDL load — match bootstrap-init.ts pattern. The SDK ships the OT IDL JSON
// alongside its source.
// ---------------------------------------------------------------------------

/**
 * Load the OT IDL and patch every `#[account(init, ...)]` / `#[account(mut)]`
 * annotation that the IDL emitter dropped. ArlexClient v0.3.x reads
 * `acc.isMut` (old Anchor format) — modern IDLs emit `acc.writable`. We
 * additionally force `ot_config` writable since `initialize_ot` opens the
 * account but the IDL marks it readonly.
 *
 * Same logic as bootstrap-init.ts::normalizeIdlForArlexClient — kept inline
 * here so this script is standalone.
 */
/**
 * Load the native-dex IDL. `create_pool` and `add_liquidity` already have
 * accurate `isMut` flags in the IDL (different generator output), so no
 * overrides needed here.
 */
async function loadDexIdl(): Promise<any> {
	const idlPath = resolve(REPO_ROOT, 'sdk', 'idl', 'native-dex.json');
	if (!existsSync(idlPath)) {
		throw new Error(`native-dex IDL not found at ${idlPath}`);
	}
	return JSON.parse(readFileSync(idlPath, 'utf8'));
}

async function loadOtIdl(): Promise<unknown> {
	const idlPath = resolve(REPO_ROOT, 'sdk', 'idl', 'ownership-token.json');
	if (!existsSync(idlPath)) {
		throw new Error(`OT IDL not found at ${idlPath}`);
	}
	const idl = JSON.parse(readFileSync(idlPath, 'utf8'));
	// All accounts initialized by `initialize_ot` (the OT program creates a
	// chain of PDAs in one tx). The IDL drops `mut` annotations for several
	// of these — pin them all writable here. Static programs & system
	// program stay readonly.
	const writableOverrides: Record<string, Set<string>> = {
		initialize_ot: new Set([
			'deployer',
			'ot_config',
			'revenue_account',
			'revenue_token_account',
			'revenue_config',
			'ot_governance',
			'ot_treasury'
		]),
		mint_ot: new Set(['ot_config', 'ot_mint', 'recipient_token_account', 'payer'])
	};
	for (const ix of idl.instructions ?? []) {
		const overrides = writableOverrides[ix.name];
		if (!overrides) continue;
		for (const acc of ix.accounts ?? []) {
			const writable = acc.writable ?? acc.isMut ?? false;
			const signer = acc.signer ?? acc.isSigner ?? false;
			acc.isMut = writable || overrides.has(acc.name);
			acc.isSigner = signer;
		}
	}
	return idl;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log(`[sparkles] RPC: ${RPC_URL}`);
	console.log(`[sparkles] deployer keypair: ${DEPLOYER_PATH}`);

	const deployer = loadKeypair(DEPLOYER_PATH);
	console.log(`[sparkles] deployer pubkey: ${deployer.publicKey.toBase58()}`);

	const conn = new Connection(RPC_URL, 'confirmed');
	const balance = await conn.getBalance(deployer.publicKey);
	console.log(`[sparkles] deployer SOL: ${balance / 1e9}`);
	if (balance < 0.05 * 1e9) {
		throw new Error('deployer needs at least 0.05 SOL for init txs');
	}

	// 1. Load or generate SPRK mint keypair.
	let mintKp: Keypair;
	if (existsSync(MINT_OUT_PATH)) {
		mintKp = loadKeypair(MINT_OUT_PATH);
		console.log(`[sparkles] reusing existing mint keypair: ${mintKp.publicKey.toBase58()}`);
	} else {
		mintKp = Keypair.generate();
		saveKeypair(MINT_OUT_PATH, mintKp);
		console.log(
			`[sparkles] generated new mint keypair: ${mintKp.publicKey.toBase58()} → ${MINT_OUT_PATH}`
		);
	}

	// 2. Create the SPL mint if not already on-chain.
	const { created } = await ensureMint(conn, deployer, 6, mintKp);
	console.log(
		`[sparkles] mint ${created ? 'created' : 'already exists'}: ${mintKp.publicKey.toBase58()}`
	);

	// 3. Resolve OT program ID + USDC mint + areal_fee_ata.
	const otProgramId = PROGRAM_IDS.ownershipToken;
	const usdcMint = USDC_MINT_OVERRIDE;

	const otMint = mintKp.publicKey;
	const [otConfig] = findPda([Buffer.from('ot_config'), otMint.toBuffer()], otProgramId);
	const [revAcc] = findPda([Buffer.from('revenue'), otMint.toBuffer()], otProgramId);
	const [revCfg] = findPda([Buffer.from('revenue_config'), otMint.toBuffer()], otProgramId);
	const [otGov] = findPda([Buffer.from('ot_governance'), otMint.toBuffer()], otProgramId);
	const [otTreas] = findPda([Buffer.from('ot_treasury'), otMint.toBuffer()], otProgramId);
	const revTokAcc = findAta(revAcc, usdcMint);

	// areal_fee_destination_account is the USDC ATA owned by deployer that
	// init-artifact records under pdas.areal_fee_ata. Re-derive here.
	const arealFeeAta = findAta(deployer.publicKey, usdcMint);

	console.log(`[sparkles] ot_config PDA: ${otConfig.toBase58()}`);
	console.log(`[sparkles] revenue PDA: ${revAcc.toBase58()}`);
	console.log(`[sparkles] areal_fee_ata: ${arealFeeAta.toBase58()}`);

	// 4. Initialize OT — idempotent (skips if OtConfig PDA exists already).
	const otIdl = await loadOtIdl();
	const otClient = new ArlexClient(otIdl, otProgramId, conn);
	const cfgInfo = await conn.getAccountInfo(otConfig);
	if (cfgInfo) {
		console.log(`[sparkles] OtConfig already initialised — skipping initialize_ot`);
	} else {
		await initializeOt(conn, otClient, deployer, {
			otMint,
			usdcMint,
			otConfig,
			revAcc,
			revTokAcc,
			revCfg,
			otGov,
			otTreas,
			arealFeeAta
		});
	}

	// 5. Initial mint — `mint_ot` against the OT program. Authority must
	//    still be the deployer (R-B authority transfer hasn't run on Testnet
	//    yet). Mints `INITIAL_SUPPLY` to the deployer's SPRK ATA.
	await mintInitialSupply(conn, otClient, deployer, otMint, otGov, otConfig);

	// 6. SPRK/USDC liquidity pool — gives the token a price + TVL on the
	//    /markets list and detail page. Creates a STANDARD constant-product
	//    pool (RWT-pinned `create_concentrated_pool` rejects non-RWT pairs).
	await createAndSeedPool(conn, deployer, otMint);

	console.log('\n[sparkles] DONE — Sparkles is live on Testnet.');
}

async function initializeOt(
	conn: Connection,
	otClient: any,
	deployer: Keypair,
	pdas: {
		otMint: PublicKey;
		usdcMint: PublicKey;
		otConfig: PublicKey;
		revAcc: PublicKey;
		revTokAcc: PublicKey;
		revCfg: PublicKey;
		otGov: PublicKey;
		otTreas: PublicKey;
		arealFeeAta: PublicKey;
	}
): Promise<void> {
	const tx = otClient.buildTransaction('initialize_ot', {
		accounts: {
			deployer: deployer.publicKey,
			ot_mint: pdas.otMint,
			usdc_mint: pdas.usdcMint,
			ot_config: pdas.otConfig,
			revenue_account: pdas.revAcc,
			revenue_token_account: pdas.revTokAcc,
			revenue_config: pdas.revCfg,
			ot_governance: pdas.otGov,
			ot_treasury: pdas.otTreas,
			areal_fee_destination_account: pdas.arealFeeAta,
			token_program: TOKEN_PROGRAM_ID,
			system_program: SYSTEM_PROGRAM_ID,
			ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
		},
		args: {
			name: Array.from(stringToFixedBytes('Sparkles', 32)),
			symbol: Array.from(stringToFixedBytes('SPRK', 10)),
			uri: Array.from(stringToFixedBytes('', 200)),
			initial_authority: Array.from(deployer.publicKey.toBytes())
		}
	});

	const sig = await sendAndConfirm(conn, tx, [deployer]);
	console.log(`[sparkles] initialize_ot OK — sig ${sig}`);
}

/**
 * Mint the initial SPRK supply to the deployer. Mirrors bootstrap-init.ts
 * `phaseArlMint` but for Sparkles. Skips if the SPRK supply on-chain is
 * already non-zero (idempotent re-runs).
 */
async function mintInitialSupply(
	conn: Connection,
	otClient: any,
	deployer: Keypair,
	otMint: PublicKey,
	otGov: PublicKey,
	otConfig: PublicKey
): Promise<void> {
	// Probe current supply via getMint. If non-zero, skip.
	const mintInfo = await conn.getAccountInfo(otMint);
	if (mintInfo && mintInfo.data.length >= 36) {
		// supply is at offset 36-44 (8 bytes LE u64) in the SPL Mint account.
		const supply = mintInfo.data.readBigUInt64LE(36);
		if (supply > 0n) {
			console.log(
				`[sparkles] supply already ${supply.toString()} (>0) — skipping mint_ot`
			);
			return;
		}
	}

	const INITIAL_SUPPLY = 1_000_000n * 1_000_000n; // 1_000_000 SPRK with 6 decimals
	const recipientAta = findAta(deployer.publicKey, otMint);

	const tx = otClient.buildTransaction('mint_ot', {
		accounts: {
			authority: deployer.publicKey,
			ot_governance: otGov,
			ot_config: otConfig,
			ot_mint: otMint,
			recipient_token_account: recipientAta,
			recipient: deployer.publicKey,
			payer: deployer.publicKey,
			token_program: TOKEN_PROGRAM_ID,
			system_program: SYSTEM_PROGRAM_ID,
			ata_program: ASSOCIATED_TOKEN_PROGRAM_ID
		},
		args: { amount: Number(INITIAL_SUPPLY) }
	});

	const sig = await sendAndConfirm(conn, tx, [deployer]);
	console.log(
		`[sparkles] mint_ot OK — minted 1_000_000 SPRK to ${deployer.publicKey.toBase58()} (sig ${sig})`
	);
}

/**
 * Create a SPRK/USDC standard constant-product pool and seed it with
 * `POOL_SEED_AMOUNT_BASE` of each token (1:1 → 1 SPRK = 1 USDC starting
 * price, TVL ≈ \$20K). Idempotent: skips create if the pool PDA already
 * exists, and skips seeding if vault_a is already non-empty.
 */
async function createAndSeedPool(
	conn: Connection,
	deployer: Keypair,
	sprkMint: PublicKey
): Promise<void> {
	const dexProgramId = new PublicKey('DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL');
	const pairMint = RWT_MINT; // RWT is mandatory side per dex program guard

	// Canonical (mintA < mintB) order required by the DEX program's PDA
	// derivation. Without this the program will not find the pool state
	// account at the seed it computes.
	const [tokenA, tokenB] =
		sprkMint.toBuffer().compare(pairMint.toBuffer()) < 0
			? [sprkMint, pairMint]
			: [pairMint, sprkMint];
	const [poolPda] = findPda(
		[Buffer.from('pool'), tokenA.toBuffer(), tokenB.toBuffer()],
		dexProgramId
	);
	console.log(`[sparkles] pool PDA: ${poolPda.toBase58()}`);

	const dexIdl = await loadDexIdl();
	const dexClient = new ArlexClient(dexIdl, dexProgramId, conn);

	let vaultA: PublicKey;
	let vaultB: PublicKey;
	const existingPool = await conn.getAccountInfo(poolPda);
	if (existingPool) {
		// Re-read vault addresses from the existing pool state (same offsets
		// as bootstrap-init's phaseMasterPool — 8 disc + 1 type + 32+32
		// mints, then vault_a at offset 73, vault_b at 105).
		vaultA = new PublicKey(existingPool.data.subarray(73, 105));
		vaultB = new PublicKey(existingPool.data.subarray(105, 137));
		console.log(
			`[sparkles] pool already exists — vaultA=${vaultA.toBase58()}, vaultB=${vaultB.toBase58()}`
		);
	} else {
		const vaultAKp = Keypair.generate();
		const vaultBKp = Keypair.generate();
		const tx = dexClient.buildTransaction('create_pool', {
			accounts: {
				creator: deployer.publicKey,
				dex_config: DEX_CONFIG_PDA,
				pool_creators: POOL_CREATORS_PDA,
				pool_state: poolPda,
				token_a_mint: tokenA,
				token_b_mint: tokenB,
				vault_a: vaultAKp.publicKey,
				vault_b: vaultBKp.publicKey,
				token_program: TOKEN_PROGRAM_ID,
				system_program: SYSTEM_PROGRAM_ID
			},
			args: {},
			computeUnits: 300_000
		});
		const sig = await sendAndConfirm(conn, tx, [deployer, vaultAKp, vaultBKp]);
		vaultA = vaultAKp.publicKey;
		vaultB = vaultBKp.publicKey;
		console.log(
			`[sparkles] create_pool OK — pool=${poolPda.toBase58()}, vaultA=${vaultA.toBase58()}, vaultB=${vaultB.toBase58()} (sig ${sig})`
		);
	}

	// Skip seeding if vaults already have liquidity.
	const vaultABal = await readTokenBalance(conn, vaultA);
	if (vaultABal > 0n) {
		console.log(
			`[sparkles] pool already seeded (vault_a=${vaultABal.toString()}) — skipping add_liquidity`
		);
		return;
	}

	// Provider ATAs. SPRK ATA exists from mint_ot. Deployer's RWT ATA was
	// created and seeded during bootstrap-init's master-pool phase. If the
	// RWT side is short, mint RWT into deployer via the RWT vault's
	// admin_mint_rwt path — but we don't replicate that here. We expect
	// deployer to hold ≥ POOL_SEED_AMOUNT_BASE RWT from bootstrap; abort
	// loudly if not.
	const deployerSprkAta = findAta(deployer.publicKey, sprkMint);
	const deployerRwtAta = findAta(deployer.publicKey, RWT_MINT);
	const rwtBal = await readTokenBalance(conn, deployerRwtAta);
	if (rwtBal < POOL_SEED_AMOUNT_BASE) {
		throw new Error(
			`deployer RWT balance ${rwtBal.toString()} < ${POOL_SEED_AMOUNT_BASE.toString()}. ` +
				`Top up via admin_mint_rwt or rebalance from the master pool.`
		);
	}

	const providerTokenA = tokenA.equals(RWT_MINT) ? deployerRwtAta : deployerSprkAta;
	const providerTokenB = tokenB.equals(RWT_MINT) ? deployerRwtAta : deployerSprkAta;
	const [lpPosition] = findPda(
		[Buffer.from('lp'), poolPda.toBuffer(), deployer.publicKey.toBuffer()],
		dexProgramId
	);

	const seedTx = dexClient.buildTransaction('add_liquidity', {
		accounts: {
			provider: deployer.publicKey,
			payer: deployer.publicKey,
			dex_config: DEX_CONFIG_PDA,
			pool_state: poolPda,
			lp_position: lpPosition,
			provider_token_a: providerTokenA,
			provider_token_b: providerTokenB,
			vault_a: vaultA,
			vault_b: vaultB,
			token_program: TOKEN_PROGRAM_ID,
			system_program: SYSTEM_PROGRAM_ID
		},
		args: {
			amount_a: Number(POOL_SEED_AMOUNT_BASE),
			amount_b: Number(POOL_SEED_AMOUNT_BASE),
			min_shares: 0
		},
		computeUnits: 400_000
	});
	const sig = await sendAndConfirm(conn, seedTx, [deployer]);
	console.log(
		`[sparkles] add_liquidity OK — seeded 10_000 SPRK + 10_000 USDC (sig ${sig})`
	);
}

/** Read SPL token-account balance via getTokenAccountBalance. */
async function readTokenBalance(conn: Connection, ata: PublicKey): Promise<bigint> {
	try {
		const r = await conn.getTokenAccountBalance(ata, 'confirmed');
		return BigInt(r.value.amount);
	} catch {
		return 0n;
	}
}

/**
 * Ensure deployer's USDC ATA holds at least `min` lamports. Mints the gap
 * via SPL `MintTo` (deployer is the USDC mint authority on Testnet).
 */
async function ensureUsdcBalance(
	conn: Connection,
	deployer: Keypair,
	ata: PublicKey,
	usdcMint: PublicKey,
	min: bigint
): Promise<void> {
	const have = await readTokenBalance(conn, ata);
	if (have >= min) {
		console.log(`[sparkles] deployer USDC ATA already has ${have.toString()} (≥ ${min.toString()})`);
		return;
	}
	const need = min - have;
	// SPL Token MintTo (instruction code 7): [mint, dest, authority] writable mint+dest, signer authority.
	const data = Buffer.alloc(1 + 8);
	data.writeUInt8(7, 0);
	data.writeBigUInt64LE(need, 1);
	const tx = new Transaction().add(
		new TransactionInstruction({
			keys: [
				{ pubkey: usdcMint, isSigner: false, isWritable: true },
				{ pubkey: ata, isSigner: false, isWritable: true },
				{ pubkey: deployer.publicKey, isSigner: true, isWritable: false }
			],
			programId: TOKEN_PROGRAM_ID,
			data
		})
	);
	const sig = await sendAndConfirm(conn, tx, [deployer]);
	console.log(
		`[sparkles] minted ${need.toString()} USDC (lamports) to deployer ATA (sig ${sig})`
	);
}

main().catch((e) => {
	console.error('[sparkles] FATAL:', e);
	process.exit(1);
});
