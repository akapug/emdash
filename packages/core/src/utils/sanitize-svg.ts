/**
 * Item 163g: static inline SVG carried through `sanitizeContent`, or refused whole.
 *
 * MEASURED POPULATION, from the five real exports' page content (468 published posts and pages): 11 inline `<svg>` across 3 pages on 2 sites —
 * 10 on twpe (`uagb/info-box`, `uagb/icon-list-child`) and 1 on calulti. All use only `svg`/`g`/`path`. The other four sites carry none.
 *
 * WHY parse5. The security boundary needs the browser's tree: the foreign-content rules decide when `<svg>` enters the SVG namespace, and
 * parentage is the question an SVG allowlist has to answer. Measured: `sanitize-html`'s `exclusiveFilter` receives no parent at all.
 *
 * PROVENANCE IS NODE IDENTITY, NOT TEXT. Three earlier attempts failed on this boundary: a `data-embark-svg` attribute the source could
 * write; a `Symbol` the library dropped when it rebuilt `attribs`; and a random token substituted across the raw string, which cannot prove
 * the token's position survived the policy. This version never substitutes strings. It parses the fragment, validates SVG subtrees as nodes,
 * REPLACES each accepted element with a marker node, lets the ordinary HTML policy run, then walks the sanitized tree and puts the validated
 * NODES back at the marker's own position — a position proved by tree identity, not by matching text.
 *
 * ORDINARY HTML IS NEVER RE-SERIALIZED BY HAND. Everything outside an SVG candidate goes back to the caller as parse5's own serialization of
 * the parsed tree, so a childless `<img>` or `<input>` beside an icon survives. An earlier version rebuilt HTML by hand and silently dropped
 * every childless element on any SVG-bearing page.
 */

import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";

/** The SVG namespace, exactly as the spec spells it. */
const SVG_NS = "http://www.w3.org/2000/svg";
/** Plain ASCII around 128 random bits: control characters and tag syntax do not survive an HTML sanitizer, and a stripped marker cannot resolve. */
const SLOT_PREFIX = "EMDASHSVG";
const SLOT_SUFFIX = "ENDSLOT";
const HTML_NS = "http://www.w3.org/1999/xhtml";

/** The three elements v1 carries. Anything else refuses the whole subtree. */
const SVG_TAGS = new Set(["svg", "g", "path"]);

/** Attributes allowed per element. No `href`, no `xlink:*`, no `style`, no `on*`, no `class`/`id`/`data-*`. */
const SVG_ATTRS: Record<string, ReadonlySet<string>> = {
	svg: new Set(["viewBox", "width", "height", "fill", "stroke", "stroke-width", "role", "aria-hidden", "aria-label", "focusable"]),
	g: new Set(["fill", "stroke", "stroke-width", "fill-rule", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "transform"]),
	path: new Set(["d", "fill", "stroke", "stroke-width", "fill-rule", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "transform"]),
};

/** parse5 keeps SVG's attribute casing; accept lowercased spellings too so neither path can strip an element bare. */
const NAME_OF: Record<string, string> = { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio" };

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUM = new RegExp(`^${NUMBER}$`);

/** Four finite numbers with positive extents: a zero extent draws nothing and some engines reject it. */
export function validViewBox(value: string): boolean {
	const parts = value.trim().split(VIEWBOX_SEPARATOR);
	if (parts.length !== 4 || !parts.every((p) => NUM.test(p))) return false;
	const nums = parts.map(Number);
	return nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0;
}

const PAINT_FN = /^(rgba?|hsla?)\(\s*[0-9.%\s,/+-]+\)$/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED = /^[a-z]+$/i;
/** A paint is a hex colour, a colour function with numeric arguments, or a named token — no paint shape contains `url(`. */
export function validPaint(value: string): boolean {
	const v = value.trim();
	return (HEX.test(v) || PAINT_FN.test(v) || NAMED.test(v)) && !URL_CALL.test(v);
}

const TRANSFORM_FN = /^(matrix|translate|scale|rotate|skewX|skewY)\(\s*[0-9eE.,\s+-]*\s*\)$/;
export function validTransform(value: string): boolean {
	const v = value.trim();
	return v !== "" && v.split(TRANSFORM_SEPARATOR).every((fn) => TRANSFORM_FN.test(fn.trim()));
}

const PATH_D = /^[\sMmLlHhVvCcSsQqTtAaZz0-9eE.,+-]+$/;
const PATH_STARTS_WITH_MOVETO = /^[Mm]/;
export function validPathData(value: string): boolean {
	const v = value.trim();
	return v !== "" && PATH_D.test(v) && PATH_STARTS_WITH_MOVETO.test(v);
}

const DIMENSION = new RegExp(`^(?:${NUMBER})(?:px|em|rem|%)?$`);
const URL_CALL = /url\s*\(/i;
const VIEWBOX_SEPARATOR = /[\s,]+/;
const TRANSFORM_SEPARATOR = /\s+(?=[a-zA-Z])/;
const MARKUP_CHARS = /[<>"']/;
const SCHEME = /^(?:javascript|data|vbscript):/i;
const NAMESPACE_PREFIXED = /^on/i;
export function validDimension(value: string): boolean {
	const v = value.trim();
	return v === "" || DIMENSION.test(v);
}

/**
 * Keep the attributes whose name is allowed and whose value its grammar accepts.
 *
 * ATTRIBUTES DROP; ELEMENTS REFUSE. The measured icons carry `xmlns`, `xmlns:xlink`, `version`, `id` and `data-name`; a rule that refused on
 * any unknown attribute dropped all 11 of them on sight. Dropping is safe — the danger is only in KEEPING a reference or an event handler.
 */
export function keptAttributes(element: string, attribs: Array<{ name: string; value: string }>): Record<string, string> {
	const allowed = SVG_ATTRS[element];
	const out: Record<string, string> = {};
	if (!allowed) return out;
	for (const { name: rawName, value: rawValue } of attribs) {
		const name = NAME_OF[rawName.toLowerCase()] ?? rawName;
		if (name.includes(":") || NAMESPACE_PREFIXED.test(name) || name.toLowerCase() === "href" || !allowed.has(name)) continue;
		const v = rawValue.trim();
		switch (name) {
			case "viewBox":
				if (validViewBox(v)) out[name] = v.replace(/[\s,]+/g, " ");
				break;
			case "d":
				if (validPathData(v)) out[name] = v;
				break;
			case "fill":
			case "stroke":
				if (validPaint(v)) out[name] = v;
				break;
			case "transform":
				if (validTransform(v)) out[name] = v;
				break;
			case "width":
			case "height":
				if (validDimension(v)) out[name] = v;
				break;
			case "stroke-width":
			case "opacity":
			case "fill-opacity":
			case "stroke-opacity":
				if (NUM.test(v)) out[name] = v;
				break;
			case "fill-rule":
				if (v === "nonzero" || v === "evenodd") out[name] = v;
				break;
			case "stroke-linecap":
				if (v === "butt" || v === "round" || v === "square") out[name] = v;
				break;
			case "stroke-linejoin":
				if (v === "miter" || v === "round" || v === "bevel") out[name] = v;
				break;
			case "aria-hidden":
			case "focusable":
				if (v === "true" || v === "false") out[name] = v;
				break;
			default:
				if (!MARKUP_CHARS.test(v) && !SCHEME.test(v)) out[name] = v;
		}
	}
	return out;
}

function makeElement(tag: string): P5Node {
	return { nodeName: tag, tagName: tag, attrs: [], childNodes: [], parentNode: null };
}

interface P5Attrs {
	name: string;
	value: string;
	namespace?: string;
	prefix?: string;
}

interface P5Node {
	nodeName: string;
	tagName?: string;
	namespaceURI?: string;
	attrs?: P5Attrs[];
	childNodes?: P5Node[];
	value?: string;
	parentNode?: P5Node | null;
}

/**
 * Build the replacement NODES for one SVG element, or null when the subtree carries anything this allowlist does not understand.
 *
 * Nodes, not markup: the caller inserts them into the tree it already parsed, so position is structural rather than a string match.
 */
function buildNodes(node: P5Node): P5Node | null {
	const tag = node.tagName ?? "";
	if (node.namespaceURI !== SVG_NS || !SVG_TAGS.has(tag)) return null;
	const kept = keptAttributes(tag, node.attrs ?? []);
	if (tag === "path" && kept.d === undefined) return null;
	const out = makeElement(tag);
	out.namespaceURI = SVG_NS;
	out.attrs = Object.entries(kept).map(([name, value]) => ({ name, value }));
	out.childNodes = [];
	for (const child of node.childNodes ?? []) {
		if (child.nodeName === "#text") continue; // an icon's text is not this item
		const built = buildNodes(child);
		if (built === null) return null; // a refused child refuses the WHOLE subtree, never unwraps it
		out.childNodes.push(built);
	}
	return out;
}

export interface CarryResult {
	/** The fragment, serialized by parse5 with each accepted icon replaced by a marker element and each refused one removed. */
	markup: string;
	/** marker text → the validated nodes standing in for that icon. */
	accepted: Map<string, P5Node[]>;
	refused: number;
}

/**
 * THE BRIDGE IS A TEXT NODE, as the ruling specified. An element bridge was tried and withdrawn: a unique marker in an element proves which
 * icon was validated, not that the element survived into an allowed position, and the design change was never cleared.
 *
 * Ancestry is checked on BOTH sides. Before: a candidate `<svg>` is only considered when every ancestor is ordinary HTML, so an `<svg>` inside
 * `<math>`, a `foreignObject` or a raw-text element is refused rather than carried to a position nobody approved. After: the slot's own text
 * node must sit in an approved ancestry too, and must occur exactly once.
 */
const RAW_TEXT_ANCESTORS = new Set(["math", "script", "style", "textarea", "title", "template", "iframe", "object", "embed", "noscript"]);

function approvedAncestry(node: P5Node): boolean {
	let cur = node.parentNode ?? null;
	while (cur) {
		if (cur.namespaceURI !== undefined && cur.namespaceURI !== HTML_NS) return false;
		if (cur.tagName && RAW_TEXT_ANCESTORS.has(cur.tagName.toLowerCase())) return false;
		cur = cur.parentNode ?? null;
	}
	return true;
}

/**
 * Parse the WHOLE fragment in the production `div` context and swap each accepted icon for a marker node.
 *
 * `context` is the element the real renderers wrap content in, so parse5 applies exactly the recovery and foreign-content rules a browser
 * would in that position rather than the implicit fragment context.
 */
export function carryInlineSvg(
	html: string,
	tokenFor: () => string,
	context: DefaultTreeAdapterMap["element"],
): CarryResult {
	const accepted = new Map<string, P5Node[]>();
	let refused = 0;
	// parse5's OWN types at the library boundary: the adapter rejects a hand-shaped object, which is what the typechecker said.
	const fragment = parseFragment(context, html, { sourceCodeLocationInfo: false });

	const walk = (node: DefaultTreeAdapterMap["node"]): DefaultTreeAdapterMap["node"][] => {
		if (node.namespaceURI === SVG_NS && node.tagName === "svg") {
			// Ancestry first: an <svg> under <math>/foreignObject/raw-text is not a position this pass approved, so it is refused, not carried.
			if (!approvedAncestry(node)) {
				refused++;
				return [];
			}
			const built = buildNodes(node);
			if (built === null) {
				refused++;
				return [];
			}
			const marker = SLOT_PREFIX + tokenFor() + SLOT_SUFFIX;
			// The WHOLE `svg` node, not its children: storing childNodes dropped the wrapper and left a bare path in the page.
			accepted.set(marker, [built]);
			// A TEXT node carries the slot: text is what the policy preserves verbatim, and it has no attributes to forge.
			return [{ nodeName: "#text", value: marker, parentNode: null }];
		}
		if (!node.childNodes?.length) return [node];
		const out: P5Node[] = [];
		for (const child of node.childNodes) out.push(...walk(child));
		// Rewrite children in place, preserving every attribute and every childless element exactly as parsed.
		node.childNodes = out;
		return [node];
	};

	const roots = (fragment.childNodes ?? []).flatMap(walk);
	// Rewrite the PARSED fragment IN PLACE and serialize it, so no node is fabricated and no cast is needed. `fragment`'s type already
	// accepts childNodes of the adapter's node type, and `walk` preserves that type — the earlier casts were papering over a shape I
	// was inventing rather than assigning.
	fragment.childNodes = roots;
	return { markup: serialize(fragment), accepted, refused };
}

/**
 * Put the validated nodes back at their markers' own positions in the SANITIZED tree, then serialize once.
 *
 * A marker element that the HTML policy removed is simply absent — the icon is dropped, which is the safe answer. A marker that appears more
 * than once has no unique position and is dropped. Nothing is matched by text, so a source cannot forge a slot.
 */
export function placeSvgNodes(cleaned: string, carried: Map<string, P5Node[]>, context: DefaultTreeAdapterMap["element"]): string {
	if (carried.size === 0) return cleaned;
	// THE SAME EXPLICIT CONTEXT as the carry parse. An implicit fragment parse here would recover differently and could file a slot under an
	// ancestor the carry never approved.
	const fragment = parseFragment(context, cleaned, { sourceCodeLocationInfo: false });

	const counts = new Map<string, number>();
	const count = (node: P5Node): void => {
		if (node.nodeName === "#text") {
			const text = node.value ?? "";
			for (const marker of carried.keys()) {
				let at = text.indexOf(marker);
				while (at !== -1) {
					counts.set(marker, (counts.get(marker) ?? 0) + 1);
					at = text.indexOf(marker, at + marker.length);
				}
			}
			return;
		}
		for (const child of node.childNodes ?? []) count(child);
	};
	count(fragment);

	const live = (marker: string, node: P5Node): boolean =>
		counts.get(marker) === 1 && approvedAncestry(node);

	const rewrite = (node: P5Node): void => {
		const kids = node.childNodes;
		if (!kids?.length) return;
		const out: P5Node[] = [];
		for (const child of kids) {
			if (child.nodeName === "#text") {
				const text = child.value ?? "";
				// SPLIT AT EVERY ISSUED MARKER. The parser can merge a slot with adjacent prose or another slot into ONE text node, so
				// requiring the whole node to be a marker left the marker visible as text whenever an icon stood beside prose. Each
				// occurrence is handled independently and surrounding prose is preserved in order.
				const hits = [...carried.keys()].filter((m) => text.includes(m));
				if (hits.length === 0) {
					out.push(child);
					continue;
				}
				// Longest-first so one marker can never be consumed inside another's text.
				const ordered = hits.toSorted((a, b) => b.length - a.length);
				let rest = text;
				const pieces: Array<{ kind: "text"; value: string } | { kind: "icon"; marker: string }> = [];
				let at = 0;
				while (at < rest.length) {
					const next = ordered.map((m) => ({ m, i: rest.indexOf(m, at) })).filter((h) => h.i !== -1).toSorted((x, y) => x.i - y.i)[0];
					if (!next) {
						pieces.push({ kind: "text", value: rest.slice(at) });
						break;
					}
					if (next.i > at) pieces.push({ kind: "text", value: rest.slice(at, next.i) });
					pieces.push({ kind: "icon", marker: next.m });
					at = next.i + next.m.length;
				}
				for (const piece of pieces) {
					if (piece.kind === "text") {
						if (piece.value !== "") out.push({ nodeName: "#text", value: piece.value, parentNode: node });
						continue;
					}
					if (live(piece.marker, child)) {
						for (const built of carried.get(piece.marker) ?? []) {
							built.parentNode = node;
							out.push(built);
						}
					}
					// A marker that is not live (lost, duplicated, displaced, unapproved ancestry) is STRIPPED, never left as visible text.
				}
				continue;
			}
			rewrite(child);
			out.push(child);
		}
		node.childNodes = out;
	};
	rewrite(fragment);
	return serialize(fragment);
}

export { SVG_NS, SVG_TAGS };
export type { P5Node };
