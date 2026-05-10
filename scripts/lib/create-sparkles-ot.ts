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
	const initWritable = new Set([
		'deployer',
		'ot_config',
		'revenue_account',
		'revenue_token_account',
		'revenue_config',
		'ot_governance',
		'ot_treasury'
	]);
	for (const ix of idl.instructions ?? []) {
		if (ix.name !== 'initialize_ot') continue;
		for (const acc of ix.accounts ?? []) {
			const writable = acc.writable ?? acc.isMut ?? false;
			const signer = acc.signer ?? acc.isSigner ?? false;
			acc.isMut = writable || initWritable.has(acc.name);
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

	// 4. Skip if OtConfig already initialised (idempotent re-runs).
	const cfgInfo = await conn.getAccountInfo(otConfig);
	if (cfgInfo) {
		console.log(`[sparkles] OtConfig already initialised — skipping initialize_ot`);
		console.log(`\nMint:    ${otMint.toBase58()}`);
		console.log(`Symbol:  SPRK`);
		console.log(`Name:    Sparkles`);
		return;
	}

	// 5. Initialize OT.
	const otIdl = await loadOtIdl();
	const otClient = new ArlexClient(otIdl, otProgramId, conn);
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

	console.log(`\nDeployed Sparkles OT:`);
	console.log(`  Mint:    ${otMint.toBase58()}`);
	console.log(`  Symbol:  SPRK`);
	console.log(`  Name:    Sparkles`);
	console.log(`  OtConfig PDA: ${otConfig.toBase58()}`);
}

main().catch((e) => {
	console.error('[sparkles] FATAL:', e);
	process.exit(1);
});
