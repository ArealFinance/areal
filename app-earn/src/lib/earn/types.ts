/**
 * Shared types for the earn product layer.
 * When the real contract is wired in, only the *values* in mock.ts should
 * change — these interfaces should remain stable.
 */

export interface NavPoint {
	/** ISO timestamp for the data point. */
	t: string;
	/** NAV (RWT → USD) at that moment. */
	nav: number;
}

export interface NavSnapshot {
	currentNav: number;
	apr30d: number;
	totalBacking: number;
	totalSupply: number;
	history: NavPoint[];
}

export interface BalanceState {
	usdc: number;
	rwt: number;
}

export interface MintQuote {
	/** Protocol fee (USDC), 10 % of input amount. */
	feeUsdc: number;
	/** NAV used to compute the RWT output. */
	navUsed: number;
	/** RWT the user will receive. */
	rwtOut: number;
}
