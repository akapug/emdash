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

async function render(node: unknown) {
	const c = await AstroContainer.create();
	return c.renderToString(Image, { props: { node, placeholder: false }, locals });
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
