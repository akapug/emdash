/**
 * The site's own visitor analytics, rendered in <head> from a site setting.
 *
 * A site migrated from WordPress counted its visits with a tag in its theme or
 * a plugin, and neither moves: the captured design (layouts/WpShell.astro)
 * carries no script by design, and no WordPress plugin runs here. So the
 * migration stores what the site measured with as DATA, the options row
 * `site:analyticsTag`, and this module turns it into the provider's documented
 * snippet. Both layouts render it (components/SiteAnalytics.astro), so a site
 * that wears its WordPress design keeps counting, and one on the template's own
 * design does too.
 *
 * WHAT IS STORED IS AN ID, NEVER A SCRIPT. The setting names a provider from a
 * closed list and that provider's public id; the id must match the provider's
 * exact format, and the script address is fixed here, per provider. Nothing in
 * the setting says where a script lives, except Matomo's tracker base, which is
 * the id's other half and must be an https origin with a plain path. A value
 * that is anything else is refused WHOLE, and the page renders no tag at all.
 *
 * Every value this module interpolates has passed its format check, which
 * admits no quote, angle bracket, ampersand or backslash; it is escaped for its
 * context anyway (attribute, or JSON inside a script).
 *
 * CSP. EmDash sets a Content-Security-Policy on its own /_emdash routes only
 * (astro/middleware/csp.ts), none on public pages, and this template sets
 * none, so the tag needs no header change. A site that adds a CSP allows its
 * provider's script host: www.googletagmanager.com (ga4, gtm), plausible.io,
 * cdn.usefathom.com, the Matomo base's host or cdn.matomo.cloud, www.clarity.ms,
 * static.cloudflareinsights.com; and the host each reports to.
 *
 * The same formats are checked by the writer (Embark's
 * `packages/control-plane/src/tools/analytics.ts`); the tests read the settings
 * the writer produces.
 *
 * WHY A SITE SETTING. Like the shell record, every public page already reads
 * the `site:*` rows once per isolate per 30 s through EmDash's settings cache,
 * so this costs no query of its own, follows the settings cache hint, and rides
 * the site's database into its backups and exports. EmDash's `page:fragments`
 * hook would need a trusted plugin package, and a plugin's settings are read on
 * every render.
 *
 * This module is pure (no EmDash runtime import) so the unit tests reach it.
 */

/** The site setting: the options row `site:analyticsTag`. */
export const ANALYTICS_SETTING = "analyticsTag";

/** The setting's schema version. A reader refuses any other. */
export const ANALYTICS_VERSION = 1;

/** The providers, in the order their tags are rendered. */
export const ANALYTICS_PROVIDERS = [
	"ga4",
	"gtm",
	"plausible",
	"fathom",
	"matomo",
	"clarity",
	"cloudflare",
] as const;
export type AnalyticsProvider = (typeof ANALYTICS_PROVIDERS)[number];

export interface AnalyticsTag {
	provider: AnalyticsProvider;
	id: string;
	/** Matomo's tracker base, and only Matomo's. */
	url?: string;
}

const HOSTNAME =
	/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Each provider's id, exactly. */
export const ANALYTICS_ID_FORMAT: Readonly<Record<AnalyticsProvider, RegExp>> = {
	// A GA4 measurement id (G-), or the Google tag id (GT-) gtag.js loads the same way.
	ga4: /^GT?-[A-Z0-9]{6,12}$/,
	gtm: /^GTM-[A-Z0-9]{4,10}$/,
	// The domain the site is registered under in Plausible.
	plausible: HOSTNAME,
	fathom: /^[A-Z0-9]{5,10}$/,
	matomo: /^[1-9][0-9]{0,6}$/,
	clarity: /^[a-z0-9]{6,16}$/,
	cloudflare: /^[a-f0-9]{32}$/,
};

const MATOMO_PATH = /^\/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,63}\/){0,8}$/;

/** Matomo's tracker base, when `raw` is already exactly an https origin plus a plain path ending in "/". */
export function isMatomoBase(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length > 300 || !URL.canParse(raw)) return false;
	const u = new URL(raw);
	return (
		u.protocol === "https:" &&
		u.username === "" &&
		u.password === "" &&
		u.port === "" &&
		u.search === "" &&
		u.hash === "" &&
		HOSTNAME.test(u.hostname) &&
		MATOMO_PATH.test(u.pathname) &&
		raw === `https://${u.hostname}${u.pathname}`
	);
}

const isProvider = (v: unknown): v is AnalyticsProvider => ANALYTICS_PROVIDERS.some((p) => p === v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const keysOf = (v: Record<string, unknown>): string => Object.keys(v).toSorted().join(",");

function parseTag(v: unknown): AnalyticsTag | null {
	if (!isRecord(v) || !isProvider(v.provider) || typeof v.id !== "string") return null;
	if (!ANALYTICS_ID_FORMAT[v.provider].test(v.id)) return null;
	const keys = keysOf(v);
	if (v.provider === "matomo") {
		return keys === "id,provider,url" && isMatomoBase(v.url)
			? { provider: "matomo", id: v.id, url: v.url }
			: null;
	}
	return keys === "id,provider" ? { provider: v.provider, id: v.id } : null;
}

/**
 * The tags the setting holds, or `[]` with the reason when it holds anything
 * but a version 1 setting of allow-listed tags, one per provider.
 */
export function parseAnalyticsSetting(
	value: unknown,
	warn: (why: string) => void = () => {},
): AnalyticsTag[] {
	if (value === undefined || value === null) return [];
	const refuse = (why: string): AnalyticsTag[] => {
		warn(why);
		return [];
	};
	if (!isRecord(value)) return refuse("not an object");
	const v = value;
	if (v.version !== ANALYTICS_VERSION) return refuse(`version ${String(v.version)}`);
	if (keysOf(v) !== "tags,version") return refuse("unknown keys");
	if (!Array.isArray(v.tags) || v.tags.length > ANALYTICS_PROVIDERS.length)
		return refuse("tags is not a list of at most one per provider");
	const tags: AnalyticsTag[] = [];
	for (const raw of v.tags) {
		const tag = parseTag(raw);
		if (!tag) return refuse("a tag that is not an allow-listed provider with an id in its format");
		if (tags.some((t) => t.provider === tag.provider)) return refuse("two tags for one provider");
		tags.push(tag);
	}
	return ANALYTICS_PROVIDERS.flatMap((p) => tags.filter((t) => t.provider === p));
}

const ATTR_ESCAPES: Readonly<Record<string, string>> = {
	"&": "&amp;",
	'"': "&quot;",
	"'": "&#39;",
	"<": "&lt;",
	">": "&gt;",
};
const attr = (s: string): string => s.replace(/[&"'<>]/g, (c) => ATTR_ESCAPES[c] ?? c);
/** A JSON string literal that cannot close a script element. */
const js = (s: string): string =>
	JSON.stringify(s).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

/** Marks every element this module renders, so the operator tool can see the tag is served. */
const MARK = (p: AnalyticsProvider): string => `data-site-analytics="${p}"`;

/** Matomo Cloud serves its tracker from its CDN; a self-hosted Matomo from its own base. */
function matomoScript(base: string): string {
	const host = new URL(base).hostname;
	return host.endsWith(".matomo.cloud")
		? `https://cdn.matomo.cloud/${host}/matomo.js`
		: `${base}matomo.js`;
}

/** One provider's documented snippet, its script address fixed here. */
function snippet(tag: AnalyticsTag): string {
	const id = tag.id;
	const mark = MARK(tag.provider);
	switch (tag.provider) {
		case "ga4":
			return (
				`<script async src="https://www.googletagmanager.com/gtag/js?id=${attr(id)}" ${mark}></script>` +
				`<script ${mark}>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",${js(id)});</script>`
			);
		case "gtm":
			return (
				`<script ${mark}>window.dataLayer=window.dataLayer||[];window.dataLayer.push({"gtm.start":new Date().getTime(),event:"gtm.js"});</script>` +
				`<script async src="https://www.googletagmanager.com/gtm.js?id=${attr(id)}" ${mark}></script>`
			);
		case "plausible":
			return `<script defer data-domain="${attr(id)}" src="https://plausible.io/js/script.js" ${mark}></script>`;
		case "fathom":
			return `<script defer src="https://cdn.usefathom.com/script.js" data-site="${attr(id)}" ${mark}></script>`;
		case "matomo": {
			const base = tag.url ?? "";
			return (
				`<script ${mark}>var _paq=window._paq=window._paq||[];_paq.push(["trackPageView"]);_paq.push(["enableLinkTracking"]);` +
				`_paq.push(["setTrackerUrl",${js(`${base}matomo.php`)}]);_paq.push(["setSiteId",${js(id)}]);</script>` +
				`<script async src="${attr(matomoScript(base))}" ${mark}></script>`
			);
		}
		case "clarity":
			return (
				`<script ${mark}>window.clarity=window.clarity||function(){(window.clarity.q=window.clarity.q||[]).push(arguments)};</script>` +
				`<script async src="https://www.clarity.ms/tag/${attr(id)}" ${mark}></script>`
			);
		case "cloudflare":
			return `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="${attr(JSON.stringify({ token: id }))}" ${mark}></script>`;
	}
}

/** The <head> markup for the setting's tags; empty when there are none. */
export function analyticsHead(tags: readonly AnalyticsTag[]): string {
	return tags.map(snippet).join("");
}

/** Parse once per stored value, like the shell record: settings are cached per isolate. */
let cached: { raw: unknown; tags: AnalyticsTag[] } | null = null;
export function parseAnalyticsSettingCached(
	value: unknown,
	warn: (why: string) => void = () => {},
): AnalyticsTag[] {
	if (cached && cached.raw === value) return cached.tags;
	const tags = parseAnalyticsSetting(value, warn);
	cached = { raw: value, tags };
	return tags;
}
