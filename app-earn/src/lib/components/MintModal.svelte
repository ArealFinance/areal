<script lang="ts">
	/**
	 * Mint flow modal.
	 *
	 * V1 is mock-only: validate input, show a live quote, simulate a 2 s
	 * "tx" delay, flash a success state, then auto-close. No real tx is
	 * submitted — the demo notice at the bottom of the card makes that
	 * explicit.
	 */
	import { onMount } from 'svelte';
	import { X, CheckCircle2 } from 'lucide-svelte';
	import { mockMintQuote } from '$lib/earn/mock';
	import { formatRwt, formatUsd, formatNav } from '$lib/utils/format';
	import { wallet } from '$lib/wallet/store';

	interface Props {
		nav: number;
		open: boolean;
		onClose: () => void;
	}

	let { nav, open, onClose }: Props = $props();

	type Status = 'idle' | 'submitting' | 'success';

	let amountInput = $state('');
	let status = $state<Status>('idle');
	let dialogEl = $state<HTMLDivElement | null>(null);

	const amount = $derived.by(() => {
		const n = Number(amountInput);
		return Number.isFinite(n) && n > 0 ? n : 0;
	});

	const usdc = $derived($wallet.usdc);
	const quote = $derived(mockMintQuote(amount, nav));
	const overBalance = $derived(amount > usdc);
	const canSubmit = $derived(amount > 0 && !overBalance && status === 'idle');

	function reset(): void {
		amountInput = '';
		status = 'idle';
	}

	function close(): void {
		if (status === 'submitting') return;
		reset();
		onClose();
	}

	function setMax(): void {
		// Trim to 2 decimals — USDC has 6 on-chain, but for input UX, cents.
		amountInput = usdc > 0 ? usdc.toFixed(2) : '';
	}

	async function confirmMint(): Promise<void> {
		if (!canSubmit) return;
		status = 'submitting';
		// Mock tx delay
		await new Promise((r) => setTimeout(r, 2000));
		wallet.mockSpendUsdc(amount, quote.rwtOut);
		status = 'success';
		setTimeout(() => {
			close();
		}, 1500);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') close();
	}

	function handleInput(event: Event): void {
		const target = event.target as HTMLInputElement;
		// Only allow digits + a single dot.
		const cleaned = target.value.replace(/[^0-9.]/g, '');
		const firstDot = cleaned.indexOf('.');
		amountInput =
			firstDot === -1
				? cleaned
				: cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
	}

	$effect(() => {
		if (open) {
			// Focus the input when opening so users can start typing immediately.
			queueMicrotask(() => {
				const input = dialogEl?.querySelector<HTMLInputElement>('input[name="amount"]');
				input?.focus();
			});
		}
	});

	onMount(() => {
		// Prevent body scroll while modal is open.
		const update = () => {
			document.body.style.overflow = open ? 'hidden' : '';
		};
		update();
		return () => {
			document.body.style.overflow = '';
		};
	});

	$effect(() => {
		document.body.style.overflow = open ? 'hidden' : '';
	});
</script>

{#if open}
	<div
		class="backdrop"
		role="presentation"
		onclick={close}
		onkeydown={handleKeydown}
		tabindex="-1"
	>
		<div
			class="modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="mint-title"
			tabindex="-1"
			bind:this={dialogEl}
			onclick={(e) => e.stopPropagation()}
			onkeydown={handleKeydown}
		>
			<header>
				<h2 id="mint-title">Mint RWT</h2>
				<button class="close" type="button" onclick={close} aria-label="Close" disabled={status === 'submitting'}>
					<X size={18} aria-hidden="true" />
				</button>
			</header>

			{#if status === 'success'}
				<div class="success">
					<CheckCircle2 size={48} aria-hidden="true" />
					<p class="success-title">Minted {formatRwt(quote.rwtOut, 6)} RWT</p>
					<p class="success-sub">Demo mode — no real tx submitted</p>
				</div>
			{:else}
				<div class="input-row">
					<label class="input-label" for="mint-amount">Amount</label>
					<div class="input-wrap">
						<input
							id="mint-amount"
							name="amount"
							type="text"
							inputmode="decimal"
							autocomplete="off"
							placeholder="0.00"
							value={amountInput}
							oninput={handleInput}
							disabled={status === 'submitting'}
							class="tabular"
						/>
						<span class="symbol">USDC</span>
						<button
							class="max-btn"
							type="button"
							onclick={setMax}
							disabled={status === 'submitting' || usdc <= 0}
						>
							Max
						</button>
					</div>
					<p class="balance tabular">
						Balance: {usdc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC
					</p>
					{#if overBalance}
						<p class="error">Amount exceeds balance</p>
					{/if}
				</div>

				<div class="preview">
					<div class="preview-row">
						<span>Mint fee (10%)</span>
						<span class="tabular">−{formatUsd(quote.feeUsdc)}</span>
					</div>
					<div class="preview-row">
						<span>NAV</span>
						<span class="tabular">{formatNav(quote.navUsed)}</span>
					</div>
					<div class="preview-row total">
						<span>You receive</span>
						<span class="tabular">{formatRwt(quote.rwtOut, 4)} RWT</span>
					</div>
				</div>

				<div class="actions">
					<button class="btn btn-ghost" type="button" onclick={close} disabled={status === 'submitting'}>
						Cancel
					</button>
					<button
						class="btn btn-primary"
						type="button"
						onclick={confirmMint}
						disabled={!canSubmit}
					>
						{#if status === 'submitting'}
							Confirming…
						{:else}
							Confirm Mint
						{/if}
					</button>
				</div>

				<p class="demo-notice">Demo mode — no real tx submitted</p>
			{/if}
		</div>
	</div>
{/if}

<style>
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

	.modal {
		position: relative;
		z-index: var(--z-modal);
		width: 100%;
		max-width: 420px;
		padding: var(--space-6);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-card);
		box-shadow: var(--shadow-overlay);
		display: flex;
		flex-direction: column;
		gap: var(--space-4);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	h2 {
		font-size: var(--text-xl);
		font-weight: var(--font-weight-semibold);
	}

	.close {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-sm);
		color: var(--color-text-muted);
	}

	.close:hover:not(:disabled) {
		color: var(--color-text);
		background: var(--color-hover-tint);
	}

	.input-row {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.input-label {
		font-size: var(--text-2xs);
		font-weight: var(--font-weight-medium);
		letter-spacing: var(--tracking-wide);
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.input-wrap {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface-inset);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-md);
		transition: border-color var(--motion-fast) var(--ease-out);
	}

	.input-wrap:focus-within {
		border-color: var(--color-primary);
	}

	input {
		flex: 1;
		width: 100%;
		min-width: 0;
		font-family: var(--font-numeric);
		font-size: var(--text-xl);
		font-weight: var(--font-weight-semibold);
		background: transparent;
		border: 0;
		outline: 0;
		padding: 0;
		color: var(--color-text);
	}

	input::placeholder {
		color: var(--color-text-muted);
	}

	.symbol {
		font-size: var(--text-sm);
		font-weight: var(--font-weight-medium);
		color: var(--color-text-muted);
	}

	.max-btn {
		padding: 4px var(--space-2);
		font-size: var(--text-xs);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-wide);
		color: var(--color-primary);
		background: rgba(158, 96, 246, 0.12);
		border-radius: var(--radius-xs);
	}

	.max-btn:hover:not(:disabled) {
		background: rgba(158, 96, 246, 0.2);
	}

	.balance {
		font-size: var(--text-xs);
		color: var(--color-text-muted);
	}

	.error {
		font-size: var(--text-xs);
		color: var(--color-danger);
	}

	.preview {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		background: var(--color-surface-inset);
		border-radius: var(--radius-md);
	}

	.preview-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: var(--text-sm);
		color: var(--color-text-muted);
	}

	.preview-row.total {
		margin-top: var(--space-1);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-border);
		color: var(--color-text);
		font-weight: var(--font-weight-semibold);
		font-size: var(--text-base);
	}

	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
	}

	.btn {
		height: var(--btn-height);
		padding: 0 var(--space-5);
		font-size: var(--text-base);
		font-weight: var(--font-weight-semibold);
		letter-spacing: var(--tracking-tight);
		border-radius: var(--radius-button);
		transition: filter var(--motion-fast) var(--ease-out);
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

	.btn-ghost {
		color: var(--color-text);
		background: var(--color-surface-inset);
		border: 1px solid var(--color-border);
	}

	.btn-ghost:hover:not(:disabled) {
		border-color: var(--color-primary);
	}

	.demo-notice {
		text-align: center;
		font-size: var(--text-xs);
		color: var(--color-warning);
	}

	.success {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-6) 0;
		color: var(--color-success);
	}

	.success-title {
		font-family: var(--font-numeric);
		font-size: var(--text-xl);
		font-weight: var(--font-weight-semibold);
		color: var(--color-text);
		margin-top: var(--space-2);
	}

	.success-sub {
		font-size: var(--text-xs);
		color: var(--color-warning);
	}
</style>
