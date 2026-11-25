import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalStorage } from "../../../src/storage/local.js";
import { EmDashStorageError } from "../../../src/storage/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs/promises")>();
	return { ...fs, open: vi.fn(fs.open) };
});

describe("LocalStorage same-key upload", () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
	});

	it("replaces the stored bytes without changing the key", async () => {
		directory = await mkdtemp(join(tmpdir(), "emdash-local-storage-"));
		const storage = new LocalStorage({ directory, baseUrl: "/media" });
		const key = "images/hero.png";

		await storage.upload({
			key,
			body: new Uint8Array([1, 2, 3]),
			contentType: "image/png",
		});
		await storage.upload({
			key,
			body: new Uint8Array([9, 8]),
			contentType: "image/png",
		});

		const stored = await storage.download(key);
		expect(new Uint8Array(await new Response(stored.body).arrayBuffer())).toEqual(
			new Uint8Array([9, 8]),
		);
	});
});

describe("LocalStorage.downloadRange", () => {
	const key = "images/hero.PNG";
	let directory: string;
	let storage: LocalStorage;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "emdash-local-storage-"));
		storage = new LocalStorage({ directory, baseUrl: "/media" });
		await storage.upload({
			key,
			body: new Uint8Array([0, 1, 2, 3, 4]),
			contentType: "application/octet-stream",
		});
	});

	afterEach(async () => {
		vi.mocked(open).mockReset();
		await rm(directory, { recursive: true, force: true });
	});

	async function trackNextRead() {
		const filePath = join(directory, key);
		const file = await open(filePath, "r");
		const createStream = vi.spyOn(file, "createReadStream");
		vi.mocked(open).mockClear().mockResolvedValueOnce(file);
		return { file, filePath, createStream };
	}

	it("streams inclusive bounds from the same file handle and closes it at EOF", async () => {
		const { file, filePath, createStream } = await trackNextRead();
		try {
			const result = await storage.downloadRange(key, { start: 1, end: 3 });
			if (result.kind !== "partial") throw new Error("Expected a partial download");
			expect(open).toHaveBeenCalledExactlyOnceWith(filePath, "r");
			expect(createStream).toHaveBeenCalledExactlyOnceWith({ start: 1, end: 3, autoClose: true });
			expect(result).toMatchObject({ contentType: "image/png", size: 5, start: 1, end: 3 });
			expect(new Uint8Array(await new Response(result.body).arrayBuffer())).toEqual(
				new Uint8Array([1, 2, 3]),
			);
			await vi.waitFor(() => expect(file.fd).toBe(-1));
		} finally {
			await file.close();
		}
	});

	it("returns the total without starting a read for an unsatisfiable range", async () => {
		const { file, createStream } = await trackNextRead();
		try {
			await expect(storage.downloadRange(key, { start: 5 })).resolves.toEqual({
				kind: "unsatisfiable",
				size: 5,
			});
			expect(createStream).not.toHaveBeenCalled();
			expect(file.fd).toBe(-1);
		} finally {
			await file.close();
		}
	});

	it("closes the file handle when canceled before reading the full range", async () => {
		const size = 1024 * 1024;
		await storage.upload({ key, body: new Uint8Array(size), contentType: "image/png" });
		const { file, createStream } = await trackNextRead();
		try {
			const result = await storage.downloadRange(key, { start: 0 });
			if (result.kind !== "partial") throw new Error("Expected a partial download");
			await result.body.cancel();
			await vi.waitFor(() => expect(file.fd).toBe(-1));
			const stream = createStream.mock.results[0];
			if (stream?.type !== "return") throw new Error("Expected a file stream");
			expect(stream.value.bytesRead).toBeLessThan(size);
		} finally {
			await file.close();
		}
	});

	it.each([
		["missing.png", "NOT_FOUND"],
		["images", "DOWNLOAD_FAILED"],
		["../outside.png", "INVALID_PATH"],
	])("reports %s with storage error code %s", async (fileKey, code) => {
		await expect(storage.downloadRange(fileKey, { start: 0 })).rejects.toMatchObject({
			name: EmDashStorageError.name,
			code,
		});
	});
});
