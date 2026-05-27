<script lang="ts">
	/**
	 * The center card.
	 *
	 *   - hasRwt === false: USDC + RWT balance + "Mint RWT" CTA.
	 *   - hasRwt === true : RWT value + USD value + P&L + sparkline +
	 *                       "Mint more" / "Sell on DEX" pair.
	 */
	import { ExternalLink } from 'lucide-svelte';
	import AnimatedNumber from './AnimatedNumber.svelte';
	import NavSparkline from './NavSparkline.svelte';
	import { formatApr, formatNav, formatPctDelta, formatUsd, formatUsdDelta, formatUsdc } from '$lib/utils/format';
	import type { NavPoint } from '$lib/earn/types';

	interface Props {
		hasRwt: boolean;
		usdc: number;
		rwt: number;
		nav: number;
		apr: number;
		costBasisUsd: number;
		navDeltaDay: number;
		history: NavPoint[];
		onMint: () => void;
	}

	let {
		hasRwt,
		usdc,
		rwt,
		nav,
		apr,
		costBasisUsd,
		navDeltaDay,
		history,
		onMint
	}: Props = $props();

	const rwtUsdValue = $derived(rwt * nav);
	const pnlUsd = $derived(rwtUsdValue - costBasisUsd);
	const pnlPct = $derived(costBasisUsd > 0 ? pnlUsd / costBasisUsd : 0);
</script>

<section class="card" aria-label="Your balance">
	{#if hasRwt}
		<div class="block">
			<span class="label">Your RWT</span>
			<span class="value-lg tabular">
				<AnimatedNumber value={rwt} decimals={6} durationMs={2000} />
			</span>
			<span class="value-sub tabular">≈ {formatUsd(rwtUsdValue)}</span>
			{#if costBasisUsd > 0}
				<span class="pnl tabular" class:positive={pnlUsd >= 0} class:negative={pnlUsd < 0}>
					{formatUsdDelta(pnlUsd)} ({formatPctDelta(pnlPct)}) since first mint
				</span>
			{/if}
		</div>

		<div class="meta tabular">
			NAV {formatNav(nav)}
			<span class="meta-delta" class:positive={navDeltaDay >= 0}>
				({formatPctDelta(navDeltaDay)} today)
			</span>
			· APR {formatApr(apr)}
		</div>

		<NavSparkline points={history} />

		<div class="actions">
			<button class="btn btn-primary" type="button" onclick={onMint}>Mint more</button>
			<a
				class="btn btn-secondary"
				href="https://areal.finance/markets/rwt"
				target="_blank"
				rel="noopener noreferrer"
			>
				Sell on DEX
				<ExternalLink size={14} aria-hidden="true" />
			</a>
		</div>
	{:else}
		<div class="block">
			<span class="label">Your USDC</span>
			<span class="value-lg tabular">{formatUsdc(usdc)}</span>
		</div>

		<div class="block">
			<span class="label">Your RWT</span>
			<span class="value-lg tabular">0</span>
		</div>

		<div class="meta tabular">
			NAV {formatNav(nav)} · APR {formatApr(apr)}
		</div>

		<button class="btn btn-primary full" type="button" onclick={onMint} disabled={usdc <= 0}>
			Mint RWT
		</button>

		<p class="hint">
			Each $100 mints ~{((100 * 0.9) / nav).toFixed(0)} RWT (10% protocol fee builds liquidity reserve)
		</p>
	{/if}
</section>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
		padding: var(--space-6);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-card);
		width: 100%;
	}

	.block {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}

	.label {
		font-size: var(--text-2xs);
		font-weight: var(--font-weight-medium);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.value-lg {
		font-family: var(--font-numeric);
		font-size: var(--text-2xl);
		font-weight: var(--font-weight-semibold);
		line-height: var(--leading-tight);
		color: var(--color-text);
	}

	.value-sub {
		font-family: var(--font-numeric);
		font-size: var(--text-base);
		color: var(--color-text-muted);
		margin-top: var(--space-1);
	}

	.pnl {
		display: inline-block;
		margin-top: var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--font-weight-medium);
	}

	.pnl.positive {
		color: var(--color-success);
	}

	.pnl.negative {
		color: var(--color-danger);
	}

	.meta {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.meta-delta {
		color: var(--color-text-muted);
	}

	.meta-delta.positive {
		color: var(--color-success);
	}

	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: var(--btn-height);
		padding: 0 var(--space-5);
		font-size: var(--text-base);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		border-radius: var(--radius-button);
		transition: filter var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out);
	}

	.btn.full {
		width: 100%;
	}

	.btn-primary {
		color: var(--color-text);
		background: linear-gradient(
			135deg,
			var(--color-primary-gradient-from),
			var(--color-primary-gradient-to)
		);
		box-shadow: var(--glow-purple);
	}

	.btn-primary:hover:not(:disabled) {
		filter: brightness(1.06);
	}

	.btn-secondary {
		color: var(--color-text);
		background: var(--color-surface-inset);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover {
		border-color: var(--color-primary);
		text-decoration: none;
	}

	.btn:active {
		transform: scale(0.99);
	}

	.hint {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
		text-align: center;
	}
</style>
