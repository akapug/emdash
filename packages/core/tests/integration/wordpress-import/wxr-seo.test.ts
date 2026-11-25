/**
 * The WXR execute import carries each post's Yoast SEO / Rank Math / All in
 * One SEO fields into EmDash's SEO table, and the rewrite step points a
 * carried social image at the imported media.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	importContent,
	wxrSeoContext,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { rewriteUrls } from "../../../src/astro/routes/api/import/wordpress/rewrite-urls.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { handlersFromRuntime, createTestRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const IMAGE = "https://example.org/wp-content/uploads/2024/05/pond.jpg";
const LOCAL_IMAGE = "/_emdash/api/media/file/01KSEOIMAGE0000000000000000.jpg";

function meta(key: string, value: string): string {
	return `<wp:postmeta><wp:meta_key>${key}</wp:meta_key><wp:meta_value><![CDATA[${value}]]></wp:meta_value></wp:postmeta>`;
}

const WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Garden</title>
    <link>https://example.org</link>
    <description>Plants and paths</description>
    <item>
      <title>pond.jpg</title>
      <wp:post_id>42</wp:post_id>
      <wp:post_type>attachment</wp:post_type>
      <wp:status>inherit</wp:status>
      <wp:attachment_url>${IMAGE}</wp:attachment_url>
    </item>
    <item>
      <title>The Pond</title>
      <link>https://example.org/the-pond/</link>
      <wp:post_id>7</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>the-pond</wp:post_name>
      <content:encoded><![CDATA[<p>Still water.</p>]]></content:encoded>
      ${meta("_yoast_wpseo_title", "Visit %%title%% %%sep%% %%sitename%%")}
      ${meta("_yoast_wpseo_metadesc", "Koi, lilies and a bench.")}
      ${meta("_yoast_wpseo_meta-robots-noindex", "1")}
      ${meta("_yoast_wpseo_meta-robots-nofollow", "1")}
      ${meta("_yoast_wpseo_opengraph-image-id", "42")}
      ${meta("_yoast_wpseo_canonical", "https://example.org/garden-map/")}
    </item>
    <item>
      <title>Garden Map</title>
      <link>https://example.org/garden-map/</link>
      <wp:post_id>8</wp:post_id>
      <wp:post_type>page</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>garden-map</wp:post_name>
      ${meta("rank_math_title", "Map of %sitename% for %currentyear%")}
      ${meta("rank_math_description", "Every path, marked.")}
    </item>
    <item>
      <title>A note</title>
      <link>https://example.org/notes/a-note/</link>
      <wp:post_id>9</wp:post_id>
      <wp:post_type>note</wp:post_type>
      <wp:status>publish</wp:status>
      <wp:post_name>a-note</wp:post_name>
      ${meta("_yoast_wpseo_title", "A short note")}
    </item>
  </channel>
</rss>`;

interface Harness {
	db: Kysely<Database>;
	emdash: EmDashHandlers;
	manifest: EmDashManifest;
}

const CONFIG: ImportConfig = {
	postTypeMappings: {
		page: { collection: "pages", enabled: true },
		note: { collection: "notes", enabled: true },
	},
	skipExisting: true,
};

async function setup(): Promise<Harness> {
	const db = await setupTestDatabase();
	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: "pages",
		label: "Pages",
		labelSingular: "Page",
		hasSeo: true,
		urlPattern: "/pages/{slug}",
	});
	await registry.createCollection({ slug: "notes", label: "Notes", labelSingular: "Note" });
	for (const collection of ["pages", "notes"]) {
		await registry.createField(collection, { slug: "title", label: "Title", type: "string" });
		await registry.createField(collection, { slug: "content", label: "Content", type: "portableText" });
		await registry.createField(collection, { slug: "excerpt", label: "Excerpt", type: "text" });
	}
	const emdash = handlersFromRuntime(createTestRuntime(db));
	return { db, emdash, manifest: await emdash.getManifest() };
}

async function runImport(harness: Harness, config: ImportConfig = CONFIG) {
	const wxr = await parseWxrString(WXR);
	const plan = await preImportWxrTaxonomies(harness.db, wxr.posts, wxr.categories, wxr.tags, wxr.terms);
	const attachments = new Map(wxr.attachments.map((a): [string, string] => [String(a.id), a.url ?? ""]));
	return importContent(
		wxr.posts,
		config,
		harness.emdash,
		harness.manifest,
		attachments,
		undefined,
		undefined,
		plan,
		wxrSeoContext(wxr, config, harness.manifest),
	);
}

async function idOf(harness: Harness, slug: string): Promise<string> {
	const row = await harness.db
		.selectFrom("ec_pages" as keyof Database)
		.select("id")
		.where("slug", "=", slug)
		.executeTakeFirstOrThrow();
	return (row as { id: string }).id;
}

describe("WXR import: per-post SEO", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await setup();
	});

	afterEach(async () => {
		await teardownTestDatabase(harness.db);
	});

	it("writes the SEO fields EmDash renders, and counts what it could not carry", async () => {
		const result = await runImport(harness);
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(3);

		const seo = new SeoRepository(harness.db);
		expect(await seo.get("pages", await idOf(harness, "the-pond"))).toEqual({
			title: "Visit The Pond",
			description: "Koi, lilies and a bench.",
			image: IMAGE,
			canonical: "https://example.org/pages/garden-map",
			noIndex: true,
		});
		expect(await seo.get("pages", await idOf(harness, "garden-map"))).toEqual({
			title: null,
			description: "Every path, marked.",
			image: null,
			canonical: null,
			noIndex: false,
		});

		expect(result.seo).toMatchObject({
			entries: 3,
			carried: { title: 1, description: 2, robots: 1, canonical: 1, image: 1 },
			dropped: {
				"title:unresolved-variable": 1,
				"all:collection-has-no-seo": 1,
			},
			unresolvedVariables: { currentyear: 1 },
		});
	});

	it("leaves SEO out entirely when importSeo is false", async () => {
		const result = await runImport(harness, { ...CONFIG, importSeo: false });
		expect(result.seo).toBeUndefined();
		const seo = new SeoRepository(harness.db);
		expect((await seo.get("pages", await idOf(harness, "the-pond"))).title).toBeNull();
	});

	it("gives a re-imported entry the SEO it lacks, and never overwrites an SEO row it has", async () => {
		await runImport(harness);
		const seo = new SeoRepository(harness.db);
		const pond = await idOf(harness, "the-pond");
		const map = await idOf(harness, "garden-map");
		await seo.delete("pages", pond);
		await seo.upsert("pages", map, { description: "Edited on the site." });

		const again = await runImport(harness);
		expect(again.imported).toBe(0);
		expect(again.seo).toMatchObject({ filledExisting: 1, keptExisting: 1 });
		expect((await seo.get("pages", pond)).title).toBe("Visit The Pond");
		expect((await seo.get("pages", map)).description).toBe("Edited on the site.");
	});

	it("points a carried social image at the imported media without counting the entry as rewritten", async () => {
		await runImport(harness);
		const rewrite = await rewriteUrls(harness.db, { [IMAGE]: LOCAL_IMAGE }, () => undefined);
		expect(rewrite.seoImagesRewritten).toBe(1);
		expect(rewrite.updated).toBe(0);
		const seo = new SeoRepository(harness.db);
		expect((await seo.get("pages", await idOf(harness, "the-pond"))).image).toBe(LOCAL_IMAGE);
	});
});
