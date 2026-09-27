/**
 * The forms plugin's optional stylesheet on a page in another design.
 *
 * A form drawn in a migrated WordPress site's own markup (the blog template's
 * WpShellForm) keeps `.ec-form-submit` on its submit control, for the
 * client, and takes that design's button: the button's own look holds only
 * inside EmDash's own form markup (`.ec-form`), where its variables are set.
 * And what the client hides stays hidden under a theme's rules for buttons.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../src/styles/forms.css", import.meta.url), "utf8").replace(
	/\/\*[\s\S]*?\*\//g,
	"",
);

/** Every rule's selector list, one selector each. */
const selectors = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap((m) =>
	m[1]!.split(",").map((s) => s.trim()),
);

describe("forms.css on a page in another design", () => {
	it("draws the submit and next buttons' own look only inside EmDash's own form", () => {
		const buttons = selectors.filter((s) => /\.ec-form-(submit|next)\b/.test(s));
		expect(buttons.length).toBeGreaterThan(0);
		for (const s of buttons) expect(s).toMatch(/^:where\(\.ec-form\) /);
	});

	it("keeps what the client hides hidden over a theme's display for buttons", () => {
		expect(css).toMatch(/\.ec-form \[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
	});
});
