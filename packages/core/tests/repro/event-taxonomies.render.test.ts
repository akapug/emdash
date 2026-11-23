import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

import EventArticle from "../../../../templates/blog-cloudflare/src/components/EventArticle.astro";
import {
	eventSummary,
	eventTermLabels,
	parseEventView,
	selectEventView,
} from "../../../../templates/blog-cloudflare/src/utils/events.js";

async function emdashReads() {
	return {
		getSiteSettingsWithCacheHint: async () => ({
			data: { title: "Example", timezone: "America/New_York" },
			cacheHint: { tags: ["settings"] },
		}),
	};
}
vi.mock("emdash", emdashReads);
vi.mock("../../dist/index.mjs", emdashReads);

const now = new Date("2026-11-23T12:00:00Z");

describe("MEC event taxonomies rendering and filtering (emb/106)", () => {
	it("draws all assigned mec_category, mec_organizer, and mec_location terms without duplicating the primary field", async () => {
		const entry = {
			id: "salsa-night",
			data: {
				id: "ID-salsa",
				status: "published",
				title: "Salsa Night",
				locale: "en-US",
				start_date: "2026-12-01",
				category: "Classes",
				organizer: "Community Studio",
				location: "Main Hall",
				terms: {
					mec_category: [
						{ id: "c1", name: "mec_category", slug: "classes", label: "Classes", children: [] },
						{ id: "c2", name: "mec_category", slug: "retreats", label: "Retreats", children: [] },
					],
					mec_organizer: [
						{ id: "o1", name: "mec_organizer", slug: "community-studio", label: "Community Studio", children: [] },
						{ id: "o2", name: "mec_organizer", slug: "alice-rivera", label: "Alice Rivera", children: [] },
					],
					mec_location: [
						{ id: "l1", name: "mec_location", slug: "main-hall", label: "Main Hall", children: [] },
						{ id: "l2", name: "mec_location", slug: "barn-stage", label: "Barn Stage", children: [] },
					],
				},
			},
			edit: { title: {}, content: {} },
		};

		expect(eventTermLabels(entry, "category")).toEqual(["Classes", "Retreats"]);
		expect(eventTermLabels(entry, "organizer")).toEqual(["Community Studio", "Alice Rivera"]);
		expect(eventTermLabels(entry, "location")).toEqual(["Main Hall", "Barn Stage"]);

		const container = await AstroContainer.create();
		const html = await container.renderToString(EventArticle, {
			props: { entry, now },
			request: new Request("https://example.org/events/salsa-night/"),
		});
		expect(html).toContain("Location: Main Hall, Barn Stage");
		expect(html).toContain("Organizer: Community Studio, Alice Rivera");
		expect(html).toContain("Category: Classes, Retreats");
		// No unasked-for taxonomy archive links
		expect(html).not.toContain("/events/category/");
		expect(html).not.toContain("/events/organizer/");
	});

	it("matches saved-view filters against secondary mec_category, mec_organizer, and mec_location terms", () => {
		const entry = {
			id: "retreat-class",
			data: {
				id: "ID-rc",
				status: "published",
				title: "Retreat Class",
				locale: "en-US",
				start_date: "2026-12-05",
				category: "Classes",
				terms: {
					mec_category: [
						{ id: "c1", name: "mec_category", slug: "classes", label: "Classes", children: [] },
						{ id: "c2", name: "mec_category", slug: "retreats", label: "Retreats", children: [] },
					],
				},
			},
		};
		const summary = eventSummary(entry, now)!;
		const view = parseEventView({
			version: 1,
			viewSlug: "retreats",
			mode: "upcoming",
			order: "asc",
			layout: "list",
			start: "today",
			filters: { category: ["Retreats"] },
		})!;
		expect(selectEventView([summary], view, now).map((e) => e.entry.id)).toEqual(["retreat-class"]);
	});
});
