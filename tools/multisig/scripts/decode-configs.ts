/**
 * DEVNET dry-run helper: decode EarnConfig + StakingConfig on-chain state.
 * Read-only. Prints every field used to verify Stage 3 scenarios.
 *
 * Byte layouts (8-byte Anchor discriminator prefix):
 *   EarnConfig (228 bytes) — contracts/earn/src/state.rs
 *   StakingConfig (234 bytes) — contracts/staking/src/state.rs
 */
import { Connection, PublicKey } from '@solana/web3.js';

const RPC = 'https://api.devnet.solana.com';
const EARN_CONFIG = new PublicKey('H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p');
const STAKING_CONFIG = new PublicKey('BWb75dNXbJbteLsmKy58sfHj8nYVa6CqaDzJrWo1mP1R');

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
  console.log('mint_fee_bps:', e.readUInt16LE(89));
  console.log('basket_vault:', pk(e, 91));
  console.log('dao_fee_destination:', pk(e, 123));
  console.log('rwt_mint:', pk(e, 155));
  console.log('usdc_mint:', pk(e, 187));
  console.log('min_mint_amount:', e.readBigUInt64LE(219).toString());
  console.log('bump:', e[227]);

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
  console.log('rwt_mint:', pk(s, 73));
  console.log('strwt_mint:', pk(s, 105));
  console.log('reward_depositor:', pk(s, 137));
  console.log('pool_vault:', pk(s, 169));
  console.log('total_rwt_active:', s.readBigUInt64LE(201).toString());
  console.log('total_rwt_reserved:', s.readBigUInt64LE(209).toString());
  console.log('cooldown_seconds:', s.readBigInt64LE(217).toString());
  console.log('min_stake_amount:', s.readBigUInt64LE(225).toString());
  console.log('bump:', s[233]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
