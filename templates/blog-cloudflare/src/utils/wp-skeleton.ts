/**
 * A page builder's skeleton around EmDash's own blocks (layouts/WpShell.astro).
 *
 * A page a builder made on WordPress (Elementor) is drawn inside the builder's
 * own elements: sections, columns and a wrapper per widget, each with the
 * classes and element ids the page's own stylesheet and the site's global
 * rules select by. Embark's import keeps the page's words, images and links as
 * Portable Text the admin edits, and puts what WordPress drew around them on
 * the blocks that carry the layout, as `skeleton` (Embark's
 * packages/host/src/import/elementor-pt.ts, `stampSkeleton`):
 *
 *   - a carrier block (a block of any type, other than `columns`, that holds
 *     `skeleton`): the elements the blocks after it sit in, up to the next
 *     carrier or the next `columns` block of the page's own;
 *   - a `columns` block holding `skeleton`: its own elements around its
 *     columns, and each column's around its blocks. One whose `skeleton.inner`
 *     is set sits among the blocks of the carrier before it;
 *   - `skeleton.widgets`: by element id, the elements around that widget's
 *     blocks, a block keyed `el-<id>` or `el-<id>-<n>` being the widget's;
 *     `added`, the elements around a block the owner added (any other key);
 *   - `skeleton.document`: the page's own wrapper, drawn once around the page.
 *
 * This file knows no builder: it groups the blocks and checks every element
 * it is asked to draw against one list (a tag from TAGS, classes of class
 * characters, an `id` and `data-` attributes only), so a stored value can
 * draw no script, no handler and no style of its own. The blocks themselves
 * are drawn by EmDash's PortableText, sanitized as everywhere else.
 */

/** One element of the skeleton, as stored. */
export interface SkeletonWrap {
	tag: string;
	class: string;
	attrs?: Record<string, string>;
	lead?: SkeletonWrap[];
}

interface SkeletonWidget {
	wraps?: SkeletonWrap[];
	blockClass?: string;
	body?: SkeletonWrap[];
}

interface Skeleton {
	document?: SkeletonWrap;
	wraps?: SkeletonWrap[];
	widgets?: Record<string, SkeletonWidget>;
	added?: SkeletonWidget;
	inner?: boolean;
}

type Block = { _type?: string; _key?: string; [k: string]: unknown };

/** An element to draw, checked: its tag, classes and attributes, and what it holds. */
export interface SkeletonElement {
	tag: string;
	class: string | undefined;
	attrs: Record<string, string>;
	children: SkeletonNode[];
}

/** What the layout draws: an element, or a run of blocks for EmDash's PortableText. */
export type SkeletonNode = { element: SkeletonElement } | { blocks: Block[] };

/** The elements a skeleton may draw. */
const TAGS = new Set(["div", "section", "header", "footer", "aside", "article", "nav", "main", "span"]);
const CLASS = /^[A-Za-z0-9_-]{1,100}$/;
const ATTR = /^(id|data-[a-z0-9_-]{1,40})$/;
const KEY = /^el-([0-9a-z]{1,32})(?:-[1-9]\d{0,5})?$/;
/** Blocks a widget draws its own `body` instead of: its placeholder and a divider's break. */
const PLACEHOLDERS = new Set(["elementor-widget", "break"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const skeletonOf = (b: unknown): Skeleton | null => (isObject(b) && isObject(b.skeleton) ? (b.skeleton as Skeleton) : null);

/** Whether a body holds a skeleton to draw: a carrier or a `columns` block with one. */
export function hasSkeleton(body: unknown): boolean {
	return Array.isArray(body) && body.some((b) => skeletonOf(b) !== null);
}

/** A stored element, checked; null when its tag is not one a skeleton draws. */
function checked(w: unknown, children: SkeletonNode[]): SkeletonNode | null {
	if (!isObject(w) || typeof w.tag !== "string" || !TAGS.has(w.tag)) return null;
	const classes = typeof w.class === "string" ? w.class.split(/\s+/).filter((c) => CLASS.test(c)) : [];
	const attrs: Record<string, string> = {};
	if (isObject(w.attrs)) {
		for (const [k, v] of Object.entries(w.attrs)) if (ATTR.test(k) && typeof v === "string" && v.length <= 200) attrs[k] = v;
	}
	const lead = Array.isArray(w.lead) ? w.lead.flatMap((l) => checked(l, []) ?? []) : [];
	return { element: { tag: w.tag, class: classes.length ? classes.join(" ") : undefined, attrs, children: [...lead, ...children] } };
}

/** `children` inside `wraps`, the first outermost. An element that fails the check is left out and its children kept. */
function nest(wraps: unknown, children: SkeletonNode[]): SkeletonNode[] {
	if (!Array.isArray(wraps)) return children;
	return wraps.reduceRight<SkeletonNode[]>((inner, w) => {
		const node = checked(w, inner);
		return node ? [node] : inner;
	}, children);
}

const widgetIdOf = (b: Block): string | null => (typeof b._key === "string" ? (KEY.exec(b._key)?.[1] ?? null) : null);

/** A widget's blocks: a heading's paragraphs carry its title class (WpShellBlock draws `skeletonClass`). */
function widgetBlocks(w: SkeletonWidget, blocks: Block[]): SkeletonNode[] {
	if (Array.isArray(w.body) && blocks.every((b) => PLACEHOLDERS.has(String(b._type)))) return nest(w.body, []);
	const shown = blocks.filter((b) => b._type !== "elementor-widget");
	if (shown.length === 0) return [];
	const cls = typeof w.blockClass === "string" ? w.blockClass : null;
	return [{ blocks: cls ? shown.map((b) => (b._type === "block" ? { ...b, skeletonClass: cls } : b)) : shown }];
}

/** A run of blocks in one column (or after one carrier): each widget's blocks in its elements, a `columns` block in its own. */
function run(blocks: Block[], s: Skeleton | null): SkeletonNode[] {
	const widgets = isObject(s?.widgets) ? s.widgets : {};
	const out: SkeletonNode[] = [];
	for (let i = 0; i < blocks.length; ) {
		const b = blocks[i];
		if (!b) break;
		if (b._type === "columns" && skeletonOf(b)) {
			out.push(...columns(b));
			i++;
			continue;
		}
		const id = widgetIdOf(b);
		const own = id !== null && Object.hasOwn(widgets, id) ? id : null;
		let j = i + 1;
		for (let next = blocks[j]; next && !(next._type === "columns" && skeletonOf(next)) && sameGroup(widgetIdOf(next), own, widgets); next = blocks[j]) j++;
		const group = blocks.slice(i, j);
		const w = own !== null ? widgets[own] : s?.added;
		out.push(...(isObject(w) ? nest(w.wraps, widgetBlocks(w, group)) : [{ blocks: group }]));
		i = j;
	}
	return out;
}

/** Whether a block keyed with `id` goes on in the group of widget `own` (null: the owner's added blocks). */
function sameGroup(id: string | null, own: string | null, widgets: Record<string, SkeletonWidget>): boolean {
	if (own !== null) return id === own;
	return id === null || !Object.hasOwn(widgets, id);
}

function columns(b: Block): SkeletonNode[] {
	const s = skeletonOf(b);
	const cols = Array.isArray(b.columns) ? (b.columns as Block[]) : [];
	return nest(
		s?.wraps,
		cols.flatMap((c) => {
			const cs = skeletonOf(c);
			const content = Array.isArray(c.content) ? (c.content as Block[]) : [];
			return nest(cs?.wraps, run(content, cs));
		}),
	);
}

/** The page's body as the skeleton draws it: each carrier's elements around the blocks after it, in the page's own wrapper. */
export function skeletonTree(body: Block[]): SkeletonNode[] {
	const out: SkeletonNode[] = [];
	let document: unknown;
	const starts = (b: Block) => {
		const s = skeletonOf(b);
		return s !== null && !(b._type === "columns" && s.inner === true);
	};
	for (let i = 0; i < body.length; ) {
		const b = body[i];
		if (!b) break;
		const s = skeletonOf(b);
		if (document === undefined && s?.document) document = s.document;
		if (b._type === "columns" && s && !s.inner) {
			out.push(...columns(b));
			i++;
			continue;
		}
		let j = i + 1;
		for (let next = body[j]; next && !starts(next); next = body[j]) j++;
		const carrier = s !== null && b._type !== "columns" ? s : null;
		const blocks = body.slice(carrier ? i + 1 : i, j);
		out.push(...(carrier ? nest(carrier.wraps, run(blocks, carrier)) : run(blocks, null)));
		i = j;
	}
	return document === undefined ? out : nest([document], out);
}
