/**
 * Pure formatting helpers — no side effects, no DOM.
 * Everything returns a string ready for display.
 */

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const USD_COMPACT = new Intl.NumberFormat('en-US', {
	notation: 'compact',
	maximumFractionDigits: 1
});

/** Format USDC as a plain decimal string with thousand separators (no $ sign). */
export function formatUsdc(value: number, decimals = 2): string {
	if (!Number.isFinite(value)) return '0.00';
	return value.toLocaleString('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	});
}

/** Format RWT to 6 decimals (Solana SPL convention). */
export function formatRwt(value: number, decimals = 6): string {
	if (!Number.isFinite(value)) return '0.000000';
	return value.toLocaleString('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals
	});
}

/** Format a USD amount with the $ sign and thousand separators. */
export function formatUsd(value: number): string {
	if (!Number.isFinite(value)) return '$0.00';
	return USD_FORMATTER.format(value);
}

/** Compact USD for hero stats (`$10.0M`). */
export function formatUsdCompact(value: number): string {
	if (!Number.isFinite(value)) return '$0';
	return `$${USD_COMPACT.format(value)}`;
}

/** Format NAV as $X.XXXX (4 decimals — matches the brief). */
export function formatNav(value: number): string {
	if (!Number.isFinite(value)) return '$0.0000';
	return `$${value.toFixed(4)}`;
}

/** APR as `8.4%`. Pass a fraction (0.084), not a percentage. */
export function formatApr(value: number): string {
	if (!Number.isFinite(value)) return '0.0%';
	return `${(value * 100).toFixed(1)}%`;
}

/**
 * Shortens a Solana base58 address.
 * Default `4 / 4` matches the brief's `0x82A1…3K7C` style.
 */
export function shortenAddress(address: string, head = 4, tail = 4): string {
	if (!address || address.length <= head + tail + 1) return address;
	return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** Signed delta string like `+0.04%` / `-0.12%`. Pass a fraction. */
export function formatPctDelta(value: number, decimals = 2): string {
	if (!Number.isFinite(value)) return '0.00%';
	const pct = value * 100;
	const sign = pct > 0 ? '+' : '';
	return `${sign}${pct.toFixed(decimals)}%`;
}

/** Signed USD delta like `+$0.32` / `-$1.20`. */
export function formatUsdDelta(value: number): string {
	if (!Number.isFinite(value)) return '$0.00';
	const sign = value > 0 ? '+' : value < 0 ? '-' : '';
	return `${sign}${USD_FORMATTER.format(Math.abs(value))}`;
}
