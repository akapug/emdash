import { describe, expect, it } from "vitest";

import { sanitizeContent } from "../../../src/utils/sanitize.js";

// An HTML block (a custom HTML block, a block the converter does not know) is
// drawn through sanitizeContent. What the browser never draws on a page that
// runs scripts, it draws nothing of.
describe("sanitizeContent: what a page that runs scripts never draws", () => {
	it("draws nothing of a stylesheet, a script or a scripts-off fallback", () => {
		expect(
			sanitizeContent(
				`<style>.x{color:red}</style><p>Before.</p><script>track()</script><noscript>Turn on JavaScript to see the form.</noscript><p>After.</p>`,
			),
		).toBe("<p>Before.</p><p>After.</p>");
	});

	it("loads no image a scripts-off fallback holds, and keeps what follows it", () => {
		expect(
			sanitizeContent(
				`<div><noscript><img height="1" width="1" src="https://example.org/pixel.gif?id=1" /><noscript>inner</noscript></noscript>Seen.</div>`,
			),
		).toBe("<div>Seen.</div>");
	});
});
