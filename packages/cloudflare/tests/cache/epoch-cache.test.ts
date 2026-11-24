import type { APIContext } from "astro";
import { optInPageCache, optOutPageCache } from "emdash";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	env: {},
	waitUntil: (p: Promise<unknown>) => {
		void p;
	},
}));

import {
	createEpochCacheProvider,
	hasOnlyAllowedCookies,
	isAllowlistedPublicPath,
} from "../../src/cache/epoch-runtime.js";

/** In-memory Cache API double supporting exact URL Request keys. */
function makeFakeCache(): { cache: Cache; store: Map<string, Response>; putCalls: number } {
	const store = new Map<string, Response>();
	const state = { putCalls: 0 };
	const cache = {
		async match(req: RequestInfo | URL): Promise<Response | undefined> {
			const key = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
			const hit = store.get(key);
			return hit ? hit.clone() : undefined;
		},
		async put(req: RequestInfo | URL, res: Response): Promise<void> {
			state.putCalls++;
			const key = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
			store.set(key, res.clone());
		},
		async delete(req: RequestInfo | URL): Promise<boolean> {
			const key = typeof req === "string" ? req : req instanceof URL ? req.toString() : req.url;
			return store.delete(key);
		},
	} as unknown as Cache;
	return {
		cache,
		store,
		get putCalls() {
			return state.putCalls;
		},
	};
}

function makeContext(
	urlStr: string,
	init: RequestInit = {},
	queuedCookies: string[] = [],
): APIContext {
	const url = new URL(urlStr);
	const request = new Request(url, init);
	return {
		request,
		url,
		cookies: {
			headers: function* () {
				for (const c of queuedCookies) yield c;
			},
		},
	} as unknown as APIContext;
}

describe("Item 124: epochCloudflareCache full-page cache", () => {
	it("is OFF by default when EMDASH_PAGE_CACHE is unset and uses a distinct provider name", async () => {
		const fake = makeFakeCache();
		let renders = 0;
		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({}),
				openCache: async () => fake.cache,
				schedule: (p) => void p,
				readVector: async () => ({ vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0", certain: true }),
				readVisibilityRev: async () => "1",
			},
		);
		expect(provider.name).toBe("emdash-epoch-cache");
		expect(provider.name).not.toBe("cloudflare");

		const res = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/about"),
			async () => {
				renders++;
				optInPageCache(300);
				return new Response("<h1>About</h1>", {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		);
		expect(renders).toBe(1);
		expect(res.headers.get("x-embark-page-cache")).toBeNull();
		expect(fake.putCalls).toBe(0);
	});

	it("serves MISS -> HIT on allowlisted public routes, strips internal/CDN headers, and isolates distinct hosts", async () => {
		const fake = makeFakeCache();
		const pending: Promise<unknown>[] = [];
		let renders = 0;
		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache: async () => fake.cache,
				schedule: (p) => pending.push(p),
				readVector: async () => ({ vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0", certain: true }),
				readVisibilityRev: async () => "1",
				now: () => 10_000,
			},
		);

		const render = (label: string) => async () => {
			renders++;
			optInPageCache(300);
			return new Response(`<h1>${label}</h1>`, {
				status: 200,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cdn-cache-control": "max-age=600",
				},
			});
		};

		const r1 = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/about"),
			render("Acme"),
		);
		await Promise.all(pending);
		expect(r1.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(r1.headers.get("cdn-cache-control")).toBeNull();
		expect(r1.headers.get("cache-control")).toBe("private, no-cache");
		expect(await r1.text()).toBe("<h1>Acme</h1>");
		expect(renders).toBe(1);

		const r2 = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/about"),
			render("ShouldNotRun"),
		);
		expect(r2.headers.get("x-embark-page-cache")).toBe("HIT");
		expect(r2.headers.get("x-emdash-page-vector")).toBeNull();
		expect(r2.headers.get("x-emdash-visibility-rev")).toBeNull();
		expect(r2.headers.get("cache-control")).toBe("private, no-cache");
		expect(await r2.text()).toBe("<h1>Acme</h1>");
		expect(renders).toBe(1);

		// Distinct host must NOT hit acme's entry
		const r3 = await provider.onRequest!(
			makeContext("https://other.sites.embarkeasy.com/pages/about"),
			render("Other"),
		);
		expect(r3.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(await r3.text()).toBe("<h1>Other</h1>");
		expect(renders).toBe(2);
	});

	it("bypasses ineligible requests (workers.dev, query strings, non-allowlisted paths, unknown/malformed cookies, auth/CF-Access, conditional/range, playground)", async () => {
		const fake = makeFakeCache();
		const pending: Promise<unknown>[] = [];
		const openCache = vi.fn(async () => fake.cache);
		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache,
				schedule: (p) => pending.push(p),
				readVector: async () => ({ vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0", certain: true }),
				readVisibilityRev: async () => "1",
			},
		);

		const cases: Array<[string, RequestInit?]> = [
			["https://site.example.workers.dev/pages/about"],
			["https://acme.sites.embarkeasy.com/pages/about?utm_source=x"],
			["https://acme.sites.embarkeasy.com/pages/about?_preview=tok"],
			["https://acme.sites.embarkeasy.com/_emdash/admin"],
			["https://acme.sites.embarkeasy.com/events/"],
			["https://acme.sites.embarkeasy.com/search"],
			["https://acme.sites.embarkeasy.com/pages/about", { method: "POST" }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { cookie: "astro-session=abc" } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { cookie: "unknown=1" } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { cookie: "malformed" } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { authorization: "Bearer tok" } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { "cf-access-jwt-assertion": "jwt" } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { "if-modified-since": "Mon, 01 Jan 2024 00:00:00 GMT" } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { "if-none-match": '"old"' } }],
			["https://acme.sites.embarkeasy.com/pages/about", { headers: { range: "bytes=0-10" } }],
		];

		for (const [url, init] of cases) {
			const res = await provider.onRequest!(makeContext(url, init), async () => {
				optInPageCache(300);
				return new Response("ok", { status: 200, headers: { "content-type": "text/html" } });
			});
			expect(res.headers.get("x-embark-page-cache"), `expected BYPASS for ${url}`).toBe("BYPASS");
		}
		expect(openCache).not.toHaveBeenCalled();
		expect(fake.putCalls).toBe(0);

		// Playground mode bypasses even allowlisted routes
		const pgProvider = createEpochCacheProvider(
			{ buildId: "b1", disabledWhenPlayground: true },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache,
				readVector: async () => ({ vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0", certain: true }),
				readVisibilityRev: async () => "1",
			},
		);
		const pgRes = await pgProvider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/about"),
			async () => new Response("pg", { status: 200, headers: { "content-type": "text/html" } }),
		);
		expect(pgRes.headers.get("x-embark-page-cache")).toBe("BYPASS");
		expect(openCache).not.toHaveBeenCalled();
	});

	it("keeps delayed nested/streamed opt-out irreversibly sticky even if a later call attempts optInPageCache", async () => {
		const fake = makeFakeCache();
		const pending: Promise<unknown>[] = [];
		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache: async () => fake.cache,
				schedule: (p) => pending.push(p),
				readVector: async () => ({ vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0", certain: true }),
				readVisibilityRev: async () => "1",
			},
		);

		const res = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/upcoming"),
			async () => {
				// Outer page opts in before streaming starts
				optInPageCache(300);
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("<h1>Upcoming</h1>"));
						// Delayed nested component (e.g. EventEmbed) opts out mid-stream
						optOutPageCache();
						// Later component tries to re-enable — must stay opted out
						optInPageCache(300);
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		);
		await Promise.all(pending);
		expect(res.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(await res.text()).toBe("<h1>Upcoming</h1>");
		expect(fake.putCalls).toBe(0);
	});

	it("blocks storage on queued non-bookmark Astro cookies, and strips __em_d1_bookmark ONLY from stored copy while preserving it on MISS", async () => {
		const fake = makeFakeCache();
		const pending: Promise<unknown>[] = [];
		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache: async () => fake.cache,
				schedule: (p) => pending.push(p),
				readVector: async () => ({ vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0", certain: true }),
				readVisibilityRev: async () => "1",
				now: () => 10_000,
			},
		);

		// Queued non-bookmark Astro cookie blocks storage
		const rBlocked = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/queued", {}, ["astro-session=secret; Path=/"]),
			async () => {
				optInPageCache(300);
				return new Response("secret", { status: 200, headers: { "content-type": "text/html" } });
			},
		);
		await Promise.all(pending);
		expect(rBlocked.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(fake.putCalls).toBe(0);

		// Bookmark-only Set-Cookie reaches MISS visitor, stripped from stored copy & HIT
		const rMiss = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/bookmark"),
			async () => {
				optInPageCache(300);
				return new Response("hello", {
					status: 200,
					headers: {
						"content-type": "text/html",
						"set-cookie": "__em_d1_bookmark=bk-1; Path=/; HttpOnly",
					},
				});
			},
		);
		await Promise.all(pending);
		expect(rMiss.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(rMiss.headers.getSetCookie()).toEqual(["__em_d1_bookmark=bk-1; Path=/; HttpOnly"]);
		expect(fake.putCalls).toBe(1);

		const rHit = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/bookmark"),
			async () => new Response("should-not-run", { status: 200, headers: { "content-type": "text/html" } }),
		);
		expect(rHit.headers.get("x-embark-page-cache")).toBe("HIT");
		expect(rHit.headers.getSetCookie()).toEqual([]);
	});

	it("revokes cached public page immediately on public->private transition even while KV is stale or failing", async () => {
		const fake = makeFakeCache();
		const pending: Promise<unknown>[] = [];
		let visRev: string | null = "100";
		let kvCertain = true;
		let version = 1;

		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache: async () => fake.cache,
				schedule: (p) => pending.push(p),
				// KV stays completely stale at the exact same vector!
				readVector: async () => ({
					vector: "v1|b=b1|s=1|m=0|t=0|y=0|c=0|w=0|lc=0|p=0",
					certain: kvCertain,
				}),
				readVisibilityRev: async () => visRev,
				now: () => 10_000,
			},
		);

		// 1. Warm public page -> MISS then HIT
		const r1 = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/secret"),
			async () => {
				optInPageCache(300);
				return new Response(`public-v${version}`, { status: 200, headers: { "content-type": "text/html" } });
			},
		);
		await Promise.all(pending);
		expect(r1.headers.get("x-embark-page-cache")).toBe("MISS");

		const r2 = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/secret"),
			async () => new Response("unexpected", { status: 200, headers: { "content-type": "text/html" } }),
		);
		expect(r2.headers.get("x-embark-page-cache")).toBe("HIT");
		expect(await r2.text()).toBe("public-v1");

		// 2. Page transitions to draft/password-protected -> D1 primary bumps visRev, KV is STILL STALE!
		visRev = "101";
		version = 2;
		const r3 = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/secret"),
			async () => {
				optOutPageCache();
				return new Response("password-challenge", {
					status: 200,
					headers: { "content-type": "text/html", "cache-control": "private, no-store" },
				});
			},
		);
		expect(r3.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(await r3.text()).toBe("password-challenge");

		// 3. Even if D1 visibility check errors (null) or KV becomes uncertain -> fails CLOSED (never HIT)
		visRev = null;
		kvCertain = false;
		const r4 = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/secret"),
			async () => new Response("live-fallback", { status: 200, headers: { "content-type": "text/html" } }),
		);
		expect(r4.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(await r4.text()).toBe("live-fallback");
	});

	it("invalidates on non-max epoch change, rejects storage on mid-render vector change, and expires without SWR", async () => {
		const fake = makeFakeCache();
		const pending: Promise<unknown>[] = [];
		let vector = "v1|b=b1|s=9999|m=0|t=0|y=0|c=0|w=0|lc=0|p=0";
		let clock = 10_000;

		const provider = createEpochCacheProvider(
			{ buildId: "b1" },
			{
				getEnv: () => ({ EMDASH_PAGE_CACHE: "1" }),
				openCache: async () => fake.cache,
				schedule: (p) => pending.push(p),
				readVector: async () => ({ vector, certain: true }),
				readVisibilityRev: async () => "1",
				now: () => clock,
			},
		);

		// Warm with s=9999, w=0
		await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/home"),
			async () => {
				optInPageCache(60);
				return new Response("v1", { status: 200, headers: { "content-type": "text/html" } });
			},
		);
		await Promise.all(pending);

		// Non-max namespace bump (w=0 -> w=1 while s stays 9999) MUST invalidate HIT
		vector = "v1|b=b1|s=9999|m=0|t=0|y=0|c=0|w=1|lc=0|p=0";
		const rNonMax = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/home"),
			async () => {
				optInPageCache(60);
				return new Response("v2", { status: 200, headers: { "content-type": "text/html" } });
			},
		);
		await Promise.all(pending);
		expect(rNonMax.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(await rNonMax.text()).toBe("v2");

		// Mid-render mutation rejects storage
		const putsBefore = fake.putCalls;
		const rMid = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/mid"),
			async () => {
				optInPageCache(60);
				vector = "v1|b=b1|s=9999|m=0|t=0|y=0|c=0|w=2|lc=0|p=0";
				return new Response("mid", { status: 200, headers: { "content-type": "text/html" } });
			},
		);
		await Promise.all(pending);
		expect(rMid.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(fake.putCalls).toBe(putsBefore);

		// TTL expiry: no SWR, hard MISS
		vector = "v1|b=b1|s=9999|m=0|t=0|y=0|c=0|w=1|lc=0|p=0";
		clock += 61_000;
		const rExpired = await provider.onRequest!(
			makeContext("https://acme.sites.embarkeasy.com/pages/home"),
			async () => {
				optInPageCache(60);
				return new Response("v3", { status: 200, headers: { "content-type": "text/html" } });
			},
		);
		expect(rExpired.headers.get("x-embark-page-cache")).toBe("MISS");
		expect(await rExpired.text()).toBe("v3");
	});

	it("enforces positive route allowlist and strict cookie allowlist helpers", () => {
		expect(isAllowlistedPublicPath("/")).toBe(true);
		expect(isAllowlistedPublicPath("/posts")).toBe(true);
		expect(isAllowlistedPublicPath("/posts/hello-world")).toBe(true);
		expect(isAllowlistedPublicPath("/pages/about")).toBe(true);
		expect(isAllowlistedPublicPath("/sitemap.xml")).toBe(true);
		expect(isAllowlistedPublicPath("/_emdash/admin")).toBe(false);
		expect(isAllowlistedPublicPath("/events/")).toBe(false);
		expect(isAllowlistedPublicPath("/pages/a/b")).toBe(false);

		const allowed = new Set(["__em_d1_bookmark", "theme"]);
		expect(hasOnlyAllowedCookies(null, allowed)).toBe(true);
		expect(hasOnlyAllowedCookies("theme=dark; __em_d1_bookmark=abc", allowed)).toBe(true);
		expect(hasOnlyAllowedCookies("theme=dark; astro-session=1", allowed)).toBe(false);
		expect(hasOnlyAllowedCookies("badcookie", allowed)).toBe(false);
	});
});
