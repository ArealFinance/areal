<script lang="ts">
	/**
	 * Connected-state wallet chip.
	 *
	 * Sits in the fixed top-right strip. Click reveals a small dropdown
	 * with copy / explorer / disconnect actions. The dropdown closes on
	 * outside click, Escape, or after any action.
	 */
	import { onMount } from 'svelte';
	import { Wallet, Copy, ExternalLink, LogOut, Check, ChevronDown } from 'lucide-svelte';
	import { wallet } from '$lib/wallet/store';
	import { shortenAddress } from '$lib/utils/format';

	let open = $state(false);
	let copied = $state(false);
	let rootEl = $state<HTMLDivElement | null>(null);

	const address = $derived($wallet.address ?? '');
	const short = $derived(shortenAddress(address));

	function toggle(): void {
		open = !open;
	}

	function close(): void {
		open = false;
	}

	async function copyAddress(): Promise<void> {
		if (!address) return;
		try {
			await navigator.clipboard.writeText(address);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 1500);
		} catch {
			// Clipboard permission denied — ignore silently.
		}
	}

	function viewOnExplorer(): void {
		if (!address) return;
		window.open(`https://solscan.io/account/${address}`, '_blank', 'noopener,noreferrer');
		close();
	}

	async function disconnect(): Promise<void> {
		close();
		await wallet.disconnect();
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') close();
	}

	onMount(() => {
		const onDocClick = (e: MouseEvent) => {
			if (!rootEl) return;
			if (!rootEl.contains(e.target as Node)) close();
		};
		document.addEventListener('mousedown', onDocClick);
		return () => document.removeEventListener('mousedown', onDocClick);
	});
</script>

<div class="root" bind:this={rootEl} onkeydown={handleKeydown} role="presentation">
	<button
		class="pill"
		type="button"
		onclick={toggle}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Wallet menu"
	>
		<Wallet size={14} aria-hidden="true" />
		<span class="addr tabular">{short}</span>
		<ChevronDown size={14} aria-hidden="true" class={open ? 'rot' : ''} />
	</button>

	{#if open}
		<div class="menu" role="menu">
			<button class="item" type="button" role="menuitem" onclick={copyAddress}>
				{#if copied}
					<Check size={14} aria-hidden="true" />
					<span>Copied</span>
				{:else}
					<Copy size={14} aria-hidden="true" />
					<span>Copy address</span>
				{/if}
			</button>
			<button class="item" type="button" role="menuitem" onclick={viewOnExplorer}>
				<ExternalLink size={14} aria-hidden="true" />
				<span>View on explorer</span>
			</button>
			<div class="divider" role="separator"></div>
			<button class="item danger" type="button" role="menuitem" onclick={disconnect}>
				<LogOut size={14} aria-hidden="true" />
				<span>Disconnect</span>
			</button>
		</div>
	{/if}
</div>

<style>
	.root {
		position: relative;
		display: inline-block;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		background: var(--color-surface-inset);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-pill);
		color: var(--color-text-accent);
		font-size: var(--text-xs);
		font-weight: var(--font-weight-medium);
		transition: border-color var(--motion-fast) var(--ease-out);
	}

	.pill:hover {
		border-color: var(--color-primary);
	}

	.pill :global(.rot) {
		transform: rotate(180deg);
	}

	.addr {
		letter-spacing: 0;
	}

	.menu {
		position: absolute;
		top: calc(100% + 8px);
		right: 0;
		min-width: 200px;
		padding: var(--space-2);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-overlay);
		display: flex;
		flex-direction: column;
		gap: 2px;
		z-index: var(--z-dropdown);
	}

	.item {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		font-size: var(--text-sm);
		text-align: left;
		border-radius: var(--radius-xs);
		color: var(--color-text);
	}

	.item:hover {
		background: var(--color-hover-tint);
	}

	.item.danger {
		color: var(--color-danger);
	}

	.divider {
		height: 1px;
		background: var(--color-border);
		margin: var(--space-1) 0;
	}
</style>
