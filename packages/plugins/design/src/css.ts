/**
 * Types, CSS selector/value sanitization, and stylesheet compilation for
 * @emdash-cms/plugin-design (emb/27).
 *
 * Security invariants:
 * - Selectors are length- and complexity-capped and reject `<`, `{`, `}`, `;`,
 *   `@`, comments, backslashes, and control characters so a rule can never
 *   break out of `<style data-embark-design>` or inject at-rules.
 * - Declarations are restricted to an explicit allowlist of visual properties.
 * - Values reject `expression()`, `javascript:`, `vbscript:`, `behavior:`,
 *   `-moz-binding`, `@import`, comments, `<`, `{`, `}`, `;`, backslashes, and
 *   any `url(...)` outside same-site media paths (`/_emdash/api/media/...` or
 *   `/uploads/...`).
 */

export interface ElementFingerprint {
	tag: string;
	textHash: string;
}

export type DesignRuleStatus = "active" | "element_changed";

export interface DesignRule {
	id: string;
	selector: string;
	declarations: Record<string, string>;
	fingerprint: ElementFingerprint;
	/** Optional pathname scope (e.g. "/about"). Omitted means site-wide. */
	pagePath?: string;
	status: DesignRuleStatus;
	updatedBy: string;
	at: string;
}

export const MAX_RULES = 100;
export const MAX_HISTORY = 25;
export const MAX_SELECTOR_LEN = 200;
export const MAX_SELECTOR_PARTS = 8;
export const MAX_VALUE_LEN = 200;

export const ALLOWED_CSS_PROPERTIES: ReadonlySet<string> = new Set([
	"color",
	"background",
	"background-color",
	"background-image",
	"font-size",
	"font-weight",
	"line-height",
	"letter-spacing",
	"text-align",
	"padding",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"margin",
	"margin-top",
	"margin-right",
	"margin-bottom",
	"margin-left",
	"border",
	"border-color",
	"border-radius",
	"opacity",
	"max-width",
	"gap",
	"display",
]);

const FORBIDDEN_SELECTOR_RE = /[<{}@;\\]|\/\*|\*\/|[\x00-\x1f\x7f]|expression\s*\(|javascript:|url\s*\(/i;
const SAFE_SELECTOR_CHARS_RE = /^[A-Za-z0-9_#.\-\s>+~:()[\]="'*,]+$/;

const FORBIDDEN_VALUE_RE =
	/[<>{};\\]|\/\*|\*\/|[\x00-\x1f\x7f]|@import|expression\s*\(|javascript:|vbscript:|behavior\s*:|-moz-binding/i;

const URL_CALL_RE = /url\s*\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
const SAFE_SITE_MEDIA_PATH_RE = /^\/(?:_emdash\/api\/media\/|uploads\/)[A-Za-z0-9/_.~-]+$/;

const SAFE_DISPLAY_VALUES = new Set(["none", "block", "inline", "inline-block", "flex", "grid"]);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate and normalize a CSS selector for a design tweak rule.
 */
export function sanitizeSelector(raw: unknown): ValidationResult<string> {
	if (typeof raw !== "string") return { ok: false, error: "selector must be a string" };
	const trimmed = raw.trim().replace(/\s+/g, " ");
	if (trimmed.length === 0) return { ok: false, error: "selector cannot be empty" };
	if (trimmed.length > MAX_SELECTOR_LEN) {
		return { ok: false, error: `selector exceeds ${MAX_SELECTOR_LEN} characters` };
	}
	if (FORBIDDEN_SELECTOR_RE.test(trimmed)) {
		return { ok: false, error: "selector contains forbidden characters or constructs" };
	}
	if (!SAFE_SELECTOR_CHARS_RE.test(trimmed)) {
		return { ok: false, error: "selector contains unsupported characters" };
	}
	// Reject comma-separated selector lists to keep one rule scoped to one target.
	if (trimmed.includes(",")) {
		return { ok: false, error: "selector must target a single element (no commas)" };
	}
	const parts = trimmed.split(/\s*(?:>|\+|~|\s)\s*/).filter(Boolean);
	if (parts.length === 0 || parts.length > MAX_SELECTOR_PARTS) {
		return { ok: false, error: `selector complexity exceeds ${MAX_SELECTOR_PARTS} segments` };
	}
	return { ok: true, value: trimmed };
}

/**
 * Validate and sanitize a single CSS property/value pair.
 */
export function sanitizeCssDeclaration(
	rawProp: unknown,
	rawValue: unknown,
): ValidationResult<{ prop: string; value: string }> {
	if (typeof rawProp !== "string" || typeof rawValue !== "string") {
		return { ok: false, error: "property and value must be strings" };
	}
	const prop = rawProp.trim().toLowerCase();
	if (!ALLOWED_CSS_PROPERTIES.has(prop)) {
		return { ok: false, error: `CSS property "${prop}" is not allowed` };
	}
	const value = rawValue.trim();
	if (value.length === 0) return { ok: false, error: `value for "${prop}" cannot be empty` };
	if (value.length > MAX_VALUE_LEN) {
		return { ok: false, error: `value for "${prop}" exceeds ${MAX_VALUE_LEN} characters` };
	}
	if (FORBIDDEN_VALUE_RE.test(value)) {
		return { ok: false, error: `value for "${prop}" contains forbidden CSS constructs` };
	}
	if (prop === "display" && !SAFE_DISPLAY_VALUES.has(value.toLowerCase())) {
		return { ok: false, error: `display value "${value}" is not allowed` };
	}
	// Check every url(...) reference: only same-site media paths are permitted.
	URL_CALL_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = URL_CALL_RE.exec(value)) !== null) {
		const target = (match[2] ?? "").trim();
		if (target.includes("..") || !SAFE_SITE_MEDIA_PATH_RE.test(target)) {
			return { ok: false, error: `url() in "${prop}" must reference same-site media only` };
		}
	}
	// Reject bare `url(` that didn't match well-formed url(...) above (e.g., nested/unclosed).
	const strippedUrls = value.replace(URL_CALL_RE, "");
	if (/url\s*\(/i.test(strippedUrls)) {
		return { ok: false, error: `malformed url() in "${prop}"` };
	}
	return { ok: true, value: { prop, value } };
}

/**
 * Validate and sanitize a full declarations map.
 */
export function sanitizeDeclarations(raw: unknown): ValidationResult<Record<string, string>> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ok: false, error: "declarations must be an object" };
	}
	const entries = Object.entries(raw as Record<string, unknown>);
	if (entries.length === 0) return { ok: false, error: "declarations cannot be empty" };
	const clean: Record<string, string> = {};
	for (const [prop, val] of entries) {
		const res = sanitizeCssDeclaration(prop, val);
		if (!res.ok) return res;
		clean[res.value.prop] = res.value.value;
	}
	return { ok: true, value: clean };
}

/**
 * Normalize an optional pathname scope. Returns undefined for site-wide rules.
 */
export function sanitizePagePath(raw: unknown): ValidationResult<string | undefined> {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
	if (typeof raw !== "string") return { ok: false, error: "pagePath must be a string" };
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//") || /[\x00-\x1f\x7f\\]/.test(trimmed)) {
		return { ok: false, error: "pagePath must be a site-relative path starting with /" };
	}
	if (trimmed.length > 256) return { ok: false, error: "pagePath too long" };
	const normalized = trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : "/";
	return { ok: true, value: normalized };
}

function normalizePathForMatch(pathname: string): string {
	const clean = pathname.split(/[?#]/)[0] || "/";
	return clean.length > 1 ? clean.replace(/\/+$/, "") : "/";
}

/**
 * Compile active rules (matching `currentPath` when scoped) into one CSS string.
 * Re-validates every rule defensively before emission so even corrupted KV data
 * can never inject raw HTML or unsafe CSS into `<style data-embark-design>`.
 */
export function compileDesignCss(rules: readonly DesignRule[], currentPath?: string): string {
	const targetPath = currentPath !== undefined ? normalizePathForMatch(currentPath) : undefined;
	const blocks: string[] = [];
	for (const rule of rules) {
		if (rule.status !== "active") continue;
		if (rule.pagePath && targetPath !== undefined && normalizePathForMatch(rule.pagePath) !== targetPath) {
			continue;
		}
		const sel = sanitizeSelector(rule.selector);
		if (!sel.ok) continue;
		const decls = sanitizeDeclarations(rule.declarations);
		if (!decls.ok) continue;
		const body = Object.entries(decls.value)
			.map(([p, v]) => `${p}: ${v};`)
			.join(" ");
		blocks.push(`${sel.value} { ${body} }`);
	}
	return blocks.join("\n");
}
