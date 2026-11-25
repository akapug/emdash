/**
 * A raw `<img>` that came through HTML gets the stored sizes too.
 *
 * MEASURED on one imported page: `<img class="alignleft" src="…/KEY.jpg"
 * alt width="300" height="225">` — no data-astro-cid, so it came through HTML — fetched 874 KB into a
 * 300x225 box. The tenant held four stored sizes for that row (300x225, 480x360, 768x576, 1024x768), so a
 * browser could have taken 300w. Nothing offered it, because HtmlBlock renders the sanitised string as-is.
 *
 * These arms render the REAL component. They run WITHOUT `locals.emdash.db`, which is also the static-build
 * and repro case: the lookup goes through the request context the way menus and settings do, so a component
 * with no database must render exactly as it does today.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import HtmlBlock from "../../src/components/HtmlBlock.astro";
import { runWithContext } from "../../src/request-context.js";

const KEY = "2024/05/body-photo.jpg";
const BLOCK = {
	_type: "htmlBlock" as const,
	_key: "b1",
	html: `<p>Words</p><img class="alignleft" src="/_emdash/api/media/file/${KEY}" alt="a body photo" width="300" height="225" loading="lazy" decoding="async"><p>More</p>`,
};

async function render(html: string): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(HtmlBlock, { props: { node: { ...BLOCK, html } }, locals: {} });
}

describe("HtmlBlock and raw media tags", () => {
	it("renders the tag UNCHANGED when there is no database to ask", async () => {
		// The property that keeps every existing site identical: no context, no change.
		const out = await render(BLOCK.html);
		expect(out).toContain('class="alignleft"');
		expect(out).toContain('src="/_emdash/api/media/file/2024/05/body-photo.jpg"');
		expect(out).toContain('width="300"');
		expect(out).toContain('height="225"');
		expect(out).toContain('loading="lazy"');
		// `decoding` is DROPPED BY THE SANITISER, not by this change — the arm records the real baseline
		// rather than asserting an attribute the emitter never produced.
		expect(out).not.toContain("decoding");
		expect(out).not.toContain("srcset");
	});

	it("leaves a non-media image alone even with a database", async () => {
		const out = await renderWithSizes(
			'<img src="https://example.test/elsewhere.png" alt width="300" height="225">',
		);
		expect(out).toContain("example.test/elsewhere.png");
		expect(out).not.toContain("srcset");
	});

	it("keeps every attribute byte for byte, and never adds sizes twice", async () => {
		// A tag that ALREADY offers sizes is somebody else's work.
		const already = `<img class="alignleft" src="/_emdash/api/media/file/${KEY}" alt width="300" height="225" srcset="/x 300w" sizes="300px">`;
		const out = await renderWithSizes(already);
		expect(out).toContain('srcset="/x 300w"');
		expect(out.match(/srcset=/g)?.length).toBe(1);
	});
});

/** Render with a request context whose `getDb` answers the variant query with four stored sizes. */
async function renderWithSizes(html: string): Promise<string> {
	const rows = [
		{ width: 300, height: 225, contentHash: "h300", parentContentHash: "hash-of-body-photo" },
		{ width: 480, height: 360, contentHash: "h480", parentContentHash: "hash-of-body-photo" },
		{ width: 768, height: 576, contentHash: "h768", parentContentHash: "hash-of-body-photo" },
		{ width: 1024, height: 768, contentHash: "h1024", parentContentHash: "hash-of-body-photo" },
	];
	const chain: Record<string, unknown> = {};
	for (const m of ["selectFrom", "innerJoin", "select", "where", "whereRef", "orderBy"])
		chain[m] = () => chain;
	chain.execute = async () => rows;
	chain.executeTakeFirst = async () => rows[0];
	return runWithContext({ db: chain } as never, () => render(html));
}

describe("THE ARM THAT WOULD HAVE FAILED BEFORE — a raw tag with sizes to offer", () => {
	// Without this, every arm above passes on a build where nothing is ever emitted: the no-database case
	// looks identical whether the rewrite works or is missing entirely. That vacuity is what let the
	// component gap ship, so this arm supplies a context whose `getDb` answers the variant query.
	it("adds srcset and sizes, keeps every other attribute, and bounds by the tag's own width", async () => {
		const out = await renderWithSizes(BLOCK.html);
		expect(out).toContain('class="alignleft"');
		expect(out).toContain('width="300"');
		expect(out).toContain('height="225"');
		expect(out).toContain('src="/_emdash/api/media/file/2024/05/body-photo.jpg"');
		const srcset = /srcset="([^"]*)"/.exec(out)?.[1] ?? "";
		expect(
			srcset,
			`a raw media tag with stored sizes must offer them; got: ${out.slice(0, 300)}`,
		).toBeTruthy();
		expect(srcset).toContain("300w");
		expect(srcset).toContain("480w");
		// sizes from the SAME bound, or the browser assumes 100vw and takes the largest rung.
		expect(out).toMatch(/sizes="\(min-width: 300px\) 300px, 100vw"/);
	});
});

describe("the failing inputs, through the real component and the real decision of whose image it is", () => {
	// EVERY ARM HERE RUNS WITH SIZES TO OFFER. Without a database the rewrite never reaches its replacement,
	// so an arm rendered without one passes whatever the replacement does.
	it("an alt containing $& and $' survives intact, and the tag is not duplicated", async () => {
		const out = await renderWithSizes(
			`<img src="/_emdash/api/media/file/${KEY}" alt="cost $& and $' and $1" width="300" height="225">`,
		);
		expect(out.match(/<img\b/g)?.length, `one tag; got: ${out.slice(0, 400)}`).toBe(1);
		expect(out).toContain(`alt="cost $&amp; and $' and $1" width="300" height="225" srcset="`);
	});

	it("the same tag twice: BOTH gain the sizes", async () => {
		const one = `<img src="/_emdash/api/media/file/${KEY}" alt="same" width="300" height="225">`;
		const out = await renderWithSizes(`<p>a</p>${one}<p>b</p>${one}`);
		expect(out.match(/srcset=/g)?.length ?? 0, `two identical tags, two srcsets; got: ${out}`).toBe(
			2,
		);
	});

	it("keeps the sanitiser's self-closing ending after the added sizes", async () => {
		const out = await renderWithSizes(
			`<img src="/_emdash/api/media/file/${KEY}" alt="t" width="300" height="225">`,
		);
		expect(out).toContain('sizes="(min-width: 300px) 300px, 100vw" />');
	});

	it("a query string still finds its row", async () => {
		const out = await renderWithSizes(
			`<img src="/_emdash/api/media/file/${KEY}?v=2" alt="q" width="300" height="225">`,
		);
		expect(out).toContain("?v=2");
		expect(out).toContain("srcset=");
	});

	it("another site's media path is left untouched", async () => {
		const out = await renderWithSizes(
			`<img src="https://another-site.example/_emdash/api/media/file/${KEY}" alt="x" width="300" height="225">`,
		);
		expect(out).toContain("https://another-site.example/_emdash/api/media/file/");
		expect(out).not.toContain("srcset");
	});

	it("a lazy-load data-src naming our file does not give another src our sizes", async () => {
		const out = await renderWithSizes(
			`<img data-src="/_emdash/api/media/file/${KEY}" src="https://cdn.example/x.jpg" alt="lazy" width="300" height="225">`,
		);
		expect(out).toContain('src="https://cdn.example/x.jpg"');
		expect(out).not.toContain("srcset");
	});
});
