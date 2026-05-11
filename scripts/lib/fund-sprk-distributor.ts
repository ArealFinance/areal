#!/usr/bin/env tsx
/*
 * fund-sprk-distributor.ts — manually transfer RWT into the SPRK
 * MerkleDistributor's reward_vault so the merkle-publisher has
 * something to snapshot. Bypasses revenue-crank + convert-and-fund-crank
 * for the bootstrap demo: real production flow is
 *   pool fees → distribute_revenue → accumulator → convert_to_rwt → reward_vault.
 *
 * Calls `YD::fund_distributor` with `amount` base-units of RWT
 * (default 1000 RWT, i.e. 1_000_000_000 base at 6 decimals).
 * Contract takes `protocol_fee_bps` (25 bps = 0.25%) off the top and
 * routes it to `config.areal_fee_destination`; the rest (~997.5 RWT)
 * lands in `distributor.reward_vault` and bumps `total_funded`.
 *
 * Idempotent in the sense that it can be re-run; each run adds another
 * round of RWT and increments `total_funded`. The merkle-publisher
 * snapshots the cumulative balance, so the user's `cumulativeAmount`
 * will grow on every published epoch after a fund_distributor TX.
 *
 * Usage (from repo root, after `cd bots`):
 *   cp ../scripts/lib/fund-sprk-distributor.ts ./_f.ts && \
 *     REPO_ROOT=/Users/blackmesa/Documents/areal.newera \
 *     npx tsx ./_f.ts --amount 1000 && rm _f.ts
 *
 * Flags:
 *   --rpc <url>             default https://rpc.areal.finance
 *   --deployer <path>       default <repo>/data/init-deployer.json
 *   --amount <human>        RWT amount in whole tokens (default 1000)
 *   --target <RWT|SPRK>     which distributor to fund (default SPRK)
 *   --dry-run               only print what WOULD be sent
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
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
const REPO_ROOT =
	process.env.REPO_ROOT ||
	(argv.includes('--repo-root') ? arg('repo-root', '') : '') ||
	resolve(__dirname, '..', '..');

const RPC_URL = arg('rpc', 'https://rpc.areal.finance');
const DEPLOYER_PATH = arg('deployer', resolve(REPO_ROOT, 'data', 'init-deployer.json'));
const AMOUNT_HUMAN = arg('amount', '1000');
const TARGET = arg('target', 'SPRK').toUpperCase();
const DRY_RUN = flag('dry-run');

// ─────────────────────────────────────────────────────────────────────────
// On-chain constants
// ─────────────────────────────────────────────────────────────────────────

const YIELD_DISTRIBUTION_PROGRAM_ID = new PublicKey(
	'YLD9EBikcTmVCnVzdx6vuNajrDkp8tyCAgZrqTwmMXF'
);
const RWT_MINT = new PublicKey('3pBtHBiBwh4agqghTYuDQnZV1po5YahbaBGywtiZooRr');
const RWT_DECIMALS = 6;
const ARL_FEE_DESTINATION = new PublicKey(
	'AzuRhmPxaxB2KcFJzDqzbj35o1BxMiMSRn1qkoqC7AYV'
);

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
	'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

// ─────────────────────────────────────────────────────────────────────────
// Helpers
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

// `fund_distributor` mutates `distributor.total_funded` and `last_fund_ts`,
// but the IDL marks it `isMut: false`. Same pattern as bootstrap-init.ts.
const INIT_WRITABLE_OVERRIDES: Record<string, ReadonlyArray<string>> = {
	fund_distributor: ['distributor']
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

async function resolveTargetMint(): Promise<PublicKey> {
	if (TARGET === 'RWT') return RWT_MINT;
	if (TARGET === 'SPRK') {
		const sprkPath = resolve(REPO_ROOT, 'data', 'sparkles-mint.json');
		return loadKeypairPubkey(sprkPath);
	}
	throw new Error(`Unknown --target ${TARGET} (expected RWT|SPRK)`);
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log(`▶ fund_distributor → ${TARGET}`);
	console.log(`   rpc: ${RPC_URL}`);
	if (DRY_RUN) console.log('   (dry-run: no transactions will be sent)');

	const conn = new Connection(RPC_URL, 'confirmed');
	const deployer = loadKeypair(DEPLOYER_PATH);
	console.log(`   depositor: ${deployer.publicKey.toBase58()}`);

	const otMint = await resolveTargetMint();
	console.log(`   ot_mint:   ${otMint.toBase58()}`);

	const ydConfigPda = findPda([Buffer.from('dist_config')], YIELD_DISTRIBUTION_PROGRAM_ID)[0];
	const [distributor] = findPda(
		[Buffer.from('merkle_dist'), otMint.toBuffer()],
		YIELD_DISTRIBUTION_PROGRAM_ID
	);
	const depositorRwtAta = findAta(deployer.publicKey, RWT_MINT);
	const rewardVault = findAta(distributor, RWT_MINT);

	console.log(`   distributor:    ${distributor.toBase58()}`);
	console.log(`   reward_vault:   ${rewardVault.toBase58()}`);
	console.log(`   depositor_token:${depositorRwtAta.toBase58()}`);
	console.log(`   fee_account:    ${ARL_FEE_DESTINATION.toBase58()}`);

	// Convert human amount → base units. Fail loud on non-integer base.
	const dec = RWT_DECIMALS;
	const m = AMOUNT_HUMAN.match(/^(\d+)(\.(\d+))?$/);
	if (!m) throw new Error(`--amount must be a non-negative decimal (got ${AMOUNT_HUMAN})`);
	const whole = BigInt(m[1]!);
	const fracStr = (m[3] ?? '').padEnd(dec, '0').slice(0, dec);
	const frac = BigInt(fracStr || '0');
	const amount = whole * 10n ** BigInt(dec) + frac;
	console.log(`   amount:    ${AMOUNT_HUMAN} RWT (${amount} base units)`);

	if (DRY_RUN) {
		console.log('   [dry-run] would submit fund_distributor');
		return;
	}

	const ydClient = new ArlexClient(await loadYdIdl(), YIELD_DISTRIBUTION_PROGRAM_ID, conn);
	const tx = ydClient.buildTransaction('fund_distributor', {
		accounts: {
			depositor: deployer.publicKey,
			config: ydConfigPda,
			ot_mint: otMint,
			distributor,
			depositor_token: depositorRwtAta,
			reward_vault: rewardVault,
			fee_account: ARL_FEE_DESTINATION,
			token_program: TOKEN_PROGRAM_ID
		},
		args: { amount }
	}) as Transaction;

	console.log('   ⏳ submitting fund_distributor...');
	const sig = await sendAndConfirm(conn, tx, [deployer]);
	console.log(`   ✓ funded — sig ${sig}`);

	// Read post-state for sanity.
	const vaultInfo = await conn.getAccountInfo(rewardVault, 'confirmed');
	if (vaultInfo) {
		const bal = vaultInfo.data.readBigUInt64LE(64);
		console.log(`   reward_vault balance now: ${Number(bal) / 10 ** dec} RWT (raw ${bal})`);
	}
}

main().catch((err) => {
	console.error('\x1b[31mfund_distributor failed:\x1b[0m', err);
	process.exit(1);
});
