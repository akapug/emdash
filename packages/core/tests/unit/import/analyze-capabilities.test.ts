import { describe, expect, it } from "vitest";

import { BATCH_REDIRECTS_CAPABILITY } from "../../../src/api/handlers/redirects.js";
import {
	EVENT_SEARCH_BAR_CAPABILITY,
	EVENT_SEARCH_BAR_PROBE,
	IMPORT_CAPABILITIES,
	importCapabilities,
	POST,
} from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import { mappedEmbedsSchema } from "../../../src/astro/routes/api/import/wordpress/mapped-embeds.js";
import { PROTECTED_CONTENT_CAPABILITY } from "../../../src/content/protection.js";

const MINIMAL_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Example</title><link>https://example.org</link></channel>
</rss>`;

describe("WordPress WXR analyze capabilities (Item 109)", () => {
	it("advertises event-search-bar iff execute's mappedEmbedsSchema accepts searchBar", async () => {
		const acceptsSearchBar = mappedEmbedsSchema.safeParse(EVENT_SEARCH_BAR_PROBE).success;
		const form = new FormData();
		form.set("file", new File([MINIMAL_WXR], "site.wxr", { type: "text/xml" }));
		const response = await POST({
			request: new Request("https://example.org/_emdash/api/import/wordpress/analyze", {
				method: "POST",
				body: form,
			}),
			locals: {
				emdash: {},
				user: { id: "admin", role: 100, scopes: ["admin"] },
			},
		} as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			data: { protectedContentCapability: string; capabilities: string[] };
		};
		expect(body.success).toBe(true);
		expect(body.data.protectedContentCapability).toBe(PROTECTED_CONTENT_CAPABILITY);
		expect(body.data.capabilities).toEqual([...IMPORT_CAPABILITIES]);
		expect(body.data.capabilities).toContain(PROTECTED_CONTENT_CAPABILITY);
		expect(body.data.capabilities.includes(EVENT_SEARCH_BAR_CAPABILITY)).toBe(acceptsSearchBar);
	});

	it("omits event-search-bar when the execute schema rejects searchBar and includes it when accepted", () => {
		const rejecting = { safeParse: () => ({ success: false }) };
		const accepting = { safeParse: () => ({ success: true }) };
		expect(importCapabilities(rejecting)).toEqual([
			PROTECTED_CONTENT_CAPABILITY,
			BATCH_REDIRECTS_CAPABILITY,
		]);
		expect(importCapabilities(accepting)).toEqual([
			PROTECTED_CONTENT_CAPABILITY,
			EVENT_SEARCH_BAR_CAPABILITY,
			BATCH_REDIRECTS_CAPABILITY,
		]);
	});
});
