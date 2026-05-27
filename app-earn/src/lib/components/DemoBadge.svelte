<script lang="ts">
	/**
	 * Persistent "Demo data" badge.
	 *
	 * Sits in the top-right corner. When the wallet pill is also visible
	 * (connected state), the pill renders to the right of this badge and
	 * the badge slides slightly left — both share the same fixed strip.
	 */
</script>

<span
	class="demo-badge"
	title="NAV and APR are mocked. Mint functionality is not connected to a live contract."
	aria-label="Demo data — values shown are mocked"
>
	<span class="dot" aria-hidden="true"></span>
	Demo data
</span>

<style>
	.demo-badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: 6px var(--space-3);
		font-size: var(--text-2xs);
		font-weight: var(--font-weight-medium);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-warning);
		background: var(--color-warning-tint);
		border: 1px solid rgba(255, 140, 0, 0.3);
		border-radius: var(--radius-pill);
		cursor: help;
		white-space: nowrap;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-warning);
		box-shadow: var(--glow-orange);
	}
</style>
