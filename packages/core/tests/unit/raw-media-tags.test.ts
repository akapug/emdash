/**
 * The raw-tag rewrite's own contract, driven directly with an injected lookup.
 *
 * WHY A UNIT TEST AND NOT A RENDER ARM. `sanitizeContent` normalises what it sees, so a render arm cannot
 * reach the inputs that broke this: a `$`-sequence in an attribute, a body that repeats an image, a
 * self-closing slash, a query string on the src. Those are exactly the four the lead found, and two of them
 * (the `$` expansion and the repeated tag) were only reachable here.
 *
 * The lookup is a PARAMETER, not a global: a test seam in production code was tried and removed.
 */
import { describe, expect, it } from "vitest";

import { withStoredSizes } from "../../src/utils/raw-media-tags.js";

const KEY = "2024/05/body-photo.jpg";
const PATH = `/_emdash/api/media/file/${KEY}`;

/** A lookup that always finds one rung, so any tag we own gets a srcset. */
const lookup = async (_ref: { storageKey?: string | null }, bound?: number) => ({
	srcset: "/v?w=300 300w",
	bound: bound ?? 300,
});

const run = (html: string, opts: { origin?: string } = {}) => withStoredSizes(html, { lookup, ...opts });
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("withStoredSizes", () => {
	it("does not expand $& or $' or $1 inside an attribute (defect 1)", async () => {
		// THE `$&` MUST REACH THE REPLACEMENT FOR THIS ARM TO MEAN ANYTHING: `String.replace(pattern,
		// replacement)` expands `$&` in the REPLACEMENT, and an older version passed the whole tag as the
		// replacement — which is how an alt like this corrupted the page.
		const alt = `cost $& and $' and $1`;
		const out = await run(`<img src="${PATH}" alt="${alt}" width="300" height="225">`);
		expect(out).toContain(`alt="${alt}"`);
		expect(out).toContain("srcset=");
	});

	it("rewrites BOTH of two identical tags (defect 2)", async () => {
		const one = `<img src="${PATH}" alt="same" width="300" height="225">`;
		const out = await run(`<p>a</p>${one}<p>b</p>${one}`);
		expect(count(out, "srcset="), `both tags must be rewritten; got: ${out}`).toBe(2);
	});

	it("keeps /> and ' />' exactly (defect 3)", async () => {
		const tight = await run(`<img src="${PATH}" alt="t" width="300" height="225"/>`);
		expect(tight.endsWith("/>"), `a self-closing tag keeps its slash; got: ${tight}`).toBe(true);
		const spaced = await run(`<img src="${PATH}" alt="s" width="300" height="225" />`);
		expect(spaced).toContain(" />");
		// And neither is doubled into `//>`.
		expect(tight).not.toContain("//>");
		expect(spaced).not.toContain("//>");
	});

	it("finds the row from a src that carries a query string (defect 4a)", async () => {
		const out = await run(`<img src="${PATH}?v=2" alt="q" width="300" height="225">`);
		expect(out).toContain("?v=2");
		expect(out).toContain("srcset=");
	});

	it("leaves ANOTHER origin's media path alone (defect 4b)", async () => {
		const out = await run(`<img src="https://another-site.example${PATH}" alt="x" width="300" height="225">`, {
			origin: "https://site.example",
		});
		expect(out).not.toContain("srcset");
	});

	it("does not treat an origin that is a PREFIX of another host as ours", async () => {
		// `https://site.example.evil.test` merely BEGINS with `https://site.example`. Treating it as ours would
		// give somebody else's picture a srcset pointing at our file route — a swapped image.
		const out = await run(`<img src="https://site.example.evil.test${PATH}" alt="evil" width="300" height="225">`, {
			origin: "https://site.example",
		});
		expect(out, `a look-alike host must be left alone; got: ${out}`).not.toContain("srcset");
	});

	it("touches an absolute src on OUR OWN origin", async () => {
		const out = await run(`<img src="https://site.example${PATH}" alt="ours" width="300" height="225">`, {
			origin: "https://site.example",
		});
		expect(out).toContain("srcset=");
	});

	it("leaves a tag that already carries a srcset alone", async () => {
		const out = await run(`<img src="${PATH}" alt="a" srcset="/x 300w" sizes="300px">`);
		expect(count(out, "srcset=")).toBe(1);
	});

	it("leaves a tag with no stored sizes exactly as it was", async () => {
		const html = `<img src="${PATH}" alt="none" width="300" height="225">`;
		const none = async () => null;
		const out = await withStoredSizes(html, { lookup: none });
		expect(out).toBe(html);
	});

	it("leaves a non-media image alone", async () => {
		const html = `<img src="https://example.test/elsewhere.png" alt width="300" height="225">`;
		expect(await run(html)).toBe(html);
	});
});
