/**
 * How a block that holds Portable Text of its own (a column of a `columns`
 * block, a `cover`'s content) draws that content: with the components the page
 * drew the block with.
 *
 * `astro-portabletext` does not pass a `components` map down to a nested
 * `<PortableText>`, so a block that rendered its content with the bare
 * component drew only text there: an image, a gallery, an embed, a button or a
 * nested `columns` block inside a column rendered as `astro-portabletext`'s
 * unknown type, which is `display:none`. EmDash's `PortableText` records its
 * own components on each such node it renders, and the node's component hands
 * them to EmDash's `PortableText` again for its content.
 */
import type { PortableTextProps } from "astro-portabletext";

const NESTED = Symbol.for("emdash.portable-text.nested");

/** The block types whose content is Portable Text drawn inside them. */
const HOLDERS: ReadonlySet<string> = new Set(["columns", "cover"]);

export interface NestedRender {
	/** The page's own overrides, merged over EmDash's defaults exactly as at the top level. */
	components?: PortableTextProps["components"];
	listNestingMode?: PortableTextProps["listNestingMode"];
}

/** Record `render` on every node of `nodes` that holds Portable Text. `nodes` must be the renderer's own copy. */
export function recordNestedRender(nodes: unknown, render: NestedRender): void {
	if (!Array.isArray(nodes)) return;
	const list: readonly unknown[] = nodes;
	for (const node of list) {
		if (typeof node !== "object" || node === null || !("_type" in node)) continue;
		if (typeof node._type === "string" && HOLDERS.has(node._type)) {
			Object.defineProperty(node, NESTED, { value: render, enumerable: false, configurable: true });
		}
	}
}

/** What a node's content is drawn with; EmDash's defaults for a node no EmDash `PortableText` rendered. */
export function nestedRenderOf(node: unknown): NestedRender {
	if (typeof node !== "object" || node === null) return {};
	const render: unknown = Reflect.get(node, NESTED);
	return isNestedRender(render) ? render : {};
}

function isNestedRender(value: unknown): value is NestedRender {
	return typeof value === "object" && value !== null;
}
