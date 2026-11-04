/**
 * Tests for comment import from the WordPress plugin API:
 * - preserves author, date, and status
 * - threads replies (deep WP threads flatten onto the root comment)
 * - skips comments whose post was not imported
 * - idempotent re-import
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { WxrComment, WxrPost } from "../../../src/cli/wxr/parser.js";
import {
	importCommentsFromPlugin,
	importWxrComments,
	type PluginComment,
	wxrCommentText,
} from "../../../src/import/comments.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let db: Awaited<ReturnType<typeof setupTestDatabase>>;

beforeEach(async () => {
	db = await setupTestDatabase();
});

afterEach(async () => {
	await teardownTestDatabase(db);
});

function comment(overrides: Partial<PluginComment> & { id: number }): PluginComment {
	return {
		post_id: 10,
		parent_id: null,
		author_name: "Alice",
		author_email: "alice@example.com",
		body: "Nice post!",
		date_gmt: "2020-05-01T12:00:00Z",
		status: "approved",
		...overrides,
	};
}

const contentIdMap = new Map([[10, "CONTENT1"]]);
const collectionMap = new Map([[10, "posts"]]);

describe("importCommentsFromPlugin", () => {
	it("imports comments with preserved author, date, and status", async () => {
		const result = await importCommentsFromPlugin(
			[
				comment({ id: 1 }),
				comment({ id: 2, author_name: "Bob", author_email: "bob@example.com", status: "pending" }),
			],
			db,
			contentIdMap,
			collectionMap,
		);

		expect(result.imported).toBe(2);
		expect(result.errors).toEqual([]);

		const rows = await db
			.selectFrom("_emdash_comments")
			.selectAll()
			.orderBy("created_at")
			.execute();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.collection).toBe("posts");
		expect(rows[0]!.content_id).toBe("CONTENT1");
		expect(rows[0]!.author_name).toBe("Alice");
		expect(rows[0]!.created_at).toBe("2020-05-01T12:00:00.000Z");
		expect(rows[1]!.status).toBe("pending");
	});

	it("threads replies and flattens deep threads onto the root", async () => {
		await importCommentsFromPlugin(
			[
				comment({ id: 1 }),
				comment({ id: 2, parent_id: 1, date_gmt: "2020-05-02T12:00:00Z" }),
				// Reply to the reply -- deeper than EmDash's 1-level threading
				comment({ id: 3, parent_id: 2, date_gmt: "2020-05-03T12:00:00Z" }),
			],
			db,
			contentIdMap,
			collectionMap,
		);

		const rows = await db
			.selectFrom("_emdash_comments")
			.select(["id", "parent_id", "created_at"])
			.orderBy("created_at")
			.execute();
		const root = rows[0]!;
		expect(root.parent_id).toBeNull();
		// Both the reply and the reply-to-reply hang off the root
		expect(rows[1]!.parent_id).toBe(root.id);
		expect(rows[2]!.parent_id).toBe(root.id);
	});

	it("skips comments for posts that were not imported", async () => {
		const result = await importCommentsFromPlugin(
			[comment({ id: 1, post_id: 999 })],
			db,
			contentIdMap,
			collectionMap,
		);

		expect(result.imported).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("is idempotent on re-import", async () => {
		const comments = [
			comment({ id: 1 }),
			comment({ id: 2, parent_id: 1, date_gmt: "2020-05-02T12:00:00Z" }),
		];
		await importCommentsFromPlugin(comments, db, contentIdMap, collectionMap);
		const second = await importCommentsFromPlugin(comments, db, contentIdMap, collectionMap);

		expect(second.imported).toBe(0);
		expect(second.skipped).toBe(2);

		const rows = await db.selectFrom("_emdash_comments").select("id").execute();
		expect(rows).toHaveLength(2);
	});
});

describe("wxrCommentText", () => {
	it("keeps paragraphs as blank lines and line breaks as lines", () => {
		expect(wxrCommentText("Line one\nLine two\n\nPara two")).toBe("Line one\nLine two\n\nPara two");
	});

	it("follows a link's words with its address, once, unless the words are the address", () => {
		expect(
			wxrCommentText(
				'See <a href="https://example.org/a">this <em>page</em></a> and <a href="https://example.org/b">https://example.org/b</a>',
			),
		).toBe("See this page (https://example.org/a) and https://example.org/b");
	});

	it("never carries a link's address that is not a web address", () => {
		expect(wxrCommentText('<a href="javascript:alert(1)">click</a>')).toBe("click");
	});

	it("takes a script, a style and every tag out, and keeps the words a reader saw", () => {
		const text = wxrCommentText(
			'<script>alert("x")</script>Hi <b onclick="steal()">there</b><style>p{}</style>',
		);
		expect(text).toBe("Hi there");
	});

	it("reads entities as the characters they are: an escaped tag is text", () => {
		expect(wxrCommentText("Tom &amp; Jerry &lt;b&gt; bold", false)).toBe("Tom & Jerry <b> bold");
	});

	it("draws a list as lines", () => {
		expect(wxrCommentText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
	});

	it("texturizes as WordPress showed it, unless told not to", () => {
		expect(wxrCommentText('"quoted"')).toBe("\u201Cquoted\u201D");
		expect(wxrCommentText('"quoted"', false)).toBe('"quoted"');
	});
});

describe("importWxrComments", () => {
	function wxrComment(overrides: Partial<WxrComment> & { id: number }): WxrComment {
		return {
			parent: 0,
			author: "Alice",
			authorEmail: "alice@example.com",
			dateGmt: "2020-05-01 12:00:00",
			content: "Nice post!",
			approved: "1",
			type: "comment",
			...overrides,
		};
	}
	const post = (id: number, comments: WxrComment[]): WxrPost => ({
		id,
		categories: [],
		tags: [],
		meta: new Map(),
		comments,
	});

	it("stores the approved comments and counts every other one by why", async () => {
		const result = await importWxrComments(
			[
				post(10, [
					wxrComment({ id: 1 }),
					wxrComment({ id: 2, parent: 1, dateGmt: "2020-05-02 12:00:00", content: "Reply" }),
					wxrComment({ id: 3, approved: "0" }),
					wxrComment({ id: 4, approved: "spam" }),
					wxrComment({ id: 5, approved: "trash" }),
					wxrComment({ id: 6, type: "pingback" }),
					wxrComment({ id: 7, content: "<script>x()</script>" }),
				]),
				post(999, [wxrComment({ id: 8 })]),
			],
			db,
			contentIdMap,
			collectionMap,
		);
		expect(result.imported).toBe(2);
		expect(result.notCarried).toEqual({
			pending: 1,
			spam: 1,
			trash: 1,
			pingback: 1,
			empty: 1,
			"post-not-imported": 1,
		});
		const rows = await db
			.selectFrom("_emdash_comments")
			.selectAll()
			.orderBy("created_at")
			.execute();
		expect(rows.map((r) => [r.body, r.status, r.created_at])).toEqual([
			["Nice post!", "approved", "2020-05-01T12:00:00.000Z"],
			["Reply", "approved", "2020-05-02T12:00:00.000Z"],
		]);
		expect(rows[1]!.parent_id).toBe(rows[0]!.id);
		expect(rows.every((r) => r.ip_hash === null && r.user_agent === null)).toBe(true);
	});
});
