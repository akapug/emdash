// AN EVENTS COLLECTION IS SERVED AT /events/{slug}, WHATEVER PLUGIN WROTE IT.
//
// `prepare` gave the `/events/{slug}` urlPattern to `mec-events` only, so The
// Events Calendar's `tribe_events` collection got NONE — and the template's
// `loadEvent` (utils/event-data.ts, `getCollectionByUrlPattern`) never found it,
// so every imported event 404'd.
//
// MEASURED 2026-11-20 on a real second-site rehearsal: 75 `tribe_events`
// imported, ALL of them 404 at /event/<slug>/, /events/<slug>/ and
// /tribe_events/<slug>/. The census caught 73 of its 79 failures.
//
// The host mirrors this list (`packages/host/src/import/plan.ts`,
// `NATIVELY_CARRIED`); the two change together.
import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as prepare } from "../../../src/astro/routes/api/import/wordpress/prepare.js";
import type { EmDashHandlers } from "../../../src/astro/types.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const fields = [
	{ slug: "title", label: "Title", type: "string", required: true },
	{ slug: "start_date", label: "Start date", type: "string", required: true },
];

describe("an events collection's url pattern", () => {
	let db: Kysely<Database>;
	let emdash: EmDashHandlers;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabase();
		registry = new SchemaRegistry(db);
		emdash = handlersFromRuntime(createTestRuntime(db));
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function prepareType(name: string, collection: string) {
		const request = new Request("http://localhost/_emdash/api/import/wordpress/prepare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ postTypes: [{ name, collection, fields }] }),
		});
		const response = await prepare({
			request,
			locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
		} as Parameters<typeof prepare>[0]);
		expect(response.status).toBe(200);
		return registry.getCollection(collection);
	}

	it("gives tribe_events the /events/{slug} pattern", async () => {
		const collection = await prepareType("tribe_events", "tribe_events");
		expect(collection?.urlPattern, "a TEC event collection with no pattern 404s every event").toBe("/events/{slug}");
	});

	it("still gives mec-events the same pattern", async () => {
		const collection = await prepareType("mec-events", "mec_events");
		expect(collection?.urlPattern).toBe("/events/{slug}");
	});

	it("NEGATIVE CONTROL: an ordinary post type gets no events pattern", async () => {
		const collection = await prepareType("post", "posts");
		expect(collection?.urlPattern).not.toBe("/events/{slug}");
	});

	it("an EXISTING different pattern stays an error, for tribe_events too", async () => {
		// The conflict branch: a collection that already has its own pattern is not
		// silently overwritten. It was `isMecEvent`-gated, so a TEC collection with
		// a conflicting pattern was left alone with no error at all.
		await registry.createCollection({ slug: "tribe_events", label: "Events", labelSingular: "Event", supports: [], urlPattern: "/calendar/{slug}" });
		const request = new Request("http://localhost/_emdash/api/import/wordpress/prepare", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ postTypes: [{ name: "tribe_events", collection: "tribe_events", fields }] }),
		});
		const response = await prepare({
			request,
			locals: { emdash, user: { id: "operator", role: Role.ADMIN } },
		} as Parameters<typeof prepare>[0]);
		const body = (await response.json()) as { data?: { errors?: Array<{ error: string }> } };
		expect(JSON.stringify(body)).toMatch(/conflicts with/);
	});
});
