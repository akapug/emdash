// WHAT HAPPENED TO EACH UNKNOWN CONTAINER, counted FROM THE OUTPUT (item 163c).
//
// A container either keeps its wrapper — one `htmlBlock` carrying `originalBlockName`, layout preserved, edited as one HTML block —
// or keeps today's flattening: its children become their own blocks and the wrapper is gone. Both are legitimate outcomes and the
// operator needs the counts, because "my sections collapsed" and "my sections collapsed and the tool told me why" are different
// products.
//
// COUNTED FROM THE CONVERTED BLOCKS, NOT FROM MODULE STATE. The first version of this module kept module-level counters; review found
// they had no caller, would accumulate in a long-lived isolate, and would mix two imports converting at once. Deriving the counts from
// the output removes all three problems: the blocks are already the answer, so there is nothing to keep in step.

import type { PortableTextBlock } from "./types.js";

/**
 * The containers the converter KEPT, by plugin, from the blocks it produced.
 *
 * `originalBlockName` is only set by the container path, and only for an unknown container that qualified — so the presence of this
 * field is the signal, and no separate bookkeeping can drift from it.
 */
export function keptContainersIn(
	blocks: readonly PortableTextBlock[],
): Array<{ plugin: string; count: number }> {
	const counts = new Map<string, number>();
	for (const block of blocks) {
		if (block._type !== "htmlBlock") continue;
		// No assertion: the htmlBlock member of the union carries `originalBlockName` itself, so narrowing by `_type` is enough.
		const plugin = block.originalBlockName;
		if (!plugin) continue;
		counts.set(plugin, (counts.get(plugin) ?? 0) + 1);
	}
	return Array.from(counts, ([plugin, count]) => ({ plugin, count })).toSorted(
		(a, b) => b.count - a.count,
	);
}

/**
 * The two lines an operator reads.
 *
 * Deliberately two lines and not one: "layout kept" and "layout lost" are opposite outcomes, and a single total would hide which
 * sections fell on which side. `flat` comes from the caller, which knows how many unknown containers the document held — the blocks
 * cannot report the ones that were flattened, because flattening leaves no trace of the wrapper.
 */
export function containerReportLines(
	kept: Array<{ plugin: string; count: number }>,
	flat: number,
): string[] {
	const lines: string[] = [];
	const keptTotal = kept.reduce((n, k) => n + k.count, 0);
	if (keptTotal > 0) {
		const plugins = kept.map((k) => k.plugin).join(", ");
		lines.push(
			`${keptTotal} section(s) from ${plugins} kept as HTML blocks: layout kept, edited as HTML`,
		);
	}
	if (flat > 0) {
		lines.push(
			`${flat} section(s) kept flat: they contain a shortcode or a block that saves no markup`,
		);
	}
	return lines;
}
