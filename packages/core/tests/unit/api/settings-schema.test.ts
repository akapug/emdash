import { describe, expect, it } from "vitest";

import { settingsUpdateBody, siteSettingsSchema } from "../../../src/api/schemas/settings.js";

describe("settings schemas", () => {
	it("accepts null media references as deletion requests", () => {
		expect(
			settingsUpdateBody.parse({
				logo: null,
				favicon: null,
				seo: { defaultOgImage: null },
			}),
		).toEqual({ logo: null, favicon: null, seo: { defaultOgImage: null } });
	});

	it("does not expose deletion sentinels in settings responses", () => {
		expect(siteSettingsSchema.safeParse({ logo: null }).success).toBe(false);
		expect(siteSettingsSchema.safeParse({ favicon: null }).success).toBe(false);
		expect(siteSettingsSchema.safeParse({ seo: { defaultOgImage: null } }).success).toBe(false);
	});

	it("takes the site's iframe hosts as exact lowercase hostnames only", () => {
		const hosts = [
			"www.google.com",
			"calendly.com",
			"forms.xn--80ak6aa92e.com",
			"xn--p1ai.xn--p1ai",
			"evilembarkeasy.com",
		];
		expect(settingsUpdateBody.parse({ iframeHosts: hosts })).toEqual({ iframeHosts: hosts });
		expect(settingsUpdateBody.parse({ iframeHosts: [] })).toEqual({ iframeHosts: [] });
		for (const bad of [
			"*.google.com",
			".google.com",
			"https://www.google.com",
			"//www.google.com",
			"www.google.com:443",
			"www.google.com/maps",
			"user@www.google.com",
			"Www.google.com",
			"www.google.com.",
			"www..google.com",
			"-www.google.com",
			"localhost",
			"1.2.3.4",
			"[::1]",
			" www.google.com",
			"",
			// shared platforms and our own: never a host a site adds
			"workers.dev",
			"acme.workers.dev",
			"acme.pages.dev",
			"embarkeasy.com",
			"acme.embarkeasy.com",
		]) {
			expect(settingsUpdateBody.safeParse({ iframeHosts: [bad] }).success, bad).toBe(false);
		}
		expect(settingsUpdateBody.safeParse({ iframeHosts: "www.google.com" }).success).toBe(false);
		const tooMany = Array.from({ length: 101 }, (_, i) => `h${i}.example.com`);
		expect(settingsUpdateBody.safeParse({ iframeHosts: tooMany }).success).toBe(false);
		expect(siteSettingsSchema.parse({ iframeHosts: ["www.google.com"] })).toEqual({
			iframeHosts: ["www.google.com"],
		});
	});
});
