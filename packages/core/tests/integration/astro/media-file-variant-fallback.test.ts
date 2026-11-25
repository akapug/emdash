import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/file/[...key].js";
import { MediaVariantRepository } from "../../../src/database/repositories/media-variants.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashStorageError, type DownloadResult } from "../../../src/storage/types.js";
import { MEDIA_VARIANT_STORAGE_PREFIX } from "../../../src/transfer/staging/keys.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ORIGINAL_KEY = "photos/test.jpg";
const VARIANT_KEY = `${MEDIA_VARIANT_STORAGE_PREFIX}test.webp`;
const ORIGINAL_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const VARIANT_BYTES = new Uint8Array([6, 7, 8]);

let db: Kysely<Database>;

beforeEach(async () => {
	db = await setupTestDatabase();
	const parent = await new MediaRepository(db).create({
		filename: "test.jpg",
		mimeType: "image/jpeg",
		storageKey: ORIGINAL_KEY,
		size: ORIGINAL_BYTES.byteLength,
		contentHash: "parent-hash",
		status: "ready",
	});
	const variants = new MediaVariantRepository(db);
	await variants.registerCandidate(VARIANT_KEY);
	const stored = await variants.store({
		mediaId: parent.id,
		sizeName: "medium",
		width: 300,
		height: 200,
		storageKey: VARIANT_KEY,
		bytes: VARIANT_BYTES.byteLength,
		contentHash: "variant-hash",
		parentContentHash: "parent-hash",
	});
	expect(stored.outcome).toBe("stored");
});

afterEach(async () => {
	await teardownTestDatabase(db);
});

function storageObject(bytes: Uint8Array<ArrayBuffer>, contentType: string): DownloadResult {
	return { body: new Blob([bytes]).stream(), contentType, size: bytes.byteLength };
}

function requestFile({
	key = ORIGINAL_KEY,
	width = "300",
	original = storageObject(ORIGINAL_BYTES, "application/pdf"),
	variant = storageObject(VARIANT_BYTES, "image/webp"),
}: {
	key?: string;
	width?: string;
	original?: DownloadResult | Error;
	variant?: DownloadResult | Error;
} = {}) {
	const objects = new Map([
		[ORIGINAL_KEY, original],
		[VARIANT_KEY, variant],
	]);
	const download = vi.fn(async (storageKey: string) => {
		const result = objects.get(storageKey);
		if (!result) throw new Error(`Unexpected download: ${storageKey}`);
		if (result instanceof Error) throw result;
		return result;
	});
	const url = new URL(`https://site.test/_emdash/api/media/file/${key}`);
	if (width) url.searchParams.set("w", width);
	const response = GET({
		params: { key },
		url,
		locals: { emdash: { db, storage: { download } } },
	} as unknown as Parameters<typeof GET>[0]);
	return { download, response };
}

function missingObject(): EmDashStorageError {
	return new EmDashStorageError("Object absent", "NOT_FOUND");
}

describe("public media file downloads", () => {
	it.each([
		{ label: "typed storage miss", original: missingObject() },
		{ label: "legacy file-not-found error", original: new Error("File not found") },
	])("returns the ordinary 404 for a $label", async ({ original }) => {
		const { response, download } = requestFile({ width: "", original });
		const result = await response;
		expect(result.status).toBe(404);
		expect(await result.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
		expect(download.mock.calls).toEqual([[ORIGINAL_KEY]]);
	});

	it("serves the variant's bytes and storage metadata when it exists", async () => {
		const { response, download } = requestFile();
		const result = await response;
		expect(result.status).toBe(200);
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(VARIANT_BYTES);
		expect(result.headers.get("content-type")).toBe("image/webp");
		expect(result.headers.get("content-length")).toBe("3");
		expect(result.headers.get("content-disposition")).toBe("inline");
		expect(result.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(download.mock.calls).toEqual([[VARIANT_KEY]]);
	});

	it("serves the original's bytes and storage metadata after a variant miss", async () => {
		const { response, download } = requestFile({ variant: missingObject() });
		const result = await response;
		expect(result.status).toBe(200);
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(ORIGINAL_BYTES);
		expect(result.headers.get("content-type")).toBe("application/pdf");
		expect(result.headers.get("content-length")).toBe("5");
		expect(result.headers.get("content-disposition")).toBe("attachment");
		expect(result.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(download.mock.calls).toEqual([[VARIANT_KEY], [ORIGINAL_KEY]]);
	});

	it("returns 404 when both the variant and original are missing", async () => {
		const { response, download } = requestFile({
			variant: missingObject(),
			original: missingObject(),
		});
		const result = await response;
		expect(result.status).toBe(404);
		expect(await result.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
		expect(download.mock.calls).toEqual([[VARIANT_KEY], [ORIGINAL_KEY]]);
	});

	it.each([
		{
			label: "a coded failure with a misleading message",
			variant: new EmDashStorageError("File not found", "DOWNLOAD_FAILED"),
		},
		{ label: "an untyped file-not-found error", variant: new Error("File not found") },
		{ label: "an untyped upstream failure", variant: new Error("Upstream host not found") },
	])("does not fall back for $label", async ({ variant }) => {
		const { response, download } = requestFile({ variant });
		const result = await response;
		expect(result.status).toBe(500);
		expect(await result.json()).toMatchObject({ error: { code: "FILE_SERVE_ERROR" } });
		expect(download.mock.calls).toEqual([[VARIANT_KEY]]);
	});

	it("surfaces an original download failure after a variant miss", async () => {
		const { response, download } = requestFile({
			variant: missingObject(),
			original: new EmDashStorageError("File not found", "DOWNLOAD_FAILED"),
		});
		const result = await response;
		expect(result.status).toBe(500);
		expect(await result.json()).toMatchObject({ error: { code: "FILE_SERVE_ERROR" } });
		expect(download.mock.calls).toEqual([[VARIANT_KEY], [ORIGINAL_KEY]]);
	});

	it.each([VARIANT_KEY, encodeURIComponent(VARIANT_KEY)])(
		"returns 404 without a download for private key %s",
		async (key) => {
			const { response, download } = requestFile({ key });
			expect((await response).status).toBe(404);
			expect(download).not.toHaveBeenCalled();
		},
	);
});
