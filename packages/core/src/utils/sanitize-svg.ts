/**
 * Item 163g: static inline SVG carried through `sanitizeContent`, or refused whole.
 *
 * MEASURED POPULATION, on the five real exports (468 published posts and pages): 11 inline `<svg>` across 3 pages on 2 sites — 10 on twpe
 * (`uagb/info-box`, `uagb/icon-list-child`) and 1 on calulti. All of them use only `svg`/`g`/`path`. The other three sites carry none. This
 * is an allowlist for icons, not for SVG as a medium.
 *
 * WHY parse5 AND NOT sanitize-html'S OWN WALK. The first version stamped rebuilt elements with a `data-embark-svg` attribute and had the
 * filter trust it — a customer could write that attribute themselves, so markup was standing in for provenance. The second tried a Symbol
 * on the parsed node; `sanitize-html` rebuilds `attribs` from its string-keyed allowlist, so the Symbol never survived to the filter.
 * Measured: `exclusiveFilter` receives `tag,attribs,tagPosition,text,openingTagLength,mediaChildren,updateParentNodeText,
 * updateParentNodeMediaChildren` and **no parent** — so that library cannot answer "what does this element sit inside", which is the one
 * question an SVG allowlist has to answer.
 *
 * parse5 implements the HTML spec's tree construction, including the foreign-content rules that decide when `<svg>` switches namespace and
 * when it switches back. That is the property being bought: the tree validated here is the tree a browser would build, so namespace and
 * parentage are facts rather than assertions. Provenance is held in this module's own return value — never in markup, never in an attribute.
 */

import { parseFragment } from "parse5";

/** The SVG namespace, exactly as the spec spells it. */
const SVG_NS = "http://www.w3.org/2000/svg";

/** The three elements v1 carries. Anything else refuses the whole subtree. */
const SVG_TAGS = new Set(["svg", "g", "path"]);

/** Attributes allowed per element. No `href`, no `xlink:*`, no `style`, no `on*`, no `class`/`id`/`data-*`. */
const SVG_ATTRS: Record<string, ReadonlySet<string>> = {
	svg: new Set(["viewBox", "width", "height", "fill", "stroke", "stroke-width", "role", "aria-hidden", "aria-label", "focusable"]),
	g: new Set(["fill", "stroke", "stroke-width", "fill-rule", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "transform"]),
	path: new Set(["d", "fill", "stroke", "stroke-width", "fill-rule", "stroke-linecap", "stroke-linejoin", "opacity", "fill-opacity", "stroke-opacity", "transform"]),
};

/** parse5 lowercases HTML attribute names but keeps SVG's casing; accept both spellings so neither path can strip an element bare. */
const NAME_OF: Record<string, string> = { viewbox: "viewBox", preserveaspectratio: "preserveAspectRatio" };

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUM = new RegExp(`^${NUMBER}$`);

/** Four finite numbers with positive extents: a zero extent draws nothing and some engines reject it. */
export function validViewBox(value: string): boolean {
	const parts = value.trim().split(/[\s,]+/);
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
	return (HEX.test(v) || PAINT_FN.test(v) || NAMED.test(v)) && !/url\s*\(/i.test(v);
}

const TRANSFORM_FN = /^(matrix|translate|scale|rotate|skewX|skewY)\(\s*[0-9eE.,\s+-]*\s*\)$/;
export function validTransform(value: string): boolean {
	const v = value.trim();
	return v !== "" && v.split(/\s+(?=[a-zA-Z])/).every((fn) => TRANSFORM_FN.test(fn.trim()));
}

const PATH_D = /^[\sMmLlHhVvCcSsQqTtAaZz0-9eE.,+-]+$/;
export function validPathData(value: string): boolean {
	const v = value.trim();
	return v !== "" && PATH_D.test(v) && /^[Mm]/.test(v);
}

const DIMENSION = new RegExp(`^(?:${NUMBER})(?:px|em|rem|%)?$`);
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
		if (name.includes(":") || /^on/i.test(name) || name.toLowerCase() === "href" || !allowed.has(name)) continue;
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
				if (!/[<>"']/.test(v) && !/^(?:javascript|data|vbscript):/i.test(v)) out[name] = v;
		}
	}
	return out;
}

interface P5Node {
	nodeName: string;
	tagName?: string;
	namespaceURI?: string;
	attrs?: Array<{ name: string; value: string }>;
	childNodes?: P5Node[];
	value?: string;
}

const escapeText = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Rebuild one validated SVG element, or null when the subtree carries anything this allowlist does not understand. */
function rebuild(node: P5Node): string | null {
	const tag = node.tagName ?? "";
	if (node.namespaceURI !== SVG_NS || !SVG_TAGS.has(tag)) return null;
	const attrs = keptAttributes(tag, node.attrs ?? []);
	if (tag === "path" && attrs.d === undefined) return null;
	const inner: string[] = [];
	for (const child of node.childNodes ?? []) {
		// An element child must itself be a valid SVG element; TEXT inside an icon is dropped (an icon's text is not this item), and so
		// is anything else. A refused element child refuses the WHOLE subtree, never unwraps it.
		if (child.namespaceURI === undefined) {
			if (child.nodeName === "#text") continue;
			return null;
		}
		const built = rebuild(child);
		if (built === null) return null;
		inner.push(built);
	}
	const rendered = Object.entries(attrs)
		.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
		.join("");
	return `<${tag}${rendered}>${inner.join("")}</${tag}>`;
}

export interface CarriedSvg {
	/** The rebuilt, inert markup for one icon. */
	html: string;
	/** Where it stood, as a text-node value that the caller may look for. Never trusted as provenance on its own. */
	marker: string;
}

export interface CarryResult {
	/** The fragment with each accepted icon replaced by a text marker. */
	markup: string;
	/** marker → rebuilt markup, for the icons the walk accepted. */
	accepted: Map<string, string>;
	/** How many candidate `<svg>` elements were refused. */
	refused: number;
}

/**
 * Parse the WHOLE fragment in the production `div` context and swap each accepted icon for a text marker.
 *
 * The caller sanitizes this markup with the ordinary HTML policy (`svg`/`g`/`path` stay off that allowlist, so a raw one cannot survive),
 * then re-parses the result and substitutes each marker AT ITS UNIQUE OCCURRENCE IN A TEXT NODE. Provenance is the returned map, which the
 * source cannot write. A marker that is lost, repeated, or lands anywhere but an ordinary text node drops that icon.
 */
export function carryInlineSvg(html: string, tokenFor: () => string): CarryResult {
	const accepted = new Map<string, string>();
	let refused = 0;
	const fragment = parseFragment(html, { sourceCodeLocationInfo: false });
	const walk = (node: P5Node): string => {
		if (node.namespaceURI === SVG_NS && node.tagName === "svg") {
			const built = rebuild(node);
			if (built === null) {
				refused++;
				return "";
			}
			const marker = tokenFor();
			accepted.set(marker, built);
			return marker;
		}
		const kids = node.childNodes;
		if (!kids?.length) return node.nodeName === "#text" ? escapeText(node.value ?? "") : "";
		const open = node.namespaceURI !== undefined ? `<${node.tagName}${(node.attrs ?? []).map((a) => ` ${a.name}="${escapeAttr(a.value)}"`).join("")}>` : "";
		const close = node.namespaceURI !== undefined ? `</${node.tagName}>` : "";
		if (node.nodeName === "#comment") return "";
		if (node.nodeName === "#document" || node.nodeName === "#document-fragment") return kids.map(walk).join("");
		return open + kids.map(walk).join("") + close;
	};
	const markup = (fragment.childNodes ?? []).map(walk).join("");
	return { markup, accepted, refused };
}

export { SVG_NS, SVG_TAGS };

/**
 * Resolve each marker in the SANITIZED output, at its unique occurrence in an ordinary text node.
 *
 * Re-parsing the output is what makes the claim checkable rather than assumed: a marker that ended up in an attribute value, a comment or a
 * raw-text element is simply not a text node, and drops. A marker occurring zero times lost its slot to the HTML policy; occurring more than
 * once means it was copied, and a copy has no provenance. Both drop the icon.
 */
export function resolveSvgMarkers(cleaned: string, accepted: Map<string, string>): string {
	const fragment = parseFragment(cleaned, { sourceCodeLocationInfo: false });
	const counts = new Map<string, number>();
	const count = (node: P5Node): void => {
		if (node.nodeName === "#text") {
			const text = node.value ?? "";
			for (const marker of accepted.keys()) {
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

	// Only markers standing in an ordinary text node, exactly once, survive.
	const live = new Map([...accepted].filter(([m]) => counts.get(m) === 1));
	if (live.size === 0) {
		// Nothing to resolve: remove any stray markers so a duplicated one can never render as text.
		return [...accepted.keys()].reduce((out, m) => out.split(m).join(""), cleaned);
	}
	let out = cleaned;
	for (const [marker, html] of live) {
		out = out.split(marker).join(html);
	}
	// Anything unresolved (duplicated) is stripped rather than drawn as literal text.
	for (const marker of accepted.keys()) {
		if (!live.has(marker)) out = out.split(marker).join("");
	}
	return out;
}
