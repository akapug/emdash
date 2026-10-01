/**
 * The classic editor keeps a player pasted into a post as the provider's own
 * `<iframe>` (YouTube's, Vimeo's, a map's, a form's), and WordPress prints it
 * as written. Converted as saved, every such iframe was dropped: on a line of
 * its own, inside a paragraph, a div or a figure, the video, the map and the
 * form were gone. A player from a provider EmDash embeds becomes an embed of
 * the provider's page URL, the block a bare URL on its own line becomes; any
 * other iframe is kept as written, as a `<!-- wp:html -->` iframe is.
 */

import { describe, expect, it } from "vitest";

import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock, PortableTextTextBlock } from "../src/types.js";

const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const MAP_SRC = "https://www.google.com/maps/embed?pb=!1m18!1m12&amp;hl=en";

const iframe = (src: string) =>
	`<iframe src="${src}" width="560" height="315" frameborder="0" allowfullscreen></iframe>`;
const YOUTUBE = iframe(`https://www.youtube.com/embed/${VIDEO_ID}`);
const MAP = iframe(MAP_SRC);

/** Each text block's text; an embed as its provider and URL; an HTML block as its HTML. */
const shape = (blocks: PortableTextBlock[]) =>
	blocks.map((b) =>
		b._type === "block"
			? b.children.map((c) => c.text).join("")
			: b._type === "embed"
				? `[embed ${b.provider} ${b.url}]`
				: b._type === "htmlBlock"
					? `[html ${b.html}]`
					: `[${b._type}]`,
	);

const keys = () => {
	let n = 0;
	return () => `k${++n}`;
};

describe("classic iframes: a provider's player becomes an embed of its page", () => {
	it.each([
		["YouTube", `https://www.youtube.com/embed/${VIDEO_ID}`, WATCH_URL, "youtube"],
		[
			"YouTube without cookies",
			`https://www.youtube-nocookie.com/embed/${VIDEO_ID}`,
			WATCH_URL,
			"youtube",
		],
		["YouTube's short link", `https://youtu.be/${VIDEO_ID}`, WATCH_URL, "youtube"],
		[
			"YouTube from a start time",
			`https://www.youtube.com/embed/${VIDEO_ID}?start=90&amp;rel=0`,
			`${WATCH_URL}&t=90`,
			"youtube",
		],
		[
			"a YouTube video in a playlist",
			`https://www.youtube.com/embed/${VIDEO_ID}?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG`,
			WATCH_URL,
			"youtube",
		],
		["YouTube on the page's scheme", `//www.youtube.com/embed/${VIDEO_ID}`, WATCH_URL, "youtube"],
		["Vimeo", "https://player.vimeo.com/video/76979871", "https://vimeo.com/76979871", "vimeo"],
		...["track", "episode", "show", "playlist", "album"].map((kind) => [
			`a Spotify ${kind}`,
			`https://open.spotify.com/embed/${kind}/4cOdK2wGLETKBW3PvgPWqT?utm_source=generator`,
			`https://open.spotify.com/${kind}/4cOdK2wGLETKBW3PvgPWqT`,
			"spotify",
		]),
		[
			"SoundCloud",
			"https://w.soundcloud.com/player/?url=https%3A//api.soundcloud.com/tracks/293&amp;color=%23ff5500&amp;auto_play=false",
			"https://api.soundcloud.com/tracks/293",
			"soundcloud",
		],
		[
			"an Instagram post",
			"https://www.instagram.com/p/CxYz123AbC/embed",
			"https://www.instagram.com/p/CxYz123AbC/",
			"instagram",
		],
		[
			"an Instagram post with its caption",
			"https://www.instagram.com/p/CxYz123AbC/embed/captioned/",
			"https://www.instagram.com/p/CxYz123AbC/",
			"instagram",
		],
		[
			"a CodePen pen",
			"https://codepen.io/someone/embed/abcXYZ?default-tab=result",
			"https://codepen.io/someone/pen/abcXYZ",
			"codepen",
		],
		[
			"a Facebook video",
			"https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fexample%2Fvideos%2F10153231379946729%2F&amp;show_text=0",
			"https://www.facebook.com/example/videos/10153231379946729/",
			"facebook",
		],
	])("embeds %s from its player", (_, src, url, provider) => {
		expect(gutenbergToPortableText(iframe(src))).toEqual([
			{ _type: "embed", _key: expect.any(String), url, provider },
		]);
	});

	it("is the same block a bare URL on its own line becomes", () => {
		const [fromIframe] = gutenbergToPortableText(YOUTUBE, { keyGenerator: keys() });
		const [fromUrl] = gutenbergToPortableText(WATCH_URL, { keyGenerator: keys() });

		expect(fromIframe).toEqual(fromUrl);
	});

	// EmDash's embed component draws a player for a YouTube video or a public Vimeo video,
	// and a link for a page it has no player for. A player whose page it cannot draw, or
	// whose page URL cannot be read from it, keeps its iframe, which plays where it did.
	it.each([
		[
			"a YouTube live stream",
			"https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv",
		],
		[
			"a YouTube playlist",
			"https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG",
		],
		[
			"a YouTube playlist by its query",
			"https://www.youtube.com/embed?listType=playlist&amp;list=PLabc",
		],
		["YouTube's player with no video", "https://www.youtube.com/embed/"],
		["an unlisted Vimeo video", "https://player.vimeo.com/video/76979871?h=8272103f6e&amp;badge=0"],
		["an unlisted Vimeo video with any hash", "https://player.vimeo.com/video/123?h=ab-cd"],
		["a Vimeo showcase", "https://vimeo.com/showcase/123/embed"],
		["a Spotify artist", "https://open.spotify.com/embed/artist/0OdUWJ0sBjDrqHygGUXeCF"],
		[
			"an old Spotify podcast player",
			"https://open.spotify.com/embed-podcast/episode/4rOoJ6Egrf8K2IrywzwOMk",
		],
		[
			"Spotify by its URI",
			"https://open.spotify.com/embed?uri=spotify:track:4cOdK2wGLETKBW3PvgPWqT",
		],
		[
			"a private SoundCloud track",
			"https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/293&amp;secret_token=s-abc",
		],
		[
			"a SoundCloud player for a page elsewhere",
			"https://w.soundcloud.com/player/?url=https://evil.example/x",
		],
		[
			"a Facebook page",
			"https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2Fexample",
		],
		[
			"a Facebook video of a page elsewhere",
			"https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fevil.example%2Fx",
		],
		["a tweet", "https://platform.twitter.com/embed/Tweet.html?id=123"],
		["a CodePen team pen", "https://codepen.io/team/acme/embed/abcXYZ"],
		["a TikTok video", "https://www.tiktok.com/embed/v2/7211234567890123456"],
	])("keeps the iframe of %s", (_, src) => {
		expect(gutenbergToPortableText(iframe(src))).toEqual([
			{ _type: "htmlBlock", _key: expect.any(String), html: iframe(src) },
		]);
	});
});

describe("classic iframes: where the iframe stands, it stays", () => {
	it("on a line of its own between paragraphs", () => {
		const content = `<p>Before the video.</p>\n${YOUTUBE}\n<p>After the video.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before the video.",
			`[embed youtube ${WATCH_URL}]`,
			"After the video.",
		]);
	});

	it("between runs of text with no paragraphs", () => {
		const content = `Some text before.\n\n${YOUTUBE}\n\nSome text after.`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Some text before.",
			`[embed youtube ${WATCH_URL}]`,
			"Some text after.",
		]);
	});

	it("alone in a paragraph", () => {
		const content = `<p>Before.</p>\n<p>${YOUTUBE}</p>\n<p>After.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before.",
			`[embed youtube ${WATCH_URL}]`,
			"After.",
		]);
	});

	it("inside a paragraph, between the text before it and the text after it", () => {
		const content = `<p>Watch this: ${YOUTUBE} and tell me what you think.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Watch this:",
			`[embed youtube ${WATCH_URL}]`,
			"and tell me what you think.",
		]);
	});

	it("keeps the marks and links of the text around it in a paragraph", () => {
		const content = `<p><strong>Watch</strong> this ${YOUTUBE} then <a href="https://example.com/">read on</a>.</p>`;
		const result = gutenbergToPortableText(content);

		expect(shape(result)).toEqual(["Watch this", `[embed youtube ${WATCH_URL}]`, "then read on."]);
		const [before, , after] = result;
		expect(before).toMatchObject({
			children: [{ text: "Watch", marks: ["strong"] }, { text: " this" }],
		});
		expect(after).toMatchObject({
			children: [{ text: "then " }, { text: "read on" }, { text: "." }],
			markDefs: [{ _type: "link", href: "https://example.com/" }],
		});
	});

	it("keeps a link or a bold run around it on the text either side of it", () => {
		const link = gutenbergToPortableText(
			`<p>Watch <a href="https://example.com/">this ${YOUTUBE} clip</a> now.</p>`,
		);
		expect(shape(link)).toEqual(["Watch this", `[embed youtube ${WATCH_URL}]`, "clip now."]);
		const [before, , after] = link;
		const href = [{ _type: "link", href: "https://example.com/" }];
		expect(before).toMatchObject({
			children: [{ text: "Watch " }, { text: "this" }],
			markDefs: href,
		});
		expect(after).toMatchObject({
			children: [{ text: "clip" }, { text: " now." }],
			markDefs: href,
		});
		expect((after as PortableTextTextBlock).children[0]!.marks).toHaveLength(1);

		const bold = gutenbergToPortableText(`<p><strong>Bold ${YOUTUBE} still bold</strong> end</p>`);
		expect(shape(bold)).toEqual(["Bold", `[embed youtube ${WATCH_URL}]`, "still bold end"]);
		expect(bold[2]).toMatchObject({
			children: [{ text: "still bold", marks: ["strong"] }, { text: " end" }],
		});
	});

	it("takes the line breaks beside it in a paragraph with it", () => {
		const content = `<p>Before<br />\n${YOUTUBE}<br />\nAfter</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before",
			`[embed youtube ${WATCH_URL}]`,
			"After",
		]);
	});

	it("keeps two iframes in one paragraph in their order", () => {
		const vimeo = iframe("https://player.vimeo.com/video/76979871");
		const content = `<p>First ${YOUTUBE} then ${vimeo} last.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"First",
			`[embed youtube ${WATCH_URL}]`,
			"then",
			"[embed vimeo https://vimeo.com/76979871]",
			"last.",
		]);
	});

	it("inside a div", () => {
		const content = `<p>Before.</p>\n<div class="video-container">${YOUTUBE}</div>\n<p>After.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before.",
			`[embed youtube ${WATCH_URL}]`,
			"After.",
		]);
	});

	it("inside a div, between the text before it and the text after it", () => {
		const content = `<div class="intro">Our launch: ${YOUTUBE} Thanks for watching.</div>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Our launch:",
			`[embed youtube ${WATCH_URL}]`,
			"Thanks for watching.",
		]);
	});

	it("inside a figure, with its caption as text after it", () => {
		const content = `<p>Before.</p>\n<figure class="video">${YOUTUBE}<figcaption>Our launch video</figcaption></figure>\n<p>After.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before.",
			`[embed youtube ${WATCH_URL}]`,
			"Our launch video",
			"After.",
		]);
	});

	it("inside a figure's wrapper div", () => {
		const content = `<figure class="embed"><div class="embed-wrapper">${YOUTUBE}</div><figcaption>Caption</figcaption></figure>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			`[embed youtube ${WATCH_URL}]`,
			"Caption",
		]);
	});
});

describe("classic iframes: an iframe from any other host is kept", () => {
	it("keeps a Google map on a line of its own as an HTML block", () => {
		const content = `<p>Find us.</p>\n${MAP}\n<p>Open daily.</p>`;
		const result = gutenbergToPortableText(content);

		expect(shape(result)).toEqual(["Find us.", `[html ${MAP}]`, "Open daily."]);
		expect(result[1]).toEqual({ _type: "htmlBlock", _key: expect.any(String), html: MAP });
	});

	it("keeps a Google map inside a paragraph between its text", () => {
		const content = `<p>Find us here: ${MAP} Open daily.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Find us here:",
			`[html ${MAP}]`,
			"Open daily.",
		]);
	});

	it("keeps a form inside a div as an HTML block, without the fallback text a browser never shows", () => {
		const form = `<iframe src="https://docs.google.com/forms/d/e/1FAIpQLSf/viewform?embedded=true" width="640" height="800">`;
		expect(
			shape(gutenbergToPortableText(`<div class="form">${form}Loading…</iframe></div>`)),
		).toEqual([`[html ${form}</iframe>]`]);
	});

	it("keeps only the attributes that draw the frame", () => {
		// srcdoc would replace the page the src names, and on* attributes run script: neither is kept
		const content = `<p><iframe src="https://maps.example.com/x?a=1&amp;b=2" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;" onload="alert(2)" title='Say "hi"' loading="lazy" referrerpolicy="no-referrer" allow="fullscreen" class="wide" style="border:0"><script>alert(3)</script></iframe></p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			`[html <iframe src="https://maps.example.com/x?a=1&amp;b=2" title="Say &quot;hi&quot;" loading="lazy" referrerpolicy="no-referrer" allow="fullscreen"></iframe>]`,
		]);
	});

	it("does not read a host that merely contains a provider's domain as that provider", () => {
		// "api.mapbox.com" contains "x.com", which is X (Twitter)
		const map = iframe("https://api.mapbox.com/styles/v1/example/abc.html?title=false");
		expect(shape(gutenbergToPortableText(map))).toEqual([`[html ${map}]`]);
	});

	it("keeps an iframe a page builder closed in its start tag", () => {
		const closed = `<iframe src="https://www.google.com/maps/embed?pb=abc"></iframe>`;
		const content = `<iframe src="https://www.google.com/maps/embed?pb=abc" />\n\n<p>After.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([`[html ${closed}]`, "After."]);
	});

	it("keeps what follows an iframe closed in its start tag, up to the next iframe's end tag", () => {
		const map = `<iframe src="https://www.google.com/maps/embed?pb=a" />`;
		const content = `${map}\n\n<p>Middle text.</p>\n\n${YOUTUBE}\n\n<p>Last.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			`[html <iframe src="https://www.google.com/maps/embed?pb=a"></iframe>]`,
			"Middle text.",
			`[embed youtube ${WATCH_URL}]`,
			"Last.",
		]);
	});
});

describe("classic iframes: what a browser does not draw is not lifted", () => {
	// An iframe whose src is not a web URL (javascript:, data:) shows nothing an
	// import can keep, and an EmDash site would not draw it: it is dropped, as before.
	it.each([
		["a javascript: URL", "javascript:alert(1)"],
		["a data: URL", "data:text/html;base64,PGgxPkhpPC9oMT4="],
	])("drops an iframe whose src is %s", (_, src) => {
		const content = `<p>Before.</p>\n${iframe(src)}\n<p>After.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["Before.", "After."]);
	});

	it("drops an iframe whose src is not a web URL inside a paragraph, and keeps its text one block", () => {
		const content = `<p>Before ${iframe("javascript:alert(1)")} after.</p>`;
		const text = shape(gutenbergToPortableText(content)).map((t) => t.replace(/\s+/g, " "));

		expect(text).toEqual(["Before after."]);
	});

	it("leaves an iframe in a comment alone", () => {
		const content = `<p>Before.</p>\n<!-- ${YOUTUBE} -->\n<p>After.</p>`;
		expect(shape(gutenbergToPortableText(content))).toEqual(["Before.", "After."]);
	});
});

describe("classic iframes: block editor content is unchanged", () => {
	it("keeps an iframe in a Custom HTML block as that block's HTML", () => {
		const content = `<!-- wp:paragraph --><p>Before.</p><!-- /wp:paragraph -->
<!-- wp:html -->
${YOUTUBE}
<!-- /wp:html -->
<!-- wp:paragraph --><p>After.</p><!-- /wp:paragraph -->`;
		const result = gutenbergToPortableText(content);

		expect(shape(result)).toEqual(["Before.", `[html ${YOUTUBE}]`, "After."]);
		expect(result[1]).toMatchObject({ _type: "htmlBlock", originalBlockName: "core/html" });
	});

	it("keeps an embed block's URL, provider and HTML", () => {
		const html = `<figure class="wp-block-embed is-type-video is-provider-youtube"><div class="wp-block-embed__wrapper">\n${WATCH_URL}\n</div></figure>`;
		const content = `<!-- wp:embed {"url":"${WATCH_URL}","type":"video","providerNameSlug":"youtube"} -->\n${html}\n<!-- /wp:embed -->`;

		expect(gutenbergToPortableText(content)).toEqual([
			{ _type: "embed", _key: expect.any(String), url: WATCH_URL, provider: "youtube", html },
		]);
	});

	it("keeps an iframe in classic HTML between blocks in that HTML", () => {
		const content = `<!-- wp:paragraph --><p>Before.</p><!-- /wp:paragraph -->

${YOUTUBE}

<!-- wp:paragraph --><p>After.</p><!-- /wp:paragraph -->`;
		expect(shape(gutenbergToPortableText(content))).toEqual([
			"Before.",
			`[html \n\n${YOUTUBE}\n\n]`,
			"After.",
		]);
	});
});
