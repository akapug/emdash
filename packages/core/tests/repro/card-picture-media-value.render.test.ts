// THE STORED MEDIA VALUE, WHICH IS THE ONLY SHAPE THE MEDIA PASS WRITES.
//
// Measured from a real tenant row (read through the content API the template itself uses):
//   {"provider":"local","id":"01M89XSZ…","filename":"Club-Sectionals-Logo.png","mimeType":"image/png",
//    "width":500,"height":500,"blurhash":"…","dominantColor":"…",
//    "meta":{"storageKey":"01M89XSZJF7EHVPC7VP7E47NED.png","caption":null,…}}
// Field names: provider, id, filename, mimeType, width, height, blurhash, dominantColor, meta. NO `url`, NO `asset.url`.
// `cardPicture`'s featured branch read a string and `url`/`asset.url`/`asset._ref`, so this value — the one every
// imported featured image actually holds — fell through to the content walk, and the card drew the wrong picture.
import { describe, expect, it } from "vitest";

import { cardPicture } from "../../src/utils/card-picture.ts";

/** The real value, field for field, as a tenant stores it. Storage keys are opaque; the name is a reserved example. */
const STORED_VALUE = {
	provider: "local",
	id: "01M89XSZYN028DKNRN4NRM2Q0C",
	filename: "club-logo.png",
	mimeType: "image/png",
	width: 500,
	height: 500,
	blurhash: "LNR:HH-;~p%MtRj[xtj[_3ayD*of",
	dominantColor: "rgb(233,233,238)",
	meta: { storageKey: "01M89XSZJF7EHVPC7VP7E47NED.png", caption: null },
};

describe("a card draws the STORED MEDIA VALUE, which carries no url", () => {
	it("THE REAL VALUE SHAPE is recognised, and named by its storage key", () => {
		const got = cardPicture({ featuredImage: STORED_VALUE });
		expect(got, "an imported featured image draws a picture").toBeTruthy();
		expect(got.src).toBe("/_emdash/api/media/file/01M89XSZJF7EHVPC7VP7E47NED.png");
		// THE ROUTE, NOT THE KEY. `index.astro:104` renders `picture.assetRef ?? picture.src` AS THE `<img src>`, so a
		// bare key became a relative URL that 404s. This arm asserted the key, which encoded the defect.
		expect(got.assetRef, "assetRef is the route path the template renders as the img src").toBe(
			"/_emdash/api/media/file/01M89XSZJF7EHVPC7VP7E47NED.png",
		);
	});

	it("a value with NO storageKey draws NOTHING — never a guessed URL from its id", () => {
		// The id is a database key, not a path. Guessing `/_emdash/api/media/file/<id>` without an extension is exactly
		// the invented-URL failure the content walk's arms already refuse, and it 404s on a real tenant.
		const noKey = {
			provider: "local",
			id: "01M89XSZYN028DKNRN4NRM2Q0C",
			mimeType: "image/png",
			width: 500,
			height: 500,
			meta: {},
		};
		expect(cardPicture({ featuredImage: noKey })).toBeNull();
		expect(
			cardPicture({ featuredImage: { provider: "local", width: 500 } }),
			"no key, no path",
		).toBeNull();
	});

	it("an EMPTY or non-string storageKey draws nothing rather than a bare route", () => {
		expect(
			cardPicture({ featuredImage: { provider: "local", meta: { storageKey: "" } } }),
		).toBeNull();
		expect(
			cardPicture({ featuredImage: { provider: "local", meta: { storageKey: 42 } } }),
			"a non-string key is not a key",
		).toBeNull();
	});

	it("THE STRING AND _ref BRANCHES ARE UNCHANGED by it", () => {
		expect(cardPicture({ featuredImage: "https://cdn.example/x.jpg" })).toEqual({
			src: "https://cdn.example/x.jpg",
		});
		expect(cardPicture({ featuredImage: { url: "/a.jpg" } })).toEqual({ src: "/a.jpg" });
		expect(
			cardPicture({ featuredImage: { asset: { _ref: "/_emdash/api/media/file/abc.png" } } }),
		).toEqual({
			src: "/_emdash/api/media/file/abc.png",
			assetRef: "/_emdash/api/media/file/abc.png",
		});
	});

	it("A NESTED KEY IS VALID and its segments are ENCODED, because a key is not always a flat name", () => {
		// The first version refused any key containing "/" — which rejects the `2024/05/x.jpg` layout real uploads use.
		// And a key can contain `?`, `#` or `%`, which must stay INSIDE the path rather than become a query or a fragment.
		const nested = { provider: "local", meta: { storageKey: "2024/05/club-logo.png" } };
		expect(cardPicture({ featuredImage: nested })?.src).toBe(
			"/_emdash/api/media/file/2024/05/club-logo.png",
		);
		const encoded = { provider: "local", meta: { storageKey: "a?b#c%d.jpg" } };
		const got = cardPicture({ featuredImage: encoded });
		expect(got?.src, "built by localMediaFileUrl, not by interpolation").toBe(
			"/_emdash/api/media/file/a%3Fb%23c%25d.jpg",
		);
	});

	it("A NON-LOCAL PROVIDER DRAWS NOTHING — our route would serve a different local file", () => {
		// A remote provider's `meta.storageKey` names a file in ITS storage. The route this branch builds is joined to OUR
		// tenant, so honouring it shows whatever local asset shares that key — a different picture, silently.
		expect(
			cardPicture({ featuredImage: { provider: "s3", meta: { storageKey: "01M89.png" } } }),
		).toBeNull();
		expect(
			cardPicture({ featuredImage: { provider: "youtube", meta: { storageKey: "x.png" } } }),
		).toBeNull();
		// A LEGACY value with no provider IS ours: the earliest imports carry none.
		expect(cardPicture({ featuredImage: { meta: { storageKey: "legacy.png" } } })?.src).toBe(
			"/_emdash/api/media/file/legacy.png",
		);
	});

	it("CARRIES the value's own alt and focal point, which the template's rebuild would otherwise drop", () => {
		const got = cardPicture({
			featuredImage: {
				provider: "local",
				meta: { storageKey: "x.png" },
				alt: "A club logo",
				focalX: 0.3,
				focalY: 0.7,
			},
		});
		expect(got?.alt, "the stored alt, not the post title").toBe("A club logo");
		expect(got?.focalX).toBe(0.3);
		expect(got?.focalY).toBe(0.7);
	});

	it("contentFirst IS STILL OFF BY DEFAULT: a post with content pictures and no featured image draws nothing", () => {
		const post = { content: [{ _type: "image", asset: { url: "/in-content.jpg" } }] };
		expect(cardPicture(post), "no featured image and no site option = no picture").toBeNull();
		expect(
			cardPicture(post, { contentFirst: true }),
			"and the site option turns the walk on",
		).toBeTruthy();
	});

	it("A FEATURED MEDIA VALUE BEATS THE CONTENT WALK even when contentFirst is on", () => {
		const got = cardPicture(
			{
				featuredImage: STORED_VALUE,
				content: [{ _type: "image", asset: { url: "/in-content.jpg" } }],
			},
			{ contentFirst: true },
		);
		expect(got?.src, "the featured image wins").toBe(
			"/_emdash/api/media/file/01M89XSZJF7EHVPC7VP7E47NED.png",
		);
	});
});
