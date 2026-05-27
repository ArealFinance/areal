<script lang="ts">
	/**
	 * Three-card hero strip: NAV / APR / Total backing.
	 * Stacks on mobile, row on desktop.
	 *
	 * NAV is rendered through AnimatedNumber so the live "drift" reads
	 * as a softly ticking value rather than a snap.
	 */
	import AnimatedNumber from './AnimatedNumber.svelte';
	import { formatApr, formatUsdCompact } from '$lib/utils/format';

	interface Props {
		nav: number;
		apr: number;
		totalBacking: number;
	}

	let { nav, apr, totalBacking }: Props = $props();
</script>

<section class="hero-stats" aria-label="Earn product stats">
	<article class="stat">
		<span class="label">NAV</span>
		<span class="value tabular">
			$<AnimatedNumber value={nav} decimals={4} durationMs={1500} />
		</span>
	</article>

	<article class="stat">
		<span class="label">30-day APR</span>
		<span class="value tabular">{formatApr(apr)}</span>
	</article>

	<article class="stat">
		<span class="label">Total backing</span>
		<span class="value tabular">{formatUsdCompact(totalBacking)}</span>
	</article>
</section>

<style>
	.hero-stats {
		display: grid;
		grid-template-columns: 1fr;
		gap: var(--space-3);
		width: 100%;
	}

	.stat {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-4);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}

	.label {
		font-size: var(--text-2xs);
		font-weight: var(--font-weight-medium);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.value {
		font-family: var(--font-numeric);
		font-size: var(--text-xl);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
	}

	@media (min-width: 480px) {
		.hero-stats {
			grid-template-columns: repeat(3, 1fr);
		}
	}
</style>
