/**
 * 141b: an image BLOCK whose stored sizes are known but whose node carries no dimensions must still
 * get `sizes="auto, …"`.
 *
 * MEASURED on a real imported home page: four image blocks inside columns were served
 * `sizes="(min-width: 3024px) 3024px, 100vw"` and the browser fetched `?w=1536` for a column slot —
 * 4.5 MB of a 7.45 MB page. The two image blocks whose nodes DID carry width/height were served
 * `auto, …` and fetched correctly.
 *
 * The cause is `lazyAutoSizes`: it refuses to emit `auto, …` without a reserved box, and
 * `renderWidth` is undefined when an imported block carries no dimensions — even though the stored
 * read knows exactly which widths that image has. `stored.bound` is that box.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeEach, describe, expect, test, vi } from "vitest";

const stored = {
	value: null as { srcset: string; bound: number; shape: number | undefined } | null,
};
vi.mock("../../src/media/variant-read.js", () => ({
	storedSizesForRender: async () => stored.value,
	storedDimensionsForRender: async () => null,
	getCommittedVariants: async () => [],
}));

const { default: Image } = await import("../../src/components/Image.astro");
const { default: Cover } = await import("../../src/components/Cover.astro");
const { default: WpShellImage } =
	await import("../../../../templates/blog-cloudflare/src/components/WpShellImage.astro");
const { WP_SHELL_CONTENT_WIDTH_KEY } =
	await import("../../../../templates/blog-cloudflare/src/utils/wp-shell.js");

const locals = { emdash: { getPublicMediaUrl: (k: string) => `/_emdash/api/media/file/${k}` } };
const imgTag = (html: string) => html.match(/<img\b[^>]*>/)?.[0] ?? "";
const attr = (tag: string, name: string) =>
	tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

/** An imported image block as the real page has one: a stored asset and NO dimensions. */
const nodimensions = {
	_type: "image",
	asset: {
		_ref: "01M8A0XEB7TF21ZHS32FP04RHY",
		url: "01M8A0XEB7TF21ZHS32FP04RHY.png",
		mimeType: "image/png",
	},
	alt: "",
};

const withDimensions = {
	...nodimensions,
	width: 1640,
	height: 900,
};

async function render(node: unknown, extraProps: Record<string, unknown> = {}) {
	const c = await AstroContainer.create();
	return c.renderToString(Image, { props: { node, placeholder: false, ...extraProps }, locals });
}

describe("an image block inside columns gets a layout-driven sizes", () => {
	beforeEach(() => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01M8A0XEB7.png?w=300 300w, /_emdash/api/media/file/01M8A0XEB7.png?w=1024 1024w",
			bound: 1640,
			shape: 1640 / 900,
		};
	});

	test("NO dimensions on the node, stored sizes present: sizes starts with `auto,`", async () => {
		const tag = imgTag(await render(nodimensions));
		const sizes = attr(tag, "sizes") ?? "";
		expect(sizes, `sizes was "${sizes}"`).toMatch(/^auto,\s/u);
		// And the fallback is still the stored bound, so a browser without `auto` support is no worse off.
		expect(sizes).toContain("1640px");
	});

	test("the box is REAL: the <img> carries BOTH width and height, derived from the stored shape", async () => {
		// `sizes="auto"` asks the browser for the laid-out width, and a lazy image with no `height` lays out 0 tall
		// until it loads — the browser then takes the smallest candidate and the picture is blurry. Width alone is not
		// a reserved box; both dimensions are. The height comes from the media's own shape, so it is the real aspect.
		const tag = imgTag(await render(nodimensions));
		expect(attr(tag, "width"), `width attribute missing in: ${tag.slice(0, 160)}`).toBe("1640");
		expect(attr(tag, "height"), `height attribute missing in: ${tag.slice(0, 160)}`).toBe("900");
		expect(attr(tag, "sizes") ?? "").toMatch(/^auto,\s/u);
	});

	test("the same block WITH dimensions also says `auto,` — the case that already worked", async () => {
		const tag = imgTag(await render(withDimensions));
		expect(attr(tag, "sizes") ?? "").toMatch(/^auto,\s/u);
	});

	test("NO stored sizes and no dimensions: no `auto,`, because there is no box to reserve", async () => {
		stored.value = null;
		const tag = imgTag(await render(nodimensions));
		const sizes = attr(tag, "sizes") ?? "";
		expect(sizes.startsWith("auto,"), `sizes was "${sizes}"`).toBe(false);
	});
});

describe("141b: article body images declare the content column width, never wider than the image", () => {
	test("a body image wider than the column gets the column sizes", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01WIDE.png?w=600 600w, /_emdash/api/media/file/01WIDE.png?w=1024 1024w, /_emdash/api/media/file/01WIDE.png?w=1440 1440w",
			bound: 1456,
			shape: 1456 / 800,
		};
		const tag = imgTag(await render(withDimensions, { maxWidth: 632, gutterPx: 48 }));
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 680px) 632px, calc(100vw - 48px)");
	});

	test("a body image narrower than the column keeps its own width", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01SMALL.png?w=150 150w, /_emdash/api/media/file/01SMALL.png?w=500 500w",
			bound: 500,
			shape: 500 / 350,
		};
		const narrowNode = { ...nodimensions, width: 500, height: 350 };
		const tag = imgTag(await render(narrowNode, { maxWidth: 632, gutterPx: 48 }));
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 548px) 500px, calc(100vw - 48px)");
	});

	test("a full-width or wide image block (alignment: full | wide) and a Cover block keep full width", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01HERO.png?w=600 600w, /_emdash/api/media/file/01HERO.png?w=1440 1440w",
			bound: 1456,
			shape: 1456 / 800,
		};
		const fullImageTag = imgTag(
			await render({ ...withDimensions, alignment: "full" }, { maxWidth: 632, gutterPx: 48 }),
		);
		expect(attr(fullImageTag, "sizes")).toBe("auto, (min-width: 1456px) 1456px, 100vw");

		const wideImageTag = imgTag(
			await render({ ...withDimensions, alignment: "wide" }, { maxWidth: 632, gutterPx: 48 }),
		);
		expect(attr(wideImageTag, "sizes")).toBe("auto, (min-width: 1456px) 1456px, 100vw");

		const c = await AstroContainer.create();
		const coverHtml = await c.renderToString(Cover, {
			props: {
				node: {
					_type: "cover",
					_key: "cv1",
					backgroundImage: "/_emdash/api/media/file/01HERO.png",
					content: [],
				},
			},
			locals,
		});
		expect(attr(imgTag(coverHtml), "sizes")).toBe("auto, 100vw");
	});
});

describe("141c: shelled WpShellImage uses the shell layout's measured contentWidth", () => {
	async function renderShelled(node: unknown, contentWidth?: number) {
		const c = await AstroContainer.create();
		const shellLocals: Record<PropertyKey, unknown> = { ...locals };
		if (contentWidth !== undefined) shellLocals[WP_SHELL_CONTENT_WIDTH_KEY] = contentWidth;
		return c.renderToString(WpShellImage, {
			props: { node, placeholder: false },
			locals: shellLocals,
		});
	}

	test("shelled post with contentWidth 1140 and 2400px image caps desktop sizes at 1140px", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01BIG.png?w=600 600w, /_emdash/api/media/file/01BIG.png?w=1200 1200w, /_emdash/api/media/file/01BIG.png?w=2400 2400w",
			bound: 2400,
			shape: 2400 / 1600,
		};
		const tag = imgTag(await renderShelled({ ...nodimensions, width: 2400, height: 1600 }, 1140));
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 1140px) 1140px, 100vw");
	});

	test("shelled post with contentWidth 1140 and 600px image keeps the image's own 600px width", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01MED.png?w=300 300w, /_emdash/api/media/file/01MED.png?w=600 600w",
			bound: 600,
			shape: 600 / 400,
		};
		const tag = imgTag(await renderShelled({ ...nodimensions, width: 600, height: 400 }, 1140));
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 600px) 600px, 100vw");
	});

	test("shelled post with contentWidth absent keeps today's sizes unchanged", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01BIG.png?w=600 600w, /_emdash/api/media/file/01BIG.png?w=2400 2400w",
			bound: 2400,
			shape: 2400 / 1600,
		};
		const tag = imgTag(await renderShelled({ ...nodimensions, width: 2400, height: 1600 }));
		expect(attr(tag, "sizes")).toBe("auto, (min-width: 2400px) 2400px, 100vw");
	});

	test("shelled post with contentWidth 1140 leaves alignment: wide and alignment: full uncapped", async () => {
		stored.value = {
			srcset:
				"/_emdash/api/media/file/01BIG.png?w=600 600w, /_emdash/api/media/file/01BIG.png?w=2400 2400w",
			bound: 2400,
			shape: 2400 / 1600,
		};
		const wideTag = imgTag(
			await renderShelled({ ...nodimensions, width: 2400, height: 1600, alignment: "wide" }, 1140),
		);
		expect(attr(wideTag, "sizes")).toBe("auto, (min-width: 2400px) 2400px, 100vw");

		const fullTag = imgTag(
			await renderShelled({ ...nodimensions, width: 2400, height: 1600, alignment: "full" }, 1140),
		);
		expect(attr(fullTag, "sizes")).toBe("auto, (min-width: 2400px) 2400px, 100vw");
	});
});
