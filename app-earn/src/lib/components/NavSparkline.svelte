<script lang="ts">
	/**
	 * Tiny inline SVG sparkline for the 30-day NAV curve.
	 * Pure SVG path math — no chart library, no dependencies.
	 *
	 * Y-axis is auto-scaled to the min/max of the data so the gentle slope
	 * remains visible. A soft area fill underneath gives it weight.
	 */
	import type { NavPoint } from '$lib/earn/types';

	interface Props {
		points: NavPoint[];
		width?: number;
		height?: number;
	}

	let { points, width = 480, height = 60 }: Props = $props();

	const padding = 2;

	const path = $derived.by(() => {
		if (points.length < 2) return { line: '', area: '' };

		const navs = points.map((p) => p.nav);
		const min = Math.min(...navs);
		const max = Math.max(...navs);
		const range = max - min || 1;

		const xStep = (width - padding * 2) / (points.length - 1);

		const coords = points.map((p, i) => {
			const x = padding + i * xStep;
			const y = padding + (1 - (p.nav - min) / range) * (height - padding * 2);
			return { x, y };
		});

		const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ');
		const area = `${line} L ${coords[coords.length - 1].x.toFixed(2)} ${height} L ${coords[0].x.toFixed(2)} ${height} Z`;

		return { line, area };
	});
</script>

<svg
	class="spark"
	viewBox={`0 0 ${width} ${height}`}
	preserveAspectRatio="none"
	role="img"
	aria-label="30-day NAV history"
>
	<defs>
		<linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="var(--color-success)" stop-opacity="0.25" />
			<stop offset="100%" stop-color="var(--color-success)" stop-opacity="0" />
		</linearGradient>
	</defs>
	<path d={path.area} fill="url(#spark-fill)" />
	<path
		d={path.line}
		fill="none"
		stroke="var(--color-success)"
		stroke-width="1.5"
		stroke-linejoin="round"
		stroke-linecap="round"
	/>
</svg>

<style>
	.spark {
		display: block;
		width: 100%;
		height: 60px;
	}
</style>
