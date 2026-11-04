/**
 * A WXR export's comments, through the import as the admin wizard (and any
 * client of the execute route) drives it: the approved comments a visitor of
 * the WordPress site could read land in EmDash's own comments table, threaded,
 * dated and approved; a pending, spam or trashed comment and a pingback never
 * land, and the result counts each by why. The body is the text a reader saw:
 * a script in it is gone, and its markup is not stored. The public read of the
 * comments carries no commenter's email, and nothing stores an IP address.
 */
import { readFileSync } from "node:fs";

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	importContent,
	type ImportConfig,
} from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import { parseWxrString, type WxrPost } from "../../../src/cli/wxr/parser.js";
import { lookupContentAuthor, sendCommentNotification } from "../../../src/comments/notifications.js";
import { getCommentsWithDb } from "../../../src/comments/query.js";
import type { Database } from "../../../src/database/types.js";
import { preImportWxrTaxonomies } from "../../../src/import/wxr-taxonomies.js";
import { EmailPipeline } from "../../../src/plugins/email.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const WXR = readFileSync(new URL("./fixtures/comments-export.xml", import.meta.url), "utf8");

const CONFIG: ImportConfig = {
	// `product` is not mapped: item 9 and its comment do not come over.
	postTypeMappings: { post: { collection: "posts", enabled: true } },
	skipExisting: true,
};

describe("WXR import: a post's comments", () => {
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
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	const run = async (config: ImportConfig = CONFIG, edit?: (post: WxrPost) => void) => {
		const wxr = await parseWxrString(WXR);
		if (edit) wxr.posts.forEach(edit);
		const plan = await preImportWxrTaxonomies(db, wxr.posts, wxr.categories, wxr.tags, wxr.terms);
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
	const rows = () => db.selectFrom("_emdash_comments").selectAll().orderBy("created_at").execute();
	const postId = async () =>
		(
			(await db
				.selectFrom("ec_posts" as keyof Database)
				.select("id" as never)
				.where("slug" as never, "=", "the-pond" as never)
				.executeTakeFirstOrThrow()) as { id: string }
		).id;

	it("stores the approved comments, threaded, and counts the rest by why", async () => {
		const result = await run();
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		expect(result.comments).toEqual({
			imported: 4,
			skipped: 0,
			notCarried: { pending: 1, spam: 1, trash: 1, pingback: 1, "post-not-imported": 1 },
		});

		const stored = await rows();
		const id = await postId();
		expect(
			stored.map((r) => [
				r.author_name,
				r.body,
				r.status,
				r.created_at,
				r.collection,
				r.content_id,
			]),
		).toEqual([
			[
				"Alice",
				"First!\n\nLovely fish (https://example.org/fish) & frogs.",
				"approved",
				"2026-01-16T10:00:00.000Z",
				"posts",
				id,
			],
			["Bob", "Agreed, quite lovely.", "approved", "2026-01-17T10:00:00.000Z", "posts", id],
			["Cy", "A reply to the reply.", "approved", "2026-01-18T10:00:00.000Z", "posts", id],
			["Mallory", "Hi there", "approved", "2026-01-21T10:00:00.000Z", "posts", id],
		]);
		// EmDash threads one level deep: the reply to the reply hangs on the root.
		const [alice, bob, cy, mallory] = stored;
		expect([alice!.parent_id, bob!.parent_id, cy!.parent_id, mallory!.parent_id]).toEqual([
			null,
			alice!.id,
			alice!.id,
			null,
		]);
		// Nothing of a request is stored: the export's IP addresses are never read.
		expect(stored.every((r) => r.ip_hash === null && r.user_agent === null)).toBe(true);
		expect(JSON.stringify(stored)).not.toContain("203.0.113.9");
		// No body holds markup: the script and the tags are gone.
		expect(stored.some((r) => /[<>]/.test(r.body))).toBe(false);
	});

	it("serves them publicly without any commenter's email", async () => {
		await run();
		const { items, total } = await getCommentsWithDb(db, {
			collection: "posts",
			contentId: await postId(),
			threaded: true,
		});
		expect(total).toBe(4);
		expect(items.map((c) => [c.authorName, c.replies?.map((r) => r.authorName) ?? []])).toEqual([
			["Alice", ["Bob", "Cy"]],
			["Mallory", []],
		]);
		expect(JSON.stringify(items)).not.toMatch(/@example\.net/);
	});

	it("imports historical approved comments without sending mail through an available pipeline", async () => {
		// The post's author is a verified user with an address, so a stored comment
		// that reached the notification path would mail them. Without an author no
		// comment can notify anyone, and a zero below would prove nothing.
		await db
			.insertInto("users")
			.values({
				id: "author_1",
				email: "author@example.org",
				name: "Pat",
				role: 40,
				email_verified: 1,
			})
			.execute();
		emdash.email = new EmailPipeline(createHookPipeline([], { db }));
		vi.spyOn(emdash.email, "isAvailable").mockReturnValue(true);
		const send = vi.spyOn(emdash.email, "send").mockResolvedValue({ status: "sent" });

		const result = await run({ ...CONFIG, authorMappings: { pat: "author_1" } });
		expect(result.errors).toEqual([]);
		expect(result.comments?.imported).toBe(4);
		const stored = await rows();
		expect(stored).toHaveLength(4);
		expect(send).not.toHaveBeenCalled();

		// Control: the same pipeline and author do mail when a stored comment
		// reaches the notification path, so the import's zero is the import's.
		const first = stored[0]!;
		const found = await lookupContentAuthor(db, "posts", first.content_id);
		expect(found?.author?.email).toBe("author@example.org");
		const sent = await sendCommentNotification({
			email: emdash.email,
			comment: {
				authorName: first.author_name,
				authorEmail: first.author_email,
				body: first.body,
				status: first.status,
				collection: first.collection,
			},
			contentAuthor: found?.author,
			adminBaseUrl: "https://example.org/_emdash",
		});
		expect(sent).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("stores nothing twice when the export is imported again", async () => {
		await run();
		const again = await run();
		expect(again.comments).toMatchObject({ imported: 0, skipped: 4 });
		expect(await rows()).toHaveLength(4);
	});

	it("stores no comment when importComments is false", async () => {
		const result = await run({ ...CONFIG, importComments: false });
		expect(result.comments).toBeUndefined();
		expect(await rows()).toHaveLength(0);
	});

	// WordPress shows no comment on an item a visitor cannot read, and EmDash's
	// public comment list does not check that its entry is published.
	it.each([
		["private", { status: "private" }, "unpublished-parent"],
		["behind a password", { postPassword: "hunter2" }, "password-protected-parent"],
	] as const)("stores no comment on a post that is %s", async (_, change, reason) => {
		const result = await run(CONFIG, (post) => {
			if (post.id === 7) Object.assign(post, change);
		});
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		expect(result.comments).toEqual({
			imported: 0,
			skipped: 0,
			notCarried: { [reason]: 8, "post-not-imported": 1 },
		});
		expect(await rows()).toHaveLength(0);
	});
});
