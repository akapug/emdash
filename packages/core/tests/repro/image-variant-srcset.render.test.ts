/**
 * OUR SRCSET MUST REACH THE MARKUP.
 *
 * This is the arm that was missing, and its absence is why a feature that stored 1,490 variants and
 * served them at `?w=` changed no page: `EmDashImage` built the srcset correctly, then handed the
 * same-origin image to `<AstroImage>`, which takes `src` alone and derives its own srcset from the
 * local file. Every layer upstream was green.
 *
 * A render arm runs WITHOUT a request context, so the component's read is guarded with
 * `mediaDb ? … : []`. This arm supplies a `db` good enough for `getCommittedVariants`' query and
 * asserts the HTML that comes out — the only thing that proves the variants reach a browser.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";

import EmDashImage from "../../src/components/EmDashImage.astro";

/**
 * The smallest object `getCommittedVariants` accepts.
 *
 * It calls `db.selectFrom("_emdash_media_variants as variant").innerJoin("media as parent", …)
 * .select([…]).where(…).where(…).execute()`, so the stub answers that chain and nothing else.
 * The variant rows it returns are the shape the real query selects.
 */
function variantDb(rows: Array<Record<string, unknown>>) {
	const chain = {
		selectFrom: () => chain,
		innerJoin: () => chain,
		select: () => chain,
		where: () => chain,
		whereRef: () => chain,
		orderBy: () => chain,
		execute: async () => rows,
		executeTakeFirst: async () => rows[0],
	};
	return chain as unknown as Record<string, unknown>;
}

const imgTags = (html: string) => html.match(/<img\b[^>]*>/g) ?? [];
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]?.replaceAll("&amp;", "&");

async function render(image: Record<string, unknown>, db?: Record<string, unknown>): Promise<string> {
	const container = await AstroContainer.create();
	return container.renderToString(EmDashImage, {
		props: { image },
		locals: {
			emdash: {
				getPublicMediaUrl: (key: string) => `/_emdash/api/media/file/${key}`,
				...(db ? { db } : {}),
			},
		},
	});
}

const IMAGE = {
	src: "/_emdash/api/media/file/2024/05/ladder.jpg",
	storageKey: "2024/05/ladder.jpg",
	alt: "a ladder",
	width: 1600,
	height: 900,
};

const COMMITTED = [
	{ width: 300, height: 169, contentHash: "h300", parentContentHash: "hash-of-ladder" },
	{ width: 1024, height: 576, contentHash: "h1024", parentContentHash: "hash-of-ladder" },
];

describe("EmDashImage emits the COMMITTED variant ladder", () => {
	it("offers every committed rung in srcset, and the original stays the src", async () => {
		const html = await render(IMAGE, variantDb(COMMITTED));
		const tag = imgTags(html).find((t) => t.includes("ladder.jpg")) ?? "";
		expect(tag, "the image must render").not.toBe("");
		const srcset = attr(tag, "srcset");
		// THE ASSERTION THAT WAS MISSING. Without it the component builds a srcset and throws it
		// away at <AstroImage>, and every other arm in the repo still passes.
		expect(srcset, "a committed variant must reach the markup").toBeTruthy();
		expect(srcset).toContain("300w");
		expect(srcset).toContain("1024w");
		expect(attr(tag, "sizes"), "srcset without sizes makes the browser assume 100vw").toBeTruthy();
		// The fallback is the original, never an invented width.
		expect(attr(tag, "src") ?? "").toContain("2024/05/ladder.jpg");
		expect(attr(tag, "src") ?? "").not.toMatch(/\?w=\d+/);
	});

	it("is byte-identical to a site with no variants when nothing is committed", async () => {
		// THE COMPARISON IS OURS AGAINST OURS, not "no srcset exists": on the <AstroImage> path
		// Astro emits a srcset of its own from the local file, which is its behaviour and not a
		// variant reaching the markup. What must be true is that an empty variant set changes
		// nothing relative to rendering with no database at all.
		const withDb = await render(IMAGE, variantDb([]));
		const withoutDb = await render(IMAGE);
		expect(withDb).toBe(withoutDb);
		// And no variant URL was invented: every candidate still points at the original.
		for (const tag of imgTags(withDb)) expect(attr(tag, "srcset") ?? "").not.toMatch(/\?w=\d+/);
	});
});
