// AN UNKNOWN CONTAINER THAT SAVES NOTHING BUT ITS OWN TAG (item 163c).
//
// A page-builder plugin — Spectra (`uagb/container`), and Kadence or GenerateBlocks the same way — puts its entire layout system in
// classes on a wrapper element, and generates a per-instance class (`uagb-block-a11f6d7d`) that exists in no attr and in no CSS of
// ours. The fallback transformer dropped that wrapper and kept only the children, so the plugin's CSS lost its subject and every
// grid or flex rule collapsed: measured on twpe (Astra + Spectra), 21 containers across Home/About/Contact.
//
// The wrapper cannot be recovered from `innerHTML` ALONE, and that is the trap this module exists to avoid. MEASURED on a real twpe
// container: `innerHTML` is 176 characters — the opening `<div class="wp-block-uagb-container uagb-block-a11f6d7d alignfull
// uagb-is-root-container">` and nothing else. WordPress's parser keeps each child block's markup in the CHILD's own `innerHTML` and
// leaves a `null` placeholder in the parent's `innerContent`. Emitting the parent's `innerHTML` would therefore produce an EMPTY
// wrapper with the right class — which looks fixed and is worse than flattening.
//
// So the markup is ASSEMBLED: walk `innerContent`, and for each `null` splice in the next child's own assembly. A leaf's assembly
// is its `innerHTML`; a nested container's is recursive.
//
// AND ONLY WHEN EVERY DESCENDANT IS STATIC SAVED HTML. Two classes of descendant make the assembly a LIE rather than a fix:
//   * `core/shortcode` — its real output is generated at render, so its saved text (`[shortcode]`) would become visible prose.
//   * a self-closing block (`uagb/icon`, `srfm/input`) — it saves NO markup at all, so the assembled wrapper would have a real hole
//     where that block should be: the box right, the contents missing.
// MEASURED on twpe's 21: 10 qualify, 5 hold a shortcode, 6 hold a markup-less block. The rest keep today's flattening and are named
// in the import report. Rendering those is items 163g (self-closing from attrs) and 163h (shortcode through the shortcode stage).

import type { GutenbergBlock } from "./types.js";

/**
 * Core blocks whose real output is NOT their saved `innerHTML` — generated at render from attrs or from the site's data.
 *
 * A section holding one of these cannot be kept as saved markup: the markup would show the block's source text instead of its
 * output. Kept as a list rather than inferred, because the failure is silent: the page renders, and reads wrong.
 */
const DYNAMIC_CORE_BLOCKS = new Set([
	"shortcode",
	"latest-posts",
	"latest-comments",
	"archives",
	"categories",
	"calendar",
	"rss",
	"tag-cloud",
	"search",
	"query",
	"post-template",
	"post-title",
	"post-excerpt",
	"post-featured-image",
	"post-date",
	"post-author",
	"post-terms",
	"post-content",
	"query-pagination",
	"query-no-results",
	"navigation",
	"loginout",
	"widget-group",
	"template-part",
	"block",
	"home",
	"read-more",
	"comments",
	"comment-form",
]);

/** WordPress serialises core blocks bare (`wp:columns`) and plugin blocks namespaced (`wp:uagb/container`). */
function qualifiedName(blockName: string | null): string {
	if (!blockName) return "";
	return blockName.includes("/") ? blockName : `core/${blockName}`;
}

/** Whether this block saves markup at all. A self-closing block's `innerHTML` is empty by construction. */
function savesMarkup(block: GutenbergBlock): boolean {
	return block.innerHTML.trim().length > 0 || block.innerBlocks.length > 0;
}

/**
 * Every descendant is static saved HTML — or a childless block that saves no markup at all (item 163d).
 *
 * Flat or kept, a descendant block that saves no markup is lost either way, so keeping the enclosing
 * wrapper is strictly better while counting and naming every dropped no-markup block for the report.
 * Shortcodes and dynamic core blocks still disqualify the container so raw `[shortcode]` text never
 * leaks into an assembled HTML block.
 *
 * `depth` guards the recursion: a pathological or cyclic export must not assemble without bound.
 */
export function allDescendantsAreStaticSavedHtml(block: GutenbergBlock, depth = 0): boolean {
	if (depth > 8) return false;
	for (const child of block.innerBlocks) {
		const name = qualifiedName(child.blockName);
		if (name === "core/shortcode") return false;
		if (name.startsWith("core/") && DYNAMIC_CORE_BLOCKS.has(name.slice(5))) return false;
		if (child.innerBlocks.length === 0 && !savesMarkup(child)) continue;
		if (!allDescendantsAreStaticSavedHtml(child, depth + 1)) return false;
	}
	return true;
}

/**
 * Block names of every childless descendant that saves no markup (item 163d), in document order.
 * Called when an unknown container is kept so the import report can name what was not carried.
 */
export function droppedNoMarkupIn(block: GutenbergBlock, depth = 0): string[] {
	if (depth > 8) return [];
	const dropped: string[] = [];
	for (const child of block.innerBlocks) {
		if (child.innerBlocks.length === 0 && !savesMarkup(child)) {
			const name = qualifiedName(child.blockName);
			if (name) dropped.push(name);
			continue;
		}
		if (child.innerBlocks.length > 0) {
			dropped.push(...droppedNoMarkupIn(child, depth + 1));
		}
	}
	return dropped;
}

/**
 * The block's markup with every child's own assembly spliced into its `innerContent` placeholders.
 *
 * `innerContent` is the parser's interleaving of the block's own HTML fragments with `null` where each child belongs, so this is a
 * join rather than a reconstruction. Falls back to `innerHTML` when the two disagree in length, because a mismatch means the parser
 * and this function disagree about the shape and guessing would concatenate the wrong fragments.
 */
export function assembleUnknownContainer(block: GutenbergBlock, depth = 0): string {
	if (depth > 8) return block.innerHTML;
	const parts = block.innerContent ?? [];
	const children = block.innerBlocks ?? [];
	const nulls = parts.filter((part) => part === null).length;
	if (nulls !== children.length) return block.innerHTML;
	let next = 0;
	return parts
		.map((part) => {
			if (part !== null) return part;
			const child = children[next++];
			if (!child) return "";
			// A nested unknown container assembles recursively; anything else keeps whatever markup it saved.
			return child.innerBlocks.length > 0 && allDescendantsAreStaticSavedHtml(child)
				? assembleUnknownContainer(child, depth + 1)
				: child.innerHTML;
		})
		.join("");
}
