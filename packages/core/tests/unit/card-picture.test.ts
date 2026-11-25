/**
 * Which picture a card draws — the rule and its guards.
 *
 * The rule was measured, not guessed: on a real imported site, six of six live cards drew exactly the first
 * picture of that post's own content, and none of 45 published posts carried a `_thumbnail_id`. So the fallback
 * IS the spec there, and the guards exist because a body's raw HTML is a whole email — spacers, trackers, CSS.
 */
import { describe, expect, it } from "vitest";

import { cardPicture, pictureInHtml } from "../../src/utils/card-picture.js";

const imageNode = (url: string, alt?: string) => ({
	_type: "image",
	_key: "i1",
	asset: { _ref: `ref-${url}`, url },
	...(alt ? { alt } : {}),
});

describe("pictureInHtml — an htmlBlock's pictures", () => {
	it("takes the first real picture", () => {
		const found = pictureInHtml(
			`<p>x</p><img src="/_emdash/api/media/file/a.jpg" alt="A"><img src="/b.jpg">`,
		);
		expect(found).toEqual({ src: "/_emdash/api/media/file/a.jpg", alt: "A" });
	});

	it("SKIPS a 1x1 spacer and takes the next real picture", () => {
		const found = pictureInHtml(
			`<img src="/spacer.gif" width="1" height="1"><img src="/_emdash/api/media/file/real.jpg" width="600" height="400">`,
		);
		expect(found?.src).toBe("/_emdash/api/media/file/real.jpg");
	});

	it("skips a zero-dimension image", () => {
		const found = pictureInHtml(`<img src="/tracker.gif" width="0"><img src="/real.jpg">`);
		expect(found?.src).toBe("/real.jpg");
	});

	it("skips a data: source — and takes nothing at all when it is the only one", () => {
		// THE ONLY SOURCE IS THE CASE THAT MEANS SOMETHING: with a real picture behind it, a build that accepts
		// `data:` still returns the real picture and the arm cannot tell. So the data: tag stands alone.
		expect(pictureInHtml(`<img src="data:image/gif;base64,R0lGOD">`)).toBeNull();
	});

	it("skips a javascript: source", () => {
		expect(pictureInHtml(`<img src="javascript:alert(1)">`)).toBeNull();
	});

	it("skips an img with no src and takes the next", () => {
		const found = pictureInHtml(`<img alt="nothing"><img src="/real.jpg">`);
		expect(found?.src).toBe("/real.jpg");
	});

	it("does NOT skip a picture merely because it carries no dimensions", () => {
		// Most real pictures carry neither width nor height; only a stated 1 or 0 is decisive.
		expect(pictureInHtml(`<img src="/real.jpg" alt="no dims">`)?.src).toBe("/real.jpg");
	});

	it("reads attributes properly: a > inside an alt does not end the tag", () => {
		const found = pictureInHtml(`<img alt="a > b" src="/real.jpg">`);
		expect(found?.src).toBe("/real.jpg");
	});

	it("returns null when the html holds no picture", () => {
		expect(pictureInHtml(`<p>just words</p>`)).toBeNull();
		expect(pictureInHtml(undefined)).toBeNull();
	});
});

describe("cardPicture — the order the lead specified", () => {
	it("the FEATURED image wins over the content", () => {
		const post = { featuredImage: "/featured.jpg", content: [imageNode("/content.jpg")] };
		expect(cardPicture(post)?.src).toBe("/featured.jpg");
	});

	it("falls back to an IMAGE NODE when there is no featured image", () => {
		expect(cardPicture({ content: [{ _type: "p" }, imageNode("/content.jpg", "Alt")] })).toEqual({
			src: "/content.jpg",
			alt: "Alt",
			assetRef: "ref-/content.jpg",
		});
	});

	it("falls back to a GALLERY's first image", () => {
		const post = {
			content: [
				{ _type: "gallery", _key: "g", images: [imageNode("/g1.jpg"), imageNode("/g2.jpg")] },
			],
		};
		expect(cardPicture(post)?.src).toBe("/g1.jpg");
	});

	it("falls back to a COVER's background", () => {
		expect(cardPicture({ content: [{ _type: "cover", backgroundImage: "/cover.jpg" }] })?.src).toBe(
			"/cover.jpg",
		);
	});

	it("falls back to the first <img> inside an htmlBlock, guards and all", () => {
		const post = {
			content: [
				{
					_type: "htmlBlock",
					html: `<img src="/spacer.gif" width="1"><img src="/body.jpg" alt="B">`,
				},
			],
		};
		expect(cardPicture(post)).toEqual({ src: "/body.jpg", alt: "B" });
	});

	it("walks in DOCUMENT ORDER: a container's child comes before the next sibling", () => {
		const post = {
			content: [
				{ _type: "columns", content: [{ _type: "p" }, imageNode("/nested.jpg")] },
				imageNode("/later.jpg"),
			],
		};
		expect(cardPicture(post)?.src).toBe("/nested.jpg");
	});

	it("returns null when there is neither a featured image nor any picture", () => {
		expect(
			cardPicture({ content: [{ _type: "p" }, { _type: "htmlBlock", html: "<p>words</p>" }] }),
		).toBeNull();
	});

	it("returns null for a post with no content at all", () => {
		expect(cardPicture({})).toBeNull();
	});
});
