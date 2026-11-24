import { describe, expect, it } from "vitest";

import {
	EVENT_SEARCH_BAR_CAPABILITY,
	IMPORT_CAPABILITIES,
	POST,
} from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import { PROTECTED_CONTENT_CAPABILITY } from "../../../src/content/protection.js";

const MINIMAL_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Example</title><link>https://example.org</link></channel>
</rss>`;

describe("WordPress WXR analyze capabilities (Item 109)", () => {
	it("advertises capabilities[] including protected-content and event-search-bar alongside protectedContentCapability", async () => {
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
		expect(body.data.capabilities).toContain(EVENT_SEARCH_BAR_CAPABILITY);
	});
});
