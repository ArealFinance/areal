<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		MOCK_APR_30D,
		MOCK_INITIAL_NAV,
		MOCK_TOTAL_BACKING,
		generateNavHistory,
		simulateLiveNav
	} from '$lib/earn/mock';
	import { wallet } from '$lib/wallet/store';
	import HeroStats from '$lib/components/HeroStats.svelte';
	import BalanceCard from '$lib/components/BalanceCard.svelte';
	import ConnectWalletButton from '$lib/components/ConnectWalletButton.svelte';
	import WalletPill from '$lib/components/WalletPill.svelte';
	import MintModal from '$lib/components/MintModal.svelte';
	import DemoBadge from '$lib/components/DemoBadge.svelte';

	// Live-ish NAV — ticks ~once a second via the mock simulator.
	let nav = $state(MOCK_INITIAL_NAV);
	const history = generateNavHistory(30);
	const apr = MOCK_APR_30D;
	const totalBacking = MOCK_TOTAL_BACKING;

	// NAV delta over the last 24h, computed from the synthesized history.
	const navDeltaDay = $derived.by(() => {
		if (history.length < 2) return 0;
		const last = history[history.length - 1].nav;
		const prev = history[history.length - 2].nav;
		return prev > 0 ? (last - prev) / prev : 0;
	});

	let mintOpen = $state(false);
	let interval: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		interval = setInterval(() => {
			nav = simulateLiveNav();
		}, 1500);
	});

	onDestroy(() => {
		if (interval) clearInterval(interval);
	});

	function openMint(): void {
		mintOpen = true;
	}

	function closeMint(): void {
		mintOpen = false;
	}

	// Derive UI states from the wallet store.
	const connected = $derived($wallet.connected);
	const usdc = $derived($wallet.usdc);
	const rwt = $derived($wallet.rwt);
	const hasRwt = $derived(rwt > 0);
	const costBasisUsd = $derived(rwt > 0 ? rwt * 1.0 : 0);
</script>

<header class="top-strip">
	<a class="brand" href="/" aria-label="Areal Earn">
		<span class="brand-mark" aria-hidden="true">◆</span>
		<span class="brand-text">Areal Earn</span>
	</a>
	<div class="top-right">
		<DemoBadge />
		{#if connected}
			<WalletPill />
		{/if}
	</div>
</header>

<main class="page">
	<div class="container">
		{#if !connected}
			<section class="hero">
				<h1 class="hero-title">Earn yield on RWT</h1>
				<p class="hero-sub">
					Real-world asset–backed token. NAV grows automatically. Sell anytime on the DEX.
				</p>
			</section>

			<HeroStats {nav} {apr} {totalBacking} />

			<div class="cta-wrap">
				<ConnectWalletButton />
				<p class="cta-disclaimer">By connecting, you agree to terms (demo).</p>
			</div>
		{:else}
			<BalanceCard
				{hasRwt}
				{usdc}
				{rwt}
				{nav}
				{apr}
				{costBasisUsd}
				{navDeltaDay}
				history={history}
				onMint={openMint}
			/>

			{#if !hasRwt}
				<HeroStats {nav} {apr} {totalBacking} />
			{/if}
		{/if}
	</div>

	<footer class="footer">
		<p>
			Powered by
			<a href="https://areal.finance" target="_blank" rel="noopener noreferrer">Areal Finance</a>
		</p>
	</footer>
</main>

<MintModal {nav} open={mintOpen} onClose={closeMint} />

<style>
	.top-strip {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: var(--z-sticky);
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-4) var(--space-4);
		pointer-events: none;
	}

	.brand,
	.top-right {
		pointer-events: auto;
	}

	.brand {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		color: var(--color-text);
		text-decoration: none;
	}

	.brand:hover {
		text-decoration: none;
	}

	.brand-mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		font-size: var(--text-md);
		color: var(--color-primary);
		background: rgba(158, 96, 246, 0.12);
		border: 1px solid rgba(158, 96, 246, 0.3);
		border-radius: var(--radius-sm);
	}

	.top-right {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

	.page {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
		min-height: 100dvh;
		padding: 80px var(--space-4) var(--space-8);
	}

	.container {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: center;
		gap: var(--space-6);
		width: 100%;
		max-width: 440px;
		margin: 0 auto;
	}

	.hero {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		text-align: center;
		padding: var(--space-4) 0;
	}

	.hero-title {
		font-family: var(--font-sans);
		font-size: var(--text-3xl);
		font-weight: var(--font-weight-bold);
		line-height: var(--leading-tight);
		letter-spacing: var(--tracking-display);
		color: var(--color-text);
	}

	.hero-sub {
		max-width: 380px;
		color: var(--color-text-muted);
		font-size: var(--text-base);
		line-height: var(--leading-normal);
	}

	.cta-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
	}

	.cta-disclaimer {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}

	.footer {
		display: flex;
		justify-content: center;
		padding: var(--space-6) 0 0;
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}

	.footer a {
		color: var(--color-text-muted);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.footer a:hover {
		color: var(--color-text);
	}

	@media (min-width: 768px) {
		.container {
			max-width: 520px;
			gap: var(--space-8);
		}

		.hero-title {
			font-size: var(--text-4xl);
		}

		.top-strip {
			padding: var(--space-5) var(--space-6);
		}

		.page {
			padding: 100px var(--space-6) var(--space-12);
		}
	}
</style>
