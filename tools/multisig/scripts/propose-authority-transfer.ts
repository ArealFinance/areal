/**
 * DEVNET Stage 3a helper: PROPOSE side of the 2-step authority transfer for BOTH
 * earn + staking, signed by the CURRENT authority (deployer). The CLI only does
 * the vault-signed ACCEPT half; this builds the deployer-signed propose half.
 *
 * Ground truth: contracts/{earn,staking}/src/instructions/authority_transfer.rs
 *   ProposeAuthorityTransfer accounts:
 *     0 authority      signer   (= deployer, current authority)
 *     1 {earn,staking}_config   mut
 *   arg: new_authority [u8;32]  (= Squads vault GkDVox...)
 *   discriminator = sha256("global:propose_authority_transfer")[0..8]
 *
 * DEVNET ONLY. Read-only on contracts; sends 2 txs signed by deployer.
 */
import { readFileSync as rf } from 'node:fs';
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createHash as sha } from 'node:crypto';

const RPC = 'https://api.devnet.solana.com';
const EARN_PROGRAM = new PublicKey('EXW5JYFX32Xzd2QByvVxDxa9nRGNHbrhccboNqNHhwtm');
const STAKING_PROGRAM = new PublicKey('7QzDVFQcMs4N1sa3fdyuTNHS6Ej9warYnEQwuztq9ub');
const EARN_CONFIG = new PublicKey('719YWEeDNWMFbfpY5fkoFMZKQcbyKqf1TGNG1JvWCXGy');
const STAKING_CONFIG = new PublicKey('4JUKMhSj3eueDaxQYdYNECCTBP6jz4rcx3eNNK1EDrLA');
const VAULT = new PublicKey('GkDVoxszUAkWYKhQzWLK4jTzAssBGsZVpfYssAFUtVh1');
const DEPLOYER_PATH = '../../keys/devnet/deployer.json';

function disc(name: string): Buffer {
  return sha('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function loadKeypair(path: string): Keypair {
  const arr = JSON.parse(rf(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(arr));
}

async function sendIx(
  conn: Connection,
  ix: TransactionInstruction,
  payer: Keypair,
  label: string,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, preflightCommitment: 'confirmed' });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`${label}: ${sig}`);
  return sig;
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const deployer = loadKeypair(DEPLOYER_PATH);
  console.log('deployer:', deployer.publicKey.toBase58());
  console.log('new_authority (vault):', VAULT.toBase58());

  const data = (program: 'earn' | 'staking') =>
    Buffer.concat([disc('propose_authority_transfer'), Buffer.from(VAULT.toBytes())]);

  // EARN propose
  const earnIx = new TransactionInstruction({
    programId: EARN_PROGRAM,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: EARN_CONFIG, isSigner: false, isWritable: true },
    ],
    data: data('earn'),
  });
  console.log('\n--- earn.propose_authority_transfer ---');
  console.log('disc:', disc('propose_authority_transfer').toString('hex'));
  await sendIx(conn, earnIx, deployer, 'earn propose tx');

  // STAKING propose
  const stakingIx = new TransactionInstruction({
    programId: STAKING_PROGRAM,
    keys: [
      { pubkey: deployer.publicKey, isSigner: true, isWritable: false },
      { pubkey: STAKING_CONFIG, isSigner: false, isWritable: true },
    ],
    data: data('staking'),
  });
  console.log('\n--- staking.propose_authority_transfer ---');
  await sendIx(conn, stakingIx, deployer, 'staking propose tx');
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
