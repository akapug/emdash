/**
 * Item 163c: an unknown container whose descendants are all static saved HTML keeps its wrapper.
 *
 * MEASURED on twpe (Astra + Spectra): 21 unknown containers hold innerBlocks, 10 qualify, 5 hold a
 * `core/shortcode`, 6 hold a block that saves no markup. The wrapper carries `uagb-block-<hash>`, which
 * exists in no attr and in no CSS of ours — dropping it collapsed every grid section.
 */

import { describe, expect, it } from "vitest";

import { containerReportLines, keptContainersIn } from "../src/container-report.js";
import { gutenbergToPortableText } from "../src/index.js";
import type { PortableTextBlock } from "../src/types.js";

/** A Spectra container as WordPress saves one: the wrapper's tag, then children as separate blocks. */
const container = (
	inner: string,
	hash = "a11f6d7d",
	attrs = '{"block_id":"a11f6d7d","tag":"div"}',
) =>
	`<!-- wp:uagb/container ${attrs} -->
<div class="wp-block-uagb-container uagb-block-${hash} alignfull uagb-is-root-container">${inner}</div>
<!-- /wp:uagb/container -->`;

const heading = (text: string) => `<!-- wp:heading -->
<h2 class="wp-block-heading">${text}</h2>
<!-- /wp:heading -->`;

const paragraph = (text: string) => `<!-- wp:paragraph -->
<p>${text}</p>
<!-- /wp:paragraph -->`;

const htmlOf = (blocks: PortableTextBlock[]) =>
	blocks
		.filter(
			(b): b is PortableTextBlock & { _type: "htmlBlock"; html: string } => b._type === "htmlBlock",
		)
		.map((b) => b.html)
		.join("\n");

describe("163c: an unknown container keeps its wrapper when every descendant is static saved HTML", () => {
	it("ONE wrapper carries its uagb-block class and every child's text appears exactly once", () => {
		const out = gutenbergToPortableText(
			container(heading("Section title") + paragraph("Body text")),
		);
		const html = htmlOf(out);
		expect(html, "the builder's class survives — it is the whole point").toContain(
			"uagb-block-a11f6d7d",
		);
		expect(
			html.match(/uagb-block-a11f6d7d/g),
			"exactly one wrapper, not one per child",
		).toHaveLength(1);
		// The text must appear ONCE. A copy of innerHTML instead of an assembly would duplicate it.
		expect(html.match(/Section title/g)).toHaveLength(1);
		expect(html.match(/Body text/g)).toHaveLength(1);
		// and it must be INSIDE the wrapper, not beside it
		expect(html).toMatch(
			/<div class="wp-block-uagb-container[^"]*">[\s\S]*Section title[\s\S]*Body text[\s\S]*<\/div>/,
		);
	});

	it("NESTED unknown containers both keep their wrappers, outer around inner", () => {
		const inner = container(heading("Inner"), "11111111");
		const out = gutenbergToPortableText(container(inner, "22222222"));
		const html = htmlOf(out);
		expect(html).toContain("uagb-block-22222222");
		expect(html).toContain("uagb-block-11111111");
		expect(html.indexOf("22222222"), "outer opens first").toBeLessThan(html.indexOf("11111111"));
		expect(html).toContain("Inner");
	});

	it("a KNOWN core block inside the container appears exactly once and is not double-counted", () => {
		const out = gutenbergToPortableText(container(heading("Only once")));
		const html = htmlOf(out);
		expect(html.match(/Only once/g)).toHaveLength(1);
	});

	it("A SHORTCODE descendant keeps today's flattening and is counted as flat", () => {
		// A shortcode's output is generated at render; keeping the saved markup would show `[gallery]` as prose.
		const events: Array<{ blockName: string | null; outcome: string }> = [];
		const out = gutenbergToPortableText(
			container(`<!-- wp:shortcode -->
[gallery ids="1,2"]
<!-- /wp:shortcode -->${paragraph("After")}`),
			{ onContainer: (e) => events.push(e) },
		);
		const html = htmlOf(out);
		expect(html, "no wrapper kept for a section holding a shortcode").not.toContain("uagb-block-");
		expect(
			events.some((e) => e.outcome === "flat"),
			"reported flat so the import can name it",
		).toBe(true);
	});

	it("163d: a no-saved-markup descendant (twpe 3x uagb/icon inside a uagb/container grid) keeps the wrapper and names the 3 dropped blocks", () => {
		// Flat or kept, a descendant that saves no markup is lost either way — so keeping the enclosing
		// wrapper is strictly better, while counting and naming every dropped no-markup block for the report.
		const events: Array<{
			blockName: string | null;
			outcome: "kept" | "flat";
			droppedNoMarkup?: string[];
		}> = [];
		const card = (hash: string, iconId: string, quote: string) =>
			container(
				`<!-- wp:uagb/icon {"icon":"quote-left","block_id":"${iconId}"} /-->${paragraph(quote)}`,
				hash,
				`{"block_id":"${hash}"}`,
			);
		const grid = container(
			card("11111111", "d7de978c", "First testimonial") +
				card("22222222", "fee179dd", "Second testimonial") +
				card("33333333", "495a3e5f", "Third testimonial"),
			"grid0001",
			'{"block_id":"grid0001"}',
		);
		const out = gutenbergToPortableText(grid, { onContainer: (e) => events.push(e) });
		const html = htmlOf(out);
		expect(html, "outer grid wrapper kept").toContain("uagb-block-grid0001");
		expect(html, "all three nested testimonial cards kept").toContain("uagb-block-11111111");
		expect(html).toContain("uagb-block-22222222");
		expect(html).toContain("uagb-block-33333333");
		expect(html.match(/First testimonial/g)).toHaveLength(1);
		expect(html.match(/Second testimonial/g)).toHaveLength(1);
		expect(html.match(/Third testimonial/g)).toHaveLength(1);
		expect(events).toEqual([
			{
				blockName: "uagb/container",
				outcome: "kept",
				droppedNoMarkup: ["uagb/icon", "uagb/icon", "uagb/icon"],
			},
		]);
		const lines = containerReportLines(keptContainersIn(out), 0, [
			{ blockName: "uagb/icon", count: 3 },
		]);
		expect(lines).toContain("3 uagb/icon blocks have no saved markup and were not carried");
	});

	it("163d: a DYNAMIC CORE block descendant (e.g. core/latest-posts) still flattens the container", () => {
		const events: Array<{ blockName: string | null; outcome: "kept" | "flat" }> = [];
		const out = gutenbergToPortableText(
			container(`<!-- wp:latest-posts {"postsToShow":3} /-->${paragraph("After")}`, "dyn00001"),
			{ onContainer: (e) => events.push(e) },
		);
		expect(htmlOf(out), "no wrapper kept for dynamic core block").not.toContain("uagb-block-");
		expect(events).toEqual([{ blockName: "uagb/container", outcome: "flat" }]);
	});

	it("a site with NO unknown containers is unchanged: the report is empty", () => {
		const events: Array<{ blockName: string | null; outcome: string }> = [];
		const out = gutenbergToPortableText(paragraph("Just a paragraph") + heading("And a heading"), {
			onContainer: (e) => events.push(e),
		});
		expect(htmlOf(out), "no htmlBlock at all").toBe("");
		expect(events, "nothing to report").toHaveLength(0);
	});

	it("HOSTILE classes are still removed by the existing sanitiser on the render path", () => {
		// The transformer emits the source's own tag; the sanitiser is what makes that safe, so this arm
		// pins that a script-bearing attribute never survives the converter's own output.
		const out = gutenbergToPortableText(
			container(heading("x"), "aaaa1111", '{"block_id":"aaaa1111","onclick":"alert(1)"}'),
		);
		const html = htmlOf(out);
		expect(html).toContain("uagb-block-aaaa1111");
		expect(
			html,
			"an onclick attribute from attrs must not be printed into the markup",
		).not.toContain("onclick=");
	});
});

describe("163c: the counts the operator sees, from the converter the import actually calls", () => {
	it("an import of a page with one KEPT and one FLAT container reports {kept:1, flat:1}", () => {
		// This is the report the lead asked for: the two numbers the operator reads, derived from the same sink the
		// WXR source uses to fill NormalizedItem.containers. One kept (static descendants), one flat (a shortcode).
		const events: Array<{ blockName: string | null; outcome: "kept" | "flat" }> = [];
		gutenbergToPortableText(
			`${container(heading("Kept section"))}
${container(
	`<!-- wp:shortcode -->
[gallery ids="9"]
<!-- /wp:shortcode -->`,
	"bbbb2222",
)}`,
			{ onContainer: (e) => events.push(e) },
		);
		expect(
			events.filter((e) => e.outcome === "kept"),
			"one section kept its layout",
		).toHaveLength(1);
		expect(
			events.filter((e) => e.outcome === "flat"),
			"one was flattened",
		).toHaveLength(1);
		// and the counts group by plugin, which is what the report line names
		const kept = keptContainersIn(
			gutenbergToPortableText(container(heading("Only kept")), { onContainer: () => {} }),
		);
		expect(kept).toEqual([{ plugin: "uagb/container", count: 1 }]);
	});
});
