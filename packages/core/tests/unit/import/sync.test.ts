import { describe, expect, it } from "vitest";

import {
	hashImportSyncRequest,
	importSyncRequestSchema,
	type ImportSyncRequest,
} from "../../../src/import/sync.js";

const request: ImportSyncRequest = {
	version: 1,
	operationId: "receipt-1",
	source: { site: "https://source.example", type: "page", id: "42" },
	collection: "pages",
	locale: "en",
	sequence: 1,
	slug: "home",
	data: { title: "Home", content: [] },
};

describe("import sync request identity", () => {
	it("rejects partial update evidence and unknown authority fields", () => {
		expect(importSyncRequestSchema.safeParse({ ...request, entryId: "entry" }).success).toBe(false);
		expect(importSyncRequestSchema.safeParse({ ...request, expectedVersion: 1 }).success).toBe(
			false,
		);
		expect(importSyncRequestSchema.safeParse({ ...request, authorId: "forged" }).success).toBe(
			false,
		);
		expect(importSyncRequestSchema.safeParse({ ...request, sequence: 0 }).success).toBe(false);
		expect(importSyncRequestSchema.safeParse({ ...request, version: 2 }).success).toBe(false);
	});

	it("hashes the whole accepted request and actor, independent of object key order", async () => {
		const original = await hashImportSyncRequest(request, "importer");
		expect(original).toMatch(/^[a-f0-9]{64}$/);
		expect(
			await hashImportSyncRequest({ ...request, data: { content: [], title: "Home" } }, "importer"),
		).toBe(original);
		for (const changed of [
			{ ...request, sequence: 2 },
			{ ...request, locale: "fr" },
			{ ...request, source: { ...request.source, id: "43" } },
			{ ...request, entryId: "entry", expectedVersion: 1 },
			{ ...request, data: { title: "Changed" } },
		]) {
			expect(await hashImportSyncRequest(changed, "importer")).not.toBe(original);
		}
		expect(await hashImportSyncRequest(request, "other-importer")).not.toBe(original);
	});
});
