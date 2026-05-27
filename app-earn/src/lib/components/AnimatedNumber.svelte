<script lang="ts">
	/**
	 * Smooth count-up display for a numeric value.
	 *
	 * Lifted (and trimmed) from the main app's AnimatedNumber. Same
	 * tabular-nums trick to prevent layout jitter while the value tweens.
	 *
	 * Default is `linear` over 1500 ms — pair the duration with the
	 * upstream poll interval for a constant-velocity tick feel. Use
	 * `easeOutCubic` for one-shot updates (e.g. wallet-balance snap).
	 */
	import { onDestroy, untrack } from 'svelte';

	type Easing = 'linear' | 'easeOutCubic';

	interface Props {
		value: number;
		decimals?: number;
		durationMs?: number;
		easing?: Easing;
	}

	let { value, decimals = 4, durationMs = 1500, easing = 'linear' }: Props = $props();

	let displayed = $state(untrack(() => value));
	let firstRun = $state(untrack(() => value === 0));
	let raf: number | null = null;

	const EASING_FNS: Record<Easing, (t: number) => number> = {
		linear: (t) => t,
		easeOutCubic: (t) => 1 - Math.pow(1 - t, 3)
	};

	$effect(() => {
		const target = value;

		if (firstRun) {
			if (target === 0) {
				displayed = 0;
				return;
			}
			firstRun = false;
			displayed = target;
			return;
		}

		const start = displayed;
		if (target === start) return;

		const startTime = performance.now();
		const ease = EASING_FNS[easing];
		const tick = (now: number) => {
			const elapsed = now - startTime;
			const t = Math.min(elapsed / durationMs, 1);
			displayed = start + (target - start) * ease(t);
			if (t < 1) {
				raf = requestAnimationFrame(tick);
			} else {
				raf = null;
			}
		};
		if (raf !== null) cancelAnimationFrame(raf);
		raf = requestAnimationFrame(tick);

		return () => {
			if (raf !== null) {
				cancelAnimationFrame(raf);
				raf = null;
			}
		};
	});

	onDestroy(() => {
		if (raf !== null) {
			cancelAnimationFrame(raf);
			raf = null;
		}
	});

	const formatted = $derived(
		displayed.toLocaleString('en-US', {
			minimumFractionDigits: decimals,
			maximumFractionDigits: decimals
		})
	);
</script>

<span class="num">{formatted}</span>

<style>
	.num {
		font-variant-numeric: tabular-nums;
		font-feature-settings: 'tnum' 1;
	}
</style>
