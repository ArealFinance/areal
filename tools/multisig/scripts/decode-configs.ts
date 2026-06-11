/**
 * DEVNET dry-run helper: decode EarnConfig + StakingConfig on-chain state.
 * Read-only. Prints every field used to verify Stage 3 scenarios.
 *
 * Byte layouts (8-byte Anchor discriminator prefix):
 *   EarnConfig (325 bytes) — contracts/earn/src/state.rs
 *   StakingConfig (331 bytes) — contracts/staking/src/state.rs
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = 'https://api.devnet.solana.com';
const EARN_CONFIG = new PublicKey('719YWEeDNWMFbfpY5fkoFMZKQcbyKqf1TGNG1JvWCXGy');
const STAKING_CONFIG = new PublicKey('4JUKMhSj3eueDaxQYdYNECCTBP6jz4rcx3eNNK1EDrLA');

function pk(b: Buffer, o: number): string {
  return new PublicKey(b.subarray(o, o + 32)).toBase58();
}
function u128(b: Buffer, o: number): bigint {
  const lo = b.readBigUInt64LE(o);
  const hi = b.readBigUInt64LE(o + 8);
  return lo + (hi << 64n);
}

async function main() {
  const conn = new Connection(RPC, 'confirmed');

  const ec = await conn.getAccountInfo(EARN_CONFIG);
  if (!ec) throw new Error('EarnConfig not found');
  const e = ec.data;
  console.log('=== EarnConfig 719Y ===');
  console.log('owner:', ec.owner.toBase58());
  console.log('len:', e.length);
  console.log('disc:', e.subarray(0, 8).toString('hex'));
  console.log('total_invested_capital:', u128(e, 8).toString());
  console.log('authority:', pk(e, 24));
  console.log('pending_authority:', pk(e, 56));
  console.log('has_pending:', e[88]);
  console.log('pause_auth[0]:', pk(e, 89));
  console.log('pause_auth[1]:', pk(e, 121));
  console.log('pause_auth[2]:', pk(e, 153));
  console.log('is_paused:', e[185]);
  console.log('mint_fee_bps:', e.readUInt16LE(186));
  console.log('basket_vault:', pk(e, 188));
  console.log('dao_fee_destination:', pk(e, 220));
  console.log('rwt_mint:', pk(e, 252));
  console.log('usdc_mint:', pk(e, 284));
  console.log('min_mint_amount:', e.readBigUInt64LE(316).toString());
  console.log('bump:', e[324]);

  const sc = await conn.getAccountInfo(STAKING_CONFIG);
  if (!sc) throw new Error('StakingConfig not found');
  const s = sc.data;
  console.log('');
  console.log('=== StakingConfig 4JUK ===');
  console.log('owner:', sc.owner.toBase58());
  console.log('len:', s.length);
  console.log('disc:', s.subarray(0, 8).toString('hex'));
  console.log('authority:', pk(s, 8));
  console.log('pending_authority:', pk(s, 40));
  console.log('has_pending:', s[72]);
  console.log('pause_auth[0]:', pk(s, 73));
  console.log('pause_auth[1]:', pk(s, 105));
  console.log('pause_auth[2]:', pk(s, 137));
  console.log('is_paused:', s[169]);
  console.log('rwt_mint:', pk(s, 170));
  console.log('strwt_mint:', pk(s, 202));
  console.log('reward_depositor:', pk(s, 234));
  console.log('pool_vault:', pk(s, 266));
  console.log('total_rwt_active:', s.readBigUInt64LE(298).toString());
  console.log('total_rwt_reserved:', s.readBigUInt64LE(306).toString());
  console.log('cooldown_seconds:', s.readBigInt64LE(314).toString());
  console.log('min_stake_amount:', s.readBigUInt64LE(322).toString());
  console.log('bump:', s[330]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
