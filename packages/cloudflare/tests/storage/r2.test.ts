import { EmDashStorageError } from "emdash";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { R2Storage } from "../../src/storage/r2.js";

describe("R2Storage same-key upload", () => {
	it("replaces the object bytes without changing the key", async () => {
		const objects = new Map<string, Uint8Array>();
		const cacheControls: string[] = [];
		const bucket = {
			async put(key: string, body: Uint8Array, options: R2PutOptions) {
				objects.set(key, body);
				const metadata = options.httpMetadata;
				cacheControls.push(
					metadata instanceof Headers
						? (metadata.get("Cache-Control") ?? "")
						: (metadata?.cacheControl ?? ""),
				);
				return { size: body.byteLength };
			},
		} as unknown as R2Bucket;
		const storage = new R2Storage(bucket);

		await storage.upload({
			key: "hero.png",
			body: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
			cacheControl: "public, max-age=0, must-revalidate",
		});
		await storage.upload({
			key: "hero.png",
			body: new Uint8Array([9, 8]),
			contentType: "image/png",
			cacheControl: "public, max-age=0, must-revalidate",
		});

		expect(objects.get("hero.png")).toEqual(new Uint8Array([9, 8]));
		expect(cacheControls).toEqual([
			"public, max-age=0, must-revalidate",
			"public, max-age=0, must-revalidate",
		]);
	});
});

describe("R2Storage reads", () => {
	const key = "clip.webm";
	const metadata = { size: 6, etag: "raw-etag", httpEtag: '"raw-etag"' };

	function setup() {
		const head = vi.fn().mockResolvedValue(metadata);
		const get = vi.fn();
		const storage = new R2Storage({ head, get } as unknown as R2Bucket);
		return { storage, head, get };
	}

	it("downloads a whole object without a head or range options", async () => {
		const { storage, head, get } = setup();
		const body = new Response(new Uint8Array([10, 20, 30, 40, 50, 60])).body;
		get.mockResolvedValue({ ...metadata, body });

		await expect(storage.download(key)).resolves.toEqual({
			body,
			size: 6,
			contentType: "application/octet-stream",
		});
		expect(head).not.toHaveBeenCalled();
		expect(get).toHaveBeenCalledExactlyOnceWith(key);
	});

	it.each([
		{ name: "bounded", range: { start: 1, end: 3 }, start: 1, end: 3, bytes: [20, 30, 40] },
		{ name: "open-ended", range: { start: 3 }, start: 3, end: 5, bytes: [40, 50, 60] },
		{ name: "suffix", range: { suffix: 2 }, start: 4, end: 5, bytes: [50, 60] },
		{ name: "clamped", range: { start: 5, end: 9 }, start: 5, end: 5, bytes: [60] },
	])("streams the exact $name range with total size and inclusive bounds", async (test) => {
		const { storage, head, get } = setup();
		const body = new Response(new Uint8Array(test.bytes)).body;
		get.mockResolvedValue({ ...metadata, httpMetadata: { contentType: "video/webm" }, body });

		const result = await storage.downloadRange(key, test.range);

		expect(head).toHaveBeenCalledExactlyOnceWith(key);
		expect(get).toHaveBeenCalledExactlyOnceWith(key, {
			onlyIf: { etagMatches: metadata.etag },
			range: { offset: test.start, length: test.bytes.length },
		});
		if (result.kind !== "partial") throw new Error("Expected a partial download");
		const { body: stream, ...details } = result;
		expect(details).toEqual({
			kind: "partial",
			contentType: "video/webm",
			size: 6,
			start: test.start,
			end: test.end,
		});
		expect(stream).toBe(body);
		const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
		expect(bytes.byteLength).toBe(result.end - result.start + 1);
		expect([...bytes]).toEqual(test.bytes);
	});

	it.each([
		{ size: 6, range: { start: 6 } },
		{ size: 0, range: { suffix: 2 } },
	])(
		"reports an unsatisfiable range for size $size without fetching bytes",
		async ({ size, range }) => {
			const { storage, head, get } = setup();
			head.mockResolvedValue({ ...metadata, size });

			await expect(storage.downloadRange(key, range)).resolves.toEqual({
				kind: "unsatisfiable",
				size,
			});
			expect(get).not.toHaveBeenCalled();
		},
	);

	it.each(["head", "get"] as const)(
		"reports typed NOT_FOUND when %s returns null",
		async (step) => {
			const { storage, head, get } = setup();
			const operation = step === "head" ? head : get;
			operation.mockResolvedValue(null);

			const result = storage.downloadRange(key, { start: 0 });
			await expect(result).rejects.toBeInstanceOf(EmDashStorageError);
			await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" });
			if (step === "head") expect(get).not.toHaveBeenCalled();
		},
	);

	it("treats metadata without a body from the conditional get as a download failure", async () => {
		const { storage, get } = setup();
		get.mockResolvedValue({ ...metadata, etag: "replacement-etag", size: 2 });

		const result = storage.downloadRange(key, { start: 3 });
		await expect(result).rejects.toBeInstanceOf(EmDashStorageError);
		await expect(result).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
		expect(get).toHaveBeenCalledTimes(1);
	});

	it.each(["head", "get"] as const)(
		"preserves a %s failure as the download error cause",
		async (step) => {
			const { storage, head, get } = setup();
			const cause = new Error("R2 unavailable");
			const operation = step === "head" ? head : get;
			operation.mockRejectedValue(cause);

			await expect(storage.downloadRange(key, { start: 0 })).rejects.toMatchObject({
				code: "DOWNLOAD_FAILED",
				cause,
			});
			if (step === "head") expect(get).not.toHaveBeenCalled();
		},
	);
});
