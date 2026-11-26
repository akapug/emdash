/**
 * Item 163g: static inline SVG the source site actually draws, carried through `sanitizeContent`.
 *
 * MEASURED FIRST, on the five real exports (468 published posts and pages): 11 inline `<svg>` elements across 3 pages on 2 sites —
 * 10 on twpe (`uagb/info-box` and `uagb/icon-list-child` icons, `svg`/`path` only) and 1 on calulti (`svg`/`g`/`path`). The other
 * three sites carry none. So this allowlist is written for icons, not for SVG as a medium.
 *
 * WHY A PRE-PASS AND NOT A `sanitize-html` TAG RULE. `sanitize-html` walks tags flatly: it cannot tell a `<path>` inside `<svg>`
 * from one outside it, and it has no notion of SVG's separable namespace. Building this out of `allowedTags` would let an HTML
 * context grow SVG children, and a subtree cannot be *rejected whole* by a per-tag allowlist — the allowed child of a refused
 * parent gets unwrapped in place, which is exactly the reparenting codex's amend forbids.
 *
 * So: find each complete `<svg>…</svg>` in the markup, parse it on its own, rebuild it from validated nodes and attributes only,
 * and hand the caller a finished inert string. A subtree carrying anything not on the list is rejected WHOLE, never unwrapped.
 * The result contains no attributes that can execute, fetch, or reference anything outside the element, by construction rather
 * than by blacklist — arithmetic and colour grammars only, so `url(` cannot appear.
 */

/** The only elements v1 carries (codex AMEND 11-26 22:36Z). No `title`/`desc`: text inside an icon is not this item. */
const SVG_TAGS = new Set(["svg", "g", "path"]);

/** Attributes allowed on each element. `class`/`id`/`data-*` are deliberately absent (codex's amend). */
const SVG_ATTRS: Record<string, ReadonlySet<string>> = {
	svg: new Set(["viewBox", "width", "height", "fill", "stroke", "stroke-width", "role", "aria-hidden", "aria-label", "focusable"]),
	g: new Set([
		"fill",
		"stroke",
		"stroke-width",
		"fill-rule",
		"stroke-linecap",
		"stroke-linejoin",
		"opacity",
		"fill-opacity",
		"stroke-opacity",
		"transform",
	]),
	path: new Set([
		"d",
		"fill",
		"stroke",
		"stroke-width",
		"fill-rule",
		"stroke-linecap",
		"stroke-linejoin",
		"opacity",
		"fill-opacity",
		"stroke-opacity",
		"transform",
	]),
};

/** SVG's own case-sensitive attribute names. HTML parsing lowercases everything, so these are restored after matching. */
const CASE_SENSITIVE: Record<string, string> = {
	viewbox: "viewBox",
	preserveaspectratio: "preserveAspectRatio",
};

const NUMBER = String.raw`-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
const NUM = new RegExp(`^${NUMBER}$`);

/** Four finite numbers, positive extents. A zero or negative width/height is refused: it draws nothing and some browsers reject it. */
export function validViewBox(value: string): boolean {
	const parts = value.trim().split(/[\s,]+/);
	if (parts.length !== 4 || !parts.every((p) => NUM.test(p))) return false;
	const [x, y, w, h] = parts.map(Number);
	if (![x, y, w, h].every(Number.isFinite)) return false;
	return w > 0 && h > 0;
}

/** A paint: a hex colour, a CSS colour function with numeric arguments, a named colour token, `none`, or `currentColor`. */
const PAINT_FN = /^(rgba?|hsla?)\(\s*[0-9.%\s,/+-]+\)$/i;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NAMED = /^[a-z]+$/i;
export function validPaint(value: string): boolean {
	const v = value.trim();
	if (!v) return false;
	// `url(` is impossible by construction: the value must match one of these three shapes or a bare token.
	if (HEX.test(v) || PAINT_FN.test(v) || NAMED.test(v)) return !/url\s*\(/i.test(v);
	return false;
}

/** The 2D affine transform functions, each with numeric arguments only. No `url()`, no expressions, nothing SVG can fetch. */
const TRANSFORM_FN = /^(matrix|translate|scale|rotate|skewX|skewY)\(\s*[0-9eE.,\s+-]*\s*\)$/;
export function validTransform(value: string): boolean {
	const v = value.trim();
	if (!v) return false;
	return v.split(/\s+(?=[a-zA-Z])/).every((fn) => TRANSFORM_FN.test(fn.trim()));
}

/** A path's `d`: drawing commands and numbers. Rejects anything that could be markup or a reference. */
const PATH_D = /^[\sMmLlHhVvCcSsQqTtAaZz0-9eE.,+-]+$/;
export function validPathData(value: string): boolean {
	const v = value.trim();
	if (!v || !PATH_D.test(v)) return false;
	// Must begin with a moveto, or it draws nothing and some engines warn.
	return /^[Mm]/.test(v);
}

const DIMENSION = new RegExp(`^(?:${NUMBER})(?:px|em|rem|%)?$`);
export function validDimension(value: string): boolean {
	const v = value.trim();
	return v === "" || DIMENSION.test(v);
}

/** Validate one attribute for one element, returning the value to emit or null to drop it. */
export function validatedAttribute(element: string, rawName: string, value: string): [string, string] | null {
	const name = CASE_SENSITIVE[rawName] ?? rawName;
	const allowed = SVG_ATTRS[element];
	if (!allowed?.has(name)) return null;
	// Event handlers and anything reference-shaped are not on any list; this is a second, explicit refusal because the cost of
	// being wrong here is script execution inside a customer's page.
	if (/^on/i.test(name) || name === "href" || name.includes(":")) return null;

	const v = value.trim();
	switch (name) {
		case "viewBox":
			return validViewBox(v) ? [name, v.replace(/[\s,]+/g, " ")] : null;
		case "d":
			return validPathData(v) ? [name, v] : null;
		case "fill":
		case "stroke":
			return validPaint(v) ? [name, v] : null;
		case "transform":
			return validTransform(v) ? [name, v] : null;
		case "width":
		case "height":
			return validDimension(v) ? [name, v] : null;
		case "stroke-width":
		case "opacity":
		case "fill-opacity":
		case "stroke-opacity":
			return NUM.test(v) ? [name, v] : null;
		case "fill-rule":
			return v === "nonzero" || v === "evenodd" ? [name, v] : null;
		case "stroke-linecap":
			return v === "butt" || v === "round" || v === "square" ? [name, v] : null;
		case "stroke-linejoin":
			return v === "miter" || v === "round" || v === "bevel" ? [name, v] : null;
		case "aria-hidden":
			return v === "true" || v === "false" ? [name, v] : null;
		case "focusable":
			return v === "true" || v === "false" ? [name, v] : null;
		default:
			// role, aria-label: text only, and never anything that reads as markup or a scheme.
			if (/[<>"']/.test(v) || /^(?:javascript|data|vbscript):/i.test(v)) return null;
			return [name, v];
	}
}

const escapeAttribute = (v: string): string =>
	v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface Token {
	kind: "open" | "close" | "self";
	name: string;
	attrs: Array<[string, string]>;
}

/** Tag tokens of an SVG fragment. Anything that is not a tag — text, entities, comments — is DROPPED: an icon's text is not this item. */
function tokens(source: string): Token[] {
	const out: Token[] = [];
	const tag = /<\/?([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
	let m: RegExpExecArray | null;
	while ((m = tag.exec(source))) {
		const closing = m[0].startsWith("</");
		const name = m[1].toLowerCase();
		if (closing) {
			out.push({ kind: "close", name, attrs: [] });
			continue;
		}
		const attrs: Array<[string, string]> = [];
		const attr = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/g;
		let a: RegExpExecArray | null;
		while ((a = attr.exec(m[2]))) attrs.push([a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? ""]);
		out.push({ kind: m[3] === "/" ? "self" : "open", name, attrs });
	}
	return out;
}

/**
 * Rebuild one `<svg>` element from validated nodes, or return null to reject the subtree WHOLE.
 *
 * Rejection is all-or-nothing on purpose: an approved child of a refused parent would be unwrapped in place, which reparents it out of
 * the SVG context codex's amend requires us to stay inside. Dropping the whole icon loses a picture; unwrapping it can lose the page.
 */
export function rebuildSvg(inner: string): string | null {
	const ts = tokens(inner);
	if (ts.length === 0) return null;
	if (ts[0].kind !== "open" || ts[0].name !== "svg") return null;

	const emit = (t: Token, name: string, attrs: Array<[string, string]>): string => {
		// Every element the rebuild emits carries this marker. It is OURS, not the source's, and sanitizeContent strips it from the
		// output: its only job is to let the reject-whole filter tell a rebuilt element from a raw one that slipped through.
		const marked = [...attrs, ["data-embark-svg", "1"] as [string, string]];
		const parts = marked.map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`);
		return `<${name}${parts.join("")}>`;
	};

	const out: string[] = [];
	const stack: string[] = [];
	for (const t of ts) {
		if (!SVG_TAGS.has(t.name)) return null;
		if (t.kind === "close") {
			const top = stack.pop();
			if (top !== t.name) return null;
			out.push(`</${t.name}>`);
			continue;
		}
		const attrs: Array<[string, string]> = [];
		for (const [rawName, value] of t.attrs) {
			const kept = validatedAttribute(t.name, rawName, value);
			if (kept) attrs.push(kept);
		}
		// A `path` with no usable `d` draws nothing and would be a bare element in the tree: refuse it with its subtree.
		if (t.name === "path" && !attrs.some(([k]) => k === "d")) return null;
		out.push(emit(t, t.name, attrs));
		if (t.kind === "self") {
			// Self-closing is legal in SVG, but emit it closed so the fragment is well-formed whatever the caller does next.
			if (t.name === "svg") return null;
			out[out.length - 1] = out[out.length - 1].replace(/>$/, `></${t.name}>`);
			continue;
		}
		stack.push(t.name);
	}
	if (stack.length !== 0) return null;
	return out.join("");
}

/**
 * Replace every complete inline `<svg>` in `html` with its validated rebuild, or with nothing when the subtree is refused.
 *
 * Only complete elements are touched: an `<svg>` whose close tag is missing is left to `sanitizeContent`, which strips it — a
 * half-matched element is not something this pass should guess about.
 */
export function carryInlineSvg(html: string): string {
	if (!/<svg[\s>]/i.test(html)) return html;
	return html.replace(/<svg[\s>][\s\S]*?<\/svg\s*>/gi, (whole) => rebuildSvg(whole) ?? "");
}
