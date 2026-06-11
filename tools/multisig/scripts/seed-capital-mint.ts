/**
 * DEVNET Stage 3e prerequisite: seed earn total_invested_capital via a real
 * mint_rwt by the deployer (acts as the user). Stage 3e writedown requires
 * capital > MIN_CAPITAL_FLOOR; the freshly-initialized config has capital == 0.
 *
 * Ground truth: contracts/earn/src/instructions/mint_rwt.rs
 *   mint_rwt(usdc_amount: u64, min_rwt_out: u64)
 *   accounts: user(signer), earn_config(mut), rwt_mint(mut), user_usdc(mut),
 *             user_rwt(mut), basket_vault(mut), dao_fee_destination(mut),
 *             token_program
 *   discriminator = sha256("global:mint_rwt")[0..8]
 *
 * At capital==0/supply==0, NAV = INITIAL_NAV ($1.00): $5 body -> 5 RWT, +1.5%
 * fee. Body grows capital; fee is excluded. DEVNET ONLY.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const RPC = 'https://api.devnet.solana.com';
const EARN_PROGRAM = new PublicKey('EXW5JYFX32Xzd2QByvVxDxa9nRGNHbrhccboNqNHhwtm');
const EARN_CONFIG = new PublicKey('719YWEeDNWMFbfpY5fkoFMZKQcbyKqf1TGNG1JvWCXGy');
const RWT_MINT = new PublicKey('9gwx7oeMwfFJfx1FfcWR1G1B9n23W8UuRTbUVdB54a4V');
const BASKET_VAULT = new PublicKey('9Zs9YGkw1Qch3v56T7fBjxMSVD1ZLEwHjoagYtLeu7dg');
const DAO_FEE_DEST = new PublicKey('7eU9YeiDsN7Riz1HzRRp9cenjRNbJZDZFdDMnPsLBKvd'); // = deployer USDC ATA
const USER_USDC = new PublicKey('7eU9YeiDsN7Riz1HzRRp9cenjRNbJZDZFdDMnPsLBKvd'); // deployer USDC ATA
const USER_RWT = new PublicKey('8rDBEn94uBTkST7mcHJ2RkWuBp3kT1kGtu2YpZyvwX4k'); // deployer RWT ATA
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const DEPLOYER_PATH = '../../keys/devnet/deployer.json';

const USDC_AMOUNT = 5_000_000n; // $5 body
const MIN_RWT_OUT = 1n;

function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
function u64le(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n, 0);
  return b;
}
function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const deployer = loadKeypair(DEPLOYER_PATH);

  const data = Buffer.concat([disc('mint_rwt'), u64le(USDC_AMOUNT), u64le(MIN_RWT_OUT)]);
  console.log('mint_rwt disc:', disc('mint_rwt').toString('hex'));
  console.log('usdc_amount:', USDC_AMOUNT.toString(), 'min_rwt_out:', MIN_RWT_OUT.toString());

  const ix = new TransactionInstruction({
    programId: EARN_PROGRAM,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: EARN_CONFIG, isSigner: false, isWritable: true },
      { pubkey: RWT_MINT, isSigner: false, isWritable: true },
      { pubkey: USER_USDC, isSigner: false, isWritable: true },
      { pubkey: USER_RWT, isSigner: false, isWritable: true },
      { pubkey: BASKET_VAULT, isSigner: false, isWritable: true },
      { pubkey: DAO_FEE_DEST, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: deployer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([deployer]);

  try {
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
    console.log('RESULT: SUCCESS  sig=' + sig);
  } catch (e: any) {
    console.log('RESULT: FAILED');
    const logs = e?.logs;
    if (logs) for (const l of logs) console.log(l);
    console.log('error:', String(e?.message ?? e));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('UNEXPECTED:', e);
  process.exit(1);
});
