// WHAT HAPPENED TO EACH UNKNOWN CONTAINER, so the import report can say it (item 163c).
//
// A container either keeps its wrapper (layout preserved, edited as one HTML block) or keeps today's flattening (children stay
// editable, layout lost). Both are legitimate outcomes and the operator needs the counts, because "my sections collapsed" and
// "my sections collapsed and the tool told me why" are different products.
//
// Module-level rather than threaded through the transformer context: the fallback transformer is a pure function with a fixed
// signature, and adding a report channel to it would change the public type for one caller's bookkeeping.

const kept = new Map<string, number>();
const flat = new Map<string, number>();

/** One container kept its wrapper, with its layout. `plugin` is the block name, e.g. `uagb/container`. */
export function noteKeptContainer(plugin: string | null): void {
	const key = plugin ?? "unknown";
	kept.set(key, (kept.get(key) ?? 0) + 1);
}

/** One container kept today's flattening: its descendants were not all static saved HTML. */
export function noteFlatContainer(plugin: string | null): void {
	const key = plugin ?? "unknown";
	flat.set(key, (flat.get(key) ?? 0) + 1);
}

export interface ContainerReport {
	/** Containers whose wrapper was kept, by block name. */
	kept: Array<{ plugin: string; count: number }>;
	/** Containers whose children were kept and whose wrapper was dropped, by block name. */
	flat: Array<{ plugin: string; count: number }>;
}

/** Read and RESET the counts, so one import's numbers cannot leak into the next run's report. */
export function takeContainerReport(): ContainerReport {
	const out: ContainerReport = {
		kept: Array.from(kept, ([plugin, count]) => ({ plugin, count })).toSorted(
			(a, b) => b.count - a.count,
		),
		flat: Array.from(flat, ([plugin, count]) => ({ plugin, count })).toSorted(
			(a, b) => b.count - a.count,
		),
	};
	kept.clear();
	flat.clear();
	return out;
}

/**
 * The two lines an operator reads.
 *
 * Deliberately two lines and not one: "layout kept" and "layout lost" are opposite outcomes, and a single total would hide which
 * sections fell on which side.
 */
export function containerReportLines(report: ContainerReport): string[] {
	const lines: string[] = [];
	const keptTotal = report.kept.reduce((n, k) => n + k.count, 0);
	const flatTotal = report.flat.reduce((n, k) => n + k.count, 0);
	if (keptTotal > 0) {
		const plugins = report.kept.map((k) => k.plugin).join(", ");
		lines.push(
			`${keptTotal} section(s) from ${plugins} kept as HTML blocks: layout kept, edited as HTML`,
		);
	}
	if (flatTotal > 0) {
		const plugins = report.flat.map((k) => k.plugin).join(", ");
		lines.push(
			`${flatTotal} section(s) kept flat: they contain a shortcode or a block that saves no markup (${plugins})`,
		);
	}
	return lines;
}
