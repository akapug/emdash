import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
	ANALYTICS_PROVIDERS,
	ANALYTICS_SETTING,
	analyticsHead,
	isMatomoBase,
	parseAnalyticsSetting,
	parseAnalyticsSettingCached,
} from "../../../../../templates/blog-cloudflare/src/utils/analytics";
import writerSettings from "./analytics-writer-settings.json";

const GA4 = "G-ABC123DEF4";
const template = (rel: string): string =>
	readFileSync(
		new URL(`../../../../../templates/blog-cloudflare/src/${rel}`, import.meta.url),
		"utf8",
	);

/** Every script address a rendered head loads. */
const srcs = (html: string): string[] =>
	Array.from(html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g), (m) => m[1] ?? "");

/** The only script addresses a tag may load: fixed per provider, or Matomo's checked base. */
const ALLOWED_SCRIPT = [
	/^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=GT?-[A-Z0-9]+$/,
	/^https:\/\/www\.googletagmanager\.com\/gtm\.js\?id=GTM-[A-Z0-9]+$/,
	/^https:\/\/plausible\.io\/js\/script\.js$/,
	/^https:\/\/cdn\.usefathom\.com\/script\.js$/,
	/^https:\/\/matomo\.example\.org\/matomo\.js$/,
	/^https:\/\/cdn\.matomo\.cloud\/example\.matomo\.cloud\/matomo\.js$/,
	/^https:\/\/www\.clarity\.ms\/tag\/[a-z0-9]+$/,
	/^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js$/,
];

describe("the analytics setting, as Embark's writer produces it", () => {
	it.each(writerSettings.map((s) => [s.tags.map((t) => t.provider).join("+"), s] as const))(
		"%s is read and rendered from fixed script addresses",
		(_name, setting) => {
			const tags = parseAnalyticsSetting(setting);
			expect(tags).toEqual(setting.tags);
			const html = analyticsHead(tags);
			expect(html).not.toBe("");
			for (const src of srcs(html)) {
				expect(
					ALLOWED_SCRIPT.some((re) => re.test(src)),
					src,
				).toBe(true);
			}
			for (const tag of tags) expect(html).toContain(`data-site-analytics="${tag.provider}"`);
		},
	);

	it("every provider has a writer fixture", () => {
		const covered = new Set(writerSettings.flatMap((s) => s.tags.map((t) => t.provider)));
		expect([...covered].toSorted()).toEqual([...ANALYTICS_PROVIDERS].toSorted());
	});

	it("renders GA4's documented snippet around the id", () => {
		expect(analyticsHead([{ provider: "ga4", id: GA4 }])).toBe(
			`<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4}" data-site-analytics="ga4"></script>` +
				`<script data-site-analytics="ga4">window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","${GA4}");</script>`,
		);
	});

	it("renders Cloudflare's token as the JSON attribute its beacon reads", () => {
		const html = analyticsHead([
			{ provider: "cloudflare", id: "0123456789abcdef0123456789abcdef" },
		]);
		expect(html).toContain(
			'data-cf-beacon="{&quot;token&quot;:&quot;0123456789abcdef0123456789abcdef&quot;}"',
		);
	});

	it("renders nothing for no setting", () => {
		expect(parseAnalyticsSetting(undefined)).toEqual([]);
		expect(parseAnalyticsSetting(null)).toEqual([]);
		expect(analyticsHead([])).toBe("");
	});
});

describe("a setting that is not exactly the allow-listed shape renders no tag at all", () => {
	const good = { provider: "ga4", id: GA4 };
	it.each([
		["another version", { version: 2, tags: [good] }],
		["an unknown key", { version: 1, tags: [good], script: "https://attacker.example/x.js" }],
		[
			"a script address on the tag",
			{ version: 1, tags: [{ ...good, src: "https://attacker.example/x.js" }] },
		],
		["an unknown provider", { version: 1, tags: [{ provider: "umami", id: "x" }] }],
		["an id out of its format", { version: 1, tags: [{ provider: "ga4", id: "g-abc123def4" }] }],
		[
			"markup in an id",
			{ version: 1, tags: [{ provider: "ga4", id: `${GA4}"></script><script>alert(1)</script>` }] },
		],
		[
			"a domain that is a URL",
			{ version: 1, tags: [{ provider: "plausible", id: "https://example.org" }] },
		],
		[
			"two tags for one provider",
			{ version: 1, tags: [good, { provider: "ga4", id: "G-ZZZ999YYY8" }] },
		],
		[
			"a Matomo base over http",
			{ version: 1, tags: [{ provider: "matomo", id: "3", url: "http://matomo.example.org/" }] },
		],
		[
			"a Matomo base with a query",
			{
				version: 1,
				tags: [{ provider: "matomo", id: "3", url: "https://matomo.example.org/?x=1" }],
			},
		],
		[
			"a Matomo base with a port",
			{
				version: 1,
				tags: [{ provider: "matomo", id: "3", url: "https://matomo.example.org:8443/" }],
			},
		],
		[
			"a Matomo base not in its stored form",
			{ version: 1, tags: [{ provider: "matomo", id: "3", url: "https://MATOMO.example.org" }] },
		],
		["a Matomo tag with no base", { version: 1, tags: [{ provider: "matomo", id: "3" }] }],
		["a tags value that is not a list", { version: 1, tags: good }],
		["a string", JSON.stringify({ version: 1, tags: [good] })],
	])("%s", (_name, value) => {
		const warn = vi.fn();
		expect(parseAnalyticsSetting(value, warn)).toEqual([]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("Matomo's base is an https origin with a plain path, exactly as stored", () => {
		expect(isMatomoBase("https://example.org/stats/")).toBe(true);
		expect(isMatomoBase("https://example.org/stats")).toBe(false);
		expect(isMatomoBase("https://192.0.2.1/")).toBe(false);
		expect(isMatomoBase("https://u:p@example.org/")).toBe(false);
	});

	it("parses one stored value once", () => {
		const value = { version: 1, tags: [good] };
		const warn = vi.fn();
		expect(parseAnalyticsSettingCached(value, warn)).toBe(parseAnalyticsSettingCached(value, warn));
		expect(warn).not.toHaveBeenCalled();
	});
});

describe("both layouts render the tag in <head>", () => {
	// Look C: a migrated site wears its WordPress design through WpShell.astro,
	// whose captured chrome has every script removed, so the tag must come from
	// the template. The template's own design (Base.astro) renders it too.
	it.each(["layouts/WpShell.astro", "layouts/Base.astro"])("%s", (rel) => {
		const source = template(rel);
		const head = source.slice(source.indexOf("<head>"), source.indexOf("</head>"));
		expect(source).toContain('import SiteAnalytics from "../components/SiteAnalytics.astro";');
		expect(head).toMatch(/<SiteAnalytics settings=\{settings(?:Result\.data)?\} \/>/);
	});

	it("the component reads the one setting and renders only analyticsHead's markup", () => {
		const source = template("components/SiteAnalytics.astro");
		expect(source).toContain("Reflect.get(Astro.props.settings, ANALYTICS_SETTING)");
		expect(source).toContain("{html && <Fragment set:html={html} />}");
		expect(ANALYTICS_SETTING).toBe("analyticsTag");
	});
});
