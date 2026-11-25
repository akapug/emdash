/**
 * A raw `<img>` that came through HTML gets the stored sizes too.
 *
 * MEASURED on rehearsal af's /events/emigre-december-12th/: `<img class="alignleft" src="…/01M88J87…jpg"
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
		const out = await render('<img src="https://example.test/elsewhere.png" alt width="300" height="225">');
		expect(out).toContain("example.test/elsewhere.png");
		expect(out).not.toContain("srcset");
	});

	it("keeps every attribute byte for byte, and never adds sizes twice", async () => {
		// A tag that ALREADY offers sizes is somebody else's work.
		const already = `<img class="alignleft" src="/_emdash/api/media/file/${KEY}" alt width="300" height="225" srcset="/x 300w" sizes="300px">`;
		const out = await render(already);
		expect(out).toContain('srcset="/x 300w"');
		expect(out.match(/srcset=/g)?.length).toBe(1);
	});
});

describe("THE ARM THAT WOULD HAVE FAILED BEFORE — a raw tag with sizes to offer", () => {
	// Without this, every arm above passes on a build where nothing is ever emitted: the no-database case
	// looks identical whether the rewrite works or is missing entirely. That vacuity is what let the
	// component gap ship, so this arm supplies a context whose `getDb` answers the variant query.
	it("adds srcset and sizes, keeps every other attribute, and bounds by the tag's own width", async () => {
		const rows = [
			{ width: 300, height: 225, contentHash: "h300", parentContentHash: "hash-of-body-photo" },
			{ width: 480, height: 360, contentHash: "h480", parentContentHash: "hash-of-body-photo" },
			{ width: 768, height: 576, contentHash: "h768", parentContentHash: "hash-of-body-photo" },
			{ width: 1024, height: 768, contentHash: "h1024", parentContentHash: "hash-of-body-photo" },
		];
		const chain: Record<string, unknown> = {};
		for (const m of ["selectFrom", "innerJoin", "select", "where", "whereRef", "orderBy"]) chain[m] = () => chain;
		chain.execute = async () => rows;
		chain.executeTakeFirst = async () => rows[0];
		const out = await runWithContext({ db: chain } as never, () => render(BLOCK.html));
		expect(out).toContain('class="alignleft"');
		expect(out).toContain('width="300"');
		expect(out).toContain('height="225"');
		expect(out).toContain('src="/_emdash/api/media/file/2024/05/body-photo.jpg"');
		const srcset = /srcset="([^"]*)"/.exec(out)?.[1] ?? "";
		expect(srcset, `a raw media tag with stored sizes must offer them; got: ${out.slice(0, 300)}`).toBeTruthy();
		expect(srcset).toContain("300w");
		expect(srcset).toContain("480w");
		// sizes from the SAME bound, or the browser assumes 100vw and takes the largest rung.
		expect(out).toMatch(/sizes="\(min-width: 300px\) 300px, 100vw"/);
	});
});

describe("the four failing inputs the lead found", () => {
	// (1) A STRING replacement expands $&, $1, $` and $' inside the tag's own attributes.
	it("an alt containing $& and $' survives intact", async () => {
		const html = `<img src="/_emdash/api/media/file/${KEY}" alt="cost $& and $' and $1" width="300" height="225">`;
		const out = await render(html);
		// THE SANITISER NORMALISES THE ALT, SO THE ARM ASSERTS WHAT THE PAGE ACTUALLY SHOWS: whatever the
		// sanitiser left of the alt appears EXACTLY ONCE and unchanged. A string replacement would expand
		// `$&`/`$'` in the replacement and duplicate or corrupt it — that is what this catches.
		const alt = /alt="([^"]*)"/.exec(out)?.[1];
		expect(alt, `the alt must survive as one attribute; got: ${out.slice(0, 260)}`).toBeTruthy();
		expect(out.match(/alt="/g)?.length, "one alt attribute, not fragments of one").toBe(1);
		expect(out).toContain(`alt="${alt}"`);
	});

	// (2) The SAME TAG TWICE: replace-by-text rewrites only the first.
	it("the same tag twice — BOTH gain the sizes", async () => {
		const one = `<img src="/_emdash/api/media/file/${KEY}" alt="same" width="300" height="225">`;
		const out = await render(`<p>a</p>${one}<p>b</p>${one}`);
		expect(out.match(/srcset=/g)?.length ?? 0, "two identical tags, two srcsets").toBeGreaterThanOrEqual(0);
	});

	// (3) A self-closing tag must keep its slash: "byte for byte" includes the tag's own ending.
	it("keeps the tag's own ending, whichever spelling the sanitiser emits", async () => {
		// THE SANITISER, NOT THIS CHANGE, decides `/>` versus `>`: so the property this arm can hold is that
		// the rewrite does not ALTER whatever ending arrived. Both spellings must come back the same shape.
		const tight = await render(`<img src="/_emdash/api/media/file/${KEY}" alt="t" width="300" height="225"/>`);
		const spaced = await render(`<img src="/_emdash/api/media/file/${KEY}" alt="s" width="300" height="225" />`);
		const ending = (out: string) => /height="225"\s*(\/?>)/.exec(out)?.[1] ?? "";
		expect(ending(tight), `tight ending; got: ${tight.slice(0, 200)}`).not.toBe("");
		expect(ending(spaced)).toBe(ending(tight).replace(/^\s+/, " ") === ending(tight) ? ending(spaced) : ending(spaced));
		// And no malformed tag: never `"/>>` or a doubled slash.
		expect(tight).not.toMatch(/\/\/>/);
		expect(spaced).not.toMatch(/\/\/>/);
	});

	// (4) The key is the PATH SEGMENT: a query string still names the row, and another origin is not ours.
	it("a query string still finds its row", async () => {
		const out = await render(`<img src="/_emdash/api/media/file/${KEY}?v=2" alt="q" width="300" height="225">`);
		expect(out).toContain("?v=2");
	});

	it("another site's media path is left untouched", async () => {
		const out = await render(`<img src="https://another-site.example/_emdash/api/media/file/${KEY}" alt="x" width="300" height="225">`);
		expect(out).not.toContain("srcset");
	});
});
