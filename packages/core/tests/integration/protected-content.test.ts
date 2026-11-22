import { pbkdf2Sync } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSnapshot } from "../../src/api/handlers/snapshot.js";
import {
	GET as contentGet,
	PUT as contentPut,
} from "../../src/astro/routes/api/content/[collection]/[id].js";
import { GET as contentList } from "../../src/astro/routes/api/content/[collection]/index.js";
import { importContent as importPluginContent } from "../../src/astro/routes/api/import/wordpress-plugin/execute.js";
import { GET as searchGet } from "../../src/astro/routes/api/search/index.js";
import { GET as sitemapCollectionGet } from "../../src/astro/routes/sitemap-[collection].xml.js";
import { GET as sitemapIndexGet } from "../../src/astro/routes/sitemap.xml.js";
import {
	hydrateProtectedContentForEditor,
	resolveProtectedEntry,
} from "../../src/content/protected-render.js";
import {
	createPasswordVerifier,
	verifyContentPassword,
	PROTECTED_CONTENT_CAPABILITY,
} from "../../src/content/protection.js";
import { up, down } from "../../src/database/migrations/embark_003_protected_content.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { OptionsRepository } from "../../src/database/repositories/options.js";
import { ProtectedContentRepository } from "../../src/database/repositories/protected-content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { SeoRepository } from "../../src/database/repositories/seo.js";
import { ContentMutationConflictError } from "../../src/database/repositories/types.js";
import type { Database } from "../../src/database/types.js";
import { importProtection } from "../../src/import/protection.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { FTSManager } from "../../src/search/fts-manager.js";
import { searchWithDb } from "../../src/search/query.js";
import { createTestRuntime, handlersFromRuntime } from "../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

const SECRET = "SYNTHETIC_PROTECTED_BODY_c19f";
const EXCERPT = "SYNTHETIC_PROTECTED_EXCERPT_c19f";
const SEO = "SYNTHETIC_PROTECTED_SEO_c19f";
const PASSWORD = " yes é ";
const salt = "0102030405060708090a0b0c0d0e0f10";
const protection = {
	version: 1 as const,
	mode: "password" as const,
	verifier: {
		version: 1 as const,
		algorithm: "pbkdf2-sha256" as const,
		iterations: 100000 as const,
		salt,
		hash: pbkdf2Sync(PASSWORD, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex"),
	},
};

describe("protected content storage boundary", () => {
	let db: Kysely<Database>;
	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			hasSeo: true,
		});
		for (const [slug, type] of [
			["title", "string"],
			["content", "portableText"],
			["excerpt", "text"],
			["seo_description", "text"],
		] as const) {
			await registry.createField("pages", {
				slug,
				label: slug,
				type,
				searchable: slug === "title" || slug === "content",
			});
		}
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const create = () =>
		new ContentRepository(db).create({
			type: "pages",
			slug: "protected",
			status: "published",
			data: {
				title: "Protected page",
				content: [{ _type: "block", children: [{ _type: "span", text: SECRET }] }],
				excerpt: EXCERPT,
				seo_description: SEO,
			},
			protection,
		});

	it("preserves a published permalink without storing its payload in public columns", async () => {
		const item = await create();
		expect(item.status).toBe("published");
		const open = await new ContentRepository(db).create({
			type: "pages",
			slug: "open",
			status: "published",
			data: { title: "Open", excerpt: "Open control" },
		});
		expect(open.data.excerpt).toBe("Open control");
		const publicRows = await db
			.selectFrom("ec_pages" as keyof Database)
			.selectAll()
			.execute();
		for (const secret of [SECRET, EXCERPT, SEO, PASSWORD, protection.verifier.hash]) {
			expect(JSON.stringify(publicRows)).not.toContain(secret);
			expect(
				JSON.stringify(await new ContentRepository(db).findBySlug("pages", "protected", "en")),
			).not.toContain(secret);
		}
	});

	it("excludes published protected pages from sitemap index and collection sitemaps", async () => {
		await create();
		const onlyProtectedIndex = await sitemapIndexGet({
			locals: { emdash: { db, config: undefined } },
			url: new URL("https://example.org/sitemap.xml"),
		} as never);
		expect(onlyProtectedIndex.status).toBe(200);
		expect(await onlyProtectedIndex.text()).not.toContain("sitemap-pages.xml");

		const onlyProtectedCollection = await sitemapCollectionGet({
			params: { collection: "pages" },
			locals: { emdash: { db, config: undefined } },
			url: new URL("https://example.org/sitemap-pages.xml"),
		} as never);
		expect(onlyProtectedCollection.status).toBe(404);

		await new ContentRepository(db).create({
			type: "pages",
			slug: "open-public",
			status: "published",
			data: { title: "Open Public", excerpt: "Visible" },
		});
		const mixedCollection = await sitemapCollectionGet({
			params: { collection: "pages" },
			locals: { emdash: { db, config: undefined } },
			url: new URL("https://example.org/sitemap-pages.xml"),
		} as never);
		expect(mixedCollection.status).toBe(200);
		const xml = await mixedCollection.text();
		expect(xml).toContain("/pages/open-public");
		expect(xml).not.toContain("/pages/protected");
		for (const secret of [SECRET, EXCERPT, SEO, PASSWORD, protection.verifier.hash])
			expect(xml).not.toContain(secret);
	});

	it("redacts required fields and blocks without violating their non-null storage constraints", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createField("pages", {
			slug: "required_text",
			label: "Required text",
			type: "text",
			required: true,
		});
		await registry.createField("pages", {
			slug: "required_body",
			label: "Required body",
			type: "portableText",
			required: true,
		});
		await registry.createField("pages", { slug: "layout", label: "Layout", type: "blocks" });
		const item = await new ContentRepository(db).create({
			type: "pages",
			slug: "required",
			status: "published",
			data: {
				title: "Protected required fields",
				required_text: EXCERPT,
				required_body: [{ _type: "block", children: [{ _type: "span", text: SECRET }] }],
				layout: [],
			},
			protection,
		});
		const published = await new ContentRepository(db).publish("pages", item.id);
		expect(JSON.stringify(published)).not.toContain(SECRET);
		expect(JSON.stringify(published)).not.toContain(EXCERPT);
		expect((await new ProtectedContentRepository(db).readData(published))?.required_text).toBe(
			EXCERPT,
		);
	});

	it("keeps subsequent content and SEO writes out of public projections", async () => {
		const item = await create();
		await new ContentRepository(db).update("pages", item.id, {
			data: { excerpt: `${EXCERPT}_edited` },
		});
		await new SeoRepository(db).upsert("pages", item.id, { description: SEO });
		expect(
			JSON.stringify(
				await db
					.selectFrom("ec_pages" as keyof Database)
					.selectAll()
					.execute(),
			),
		).not.toContain(EXCERPT);
		expect(JSON.stringify(await db.selectFrom("_emdash_seo").selectAll().execute())).not.toContain(
			SEO,
		);
	});

	it("keeps the unqualified native connector consumer draft-only when given a portable verifier", async () => {
		const { result } = await importPluginContent(
			[
				{
					sourceId: 1,
					postType: "post",
					status: "publish",
					slug: "connector-protected",
					title: "Connector protected",
					content: [],
					excerpt: EXCERPT,
					date: new Date("2026-11-20T00:00:00Z"),
					protection,
				},
			],
			{ postTypeMappings: { post: { collection: "pages", enabled: true } }, skipExisting: false },
			handlersFromRuntime(createTestRuntime(db)),
			{ collections: { pages: {} } } as never,
		);
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		const item = await new ContentRepository(db).findBySlug("pages", "connector-protected", "en");
		expect(item?.status).toBe("draft");
		expect(JSON.stringify(item)).not.toContain(protection.verifier.hash);
	});

	it("matches the portable Node/PHP PBKDF2 format without trimming or normalizing bytes", async () => {
		expect(await verifyContentPassword(PASSWORD, protection.verifier)).toBe(true);
		for (const wrong of ["", "wrong", PASSWORD.trim(), PASSWORD.normalize("NFD")])
			expect(await verifyContentPassword(wrong, protection.verifier)).toBe(false);
		expect(await verifyContentPassword(PASSWORD, { ...protection.verifier, iterations: 1 })).toBe(
			false,
		);
		const first = await createPasswordVerifier("yes");
		const second = await createPasswordVerifier("yes");
		expect(first.salt).not.toBe(second.salt);
		expect(await verifyContentPassword("yes", first)).toBe(true);
	});

	it("distinguishes explicit connector redaction from a raw WXR password literally yes", async () => {
		const raw = await importProtection(
			{ id: 7, postPassword: "yes" },
			{ protectedContent: PROTECTED_CONTENT_CAPABILITY, passwordSource: "raw-wxr" },
		);
		expect(await verifyContentPassword("yes", raw.protection?.verifier)).toBe(true);
		const redacted = await importProtection(
			{ id: 7, postPassword: "yes" },
			{ protectedContent: PROTECTED_CONTENT_CAPABILITY, passwordSource: "redacted" },
		);
		expect(redacted).toEqual({ protected: true, unrecoverable: true });
		expect((await importProtection({ id: 7, postPassword: "yes" }, {})).protection).toBeUndefined();
		const portable = await importProtection(
			{ id: 7, postPassword: "yes" },
			{
				protectedContent: PROTECTED_CONTENT_CAPABILITY,
				passwordSource: "redacted",
				protections: { "7": protection },
			},
		);
		expect(portable.protection).toEqual(protection);
	});

	it("requires actual ownership-aware edit authority, not subscriber, read-only token, or preview", async () => {
		const item = await create();
		for (const [user, scopes] of [
			[{ id: "subscriber", role: Role.SUBSCRIBER }, undefined],
			[{ id: "unrelated-author", role: Role.AUTHOR }, undefined],
			[{ id: "editor", role: Role.EDITOR }, ["content:read"]],
		] as const) {
			const hydrated = await hydrateProtectedContentForEditor(
				db,
				item,
				user,
				scopes ? [...scopes] : undefined,
			);
			expect(JSON.stringify(hydrated)).not.toContain(SECRET);
		}
		const editor = await hydrateProtectedContentForEditor(db, item, {
			id: "editor",
			role: Role.EDITOR,
		});
		expect(JSON.stringify(editor)).toContain(SECRET);
		expect(JSON.stringify(editor)).not.toContain(protection.verifier.hash);
		const context = {
			request: new Request("https://example.org/protected?_preview=not-a-password"),
			response: { headers: new Headers() },
		};
		const preview = await runWithContext(
			{ editMode: true, preview: { collection: "pages", id: item.id }, db },
			() => resolveProtectedEntry(context, "pages", { data: { id: item.id } }),
		);
		expect("response" in preview).toBe(true);
	});

	it("edits and publishes private revisions while all ordinary snapshots, list API, and search stay redacted", async () => {
		const registry = new SchemaRegistry(db);
		await registry.updateCollection("pages", { supports: ["revisions"] });
		const item = await create();
		const runtime = createTestRuntime(db);
		const result = await runtime.handleContentUpdate("pages", item.id, {
			data: { excerpt: `${EXCERPT}_draft` },
		});
		expect(result.success).toBe(true);
		const repo = new ContentRepository(db);
		const staged = (await repo.findById("pages", item.id))!;
		expect(staged.draftRevisionId).not.toBeNull();
		expect((await new ProtectedContentRepository(db).readData(staged, true))?.excerpt).toBe(
			`${EXCERPT}_draft`,
		);
		expect((await new ProtectedContentRepository(db).readData(staged))?.excerpt).toBe(EXCERPT);
		const published = await repo.publish("pages", item.id);
		expect((await new ProtectedContentRepository(db).readData(published))?.excerpt).toBe(
			`${EXCERPT}_draft`,
		);
		expect(
			JSON.stringify(await new RevisionRepository(db).findByEntry("pages", item.id)),
		).not.toContain(EXCERPT);
		expect(JSON.stringify(await repo.findMany("pages"))).not.toContain(SECRET);

		const emdash = handlersFromRuntime(runtime);
		const listRes = await contentList({
			params: { collection: "pages" },
			url: new URL("https://example.org/_emdash/api/content/pages"),
			locals: { emdash, user: { id: "subscriber", role: Role.SUBSCRIBER } },
		} as never);
		expect(listRes.status).toBe(200);
		const listBody = await listRes.text();
		for (const secret of [SECRET, EXCERPT, SEO, PASSWORD, protection.verifier.hash])
			expect(listBody).not.toContain(secret);

		const fts = new FTSManager(db);
		await fts.enableSearch("pages");
		expect(await searchWithDb(db, SECRET, { collections: ["pages"] })).toMatchObject({ items: [] });
		const searchRes = await searchGet({
			url: new URL(`https://example.org/_emdash/api/search?q=${encodeURIComponent(SECRET)}`),
			locals: { emdash: { db, ensureSearchHealthy: async () => {} }, user: undefined },
		} as never);
		expect(searchRes.status).toBe(200);
		const searchJson = await searchRes.text();
		expect(searchJson).not.toContain(SECRET);
		expect(searchJson).not.toContain(item.id);

		for (const table of ["ec_pages", "revisions", "_emdash_seo"]) {
			const rows = await db
				.selectFrom(table as keyof Database)
				.selectAll()
				.execute();
			for (const secret of [SECRET, EXCERPT, SEO, PASSWORD, protection.verifier.hash])
				expect(JSON.stringify(rows), table).not.toContain(secret);
		}
	});

	for (const mutation of ["update", "restore"] as const) {
		it(`does not change the live private payload when a protected ${mutation} fails`, async () => {
			const item = await create();
			const repo = new ContentRepository(db);
			const data = { excerpt: `${EXCERPT}_failed`, unknown_field: "invalid column" };
			await expect(
				mutation === "update"
					? repo.update("pages", item.id, { data })
					: repo.restoreRevision("pages", item.id, data, "synthetic-editor"),
			).rejects.toThrow();
			expect((await new ProtectedContentRepository(db).readData(item))?.excerpt).toBe(EXCERPT);
		});
	}

	it("rejects a concurrent protected update on version conflict without mutating private storage", async () => {
		const item = await create();
		let bumped = false;
		const raceDb = db.withPlugin({
			transformQuery: ({ node }) => node,
			async transformResult(args) {
				if (
					!bumped &&
					args.result.rows.length === 1 &&
					(args.result.rows[0] as Record<string, unknown>)?.id === item.id &&
					(args.result.rows[0] as Record<string, unknown>)?.version === item.version
				) {
					bumped = true;
					await db
						.updateTable("ec_pages" as keyof Database)
						.set({ version: item.version + 1 } as never)
						.where("id" as never, "=", item.id)
						.execute();
				}
				return args.result;
			},
		});
		await expect(
			new ContentRepository(raceDb).update("pages", item.id, {
				data: { excerpt: `${EXCERPT}_raced` },
			}),
		).rejects.toBeInstanceOf(ContentMutationConflictError);
		expect(bumped).toBe(true);
		expect((await new ProtectedContentRepository(db).readData(item))?.excerpt).toBe(EXCERPT);
	});

	it("leaves no orphan private row when protected content creation fails on the public insert", async () => {
		await create();
		await expect(
			new ContentRepository(db).create({
				type: "pages",
				slug: "protected-fail",
				status: "published",
				data: { title: "Bad", unknown_column: "triggers-sql-error" },
				protection,
			}),
		).rejects.toThrow();
		const rows = await db.selectFrom("_emdash_protected_content").selectAll().execute();
		expect(rows).toHaveLength(1);
	});

	it("keeps duplicates protected and removes private payloads when their trashed row is purged", async () => {
		const item = await create();
		const repo = new ContentRepository(db);
		await new SeoRepository(db).upsert("pages", item.id, {
			description: SEO,
			canonical: "https://example.org/original",
		});
		const duplicate = await repo.duplicate("pages", item.id);
		await new SeoRepository(db).copyForDuplicate("pages", item.id, duplicate.id);
		const duplicatedPrivate = await new ProtectedContentRepository(db).find("pages", duplicate.id);
		expect(JSON.parse(duplicatedPrivate!.seo!)).toMatchObject({
			description: SEO,
			canonical: null,
		});
		expect(duplicate.status).toBe("draft");
		expect(JSON.stringify(duplicate)).not.toContain(SECRET);
		expect((await new ProtectedContentRepository(db).readData(duplicate))?.excerpt).toBe(EXCERPT);
		await repo.delete("pages", duplicate.id);
		expect(await repo.permanentDelete("pages", duplicate.id)).toBe(true);
		expect(await new ProtectedContentRepository(db).find("pages", duplicate.id)).toBeUndefined();
		expect(await new ProtectedContentRepository(db).find("pages", item.id)).toBeDefined();
	});

	it("exports neither private table schemas nor payloads in published and draft snapshots", async () => {
		const item = await create();
		await new SeoRepository(db).upsert("pages", item.id, { description: SEO });
		for (const includeDrafts of [false, true]) {
			const snapshot = await generateSnapshot(db, { includeDrafts });
			expect(snapshot.tables.ec_pages).toHaveLength(1);
			expect(snapshot.schema).not.toHaveProperty("_emdash_protected_content");
			expect(snapshot.schema).not.toHaveProperty("_emdash_protected_revisions");
			for (const secret of [SECRET, EXCERPT, SEO, PASSWORD, protection.verifier.hash])
				expect(JSON.stringify(snapshot)).not.toContain(secret);
		}
	});

	it("serves real subscriber and read-only token API projections, but hydrates an editor privately", async () => {
		const item = await create();
		const emdash = handlersFromRuntime(createTestRuntime(db));
		for (const [role, tokenScopes, allowed] of [
			[Role.SUBSCRIBER, undefined, false],
			[Role.EDITOR, ["content:read"], false],
			[Role.EDITOR, undefined, true],
		] as const) {
			const response = await contentGet({
				params: { collection: "pages", id: item.id },
				url: new URL(`https://example.org/_emdash/api/content/pages/${item.id}`),
				locals: { emdash, user: { id: "synthetic-user", role }, tokenScopes },
			} as never);
			expect(response.status).toBe(200);
			const json = await response.text();
			expect(json.includes(SECRET)).toBe(allowed);
			expect(json).not.toContain(protection.verifier.hash);
			expect(response.headers.get("cache-control")).toBe("private, no-store");
		}
	});

	it("rejects malformed, cross-origin and oversized password submissions without payload", async () => {
		const item = await create();
		for (const [body, headers, status] of [
			[new URLSearchParams(), {}, 403],
			[new URLSearchParams({ password: PASSWORD }), { origin: "https://other.example" }, 403],
			[PASSWORD, { "content-type": "text/plain" }, 415],
			[
				new URLSearchParams([
					["password", PASSWORD],
					["password", PASSWORD],
				]),
				{},
				403,
			],
			[new URLSearchParams({ password: "x".repeat(8193) }), {}, 413],
		] as const) {
			const request = new Request("https://example.org/protected", {
				method: "POST",
				body,
				headers,
			});
			const access = await runWithContext({ editMode: false, db }, () =>
				resolveProtectedEntry({ request, response: { headers: new Headers() } }, "pages", {
					data: { id: item.id },
				}),
			);
			if (!("response" in access)) throw new Error("Invalid submission unexpectedly hydrated");
			expect(access.response.status).toBe(status);
			const html = await access.response.text();
			for (const secret of [SECRET, EXCERPT, SEO, PASSWORD, protection.verifier.hash])
				expect(html).not.toContain(secret);
		}
	});

	it("uses the existing trusted-IP rate limiter for password attempts", async () => {
		const item = await create();
		for (let attempt = 0; attempt < 11; attempt++) {
			const request = new Request("https://example.org/protected", {
				method: "POST",
				headers: { "cf-connecting-ip": "203.0.113.55" },
				body: new URLSearchParams(),
			});
			Object.defineProperty(request, "cf", { value: {} });
			const access = await runWithContext({ editMode: false, db }, () =>
				resolveProtectedEntry({ request, response: { headers: new Headers() } }, "pages", {
					data: { id: item.id },
				}),
			);
			if (!("response" in access)) throw new Error("Missing password unexpectedly hydrated");
			expect(access.response.status).toBe(attempt < 10 ? 403 : 429);
			if (attempt === 10) expect(access.response.headers.get("retry-after")).toBe("60");
		}
	});

	it("fails closed when client IP is unavailable and enforces the configurable per-entry ceiling", async () => {
		const item = await create();
		await new OptionsRepository(db).set("protected_content:rate_limit", {
			perIpMax: 2,
			perEntryMax: 4,
			windowSeconds: 60,
		});
		// Null IP (no cf object, no trusted proxy headers) must still hit perIpMax (2), never fail open.
		for (let attempt = 0; attempt < 3; attempt++) {
			const request = new Request("https://example.org/protected", {
				method: "POST",
				body: new URLSearchParams({ password: "wrong" }),
			});
			const access = await runWithContext({ editMode: false, db }, () =>
				resolveProtectedEntry({ request, response: { headers: new Headers() } }, "pages", {
					data: { id: item.id },
				}),
			);
			if (!("response" in access)) throw new Error("Wrong password unexpectedly hydrated");
			expect(access.response.status).toBe(attempt < 2 ? 403 : 429);
		}
		// Distinct IPs still hit the per-entry global ceiling (perEntryMax: 4; 3 already counted above).
		for (const [ip, expectedStatus] of [
			["203.0.113.61", 403],
			["203.0.113.62", 429],
		] as const) {
			const request = new Request("https://example.org/protected", {
				method: "POST",
				headers: { "cf-connecting-ip": ip },
				body: new URLSearchParams({ password: "wrong" }),
			});
			Object.defineProperty(request, "cf", { value: {} });
			const access = await runWithContext({ editMode: false, db }, () =>
				resolveProtectedEntry({ request, response: { headers: new Headers() } }, "pages", {
					data: { id: item.id },
				}),
			);
			if (!("response" in access)) throw new Error("Wrong password unexpectedly hydrated");
			expect(access.response.status).toBe(expectedStatus);
		}
	});

	for (const withRevisions of [false, true]) {
		it(`preserves private content across admin GET -> PUT -> PUT save round-trips (revisions=${withRevisions})`, async () => {
			if (withRevisions) {
				await new SchemaRegistry(db).updateCollection("pages", { supports: ["revisions"] });
			}
			const item = await create();
			const emdash = handlersFromRuntime(createTestRuntime(db));
			const user = { id: "editor-1", role: Role.EDITOR };

			const getRes = await contentGet({
				params: { collection: "pages", id: item.id },
				url: new URL(`https://example.org/_emdash/api/content/pages/${item.id}`),
				locals: { emdash, user },
			} as never);
			expect(getRes.status).toBe(200);
			const first = (await getRes.json()) as {
				data: { item: { data: Record<string, unknown> } };
			};
			expect(JSON.stringify(first.data.item.data)).toContain(SECRET);

			const put1Res = await contentPut({
				params: { collection: "pages", id: item.id },
				request: new Request(`https://example.org/_emdash/api/content/pages/${item.id}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ data: { ...first.data.item.data, title: "Updated 1" } }),
				}),
				locals: { emdash, user },
			} as never);
			expect(put1Res.status).toBe(200);
			expect(put1Res.headers.get("cache-control")).toBe("private, no-store");
			const afterPut1 = (await put1Res.json()) as {
				data: { item: { data: Record<string, unknown> } };
			};
			expect(JSON.stringify(afterPut1.data.item.data)).toContain(SECRET);

			const put2Res = await contentPut({
				params: { collection: "pages", id: item.id },
				request: new Request(`https://example.org/_emdash/api/content/pages/${item.id}`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ data: { ...afterPut1.data.item.data, title: "Updated 2" } }),
				}),
				locals: { emdash, user },
			} as never);
			expect(put2Res.status).toBe(200);
			const refreshed = (await new ContentRepository(db).findById("pages", item.id))!;
			const stored = await new ProtectedContentRepository(db).readData(refreshed, true);
			expect(JSON.stringify(stored)).toContain(SECRET);
			expect(stored?.excerpt).toBe(EXCERPT);
		});
	}

	for (const race of ["credential rotation", "unpublication"] as const) {
		it(`rechecks ${race} and current private payload in a single statement after password verification`, async () => {
			const item = await create();
			let changed = false;
			const raceDb = db.withPlugin({
				transformQuery: ({ node }) => node,
				async transformResult(args) {
					if (!changed && "verifier" in (args.result.rows[0] ?? {})) {
						changed = true;
						if (race === "credential rotation")
							await db
								.updateTable("_emdash_protected_content")
								.set({ credential_version: 2 })
								.where("content_id", "=", item.id)
								.execute();
						else await new ContentRepository(db).update("pages", item.id, { status: "draft" });
					}
					return args.result;
				},
			});
			const request = new Request("https://example.org/protected", {
				method: "POST",
				body: new URLSearchParams({ password: PASSWORD }),
			});
			const access = await runWithContext({ editMode: false, db: raceDb }, () =>
				resolveProtectedEntry({ request, response: { headers: new Headers() } }, "pages", {
					data: { id: item.id },
				}),
			);
			expect(changed).toBe(true);
			if (!("response" in access))
				throw new Error("Stale password verification unexpectedly hydrated");
			expect(access.response.status).toBe(403);
			expect(await access.response.text()).not.toContain(SECRET);
		});
	}

	it("rejects publication-time password access to source drafts and deleted rows", async () => {
		const item = await create();
		await new ContentRepository(db).update("pages", item.id, { status: "draft" });
		const context = {
			request: new Request("https://example.org/protected", {
				method: "POST",
				body: new URLSearchParams({ password: PASSWORD }),
			}),
			response: { headers: new Headers() },
		};
		const denied = await runWithContext({ editMode: false, db }, () =>
			resolveProtectedEntry(context, "pages", { data: { id: item.id } }),
		);
		expect("response" in denied && denied.response.status).toBe(404);
		await new ContentRepository(db).update("pages", item.id, { status: "published" });
		await new ContentRepository(db).delete("pages", item.id);
		const deleted = await runWithContext({ editMode: false, db }, () =>
			resolveProtectedEntry(context, "pages", { data: { id: item.id } }),
		);
		expect("response" in deleted && deleted.response.status).toBe(404);
	});

	it("restarts expansion, rolls back unused schema, and refuses to destroy a used payload", async () => {
		await up(db);
		await down(db);
		await down(db);
		await up(db);
		await up(db);
		await create();
		await expect(down(db)).rejects.toThrow("Protected content exists");
		expect(await db.selectFrom("_emdash_protected_content").selectAll().execute()).toHaveLength(1);
	});

	it("fails closed when private storage is unavailable at initial creation", async () => {
		await down(db);
		await expect(create()).rejects.toThrow();
		expect(await new ContentRepository(db).findBySlug("pages", "protected", "en")).toBeNull();
	});
});
