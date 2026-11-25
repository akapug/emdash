import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "../../../src/astro/routes/api/media/file/[...key].js";
import { MediaVariantRepository } from "../../../src/database/repositories/media-variants.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import {
	EmDashStorageError,
	type DownloadResult,
	type Storage,
} from "../../../src/storage/types.js";
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
	headers,
	downloadRange,
}: {
	key?: string;
	width?: string;
	original?: DownloadResult | Error;
	variant?: DownloadResult | Error;
	headers?: HeadersInit;
	downloadRange?: Storage["downloadRange"];
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
		request: new Request(url, { headers }),
		locals: { emdash: { db, storage: { download, downloadRange } } },
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

	it.each([
		{ range: "bytes=0-99", spec: { start: 0, end: 99 }, start: 0, end: 99 },
		{ range: "bytes=99-102", spec: { start: 99, end: 102 }, start: 99, end: 102 },
		{ range: "bytes=-4", spec: { suffix: 4 }, start: 252, end: 255 },
		{ range: "bytes=253-", spec: { start: 253 }, start: 253, end: 255 },
	])("streams only $range of the original", async ({ range, spec, start, end }) => {
		const video = Uint8Array.from({ length: 256 }, (_, index) => index);
		const bytes = video.slice(start, end + 1);
		const downloadRange = vi.fn(async () => ({
			...storageObject(bytes, "video/quicktime"),
			kind: "partial" as const,
			size: video.byteLength,
			start,
			end,
		}));
		const { response, download } = requestFile({ width: "", headers: { range }, downloadRange });
		const result = await response;
		expect(result.status).toBe(206);
		expect(result.headers.get("accept-ranges")).toBe("bytes");
		expect(result.headers.get("content-range")).toBe(`bytes ${start}-${end}/256`);
		expect(result.headers.get("content-length")).toBe(String(bytes.length));
		expect(result.headers.get("content-type")).toBe("video/quicktime");
		expect(result.headers.get("content-disposition")).toBe("attachment");
		expect(result.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(result.headers.get("x-content-type-options")).toBe("nosniff");
		expect(result.headers.get("content-security-policy")).toMatch(/^sandbox;/);
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(bytes);
		expect(downloadRange).toHaveBeenCalledExactlyOnceWith(ORIGINAL_KEY, spec);
		expect(download).not.toHaveBeenCalled();
	});

	it("ranges over a selected variant and not the original", async () => {
		const downloadRange = vi.fn(async () => ({
			...storageObject(VARIANT_BYTES.slice(1), "image/webp"),
			kind: "partial" as const,
			size: VARIANT_BYTES.length,
			start: 1,
			end: 2,
		}));
		const { response, download } = requestFile({ headers: { range: "bytes=1-" }, downloadRange });
		const result = await response;
		expect(result.status).toBe(206);
		expect(result.headers.get("content-range")).toBe("bytes 1-2/3");
		expect(result.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(VARIANT_BYTES.slice(1));
		expect(downloadRange).toHaveBeenCalledExactlyOnceWith(VARIANT_KEY, { start: 1 });
		expect(download).not.toHaveBeenCalled();
	});

	it("answers 416 against the selected variant even if the original is larger", async () => {
		const downloadRange = vi.fn(async () => ({ kind: "unsatisfiable" as const, size: 3 }));
		const { response, download } = requestFile({ headers: { range: "bytes=4-" }, downloadRange });
		const result = await response;
		expect(result.status).toBe(416);
		expect(result.headers.get("accept-ranges")).toBe("bytes");
		expect(result.headers.get("content-range")).toBe("bytes */3");
		expect(await result.text()).toBe("");
		expect(downloadRange).toHaveBeenCalledExactlyOnceWith(VARIANT_KEY, { start: 4 });
		expect(download).not.toHaveBeenCalled();
	});

	it("reapplies the requested range to the original after a typed variant miss", async () => {
		const downloadRange = vi.fn(async (key: string) => {
			if (key === VARIANT_KEY) throw missingObject();
			return {
				...storageObject(ORIGINAL_BYTES.slice(-2), "application/pdf"),
				kind: "partial" as const,
				size: ORIGINAL_BYTES.length,
				start: 3,
				end: 4,
			};
		});
		const { response, download } = requestFile({ headers: { range: "bytes=-2" }, downloadRange });
		const result = await response;
		expect(result.status).toBe(206);
		expect(result.headers.get("content-range")).toBe("bytes 3-4/5");
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(ORIGINAL_BYTES.slice(-2));
		expect(downloadRange.mock.calls).toEqual([
			[VARIANT_KEY, { suffix: 2 }],
			[ORIGINAL_KEY, { suffix: 2 }],
		]);
		expect(download).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "no range", headers: new Headers() },
		{ label: "an unsupported range unit", headers: new Headers({ range: "items=1-2" }) },
		{ label: "multiple ranges", headers: new Headers({ range: "bytes=0-0,2-2" }) },
		{
			label: "an unverified If-Range validator",
			headers: new Headers({ range: "bytes=0-1", "if-range": '"old"' }),
		},
	])("returns the full object for $label", async ({ headers }) => {
		const downloadRange = vi.fn();
		const { response, download } = requestFile({ headers, downloadRange });
		const result = await response;
		expect(result.status).toBe(200);
		expect(result.headers.get("accept-ranges")).toBe("bytes");
		expect(result.headers.get("content-range")).toBeNull();
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(VARIANT_BYTES);
		expect(downloadRange).not.toHaveBeenCalled();
		expect(download).toHaveBeenCalledExactlyOnceWith(VARIANT_KEY);
	});

	it("keeps third-party adapters that only support full downloads working", async () => {
		const result = await requestFile({ headers: { range: "bytes=0-1" } }).response;
		expect(result.status).toBe(200);
		expect(result.headers.get("accept-ranges")).toBeNull();
		expect(new Uint8Array(await result.arrayBuffer())).toEqual(VARIANT_BYTES);
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
