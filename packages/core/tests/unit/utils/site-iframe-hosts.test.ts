import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { getSiteSettingsWithDb, invalidateSiteSettingsCache } from "../../../src/settings/index.js";
import { sanitizeContent } from "../../../src/utils/sanitize.js";
import { siteIframeHosts } from "../../../src/utils/site-iframe-hosts.js";
import { setupTestDatabase } from "../../utils/test-db.js";

// A page EmDash's middleware set up carries the page-contribution methods.
const pageLocals = { emdash: { collectPageMetadata: () => [], collectPageFragments: () => [] } };
const mapBlock = `<iframe src="https://www.google.com/maps/embed?pb=1" width="600" height="450"></iframe>`;

describe("siteIframeHosts: the site's own iframe hosts at render", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		invalidateSiteSettingsCache();
		// the row as a host writes it straight into the options table
		await db
			.insertInto("options")
			.values({ name: "site:iframeHosts", value: JSON.stringify(["www.google.com"]) })
			.execute();
	});

	afterEach(() => invalidateSiteSettingsCache());

	it("reads the stored setting back as a list of hosts", async () => {
		expect((await getSiteSettingsWithDb(db)).iframeHosts).toEqual(["www.google.com"]);
	});

	it("passes the site's hosts to the sanitizer, so the map is drawn", async () => {
		await runWithContext({ editMode: false, db }, async () => {
			const hosts = await siteIframeHosts(mapBlock, pageLocals);
			expect(hosts).toEqual(["www.google.com"]);
			expect(sanitizeContent(mapBlock, { allowedIframeHostnames: hosts })).toContain(
				`<iframe src="https://www.google.com/maps/embed?pb=1"`,
			);
			// upper-case markup is an iframe too
			expect(await siteIframeHosts(mapBlock.toUpperCase(), pageLocals)).toEqual(["www.google.com"]);
		});
	});

	it("reads nothing for HTML with no iframe, or off a page the middleware set up", async () => {
		await runWithContext({ editMode: false, db }, async () => {
			expect(await siteIframeHosts("<p>No frames here.</p>", pageLocals)).toBeUndefined();
			expect(await siteIframeHosts(mapBlock, {})).toBeUndefined();
			expect(
				await siteIframeHosts(mapBlock, { emdash: { getPublicMediaUrl: () => "" } }),
			).toBeUndefined();
		});
	});
});
