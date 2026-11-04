/**
 * A WordPress comment carried by the WXR import, drawn as a visitor sees it:
 * EmDash's Comments component over the text the import stores
 * (`wxrCommentText`). Whatever the commenter typed, the page draws words and
 * never markup: a script the comment held is not in the page, and a tag the
 * commenter wrote as text is drawn as text. No commenter's email or IP
 * address is in the page.
 */
import { readFileSync } from "node:fs";

import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import { parseWxrString } from "../../src/cli/wxr/parser.js";
import type { PublicComment } from "../../src/database/repositories/comment.js";
import { wxrCommentText } from "../../src/import/comments.js";

const items = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../../src/schema/query.js", () => ({
	getCollectionInfo: async () => ({ commentsEnabled: true }),
}));
vi.mock("../../src/comments/query.js", () => ({
	getComments: async () => ({ items: items.list, total: items.list.length }),
}));

const { default: Comments } = await import("../../src/components/Comments.astro");

const WXR = readFileSync(
	new URL("../integration/wordpress-import/fixtures/comments-export.xml", import.meta.url),
	"utf8",
);

describe("a carried comment, drawn", () => {
	it("draws the words a reader saw and no markup, and no commenter's email or IP", async () => {
		const wxr = await parseWxrString(WXR);
		const approved = wxr.posts
			.find((p) => p.id === 7)!
			.comments!.filter((c) => c.approved === "1" && (c.type === "" || c.type === "comment"));
		// A commenter who wrote a tag as text: WordPress stored it escaped, and showed the tag's letters.
		approved.push({
			...approved[0]!,
			id: 999,
			content: "Try &lt;script&gt;alert(1)&lt;/script&gt; here",
		});
		items.list = approved.map(
			(c): PublicComment => ({
				id: String(c.id),
				parentId: null,
				authorName: c.author,
				isRegisteredUser: false,
				body: wxrCommentText(c.content),
				createdAt: "2026-01-16T10:00:00.000Z",
			}),
		);

		const c = await AstroContainer.create();
		const html = await c.renderToString(Comments, {
			props: { collection: "posts", contentId: "p7" },
		});

		expect(html).toContain("Lovely fish (");
		expect(html).toContain("Hi there");
		// The tag written as text is drawn as text.
		expect(html).toContain("Try &lt;script&gt;alert(1)&lt;/script&gt; here");
		// Nothing the commenter typed runs or styles the page.
		expect(html).not.toMatch(/<script>alert|document\.title|onclick|display:none/);
		for (const never of ["@example.net", "203.0.113.9", "198.51.100."]) {
			expect(html).not.toContain(never);
		}
	});
});
