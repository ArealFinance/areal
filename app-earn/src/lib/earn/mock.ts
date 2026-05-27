/**
 * Mock data layer for the earn product.
 *
 * All numbers here are made up. The "Demo data" badge on the page makes that
 * explicit. When the real earn program ships, swap each `MOCK_*` constant /
 * helper for an on-chain read — interfaces in `./types.ts` stay the same.
 */

import type { PublicKey } from '@solana/web3.js';
import type { MintQuote, NavPoint } from './types';

export const MOCK_INITIAL_NAV = 1.0036;
export const MOCK_APR_30D = 0.0842;
export const MOCK_TOTAL_BACKING = 10_042_150.45;
export const MOCK_TOTAL_SUPPLY = 10_005_423.12;

export const MINT_FEE_RATE = 0.1;

/**
 * Generates a gentle upward-sloping NAV history.
 * Starts at MOCK_INITIAL_NAV - 0.005 and lands at MOCK_INITIAL_NAV with
 * small deterministic wobble so the sparkline doesn't look like a ruler.
 */
export function generateNavHistory(days = 30): NavPoint[] {
	const points: NavPoint[] = [];
	const start = MOCK_INITIAL_NAV - 0.005;
	const end = MOCK_INITIAL_NAV;
	const now = Date.now();
	const dayMs = 24 * 60 * 60 * 1000;

	for (let i = 0; i < days; i += 1) {
		const t = new Date(now - (days - 1 - i) * dayMs);
		const progress = i / (days - 1);
		// Tiny deterministic wobble based on index — no Math.random so SSR/CSR are stable.
		const wobble = Math.sin(i * 1.7) * 0.0004 + Math.cos(i * 0.7) * 0.0002;
		const nav = start + (end - start) * progress + wobble;
		points.push({ t: t.toISOString(), nav });
	}

	return points;
}

/**
 * Returns a live-ish NAV that drifts upward over time.
 * APR is approximated as a flat per-second rate so the user can watch the
 * number tick up between renders.
 */
export function simulateLiveNav(): number {
	const perSec = (MOCK_APR_30D / (365 * 24 * 60 * 60)) * MOCK_INITIAL_NAV;
	const secSinceEpoch = Date.now() / 1000;
	// Anchor drift to a fixed reference second so reloads don't reset the visual.
	const referenceSec = 1_700_000_000;
	const elapsed = Math.max(0, secSinceEpoch - referenceSec);
	return MOCK_INITIAL_NAV + perSec * elapsed * 0.0005;
}

/**
 * Quote for a mint: returns fee, NAV used, and RWT to mint.
 * 10 % fee, 90 % becomes RWT-backing, RWT received = backing / NAV.
 */
export function mockMintQuote(usdcAmount: number, nav: number): MintQuote {
	const safeAmount = Math.max(0, Number.isFinite(usdcAmount) ? usdcAmount : 0);
	const feeUsdc = safeAmount * MINT_FEE_RATE;
	const backing = safeAmount * (1 - MINT_FEE_RATE);
	const rwtOut = nav > 0 ? backing / nav : 0;
	return { feeUsdc, navUsed: nav, rwtOut };
}

/**
 * Deterministic mock RWT balance keyed off the pubkey's last byte.
 * Roughly ~30 % of pubkeys map to 0 so we can demo State B (no RWT).
 */
export function mockRwtBalance(pubkey: PublicKey): number {
	const bytes = pubkey.toBytes();
	const last = bytes[31];
	if (last < 80) return 0;
	const base = last / 2;
	const wobble = Math.sin(last) * 5;
	return Number((base + wobble).toFixed(6));
}

/**
 * Mock "cost basis" for the held RWT — used to render the small green
 * P&L line under the user's RWT total in State C.
 */
export function mockCostBasisUsd(rwtBalance: number): number {
	if (rwtBalance <= 0) return 0;
	// Pretend the user minted at NAV ≈ 1.0000 (start of the period).
	return rwtBalance * 1.0;
}
