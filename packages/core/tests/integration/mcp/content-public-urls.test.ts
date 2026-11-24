/**
 * Real-handler qualification for `content_public_urls` (tenant-side canonical
 * public URL resolution by `(collection, entryId)`).
 *
 * Verifies:
 * - Same-slug translations resolve distinctly by entry ID
 * - Path overrides (collection `urlPattern` and configured homepage)
 * - Unpublishing a live entry makes its link disappear (`null`)
 * - Public-visibility checks (draft, scheduled, password-protected, non-routable)
 * - Abstention on unknown/carried routes the schema does not describe,
 *   unresolved URL tokens, and unconfigured locales
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setPublicRoutesConfig } from "../../../src/content/public-url.js";
import { ProtectedContentRepository } from "../../../src/database/repositories/protected-content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { _resetAstroI18nCacheForTests } from "../../../src/i18n/resolve.js";
import {
	connectMcpHarness,
	extractJson,
	extractText,
	type McpHarness,
} from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

interface PublicUrlResult {
	items: Array<{
		collection: string;
		id?: string;
		referenceId?: string;
		locale?: string;
		path: string | null;
	}>;
}

describe("MCP content_public_urls", () => {
	let db: Kysely<Database>;
	let harness: McpHarness;

	beforeEach(async () => {
		setI18nConfig(null);
		_resetAstroI18nCacheForTests();
		setPublicRoutesConfig([
			{ pattern: "/", owner: { kind: "homepage" } },
			{ pattern: "/pages/{slug}", owner: { kind: "collection", collection: "pages" } },
			{ pattern: "/posts/{slug}", owner: { kind: "collection", collection: "posts" } },
			{
				pattern: "/events/{slug}",
				owner: { kind: "uniqueUrlPattern", pattern: "/events/{slug}" },
			},
			{ pattern: "/journal/{slug}", owner: { kind: "collection", collection: "articles" } },
		]);
		db = await setupTestDatabase();
		harness = await connectMcpHarness({
			db,
			userId: "user_admin",
			userRole: Role.ADMIN,
		});
		// Ensure standard template collections (`pages`, `posts`) exist via real MCP schema tool.
		await createCollection("pages", "Pages");
		await createCollection("posts", "Posts");
	});

	afterEach(async () => {
		setI18nConfig(null);
		setPublicRoutesConfig(null);
		_resetAstroI18nCacheForTests();
		await harness.cleanup();
		await teardownTestDatabase(db);
	});

	async function createCollection(
		slug: string,
		label: string,
		opts?: { urlPattern?: string; routable?: boolean },
	): Promise<void> {
		const res = await harness.client.callTool({
			name: "schema_create_collection",
			arguments: {
				slug,
				label,
				...(opts?.routable !== undefined ? { routable: opts.routable } : {}),
			},
		});
		expect(res.isError, extractText(res)).toBeFalsy();
		if (opts?.urlPattern !== undefined) {
			const updRes = await harness.client.callTool({
				name: "schema_update_collection",
				arguments: { slug, urlPattern: opts.urlPattern },
			});
			expect(updRes.isError, extractText(updRes)).toBeFalsy();
		}
		const fieldRes = await harness.client.callTool({
			name: "schema_create_field",
			arguments: {
				collection: slug,
				slug: "title",
				label: "Title",
				type: "string",
				required: true,
			},
		});
		expect(fieldRes.isError, extractText(fieldRes)).toBeFalsy();
	}

	async function resolveUrls(
		items: Array<{ collection: string; id?: string; referenceId?: string; locale?: string }>,
	): Promise<PublicUrlResult> {
		const res = await harness.client.callTool({
			name: "content_public_urls",
			arguments: { items },
		});
		expect(res.isError, extractText(res)).toBeFalsy();
		return extractJson<PublicUrlResult>(res);
	}

	async function createEntry(args: {
		collection: string;
		title: string;
		slug?: string;
		status?: "draft" | "published";
		locale?: string;
		translationOf?: string;
	}): Promise<{ id: string; slug: string; rev: string; translationGroup: string | null }> {
		const res = await harness.client.callTool({
			name: "content_create",
			arguments: {
				collection: args.collection,
				data: { title: args.title },
				...(args.slug !== undefined ? { slug: args.slug } : {}),
				status: args.status ?? "published",
				...(args.locale !== undefined ? { locale: args.locale } : {}),
				...(args.translationOf !== undefined ? { translationOf: args.translationOf } : {}),
			},
		});
		expect(res.isError, extractText(res)).toBeFalsy();
		const created = extractJson<{
			item: { id: string; slug: string; translationGroup?: string | null };
			_rev: string;
		}>(res);
		return {
			id: created.item.id,
			slug: created.item.slug,
			rev: created._rev,
			translationGroup: created.item.translationGroup ?? null,
		};
	}

	it("resolves same-slug translations distinctly by (collection, entryId)", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});
		_resetAstroI18nCacheForTests();

		const en = await createEntry({
			collection: "pages",
			title: "About Us",
			slug: "about",
			locale: "en",
		});
		const fr = await createEntry({
			collection: "pages",
			title: "A propos",
			slug: "about",
			locale: "fr",
			translationOf: en.id,
		});

		const out = await resolveUrls([
			{ collection: "pages", id: en.id },
			{ collection: "pages", id: fr.id },
		]);
		expect(out.items).toEqual([
			{ collection: "pages", id: en.id, path: "/pages/about" },
			{ collection: "pages", id: fr.id, path: "/fr/pages/about" },
		]);
	});

	it("applies collection urlPattern path overrides and configured homepage override", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});
		_resetAstroI18nCacheForTests();

		await createCollection("articles", "Articles", {
			urlPattern: "/journal/{slug}",
		});
		const article = await createEntry({
			collection: "articles",
			title: "Spring Issue",
			slug: "spring-issue",
			locale: "en",
		});

		const homeEn = await createEntry({
			collection: "pages",
			title: "Welcome",
			slug: "home",
			locale: "en",
		});
		const homeFr = await createEntry({
			collection: "pages",
			title: "Bienvenue",
			slug: "accueil",
			locale: "fr",
			translationOf: homeEn.id,
		});
		const setHome = await harness.client.callTool({
			name: "settings_update",
			arguments: {
				homepage: { collection: "pages", id: homeEn.translationGroup ?? homeEn.id },
			},
		});
		expect(setHome.isError, extractText(setHome)).toBeFalsy();

		const out = await resolveUrls([
			{ collection: "articles", id: article.id },
			{ collection: "pages", id: homeEn.id },
			{ collection: "pages", id: homeFr.id },
		]);
		expect(out.items).toEqual([
			{ collection: "articles", id: article.id, path: "/journal/spring-issue" },
			{ collection: "pages", id: homeEn.id, path: "/" },
			{ collection: "pages", id: homeFr.id, path: "/fr" },
		]);
	});

	it("drops the link immediately when a published entry is unpublished", async () => {
		const page = await createEntry({
			collection: "pages",
			title: "Upcoming",
			slug: "upcoming",
			status: "published",
		});

		const before = await resolveUrls([{ collection: "pages", id: page.id }]);
		expect(before.items).toEqual([{ collection: "pages", id: page.id, path: "/pages/upcoming" }]);

		const got = await harness.client.callTool({
			name: "content_get",
			arguments: { collection: "pages", id: page.id },
		});
		const { _rev } = extractJson<{ _rev: string }>(got);

		const unpub = await harness.client.callTool({
			name: "content_unpublish",
			arguments: { collection: "pages", id: page.id, _rev },
		});
		expect(unpub.isError).toBeFalsy();

		const after = await resolveUrls([{ collection: "pages", id: page.id }]);
		expect(after.items).toEqual([{ collection: "pages", id: page.id, path: null }]);
	});

	it("enforces public-visibility checks (draft, password-protected, non-routable)", async () => {
		const draft = await createEntry({
			collection: "pages",
			title: "Work in progress",
			slug: "wip",
			status: "draft",
		});
		const secret = await createEntry({
			collection: "pages",
			title: "Board Minutes",
			slug: "board-minutes",
			status: "published",
		});
		await new ProtectedContentRepository(db).create(
			"pages",
			secret.id,
			{
				version: 1,
				mode: "password",
				verifier: {
					version: 1,
					algorithm: "pbkdf2-sha256",
					iterations: 100000,
					salt: "a".repeat(32),
					hash: "b".repeat(64),
				},
			},
			{ title: "Board Minutes" },
		);

		await createCollection("snippets", "Snippets", {
			urlPattern: "/snippets/{slug}",
			routable: false,
		});
		const snippet = await createEntry({
			collection: "snippets",
			title: "Footer Blurb",
			slug: "footer-blurb",
			status: "published",
		});

		const out = await resolveUrls([
			{ collection: "pages", id: draft.id },
			{ collection: "pages", id: secret.id },
			{ collection: "snippets", id: snippet.id },
		]);
		expect(out.items).toEqual([
			{ collection: "pages", id: draft.id, path: null },
			{ collection: "pages", id: secret.id, path: null },
			{ collection: "snippets", id: snippet.id, path: null },
		]);
	});

	it("abstains on unknown/carried routes without urlPattern, unconfigured locales, and missing entries", async () => {
		// Create a "de" entry before narrowing configured locales to ["en", "fr"]
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr", "de"],
			prefixDefaultLocale: false,
		});
		_resetAstroI18nCacheForTests();
		const dePage = await createEntry({
			collection: "pages",
			title: "Kontakt",
			slug: "kontakt",
			status: "published",
			locale: "de",
		});

		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});
		_resetAstroI18nCacheForTests();

		// Carried WordPress custom post type with no schema urlPattern -> abstain
		await createCollection("wp_popups", "Popups", { routable: true });
		const popup = await createEntry({
			collection: "wp_popups",
			title: "Year End",
			slug: "year-end",
			status: "published",
			locale: "en",
		});

		// Carried events collection WITH explicit schema urlPattern -> resolved
		await createCollection("mec_events", "Events", {
			urlPattern: "/events/{slug}",
			routable: true,
		});
		const event = await createEntry({
			collection: "mec_events",
			title: "Summer Gala",
			slug: "summer-gala",
			status: "published",
			locale: "en",
		});

		const out = await resolveUrls([
			{ collection: "wp_popups", id: popup.id },
			{ collection: "mec_events", id: event.id },
			{ collection: "pages", id: dePage.id },
			{ collection: "pages", id: "nonexistent-id" },
		]);
		expect(out.items).toEqual([
			{ collection: "wp_popups", id: popup.id, path: null },
			{ collection: "mec_events", id: event.id, path: "/events/summer-gala" },
			{ collection: "pages", id: dePage.id, path: null },
			{ collection: "pages", id: "nonexistent-id", path: null },
		]);
	});

	it("requires an active template route contract (null without proof; respects starter /[slug] vs blog /pages/[slug] and rejects unserved patterns)", async () => {
		const page = await createEntry({
			collection: "pages",
			title: "About",
			slug: "about",
			status: "published",
		});
		const post = await createEntry({
			collection: "posts",
			title: "Hello",
			slug: "hello",
			status: "published",
		});
		await createCollection("articles", "Articles", { urlPattern: "/journal/{slug}" });
		const article = await createEntry({
			collection: "articles",
			title: "Spring",
			slug: "spring",
			status: "published",
		});

		// Without any active template route contract -> abstain (fail closed)
		setPublicRoutesConfig(null);
		const none = await resolveUrls([
			{ collection: "pages", id: page.id },
			{ collection: "posts", id: post.id },
			{ collection: "articles", id: article.id },
		]);
		expect(none.items).toEqual([
			{ collection: "pages", id: page.id, path: null },
			{ collection: "posts", id: post.id, path: null },
			{ collection: "articles", id: article.id, path: null },
		]);

		// starter-cloudflare contract (/[slug] owned by pages; no /pages/[slug], no /posts/[slug])
		setPublicRoutesConfig([
			{ pattern: "/", owner: { kind: "homepage" } },
			{ pattern: "/{slug}", owner: { kind: "collection", collection: "pages" } },
		]);
		const starter = await resolveUrls([
			{ collection: "pages", id: page.id },
			{ collection: "posts", id: post.id },
		]);
		expect(starter.items).toEqual([
			{ collection: "pages", id: page.id, path: "/about" },
			{ collection: "posts", id: post.id, path: null },
		]);

		// blog-cloudflare contract (/pages/{slug} owned by pages, /posts/{slug} owned by posts,
		// /events/{slug} owned by uniqueUrlPattern; NO /journal/{slug})
		setPublicRoutesConfig([
			{ pattern: "/", owner: { kind: "homepage" } },
			{ pattern: "/pages/{slug}", owner: { kind: "collection", collection: "pages" } },
			{ pattern: "/posts/{slug}", owner: { kind: "collection", collection: "posts" } },
			{
				pattern: "/events/{slug}",
				owner: { kind: "uniqueUrlPattern", pattern: "/events/{slug}" },
			},
		]);
		const blog = await resolveUrls([
			{ collection: "pages", id: page.id },
			{ collection: "posts", id: post.id },
			{ collection: "articles", id: article.id },
		]);
		expect(blog.items).toEqual([
			{ collection: "pages", id: page.id, path: "/pages/about" },
			{ collection: "posts", id: post.id, path: "/posts/hello" },
			{ collection: "articles", id: article.id, path: null },
		]);
	});

	it("rejects same-pattern wrong-owner collections and ambiguous uniqueUrlPattern routes", async () => {
		const page = await createEntry({
			collection: "pages",
			title: "Real Page",
			slug: "shared-slug",
			status: "published",
		});

		// Custom routable collection configured with `/pages/{slug}` even though
		// the template route `/pages/{slug}` is owned by `pages`.
		await createCollection("guides", "Guides", {
			urlPattern: "/pages/{slug}",
			routable: true,
		});
		const guide = await createEntry({
			collection: "guides",
			title: "Wrong Owner Guide",
			slug: "shared-slug",
			status: "published",
		});

		// Unique routable owner on `/events/{slug}` resolves; adding a second
		// routable owner on `/events/{slug}` makes ownership ambiguous -> both null.
		await createCollection("mec_events", "Events", {
			urlPattern: "/events/{slug}",
			routable: true,
		});
		const eventA = await createEntry({
			collection: "mec_events",
			title: "Autumn Fair",
			slug: "autumn-fair",
			status: "published",
		});

		const beforeAmbiguity = await resolveUrls([
			{ collection: "pages", id: page.id },
			{ collection: "guides", id: guide.id },
			{ collection: "mec_events", id: eventA.id },
		]);
		expect(beforeAmbiguity.items).toEqual([
			{ collection: "pages", id: page.id, path: "/pages/shared-slug" },
			{ collection: "guides", id: guide.id, path: null },
			{ collection: "mec_events", id: eventA.id, path: "/events/autumn-fair" },
		]);

		await createCollection("workshops", "Workshops", {
			urlPattern: "/events/{slug}",
			routable: true,
		});
		const eventB = await createEntry({
			collection: "workshops",
			title: "Woodworking",
			slug: "woodworking",
			status: "published",
		});

		const afterAmbiguity = await resolveUrls([
			{ collection: "mec_events", id: eventA.id },
			{ collection: "workshops", id: eventB.id },
		]);
		expect(afterAmbiguity.items).toEqual([
			{ collection: "mec_events", id: eventA.id, path: null },
			{ collection: "workshops", id: eventB.id, path: null },
		]);
	});

	it("resolves menu translation-group referenceId in the menu's locale and omits noindex entries", async () => {
		setI18nConfig({
			defaultLocale: "en",
			locales: ["en", "fr"],
			prefixDefaultLocale: false,
		});
		_resetAstroI18nCacheForTests();

		const en = await createEntry({
			collection: "pages",
			title: "About",
			slug: "about",
			locale: "en",
		});
		await createEntry({
			collection: "pages",
			title: "A propos",
			slug: "a-propos",
			locale: "fr",
			translationOf: en.id,
		});
		const group = en.translationGroup ?? en.id;

		// Noindex published page -> omitted
		const hidden = await createEntry({
			collection: "pages",
			title: "Thank You",
			slug: "thank-you",
			locale: "en",
		});
		await db
			.insertInto("_emdash_seo")
			.values({
				collection: "pages",
				content_id: hidden.id,
				seo_no_index: 1,
			})
			.execute();

		const out = await resolveUrls([
			{ collection: "pages", referenceId: group, locale: "en" },
			{ collection: "pages", referenceId: group, locale: "fr" },
			{ collection: "pages", id: hidden.id },
		]);
		expect(out.items).toEqual([
			{ collection: "pages", referenceId: group, locale: "en", path: "/pages/about" },
			{ collection: "pages", referenceId: group, locale: "fr", path: "/fr/pages/a-propos" },
			{ collection: "pages", id: hidden.id, path: null },
		]);
	});
});
