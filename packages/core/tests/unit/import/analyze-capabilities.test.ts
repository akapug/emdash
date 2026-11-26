import { describe, expect, it } from "vitest";

import { BATCH_REDIRECTS_CAPABILITY } from "../../../src/api/handlers/redirects.js";
import {
	EVENT_DETAIL_FIELDS_CAPABILITY,
	EVENT_OPTIONAL_START_DATE_CAPABILITY,
	EVENT_SEARCH_BAR_CAPABILITY,
	EVENT_SEARCH_BAR_PROBE,
	IMPORT_CAPABILITIES,
	importCapabilities,
	MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY,
	MEDIA_VARIANTS_CAPABILITY,
	MEDIA_VARIANTS_WEBP_FOR_PNG_CAPABILITY,
	POST,
	WXR_ATOMIC_IMPORT_CAPABILITY,
} from "../../../src/astro/routes/api/import/wordpress/analyze.js";
import { mappedEmbedsSchema } from "../../../src/astro/routes/api/import/wordpress/mapped-embeds.js";
import { PROTECTED_CONTENT_CAPABILITY } from "../../../src/content/protection.js";
import { VARIANT_LADDER } from "../../../src/media/variants.js";

const MINIMAL_WXR = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
<channel><title>Example</title><link>https://example.org</link></channel>
</rss>`;

describe("WordPress WXR analyze capabilities (Item 109)", () => {
	it("advertises the upload widths and supported import capabilities", async () => {
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
			data: {
				protectedContentCapability: string;
				capabilities: string[];
				mediaVariantWidths?: number[];
			};
		};
		expect(body.success).toBe(true);
		expect(body.data.protectedContentCapability).toBe(PROTECTED_CONTENT_CAPABILITY);
		expect(body.data.capabilities).toEqual([
			...importCapabilities(mappedEmbedsSchema, { atomicSupported: false }),
		]);
		expect(body.data.capabilities).toContain(PROTECTED_CONTENT_CAPABILITY);
		expect(body.data.capabilities).toContain(MEDIA_VARIANTS_CAPABILITY);
		expect(body.data.capabilities).toContain(MEDIA_VARIANTS_WEBP_FOR_PNG_CAPABILITY);
		expect(body.data.capabilities).not.toContain(WXR_ATOMIC_IMPORT_CAPABILITY);
		expect(body.data.mediaVariantWidths).toEqual([300, 480, 768, 1024, 1536, 2048]);
		expect(body.data.mediaVariantWidths).toEqual(VARIANT_LADDER);
		expect(body.data.capabilities.includes(EVENT_SEARCH_BAR_CAPABILITY)).toBe(acceptsSearchBar);
	});

	it("omits event-search-bar when the execute schema rejects searchBar and includes it when accepted", () => {
		const rejecting = { safeParse: () => ({ success: false }) };
		const accepting = { safeParse: () => ({ success: true }) };
		expect(importCapabilities(rejecting)).toEqual([
			PROTECTED_CONTENT_CAPABILITY,
			EVENT_OPTIONAL_START_DATE_CAPABILITY,
			BATCH_REDIRECTS_CAPABILITY,
			MEDIA_VARIANTS_CAPABILITY,
			MEDIA_VARIANTS_WEBP_FOR_PNG_CAPABILITY,
			MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY,
			WXR_ATOMIC_IMPORT_CAPABILITY,
		]);
		expect(importCapabilities(rejecting, { atomicSupported: false })).toEqual([
			PROTECTED_CONTENT_CAPABILITY,
			EVENT_OPTIONAL_START_DATE_CAPABILITY,
			BATCH_REDIRECTS_CAPABILITY,
			MEDIA_VARIANTS_CAPABILITY,
			MEDIA_VARIANTS_WEBP_FOR_PNG_CAPABILITY,
			// 161: this build stores a variant at any width in range, so a host may send WordPress's own numbers.
			MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY,
		]);
		expect(importCapabilities(accepting)).toEqual([
			PROTECTED_CONTENT_CAPABILITY,
			EVENT_SEARCH_BAR_CAPABILITY,
			EVENT_DETAIL_FIELDS_CAPABILITY,
			EVENT_OPTIONAL_START_DATE_CAPABILITY,
			BATCH_REDIRECTS_CAPABILITY,
			MEDIA_VARIANTS_CAPABILITY,
			MEDIA_VARIANTS_WEBP_FOR_PNG_CAPABILITY,
			MEDIA_VARIANTS_ANY_WIDTH_CAPABILITY,
			WXR_ATOMIC_IMPORT_CAPABILITY,
		]);
	});

	it("ADVERTISES media-variants, so the host can ask before it sends a size", () => {
		// The lead's grep found only the DEFINITION, because the route returns the
		// CONSTANT rather than the literal — `capabilities: [...IMPORT_CAPABILITIES]` —
		// so grepping the route for "media-variants.v1" can never succeed.
		//
		// This asserts the constant the route spreads, which is the same fact without
		// constructing the route: building the route pulls schema/registry, whose module
		// graph needs @emdash-cms/registry-lexicons' generated dist, and that codegen
		// does not run in this environment. Asserting through the constant keeps the
		// check honest — if the capability leaves the list, the route stops advertising
		// it and this fails.
		expect(IMPORT_CAPABILITIES).toContain(MEDIA_VARIANTS_CAPABILITY);
		expect(IMPORT_CAPABILITIES).toContain(MEDIA_VARIANTS_WEBP_FOR_PNG_CAPABILITY);
	});
});
