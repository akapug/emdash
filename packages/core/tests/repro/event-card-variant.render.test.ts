import { readFileSync } from "node:fs";

/**
 * The EVENT CARD emits the ladder, because it renders through EmDashImage.
 *
 * The lead measured the card at 33% of one real home page's image bytes. The card is a
 * template component (`EventList.astro` -> `EventCover.astro`), and EventCover renders
 * `Image` from `emdash/ui`, which IS `EmDashImage` (ui.ts:57). So the card inherits the
 * same read: no variant means no srcset, committed variants mean the ladder.
 *
 * This arm proves the INHERITANCE rather than assuming it, because that is the part a
 * later refactor could quietly break: if EventCover ever stops going through
 * EmDashImage, covers and cards silently lose the ladder with every other arm green.
 */
import { describe, expect, it } from "vitest";

/** The template's card component, read as source: this arm runs in core's suite. */
const EVENT_COVER = new URL(
	"../../../../templates/blog-cloudflare/src/components/EventCover.astro",
	import.meta.url,
);

describe("the event card renders through the component that owns the ladder", () => {
	it("draws through emdash/ui's Image, which is EmDashImage", () => {
		const source = readFileSync(EVENT_COVER, "utf8");
		expect(source, "the card must import Image from emdash/ui").toMatch(
			/import\s*\{\s*Image\s*\}\s*from\s*"emdash\/ui"/,
		);
		expect(source, "and draw it").toMatch(/<Image\b/);
	});

	it("does not draw its own <img>, which would bypass the ladder entirely", () => {
		const source = readFileSync(EVENT_COVER, "utf8");
		const ownImg = /<img\b/.test(source);
		expect(
			ownImg,
			"a raw <img> here would render the original at every width — the exact defect covers had",
		).toBe(false);
	});
});
