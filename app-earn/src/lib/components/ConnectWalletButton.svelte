<script lang="ts">
	/**
	 * Big primary CTA + wallet picker.
	 *
	 * Renders a single "Connect Wallet" button. Clicking it opens an
	 * overlay-style picker listing Phantom / Solflare / Backpack with an
	 * install link for any provider not detected in the browser.
	 */
	import { Wallet } from 'lucide-svelte';
	import { listProviders, type WalletProviderId } from '$lib/wallet/providers';
	import { wallet } from '$lib/wallet/store';

	let open = $state(false);
	let connecting = $state<WalletProviderId | null>(null);
	let errorMessage = $state<string | null>(null);

	const providers = $derived.by(() => listProviders());

	function openPicker(): void {
		open = true;
		errorMessage = null;
	}

	function closePicker(): void {
		if (connecting) return;
		open = false;
	}

	async function pick(id: WalletProviderId): Promise<void> {
		const info = providers.find((p) => p.id === id);
		if (!info) return;
		if (!info.installed) {
			// Defer to the install page rather than failing silently.
			window.open(info.installUrl, '_blank', 'noopener,noreferrer');
			return;
		}
		connecting = id;
		errorMessage = null;
		try {
			await wallet.connect(id);
			open = false;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Connection failed';
		} finally {
			connecting = null;
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') closePicker();
	}
</script>

<button class="cta" type="button" onclick={openPicker}>
	<Wallet size={18} aria-hidden="true" />
	Connect Wallet
</button>

{#if open}
	<div
		class="backdrop"
		role="presentation"
		onclick={closePicker}
		onkeydown={handleKeydown}
		tabindex="-1"
	>
		<div
			class="picker"
			role="dialog"
			aria-modal="true"
			aria-label="Select a wallet"
			tabindex="-1"
			onclick={(e) => e.stopPropagation()}
			onkeydown={handleKeydown}
		>
			<header>
				<h2>Connect a wallet</h2>
				<p>Choose your preferred Solana wallet.</p>
			</header>

			<ul class="list">
				{#each providers as p (p.id)}
					<li>
						<button
							class="row"
							type="button"
							onclick={() => pick(p.id)}
							disabled={connecting !== null && connecting !== p.id}
						>
							<span class="row-icon" aria-hidden="true">
								<Wallet size={18} />
							</span>
							<span class="row-name">{p.name}</span>
							<span class="row-state">
								{#if connecting === p.id}
									Connecting…
								{:else if p.installed}
									Detected
								{:else}
									Install ↗
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>

			{#if errorMessage}
				<p class="error">{errorMessage}</p>
			{/if}

			<button class="close" type="button" onclick={closePicker}>Cancel</button>
		</div>
	</div>
{/if}

<style>
	.cta {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		width: 100%;
		height: var(--btn-height);
		padding: 0 var(--space-6);
		font-size: var(--text-base);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		color: var(--color-text);
		background: linear-gradient(
			135deg,
			var(--color-primary-gradient-from),
			var(--color-primary-gradient-to)
		);
		border-radius: var(--radius-button);
		box-shadow: var(--glow-purple);
		transition: transform var(--motion-fast) var(--ease-out), filter var(--motion-fast) var(--ease-out);
	}

	.cta:hover {
		filter: brightness(1.06);
	}

	.cta:active {
		transform: scale(0.99);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-modal-backdrop);
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		display: grid;
		place-items: center;
		padding: var(--space-4);
	}

	.picker {
		position: relative;
		z-index: var(--z-modal);
		width: 100%;
		max-width: 360px;
		padding: var(--space-6);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-overlay);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	header h2 {
		font-size: var(--text-xl);
		font-weight: var(--font-weight-semibold);
	}

	header p {
		margin-top: var(--space-1);
		color: var(--color-text-muted);
		font-size: var(--text-sm);
	}

	.list {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface-inset);
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		transition: border-color var(--motion-fast) var(--ease-out),
			background var(--motion-fast) var(--ease-out);
	}

	.row:hover:not(:disabled) {
		border-color: var(--color-primary);
		background: var(--color-hover-tint);
	}

	.row-icon {
		display: grid;
		place-items: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-sm);
		background: var(--color-surface);
		color: var(--color-primary);
	}

	.row-name {
		flex: 1;
		text-align: left;
		font-weight: var(--font-weight-medium);
	}

	.row-state {
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.error {
		color: var(--color-danger);
		font-size: var(--text-sm);
		margin: 0;
	}

	.close {
		align-self: center;
		padding: var(--space-2) var(--space-4);
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.close:hover {
		color: var(--color-text);
	}
</style>
