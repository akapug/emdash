/**
 * An item WordPress kept behind a post password, through each WXR import: the
 * admin wizard's execute route, the CLI and the WXR import source. EmDash has
 * no password gate, so such an item is stored as a draft whatever its
 * WordPress status, the result names it, and a visitor's read of the site
 * (the live loader through `getEmDashEntry` and `getEmDashCollection`) does
 * not serve it. The password is not stored. An unprotected published item
 * still publishes.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	importContent,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import {
	executeWordPressImport,
	prepareWordPressImport,
} from "../../../src/cli/commands/import/wordpress.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import type { Database } from "../../../src/database/types.js";
import { wxrSource } from "../../../src/import/sources/wxr.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { emdashLoader } from "../../../src/loader.js";
import { getEmDashCollection, getEmDashEntry } from "../../../src/query.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// A visitor's read: Astro's live content API over EmDash's own loader.
vi.mock("astro:content", () => ({ getLiveEntry: vi.fn(), getLiveCollection: vi.fn() }));
import { getLiveCollection, getLiveEntry } from "astro:content";

const PASSWORD = "hunter2-wxr-secret";

const item = (id: number, slug: string, status: string, password: string) => `
    <item>
      <title><![CDATA[${slug}]]></title>
      <link>https://example.org/${slug}/</link>
      <pubDate>Thu, 15 Jan 2026 10:00:00 +0000</pubDate>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <content:encoded><![CDATA[<p>The words of ${slug}.</p>]]></content:encoded>
      <excerpt:encoded><![CDATA[]]></excerpt:encoded>
      <wp:post_id>${id}</wp:post_id>
      <wp:post_date_gmt><![CDATA[2026-01-15 10:00:00]]></wp:post_date_gmt>
      <wp:post_name><![CDATA[${slug}]]></wp:post_name>
      <wp:status><![CDATA[${status}]]></wp:status>
      <wp:post_type><![CDATA[post]]></wp:post_type>
      <wp:post_password><![CDATA[${password}]]></wp:post_password>
    </item>`;

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Garden</title>
    <link>https://example.org</link>
    ${item(7, "the-secret", "publish", PASSWORD)}
    ${item(8, "the-open", "publish", "")}
    ${item(9, "the-private-secret", "private", PASSWORD)}
  </channel>
</rss>`;

describe("WXR import: an item behind a password", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts", labelSingular: "Post" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		await registry.createField("posts", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("posts", { slug: "excerpt", label: "Excerpt", type: "text" });
		emdash = handlersFromRuntime(createTestRuntime(db));

		const loader = emdashLoader();
		vi.mocked(getLiveEntry).mockImplementation((async (_: string, filter: never) => {
			const r = await loader.loadEntry({ filter });
			if (!r) return { entry: undefined };
			if ("error" in r && r.error) return { error: r.error };
			return { entry: r, cacheHint: {} };
		}) as never);
		vi.mocked(getLiveCollection).mockImplementation((async (_: string, filter: never) => {
			const r = await loader.loadCollection({ filter });
			if ("error" in r && r.error) return { entries: [], error: r.error };
			return { entries: "entries" in r ? r.entries : [], cacheHint: {} };
		}) as never);
	});

	afterEach(async () => {
		vi.mocked(getLiveEntry).mockReset();
		vi.mocked(getLiveCollection).mockReset();
		await teardownTestDatabase(db);
	});

	const run = async () => {
		const wxr = await parseWxrString(WXR);
		const plan = await preImportWxrTaxonomies(db, wxr.posts, wxr.categories, wxr.tags, wxr.terms);
		const config: ImportConfig = {
			postTypeMappings: { post: { collection: "posts", enabled: true } },
			skipExisting: true,
		};
		return importContent(
			wxr.posts,
			config,
			emdash,
			await emdash.getManifest(),
			new Map(),
			undefined,
			undefined,
			plan,
			undefined,
			wxr.site.language,
		);
	};

	const visitor = <T>(read: () => Promise<T>) => runWithContext({ editMode: false, db }, read);

	it("stores it as a draft, names it in the result, and never stores the password", async () => {
		const result = await run();
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(3);
		expect(result.drafted).toEqual([
			{ title: "the-secret", reason: "password-protected" },
			{ title: "the-private-secret", reason: "password-protected" },
		]);

		const rows = (await db
			.selectFrom("ec_posts" as keyof Database)
			.selectAll()
			.orderBy("slug" as never)
			.execute()) as Array<Record<string, unknown>>;
		expect(rows.map((r) => [r.slug, r.status, r.published_at ?? null])).toEqual([
			["the-open", "published", "2026-01-15T10:00:00.000Z"],
			["the-private-secret", "draft", null],
			["the-secret", "draft", null],
		]);
		// No table holds the password: not the entry, not its revisions, not anything else.
		const tables = await db.introspection.getTables();
		for (const t of tables) {
			const all = await db
				.selectFrom(t.name as keyof Database)
				.selectAll()
				.execute();
			expect(JSON.stringify(all), t.name).not.toContain(PASSWORD);
		}
	});

	it("is not served to a visitor, while the unprotected published post is", async () => {
		await run();

		const open = await visitor(() => getEmDashEntry("posts", "the-open"));
		expect(open.error).toBeUndefined();
		// The read path is live: the published post comes back through the loader.
		expect(open.entry?.data).toMatchObject({ title: "the-open", status: "published" });

		const secret = await visitor(() => getEmDashEntry("posts", "the-secret"));
		expect(secret.error).toBeUndefined();
		expect(secret.entry).toBeNull();

		const list = await visitor(() => getEmDashCollection("posts"));
		expect(list.error).toBeUndefined();
		expect(list.entries.map((e) => e.data.title)).toEqual(["the-open"]);
		expect(JSON.stringify(list.entries)).not.toContain("The words of the-secret");
	});

	it("is written as a draft by the CLI, which names it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "emdash-wp-password-"));
		try {
			const file = join(dir, "export.xml");
			await writeFile(file, WXR);
			const common = {
				outputDir: join(dir, "out"),
				configPath: join(dir, ".wp-migration.json"),
				verbose: false,
				dryRun: false,
				json: false,
			};
			await prepareWordPressImport(file, common);
			const result = await executeWordPressImport(file, {
				...common,
				skipMedia: true,
				resume: false,
			});
			expect(result.errors).toEqual([]);
			expect(result.drafted).toEqual([
				{ id: 7, title: "the-secret", reason: "password-protected" },
				{ id: 9, title: "the-private-secret", reason: "password-protected" },
			]);
			const status = async (slug: string) =>
				(
					JSON.parse(await readFile(join(dir, "out", "posts", `${slug}.json`), "utf-8")) as {
						status: string;
					}
				).status;
			expect([
				await status("the-secret"),
				await status("the-open"),
				await status("the-private-secret"),
			]).toEqual(["draft", "published", "draft"]);
			for (const name of await readdir(join(dir, "out", "posts"))) {
				expect(await readFile(join(dir, "out", "posts", name), "utf-8")).not.toContain(PASSWORD);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("is a draft in the WXR import source's items", async () => {
		const out = [];
		for await (const i of wxrSource.fetchContent(
			{ type: "file", file: new File([WXR], "export.xml", { type: "text/xml" }) },
			{ postTypes: ["post"], includeDrafts: true },
		))
			out.push(i);
		expect(out.map((i) => [i.slug, i.status])).toEqual([
			["the-secret", "draft"],
			["the-open", "publish"],
			["the-private-secret", "draft"],
		]);
		expect(JSON.stringify(out)).not.toContain(PASSWORD);
	});
});
