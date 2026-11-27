/**
 * The raw-tag rewrite's own contract, driven directly with an injected lookup.
 *
 * EVERY EXPECTATION IS A LITERAL STRING. An earlier version of the `$`-sequence arm asserted only that the
 * output CONTAINED the original alt, and the defect it was written for expands `$&` into the whole original
 * tag, which contains that alt: the corrupt page passed. A literal comparison of the whole output is the only
 * assertion that cannot be satisfied by a page holding the right text in the wrong place.
 *
 * Whose image a src names is decided by `storedSizesForRender` (variant-read.ts), not here. The stub below
 * knows exactly one stored image by its literal address, and records what it was asked, so these arms pin
 * what the rewrite HANDS the decision; the decision itself is driven for real by the render arms.
 */
import { describe, expect, it } from "vitest";

import { sanitizeContent } from "../../src/utils/sanitize.ts";
import { withStoredSizes } from "../../src/utils/raw-media-tags.js";

const PATH = "/_emdash/api/media/file/2024/05/body-photo.jpg";
const SIZES = 'srcset="/v?w=300 300w" sizes="(min-width: 300px) 300px, 100vw"';

function stub(known: string[] = [PATH]) {
	const calls: Array<{ ref: unknown; bound: number | undefined }> = [];
	const lookup = async (ref: { url?: string | null; origin?: string | null }, bound?: number) => {
		calls.push({ ref, bound });
		if (!ref.url || !known.includes(ref.url)) return null;
		return { srcset: "/v?w=300 300w", bound: bound ?? 300, shape: undefined };
	};
	return { lookup, calls };
}

const run = (html: string, known?: string[], origin?: string) =>
	withStoredSizes(html, { lookup: stub(known).lookup, origin });

describe("withStoredSizes", () => {
	it("does not expand $& or $' or $1 found in an attribute", async () => {
		const out = await run(
			`<img src="${PATH}" alt="cost $& and $' and $1" width="300" height="225">`,
		);
		expect(out).toBe(
			`<img src="${PATH}" alt="cost $& and $' and $1" width="300" height="225" ${SIZES}>`,
		);
	});

	it("rewrites BOTH of two identical tags", async () => {
		const one = `<img src="${PATH}" alt="same" width="300" height="225">`;
		const out = await run(`<p>a</p>${one}<p>b</p>${one}`);
		const sized = `<img src="${PATH}" alt="same" width="300" height="225" ${SIZES}>`;
		expect(out).toBe(`<p>a</p>${sized}<p>b</p>${sized}`);
	});

	it("keeps /> and ' />' exactly", async () => {
		expect(await run(`<img src="${PATH}" width="300"/>`)).toBe(
			`<img src="${PATH}" width="300" ${SIZES}/>`,
		);
		expect(await run(`<img src="${PATH}" width="300" />`)).toBe(
			`<img src="${PATH}" width="300" ${SIZES} />`,
		);
	});

	it("hands the lookup the src as written and the site's origin, and the tag's own width", async () => {
		const { lookup, calls } = stub();
		const src = `https://site.example${PATH}?v=2`;
		await withStoredSizes(`<img src="${src}" width="300">`, {
			lookup,
			origin: "https://site.example",
		});
		expect(calls).toEqual([{ ref: { url: src, origin: "https://site.example" }, bound: 300 }]);
	});

	it("decodes character references in the src before handing it on", async () => {
		const { lookup, calls } = stub();
		await withStoredSizes(`<img src="/_emdash/api/media/file/a&amp;b&#39;c.jpg">`, { lookup });
		expect(calls).toEqual([
			{ ref: { url: "/_emdash/api/media/file/a&b'c.jpg", origin: undefined }, bound: undefined },
		]);
	});

	it("reads src, not data-src, and width, not data-width", async () => {
		const other = `<img data-src="${PATH}" src="https://cdn.example/x.jpg" width="300">`;
		expect(await run(other)).toBe(other);
		const out = await run(`<img data-width="1200" src="${PATH}" width="300">`);
		expect(out).toBe(`<img data-width="1200" src="${PATH}" width="300" ${SIZES}>`);
	});

	it("reads a single-quoted, an unquoted and an uppercase src", async () => {
		expect(await run(`<img src='${PATH}' width='300'>`)).toBe(
			`<img src='${PATH}' width='300' ${SIZES}>`,
		);
		expect(await run(`<img src=${PATH} width=300>`)).toBe(`<img src=${PATH} width=300 ${SIZES}>`);
		expect(await run(`<IMG SRC="${PATH}" WIDTH="300">`)).toBe(
			`<IMG SRC="${PATH}" WIDTH="300" ${SIZES}>`,
		);
	});

	it("does not read the word srcset inside another attribute's value as a srcset", async () => {
		const out = await run(`<img alt="no srcset=here" src="${PATH}" width="300">`);
		expect(out).toBe(`<img alt="no srcset=here" src="${PATH}" width="300" ${SIZES}>`);
	});

	it("does not end the tag at a > inside a quoted value", async () => {
		const out = await run(`<img src="${PATH}" alt="a > b" width="300">`);
		expect(out).toBe(`<img src="${PATH}" alt="a > b" width="300" ${SIZES}>`);
	});

	it('treats width="0" as no width', async () => {
		const { lookup, calls } = stub();
		await withStoredSizes(`<img src="${PATH}" width="0">`, { lookup });
		expect(calls).toEqual([{ ref: { url: PATH, origin: undefined }, bound: undefined }]);
	});

	it("leaves a tag that already carries a srcset alone", async () => {
		const html = `<img src="${PATH}" alt="a" srcset="/x 300w" sizes="300px">`;
		expect(await run(html)).toBe(html);
	});

	it("leaves a tag the lookup does not know exactly as it was", async () => {
		const html = `<p>x</p><img src="${PATH}" alt="none" width="300" height="225">`;
		expect(await run(html, [])).toBe(html);
	});

	it("leaves a non-media image alone without asking", async () => {
		const { lookup, calls } = stub();
		const html = `<img src="https://example.test/elsewhere.png" alt width="300" height="225">`;
		expect(await withStoredSizes(html, { lookup })).toBe(html);
		expect(calls).toEqual([]);
	});

	it("rewrites five hundred tags, asking once per distinct image", async () => {
		const { lookup, calls } = stub();
		const one = `<p>t</p><img src="${PATH}" width="300">`;
		const out = await withStoredSizes(one.repeat(500), { lookup });
		expect(out).toBe(`<p>t</p><img src="${PATH}" width="300" ${SIZES}>`.repeat(500));
		expect(calls.length).toBe(1);
	});
});

// ---- ITEM 164g: the source's own `sizes` wins; otherwise the slot is capped by the content column ----
//
// Measured on a real migrated site: adamkoren's `/about/` downloaded 5.82 MB of images against live's 1.68 MB at 1440@1x. The cause
// was uniform — every body image declared `sizes="auto, (min-width: <N>px) <N>px, 100vw"` where N was the FILE's width, while the
// source page states the COLUMN (a 2560-wide podcast cover: `(max-width: 767px) 100vw, 400px`).

describe("164g: sizes come from the source, else from the measured column", () => {
	const OUR = "/_emdash/api/media/file/01M8E1WF69GAH69YSWX7BJ6ESB.png";
	const lookup = async (): Promise<{ srcset: string; bound: number } | null> => ({
		srcset: `${OUR}?w=400 400w, ${OUR}?w=1200 1200w, ${OUR}?w=1536 1536w`,
		bound: 2560,
	});

	it("KEEPS the source's sizes on a real calulti/adamkoren tag — the 2560-wide cover that states 400px", async () => {
		const src = `<img src="${OUR}" width="2560" height="2560" sizes="(max-width: 767px) 100vw, 400px">`;
		const out = await withStoredSizes(src, { lookup });
		expect(out).toContain('sizes="(max-width: 767px) 100vw, 400px"');
		// and NOT the file's own width, which is the defect this pins
		expect(out).not.toContain("2560px");
	});

	it("uses the capped column where the source states NO sizes — the headshot case", async () => {
		const src = `<img src="${OUR}" width="455" height="683">`;
		const out = await withStoredSizes(src, { lookup, slotMaxWidth: 632 });
		expect(out).toContain('sizes="(min-width: 632px) 632px, 100vw"');
	});

	it("caps by the column even when the file is WIDER than it", async () => {
		// the file is 2560; the column 632. Cap wins.
		const src = `<img src="${OUR}" width="2560" height="2560">`;
		const out = await withStoredSizes(src, { lookup, slotMaxWidth: 632 });
		expect(out).not.toContain("2560px");
		expect(out).toContain("632px");
	});

	it("REFUSES a hostile sizes value and falls back to the capped column", async () => {
		// VALUES THAT ARRIVE AS A WELL-FORMED ATTRIBUTE and must still be refused. A value containing a literal `"` cannot reach
		// here at all: `sanitizeContent` runs first and would have ended the attribute there, so a fixture that embeds one is
		// testing the fixture. These are the shapes this layer actually decides on.
		const hostile = [
			`</style><script>alert(1)</script>`,                      // tag breakout inside a quoted value
			`400px; background:url(javascript:alert(1))`,             // CSS injection
			`url(//evil.example/x)`,                                  // url() must never appear
			`calc(100vw - 2em)); x: url(y`,                           // unbalanced calc
			`400px; x=y`,                                             // a declaration smuggled into the value
			`(max-width: 767px) 100vw, expression(alert(1))`,         // legacy expression()
		];
		for (const value of hostile) {
			const src = `<img src="${OUR}" width="455" height="683" sizes="${value}">`;
			const out = await withStoredSizes(src, { lookup, slotMaxWidth: 632 });
			// Whatever comes out must be OUR capped value, and must never carry the hostile text through.
			// WHAT THIS LAYER OWNS: a value outside the grammar never reaches the `sizes` attribute. The attribute-breakout
			// case's `onerror` is removed by `sanitizeContent` upstream — proven in the arm below — so asserting it here
			// would be testing a component this file does not control.
			// THIS LAYER'S GUARANTEE: the hostile text is not inside the `sizes` attribute it writes. (The original tag's own
			// bytes are the source's, and `sanitizeContent` upstream has already rejected them — see the order arm.)
			const sizes = /\ssizes="([^"]*)"/u.exec(out);
			expect(sizes?.[1] ?? "", value).not.toMatch(/script|javascript:|evil\.example|expression|url\(/iu);
			expect(out, value).toContain('sizes="(min-width: 632px) 632px, 100vw"');
		}
	});

	it("ACCEPTS the sizes grammar a real theme writes: media conditions, vw, em, calc, and several entries", async () => {
		const ok = [
			`(min-width: 400px) 400px`,
			`(max-width: 767px) 100vw, 600px`,
			`(min-width: 30em) 50vw, 100vw`,
			`calc(100vw - 4rem)`,
			`(max-width: 767px) 100vw, (max-width: 1200px) 50vw, 600px`,
		];
		for (const value of ok) {
			const src = `<img src="${OUR}" width="455" height="683" sizes="${value}">`;
			const out = await withStoredSizes(src, { lookup, slotMaxWidth: 632 });
			expect(out, value).toContain(`sizes="${value}"`);
		}
	});
});

describe("164g: the input to withStoredSizes is ALREADY sanitized", () => {
	it("proves the order: sanitizeContent strips onerror BEFORE withStoredSizes runs", async () => {
		// HtmlBlock.astro runs `sanitizeContent(node.html)` and passes the RESULT here. So this file never sees a handler — the
		// hostile arm above tests a shape that cannot arrive, and asserting on it would be testing the wrong component.
		const dirty = `<img src="/_emdash/api/media/file/x.png" width="455" sizes="(min-width: 400px) 400px" onerror="alert(1)">`;
		const clean = sanitizeContent(dirty);
		expect(clean).not.toContain("onerror");
		// and what reaches withStoredSizes keeps the source's sizes, because it is now a well-formed tag
		const out = await withStoredSizes(clean, { lookup: async () => ({ srcset: "/x.png?w=400 400w", bound: 455 }), slotMaxWidth: 632 });
		(await import("node:fs")).writeFileSync("/tmp/out1.txt", out);
		console.log("CLEAN:", clean);
		expect(out).toContain('sizes="(min-width: 400px) 400px"');
	});
});
