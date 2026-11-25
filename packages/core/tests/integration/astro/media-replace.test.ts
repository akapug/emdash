import { Buffer } from "node:buffer";

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleMediaGet, handleMediaReplaceMetadata } from "../../../src/api/handlers/media.js";
import { PUT as putReplace } from "../../../src/astro/routes/api/media/[id]/replace.js";
import { MediaFolderRepository } from "../../../src/database/repositories/media-folders.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type User = { id: string; role: 20 | 30 | 40 | 50 };
type ReplaceMetadata = typeof handleMediaReplaceMetadata;

// Solid-color fixtures: 1200×800 PNG, 1800×900 PNG, and 12×8 JPEG.
const originalPng = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAABLAAAAMgAQAAAAAbm6avAAAAjElEQVR42u3BMQEAAADCoPVPbQdvoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD4D1+8AARpxgZ8AAAAASUVORK5CYII=",
		"base64",
	),
);
const croppedPng = new Uint8Array(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAABwgAAAOEAQAAAACd1VibAAAA3ElEQVR42u3BMQEAAADCoPVPbQo/oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvgYatQABGE7c0wAAAABJRU5ErkJggg==",
		"base64",
	),
);
const jpeg = new Uint8Array(
	Buffer.from(
		"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/wAALCAAIAAwBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AIH/2Q==",
		"base64",
	),
);

function memoryStorage() {
	const objects = new Map<string, Uint8Array>();
	const upload = vi.fn(
		async (options: {
			key: string;
			body: Uint8Array;
			contentType: string;
			cacheControl?: string;
		}) => {
			objects.set(options.key, options.body);
			return { key: options.key, url: `/media/${options.key}`, size: options.body.byteLength };
		},
	);
	return { objects, upload };
}

function replaceRequest(
	options: {
		file?: File;
		extraFile?: File;
		width?: string;
		height?: string;
		padding?: string;
	} = {},
): Request {
	const form = new FormData();
	form.set("file", options.file ?? new File([croppedPng], "crop.png", { type: "image/png" }));
	if (options.extraFile) form.append("file", options.extraFile);
	form.set("width", options.width ?? "1800");
	form.set("height", options.height ?? "900");
	if (options.padding !== undefined) form.set("padding", options.padding);
	return new Request("http://localhost/_emdash/api/media/media-1/replace", {
		method: "PUT",
		headers: { "X-EmDash-Request": "1" },
		body: form,
	});
}

async function sizedMultipartRequest(bodySize: number, declareLength: boolean): Promise<Request> {
	const baseline = await replaceRequest({ padding: "" }).arrayBuffer();
	const request = replaceRequest({ padding: "a".repeat(bodySize - baseline.byteLength) });
	const length = (await request.clone().arrayBuffer()).byteLength;
	expect(length).toBe(bodySize);
	if (declareLength) request.headers.set("Content-Length", String(length));
	return request;
}

function buildContext(options: {
	db: Kysely<Database>;
	request: Request;
	storage?: ReturnType<typeof memoryStorage>;
	includeStorage?: boolean;
	user?: User | null;
	maxUploadSize?: number;
	replaceMetadata?: ReplaceMetadata;
}): APIContext {
	const user = options.user === undefined ? { id: "author-1", role: 30 as const } : options.user;
	return {
		params: { id: "media-1" },
		url: new URL(options.request.url),
		request: options.request,
		locals: {
			emdash: {
				db: options.db,
				config: { maxUploadSize: options.maxUploadSize },
				...(options.includeStorage === false ? {} : { storage: options.storage }),
				handleMediaGet: (id: string) => handleMediaGet(options.db, id),
				handleMediaReplaceMetadata: (
					options.replaceMetadata ??
					((db, id, key, metadata) => handleMediaReplaceMetadata(db, id, key, metadata))
				).bind(null, options.db),
			},
			user:
				user === null ? undefined : { ...user, email: `${user.id}@example.com`, name: "Test user" },
		},
	} as unknown as APIContext;
}

describe("PUT /media/:id/replace", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function createImage(overrides: Partial<Parameters<MediaRepository["create"]>[0]> = {}) {
		const repo = new MediaRepository(db);
		const item = await repo.create({
			filename: "hero.png",
			mimeType: "image/png",
			size: originalPng.byteLength,
			width: 1200,
			height: 800,
			alt: "A mountain",
			caption: "Homepage hero",
			storageKey: "media/hero.png",
			contentHash: await computeContentHash(originalPng),
			blurhash: "before-blurhash",
			dominantColor: "#123456",
			authorId: "author-1",
			...overrides,
		});
		await db.updateTable("media").set({ id: "media-1" }).where("id", "=", item.id).execute();
		return (await repo.findById("media-1"))!;
	}

	it.each([
		{ label: "owner", user: { id: "author-1", role: 30 as const } },
		{ label: "editor", user: { id: "editor-1", role: 40 as const } },
	])("lets the $label replace a ready image without changing its identity", async ({ user }) => {
		const repo = new MediaRepository(db);
		const folder = await new MediaFolderRepository(db).create("Editorial");
		const original = await createImage();
		await repo.update(original.id, { folderId: folder.id, focalX: 0.25, focalY: 0.75 });
		const storage = memoryStorage();
		storage.objects.set(original.storageKey, originalPng);

		const response = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, user }),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as { data: { item: Record<string, unknown> } };
		expect(body.data.item).toMatchObject({
			id: original.id,
			filename: original.filename,
			mimeType: original.mimeType,
			storageKey: original.storageKey,
			url: `/_emdash/api/media/file/${original.storageKey}`,
			size: croppedPng.byteLength,
			width: 1800,
			height: 900,
			contentHash: await computeContentHash(croppedPng),
			blurhash: null,
			dominantColor: null,
			focalX: null,
			focalY: null,
			alt: original.alt,
			caption: original.caption,
			authorId: original.authorId,
			folderId: folder.id,
			createdAt: original.createdAt,
		});
		expect(storage.objects.get(original.storageKey)).toEqual(croppedPng);
		expect(storage.upload).toHaveBeenCalledWith(
			expect.objectContaining({
				cacheControl: "public, max-age=0, must-revalidate",
			}),
		);
		expect((await repo.findMany()).items).toHaveLength(1);
	});

	it("stores the image's dimensions instead of different declared dimensions", async () => {
		const original = await createImage();
		const storage = memoryStorage();
		const response = await putReplace(
			buildContext({ db, request: replaceRequest({ width: "799", height: "533" }), storage }),
		);

		expect(response.status).toBe(200);
		expect(storage.objects.get(original.storageKey)).toEqual(croppedPng);
		expect(await new MediaRepository(db).findById(original.id)).toMatchObject({
			width: 1800,
			height: 900,
		});
	});

	it("accepts matching JPEG bytes with a generic file type", async () => {
		const original = await createImage({
			filename: "hero.jpg",
			mimeType: "image/jpeg",
			storageKey: "media/hero.jpg",
		});
		const storage = memoryStorage();
		const response = await putReplace(
			buildContext({
				db,
				request: replaceRequest({
					file: new File([jpeg], "crop.bin", { type: "application/octet-stream" }),
					width: "12",
					height: "8",
				}),
				storage,
			}),
		);

		expect(response.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledWith(
			expect.objectContaining({ key: original.storageKey, contentType: "image/jpeg" }),
		);
		expect(storage.objects.get(original.storageKey)).toEqual(jpeg);
		expect(await new MediaRepository(db).findById(original.id)).toMatchObject({
			mimeType: "image/jpeg",
			size: jpeg.byteLength,
			width: 12,
			height: 8,
			contentHash: await computeContentHash(jpeg),
		});
	});

	it.each([
		{ label: "unauthenticated caller", user: null, status: 401 },
		{ label: "contributor", user: { id: "contributor-1", role: 20 as const }, status: 403 },
		{ label: "another author", user: { id: "author-2", role: 30 as const }, status: 403 },
	])("rejects an $label before storage mutation", async ({ user, status }) => {
		const original = await createImage();
		const storage = memoryStorage();

		const response = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, user }),
		);

		expect(response.status).toBe(status);
		expect(storage.upload).not.toHaveBeenCalled();
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);
	});

	it("rejects missing storage and media before mutation", async () => {
		const storage = memoryStorage();
		const missingStorage = await putReplace(
			buildContext({
				db,
				request: replaceRequest(),
				storage,
				includeStorage: false,
			}),
		);
		expect(missingStorage.status).toBe(500);

		const missingMedia = await putReplace(buildContext({ db, request: replaceRequest(), storage }));
		expect(missingMedia.status).toBe(404);
		expect(storage.upload).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "non-ready source",
			source: { status: "pending" as const },
			request: {},
			status: 400,
		},
		{
			label: "unsupported source type",
			source: { mimeType: "image/gif", filename: "hero.gif", storageKey: "hero.gif" },
			request: {},
			status: 400,
		},
		{
			label: "stringified object instead of JPEG bytes",
			source: { mimeType: "image/jpeg", filename: "hero.jpg", storageKey: "hero.jpg" },
			request: { file: new File(["[object Object]"], "crop.jpg", { type: "image/jpeg" }) },
			status: 400,
		},
		{
			label: "PNG bytes for a JPEG source",
			source: { mimeType: "image/jpeg", filename: "hero.jpg", storageKey: "hero.jpg" },
			request: { file: new File([croppedPng], "crop.png", { type: "image/png" }) },
			status: 400,
		},
		{
			label: "duplicate file entries",
			source: {},
			request: { extraFile: new File([originalPng], "second.png", { type: "image/png" }) },
			status: 400,
		},
		{
			label: "empty file",
			source: {},
			request: { file: new File([], "crop.png", { type: "image/png" }) },
			status: 400,
		},
		{
			label: "file one byte over its own size limit",
			source: {},
			request: {},
			maxUploadSize: croppedPng.byteLength - 1,
			status: 413,
		},
		{
			label: "zero dimension",
			source: {},
			request: { width: "0" },
			status: 400,
		},
		{
			label: "unsafe dimensions",
			source: {},
			request: { width: "9007199254740992" },
			status: 400,
		},
	])("rejects $label without changing storage or metadata", async (testCase) => {
		const original = await createImage(testCase.source);
		const storage = memoryStorage();

		const response = await putReplace(
			buildContext({
				db,
				request: replaceRequest(testCase.request),
				storage,
				maxUploadSize: testCase.maxUploadSize,
			}),
		);

		expect(response.status).toBe(testCase.status);
		expect(storage.upload).not.toHaveBeenCalled();
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);
	});

	it("accepts a file and declared multipart body exactly at their limits", async () => {
		const original = await createImage();
		const storage = memoryStorage();
		const maxUploadSize = croppedPng.byteLength;
		const request = await sizedMultipartRequest(maxUploadSize + 64 * 1024, true);

		const response = await putReplace(buildContext({ db, request, storage, maxUploadSize }));

		expect(response.status).toBe(200);
		expect(storage.objects.get(original.storageKey)).toEqual(croppedPng);
	});

	it.each([
		{ label: "with a declared length", declareLength: true },
		{ label: "without a declared length", declareLength: false },
	])("rejects a multipart body one byte over the envelope $label", async ({ declareLength }) => {
		const original = await createImage();
		const storage = memoryStorage();
		const maxUploadSize = croppedPng.byteLength;
		const request = await sizedMultipartRequest(maxUploadSize + 64 * 1024 + 1, declareLength);

		const response = await putReplace(buildContext({ db, request, storage, maxUploadSize }));

		expect(response.status).toBe(413);
		if (declareLength) expect(request.bodyUsed).toBe(false);
		expect(storage.upload).not.toHaveBeenCalled();
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);
	});

	it("preserves database metadata when storage replacement fails", async () => {
		const original = await createImage();
		const storage = memoryStorage();
		storage.upload.mockRejectedValueOnce(new Error("storage unavailable"));
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const response = await putReplace(buildContext({ db, request: replaceRequest(), storage }));

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: "MEDIA_REPLACE_ERROR" } });
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);
	});

	it("retries metadata after bytes were overwritten without creating another item", async () => {
		const original = await createImage();
		const storage = memoryStorage();
		const replaceMetadata = vi
			.fn<ReplaceMetadata>()
			.mockResolvedValueOnce({
				success: false,
				error: {
					code: "MEDIA_REPLACE_METADATA_ERROR",
					message: "Failed to update replaced media metadata",
				},
			})
			.mockImplementation(handleMediaReplaceMetadata);

		const first = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, replaceMetadata }),
		);
		expect(first.status).toBe(500);
		expect(await first.json()).toMatchObject({
			error: { code: "MEDIA_REPLACE_METADATA_ERROR" },
		});
		expect(await new MediaRepository(db).findById(original.id)).toEqual(original);

		const retry = await putReplace(
			buildContext({ db, request: replaceRequest(), storage, replaceMetadata }),
		);
		expect(retry.status).toBe(200);
		expect(storage.upload).toHaveBeenCalledTimes(2);
		expect(storage.upload.mock.calls.map(([options]) => options.key)).toEqual([
			original.storageKey,
			original.storageKey,
		]);
		expect((await new MediaRepository(db).findMany()).items).toHaveLength(1);
	});
});
