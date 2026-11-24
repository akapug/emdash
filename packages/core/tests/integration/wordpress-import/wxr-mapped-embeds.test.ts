import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as execute } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const embed = {
	_type: "embed",
	_key: "mec-73",
	provider: "embark-events",
	url: "/events/",
	events: {
		version: 1,
		viewSlug: "homepage-next-three",
		mode: "upcoming",
		order: "asc",
		layout: "list",
		start: "today",
		limit: 3,
		navigation: false,
		filters: { category: ["Talk"], location: ["Hall"], organizer: ["Garden club"] },
	},
};
const omitEmbeds = Symbol("no embeds option");
const unavailable = {
	_type: "embed",
	_key: "mec-unresolved",
	provider: "embark-events",
	url: "/events/",
	events: { version: 1, viewSlug: "" },
};
const before =
	'<p>Before <strong>bold</strong> and <a href="https://example.org/info">linked</a>.</p>';
const after = "<p>After [[MEC id=73]] literal.</p>";
const video =
	'<iframe src="https://www.youtube.com/embed/abc123DEF45" width="640" height="360"></iframe>';
const cases = [
	{ name: "classic", body: `${before}\n\n[MEC id=73]\n\n${after}\n\n${video}` },
	{ name: "case-insensitive shortcode", body: `${before}\n\n[mEc id=73]\n\n${after}\n\n${video}` },
	{ name: "double-quoted ID", body: `${before}\n\n[MEC id="73"]\n\n${after}\n\n${video}` },
	{
		name: "single-quoted zero-padded ID",
		body: `${before}\n\n[MEC id='073']\n\n${after}\n\n${video}`,
	},
	{
		name: "Gutenberg shortcode",
		body: `<!-- wp:paragraph -->${before}<!-- /wp:paragraph --><!-- wp:shortcode -->[MEC id=73]<!-- /wp:shortcode --><!-- wp:paragraph -->${after}<!-- /wp:paragraph --><!-- wp:embed {"url":"https://www.youtube.com/watch?v=abc123DEF45","providerNameSlug":"youtube"} -->${video}<!-- /wp:embed -->`,
	},
	{
		name: "Gutenberg HTML",
		body: `<!-- wp:html -->${before}<div>[MEC id=73]</div>${after}${video}<!-- /wp:html -->`,
	},
];
interface Block {
	_type: string;
	_key: string;
	provider?: string;
	url?: string;
	events?: unknown;
	children?: Array<{ text: string; marks?: string[] }>;
	markDefs?: Array<{ href?: string }>;
	html?: string;
}
const textOf = (block: Block) =>
	block.children?.map((child) => child.text).join("") ?? block.html ?? "";

const wxr = (body: string, nextBody?: string) =>
	`<?xml version="1.0"?><rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Synthetic views</title><link>https://example.org</link><language>en</language><item><title>Homepage</title><wp:post_id>7</wp:post_id><wp:post_type>page</wp:post_type><wp:post_name>home</wp:post_name><wp:status>publish</wp:status><content:encoded><![CDATA[${body}]]></content:encoded></item>${nextBody === undefined ? "" : `<item><title>Following page</title><wp:post_id>8</wp:post_id><wp:post_type>page</wp:post_type><wp:post_name>following</wp:post_name><wp:status>publish</wp:status><content:encoded><![CDATA[${nextBody}]]></content:encoded></item>`}</channel></rss>`;

describe("WXR carried embeds at the original content mutation", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;
	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "pages",
			label: "Pages",
			labelSingular: "Page",
			urlPattern: "/{slug}",
		});
		await registry.createField("pages", {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await registry.createField("pages", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});
		await registry.createField("pages", { slug: "excerpt", label: "Excerpt", type: "text" });
		emdash = handlersFromRuntime(createTestRuntime(db));
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function run(
		body: string,
		embeds: unknown = { "7": embed },
		extra: Record<string, unknown> = {},
		nextBody?: string,
	) {
		const form = new FormData();
		form.set(
			"file",
			new File([wxr(body, nextBody)], "synthetic-views.xml", { type: "application/xml" }),
		);
		form.set(
			"config",
			JSON.stringify({
				postTypeMappings: { page: { collection: "pages", enabled: true } },
				skipExisting: true,
				importSections: false,
				...(embeds === omitEmbeds ? {} : { embeds }),
				...extra,
			}),
		);
		return execute({
			request: new Request("http://localhost/_emdash/api/import/wordpress/execute", {
				method: "POST",
				body: form,
			}),
			locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
		} as Parameters<typeof execute>[0]);
	}
	async function row() {
		return db
			.selectFrom("ec_pages" as keyof Database)
			.selectAll()
			.executeTakeFirstOrThrow() as Promise<Record<string, unknown>>;
	}

	it.each(cases)(
		"preserves the host-shaped next-three view, its source position, surrounding marks and other embeds through $name",
		async ({ body }) => {
			const response = await run(body);
			expect((await response.json()).data).toMatchObject({
				success: true,
				imported: 1,
				errors: [],
			});
			const stored = await row();
			expect(stored.status).toBe("published");
			const blocks: Block[] = JSON.parse(stored.content as string);
			const at = blocks.findIndex((block) => block.provider === "embark-events");
			expect(at).toBeGreaterThan(0);
			expect(blocks[at]).toEqual({ ...embed, _key: "mec-7-73-1" });
			expect(blocks.slice(0, at).map(textOf).join("\n")).toContain("Before bold and linked.");
			expect(
				blocks
					.slice(at + 1)
					.map(textOf)
					.join("\n"),
			).toContain("After [[MEC id=73]] literal.");
			expect(blocks.filter((block) => block.provider === "embark-events")).toHaveLength(1);
			expect(blocks.some((block) => block.provider === "youtube")).toBe(true);
			expect(blocks.flatMap((block) => block.children ?? [])).toContainEqual(
				expect.objectContaining({ text: "bold", marks: expect.arrayContaining(["strong"]) }),
			);
			expect(blocks.flatMap((block) => block.markDefs ?? [])).toContainEqual(
				expect.objectContaining({ href: "https://example.org/info" }),
			);
			expect((await emdash.handleContentPublish("pages", stored.id as string)).success).toBe(true);
			const revisions = await db
				.selectFrom("revisions")
				.selectAll()
				.where("entry_id", "=", stored.id as string)
				.execute();
			expect(revisions).toHaveLength(1);
			expect(JSON.parse(revisions[0]!.data).content).toEqual(blocks);
			const readback = await emdash.handleContentGet("pages", stored.id as string);
			expect(readback).toMatchObject({
				success: true,
				data: { item: { data: { content: blocks } } },
			});
			const again = await run(body);
			expect((await again.json()).data).toMatchObject({
				success: true,
				imported: 0,
				skipped: 1,
				errors: [],
			});
			expect(JSON.parse((await row()).content as string)).toEqual(blocks);
		},
	);

	it.each([
		{
			name: "classic inline",
			body: '<p><a href="https://example.org/info"><strong>Before [MEC id=73] after</strong></a> and [[MEC id=73]].</p>',
		},
		{
			name: "Gutenberg paragraph inline",
			body: '<!-- wp:paragraph --><p><a href="https://example.org/info"><strong>Before [MEC id=73] after</strong></a> and [[MEC id=73]].</p><!-- /wp:paragraph -->',
		},
		{
			name: "Gutenberg HTML inline",
			body: '<!-- wp:html --><p><a href="https://example.org/info"><strong>Before [MEC id=73] after</strong></a> and [[MEC id=73]].</p><!-- /wp:html -->',
		},
	])("splits an inline shortcode without losing either side's marks in $name", async ({ body }) => {
		expect((await (await run(body)).json()).data).toMatchObject({ success: true, imported: 1 });
		const blocks: Block[] = JSON.parse((await row()).content as string);
		expect(blocks).toHaveLength(3);
		expect(blocks[1]).toEqual({ ...embed, _key: "mec-7-73-1" });
		expect(textOf(blocks[0]!)).toBe("Before ");
		expect(textOf(blocks[2]!)).toBe(" after and [[MEC id=73]].");
		for (const index of [0, 2]) {
			expect(blocks[index]!.children![0]!.marks).toContain("strong");
			expect(blocks[index]!.markDefs).toContainEqual(
				expect.objectContaining({ href: "https://example.org/info" }),
			);
		}
	});

	it("replaces only source shortcodes, not entity-encoded lookalikes or attribute text", async () => {
		const response = await run(
			'<p><a href="https://example.org/?literal=[MEC id=84]">Before</a></p>[MEC id=73]<p>Literal &#91;MEC id=84&#93; remains.</p>',
		);
		expect((await response.json()).data).toMatchObject({ success: true, imported: 1, errors: [] });
		const blocks: Block[] = JSON.parse((await row()).content as string);
		expect(blocks.filter((block) => block.provider === "embark-events")).toEqual([
			{ ...embed, _key: "mec-7-73-1" },
		]);
		expect(blocks.map(textOf).join("\n")).toContain("Literal [MEC id=84] remains.");
		expect(blocks.flatMap((block) => block.markDefs ?? [])).toContainEqual(
			expect.objectContaining({ href: "https://example.org/?literal=[MEC id=84]" }),
		);
	});

	it("persists each dictionary view by explicit source ID with stable occurrence keys, not supplied keys", async () => {
		const tile = {
			...embed,
			_key: "spoof-73",
			events: { ...embed.events, viewSlug: "tile-pager", layout: "tile", navigation: true },
		};
		const response = await run(
			"<p>Before</p>[MEC id=73]<p>Between [[MEC id=84]] literal.</p>[MEC id=84]<p>Again</p>[MEC id=73]<p>After</p>",
			{ "7": { "73": { ...embed, _key: "spoof-84" }, "84": tile } },
		);
		expect((await response.json()).data).toMatchObject({ success: true, imported: 1, errors: [] });
		const stored = await row();
		const blocks: Block[] = JSON.parse(stored.content as string);
		expect(blocks.filter((b) => b.provider === "embark-events")).toEqual([
			{ ...embed, _key: "mec-7-73-1" },
			{ ...tile, _key: "mec-7-84-1" },
			{ ...embed, _key: "mec-7-73-2" },
		]);
		expect(blocks.map(textOf).join("\n")).toContain("Between [[MEC id=84]] literal.");
		expect((await emdash.handleContentPublish("pages", stored.id as string)).success).toBe(true);
		const revisions = await db
			.selectFrom("revisions")
			.selectAll()
			.where("entry_id", "=", stored.id as string)
			.execute();
		expect(revisions).toHaveLength(1);
		expect(JSON.parse(revisions[0]!.data).content).toEqual(blocks);
		expect(await emdash.handleContentGet("pages", stored.id as string)).toMatchObject({
			success: true,
			data: { item: { data: { content: blocks } } },
		});
	});

	it("persists a source view's search bar through the execute request", async () => {
		const past = {
			...embed,
			events: { ...embed.events, viewSlug: "past-886", mode: "past", order: "desc", searchBar: { text: true, monthYear: true } },
		};
		const response = await run("[MEC id=886]", { "7": { "886": past } });
		expect((await response.json()).data).toMatchObject({ success: true, imported: 1, errors: [] });
		const blocks: Block[] = JSON.parse((await row()).content as string);
		expect(blocks.filter((b) => b.provider === "embark-events")).toEqual([{ ...past, _key: "mec-7-886-1" }]);
	});

	it("does not substitute another dictionary entry when the source view ID has no definition", async () => {
		const response = await run("[MEC id=73]", { "7": { "84": { ...embed, _key: "mec-73" } } });
		const result = (await response.json()).data;
		expect(result).toMatchObject({ success: false, imported: 1 });
		expect(JSON.stringify(result.errors)).toMatch(/73.*definition|definition.*73/i);
		const blocks: Block[] = JSON.parse((await row()).content as string);
		expect(blocks).toEqual([{ ...unavailable, _key: "mec-7-73-1" }]);
	});

	it.each([false, true])(
		"ignores unused dictionary definitions and activates only the real visible token: %s",
		async (real) => {
			const source =
				'<p data-literal="[MEC id=73]">Before [[MEC id=73]] &#91;MEC id=73&#93;.</p><!-- [MEC id=73] --><script>[MEC id=73]</script><style>[MEC id=73]</style>' +
				(real ? "<p>[MEC id=73]</p>" : "") +
				"<p>After.</p>";
			const response = await run(source, { "7": { "73": embed, "84": unavailable } });
			expect((await response.json()).data).toMatchObject({
				success: true,
				imported: 1,
				errors: [],
			});
			const blocks: Block[] = JSON.parse((await row()).content as string);
			expect(blocks.filter((b) => b.provider === "embark-events")).toEqual(
				real ? [{ ...embed, _key: "mec-7-73-1" }] : [],
			);
			expect(blocks.map(textOf).join("\n")).toContain("Before [[MEC id=73]] [MEC id=73].");
			expect(blocks.map(textOf).join("\n")).toContain("After.");
		},
	);

	it.each([
		{
			name: "list source provenance",
			source: "<ul><li>&#91;MEC id=73&#93;</li><li>[MEC id=73]</li></ul>",
		},
		{
			name: "Gutenberg single-cell layout wrapper",
			source:
				'<!-- wp:table --><figure class="wp-block-table"><table><tbody><tr><td><br>[MEC id=73]</td></tr></tbody></table></figure><!-- /wp:table -->',
		},
		{
			name: "classic single-cell layout wrapper",
			source: "<table><tr><td> <br>[MEC id=73]<br /> </td></tr></table>",
		},
		{
			name: "browser comment order",
			source: "<!-- <script> --><p>[MEC id=73]</p><!-- </script> -->",
		},
	])(
		"preserves $name in the original row, published revision and actual readback",
		async ({ name, source }) => {
			const response = await run(source, { "7": { "73": embed } });
			expect((await response.json()).data).toMatchObject({
				success: true,
				imported: 1,
				errors: [],
			});
			const stored = await row();
			const blocks: Block[] = JSON.parse(stored.content as string);
			expect(blocks.filter((b) => b.provider === "embark-events")).toEqual([
				{ ...embed, _key: "mec-7-73-1" },
			]);
			if (name.endsWith("single-cell layout wrapper"))
				expect(blocks).toEqual([{ ...embed, _key: "mec-7-73-1" }]);
			if (name === "list source provenance")
				expect(blocks.map(textOf).join("\n")).toContain("[MEC id=73]");
			expect((await emdash.handleContentPublish("pages", stored.id as string)).success).toBe(true);
			const revisions = await db
				.selectFrom("revisions")
				.selectAll()
				.where("entry_id", "=", stored.id as string)
				.execute();
			expect(revisions).toHaveLength(1);
			expect(JSON.parse(revisions[0]!.data).content).toEqual(blocks);
			expect(await emdash.handleContentGet("pages", stored.id as string)).toMatchObject({
				success: true,
				data: { item: { data: { content: blocks } } },
			});
		},
	);

	it("imports the next entry intact after the prior entry's span-only table refusal", async () => {
		const response = await run(
			"<table><tr><td>[MEC id=73]</td><td>Other content</td></tr></table>",
			{ "7": { "73": embed } },
			{},
			"<h2>Visible heading</h2><p>Visible paragraph</p>",
		);
		const result = (await response.json()).data;
		expect(result).toMatchObject({ success: false, imported: 1 });
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("span-only");
		const stored = await row();
		expect(stored.slug).toBe("following");
		const blocks: Array<Block & { style?: string }> = JSON.parse(stored.content as string);
		expect(blocks.map((b) => b.style)).toEqual(["h2", "normal"]);
		expect(blocks.map(textOf)).toEqual(["Visible heading", "Visible paragraph"]);
		expect(await emdash.handleContentGet("pages", stored.id as string)).toMatchObject({
			success: true,
			data: { item: { data: { content: blocks } } },
		});
	});

	it("reports a resolved shortcode in a multi-cell table rather than silently importing its raw token", async () => {
		const response = await run(
			'<!-- wp:table --><figure class="wp-block-table"><table><tbody><tr><td>[MEC id=73]</td><td>Other content</td></tr></tbody></table></figure><!-- /wp:table -->',
			{ "7": { "73": embed } },
		);
		const result = (await response.json()).data;
		expect(result).toMatchObject({ success: false, imported: 0 });
		expect(JSON.stringify(result.errors)).toMatch(/MEC.*span|span.*MEC/i);
		expect(
			await db
				.selectFrom("ec_pages" as keyof Database)
				.selectAll()
				.execute(),
		).toEqual([]);
	});

	it("preserves the explicit upstream comments opt-out through the actual execute request", async () => {
		const response = await run("<p>Body</p>", omitEmbeds, { importComments: false });
		const result = (await response.json()).data;
		expect(result).toMatchObject({ success: true, imported: 1 });
		expect(result.comments).toBeUndefined();
	});

	it("keeps identical repeats in place with distinct block keys", async () => {
		expect(
			(await (await run("<p>Before</p>[MEC id=73]<p>Between</p>[MEC id=73]<p>After</p>")).json())
				.data,
		).toMatchObject({ success: true, imported: 1 });
		const blocks: Block[] = JSON.parse((await row()).content as string);
		const views = blocks.filter((block) => block.provider === "embark-events");
		expect(views).toHaveLength(2);
		expect(views.map((block) => block.events)).toEqual([embed.events, embed.events]);
		expect(new Set(blocks.map((block) => block._key)).size).toBe(blocks.length);
		expect(
			blocks.map((block) => (block.provider === "embark-events" ? "VIEW" : textOf(block))),
		).toEqual(["Before", "VIEW", "Between", "VIEW", "After"]);
	});

	it.each([embed, unavailable].map((mapped) => ({ mapped })))(
		"keeps multiple different views unavailable rather than rendering one view twice: $mapped._key",
		async ({ mapped }) => {
			const response = await run("<p>Before</p>[MEC id=73]<p>Between</p>[MEC id=84]<p>After</p>", {
				"7": mapped,
			});
			const result = (await response.json()).data;
			expect(result.imported).toBe(1);
			const blocks: Block[] = JSON.parse((await row()).content as string);
			expect(
				blocks.filter((block) => block.provider === "embark-events").map((block) => block.events),
			).toEqual([unavailable.events, unavailable.events]);
			expect(JSON.stringify(result)).toMatch(/different.*view|multiple.*view/i);
		},
	);

	it("does not attach a supplied block when no unescaped shortcode exists", async () => {
		const response = await run("<p>Only [[MEC id=73]] literal.</p>");
		const result = (await response.json()).data;
		expect(result).toMatchObject({ success: false, imported: 0 });
		expect(JSON.stringify(result)).toMatch(/unescaped|shortcode|placement/i);
		expect(
			await db
				.selectFrom("ec_pages" as keyof Database)
				.selectAll()
				.execute(),
		).toEqual([]);
	});

	it("preserves the existing conversion when embeds are absent", async () => {
		const response = await run("<p>Before</p>[MEC id=73]<p>After</p>", omitEmbeds);
		expect((await response.json()).data).toMatchObject({ success: true, imported: 1 });
		const blocks: Block[] = JSON.parse((await row()).content as string);
		expect(blocks.some((block) => block.provider === "embark-events")).toBe(false);
		expect(blocks.map(textOf).join("\n")).toContain("[MEC id=73]");
	});

	it.each(
		[
			null,
			[],
			{ "7": null },
			{ "7": [] },
			{ "7": { ...embed, _type: "block" } },
			{ "7": { ...embed, provider: "other" } },
			{ "7": { ...embed, url: "https://example.org/" } },
			{ "7": { ...embed, events: { ...embed.events, limit: "3" } } },
			{ "7": { ...embed, events: { ...embed.events, navigation: true } } },
			{ wrong: embed },
			{ "7": { bad: embed } },
			{ "7": { "73": null } },
			{ "7": { "73": { ...embed, events: { ...embed.events, filters: { category: [] } } } } },
			{ "7": { "73": { ...embed, events: { ...embed.events, navigation: true } } } },
			{ "7": { ...embed, events: { ...embed.events, searchBar: {} } } },
			{ "7": { ...embed, events: { ...embed.events, searchBar: { text: false, monthYear: false } } } },
			{ "7": { ...embed, events: { ...embed.events, searchBar: { category: true } } } },
			{ "7": { ...embed, events: { ...embed.events, searchBar: { text: "yes" } } } },
		].map((embeds) => ({ embeds })),
	)("rejects malformed embeds before writing: $embeds", async ({ embeds }) => {
		const response = await run("[MEC id=73]", embeds);
		expect(response.status).toBe(400);
		expect(
			await db
				.selectFrom("ec_pages" as keyof Database)
				.selectAll()
				.execute(),
		).toEqual([]);
	});
});
