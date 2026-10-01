import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { getSiteSettingsWithDb, invalidateSiteSettingsCache } from "../../../src/settings/index.js";
import { sanitizeContent } from "../../../src/utils/sanitize.js";
import {
	IFRAME_HOSTS_SETTING_MARKER,
	siteIframeHosts,
} from "../../../src/utils/site-iframe-hosts.js";
import { setupTestDatabase } from "../../utils/test-db.js";

// A page EmDash's middleware set up carries the page-contribution methods.
const pageLocals = { emdash: { collectPageMetadata: () => [], collectPageFragments: () => [] } };
const page = new URL("https://www.acme.org/visit-us/");
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
			const hosts = await siteIframeHosts(mapBlock, pageLocals, page);
			expect(hosts).toEqual(["www.google.com"]);
			expect(sanitizeContent(mapBlock, { allowedIframeHostnames: hosts })).toContain(
				`<iframe src="https://www.google.com/maps/embed?pb=1"`,
			);
			// upper-case markup is an iframe too
			expect(await siteIframeHosts(mapBlock.toUpperCase(), pageLocals, page)).toEqual([
				"www.google.com",
			]);
		});
	});

	it("reads the list once per request, under the mark a host finds in the built bundle", async () => {
		// Embark's tenant tool looks for exactly this string in an artifact's dist/server.
		expect(IFRAME_HOSTS_SETTING_MARKER).toBe("emdash-iframe-hosts-setting-v1");
		await runWithContext({ editMode: false, db }, async () => {
			expect(await siteIframeHosts(mapBlock, pageLocals, page)).toEqual(["www.google.com"]);
			await db
				.updateTable("options")
				.set({ value: JSON.stringify(["calendly.com"]) })
				.where("name", "=", "site:iframeHosts")
				.execute();
			invalidateSiteSettingsCache();
			// the same request keeps the list it read
			expect(await siteIframeHosts(mapBlock, pageLocals, page)).toEqual(["www.google.com"]);
		});
		await runWithContext({ editMode: false, db }, async () => {
			expect(await siteIframeHosts(mapBlock, pageLocals, page)).toEqual(["calendly.com"]);
		});
	});

	it("reads nothing for HTML with no iframe, or off a page the middleware set up", async () => {
		await runWithContext({ editMode: false, db }, async () => {
			expect(await siteIframeHosts("<p>No frames here.</p>", pageLocals, page)).toBeUndefined();
			expect(await siteIframeHosts(mapBlock, {}, page)).toBeUndefined();
			expect(
				await siteIframeHosts(mapBlock, { emdash: { getPublicMediaUrl: () => "" } }, page),
			).toBeUndefined();
		});
	});

	it("never allows the site's own host, or a subdomain of it, whatever the setting says", async () => {
		await db
			.updateTable("options")
			.set({
				value: JSON.stringify([
					"www.google.com",
					"acme.org",
					"shop.acme.org",
					"www.acme.org",
					// mixed case is the same host
					"Shop.ACME.org",
					"CDN.Acme.Example.Net",
					// padded, upper-case or LF-ended rows (no schema stood in front of
					// this write) are read canonically, then excluded or kept
					" blog.acme.org ",
					"maps.acme.org\n",
					"BLOG.ACME.ORG",
					"WWW.GOOGLE.COM ",
					"*.acme.org",
					42,
					"evilacme.org",
					"acme.example.net",
					"cdn.acme.example.net",
				]),
			})
			.where("name", "=", "site:iframeHosts")
			.execute();
		await db
			.insertInto("options")
			.values({ name: "site:url", value: JSON.stringify("https://acme.example.net") })
			.execute();
		invalidateSiteSettingsCache();
		await runWithContext({ editMode: false, db }, async () => {
			// a domain matches only at a dot
			expect(await siteIframeHosts(mapBlock, pageLocals, page)).toEqual([
				"www.google.com",
				"evilacme.org",
			]);
		});
	});

	// A seeded options row matching the serialization Embark's tenant writer uses
	// (scripts/tenant/lib/iframe-hosts.mjs writeIframeHosts: JSON.stringify of the
	// canonical sorted hosts). It exercises this repository's settings reader and
	// sanitizer on that shape; it does not run the writer, which lives in another
	// repository and is proven on a real tenant.
	it("draws the maps and forms a seeded row in Embark's serialization names, and links the rest", async () => {
		const EMBARK_ROW = '["calendly.com","www.google.com"]';
		await db
			.updateTable("options")
			.set({ value: EMBARK_ROW })
			.where("name", "=", "site:iframeHosts")
			.execute();
		invalidateSiteSettingsCache();
		const body =
			`<iframe src="https://www.google.com/maps/embed?pb=1" width="600" height="450"></iframe>` +
			`<iframe src="https://calendly.com/acme/30min"></iframe>` +
			`<iframe src="http://calendly.com/acme/30min"></iframe>` +
			`<iframe src="https://forms.example.net/f"></iframe>` +
			`<iframe src="https://www.acme.org/contact"></iframe>`;
		await runWithContext({ editMode: false, db }, async () => {
			const hosts = await siteIframeHosts(body, pageLocals, page);
			expect(hosts).toEqual(["calendly.com", "www.google.com"]);
			expect(sanitizeContent(body, { allowedIframeHostnames: hosts })).toBe(
				`<iframe src="https://www.google.com/maps/embed?pb=1" width="600" height="450"></iframe>` +
					`<iframe src="https://calendly.com/acme/30min"></iframe>` +
					`<a href="http://calendly.com/acme/30min" class="emdash-iframe-link">Open the embedded content (calendly.com)</a>` +
					`<a href="https://forms.example.net/f" class="emdash-iframe-link">Open the embedded content (forms.example.net)</a>` +
					`<a href="https://www.acme.org/contact" class="emdash-iframe-link">Open the embedded content (www.acme.org)</a>`,
			);
		});
	});
});
