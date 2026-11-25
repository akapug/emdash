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
