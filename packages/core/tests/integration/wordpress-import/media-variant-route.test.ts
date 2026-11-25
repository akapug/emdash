import { Role } from "@emdash-cms/auth";
/**
 * Route-handler integration: call the real WordPress POST and file GET handlers
 * with test locals. This covers storage, database and serving; it does not run
 * Astro's middleware or test the production handler binding.
 *
 * Proves, in order:
 *  1. POST /media-variant stores a size;
 *  2. GET the parent's url with ?w= returns the VARIANT's bytes, not the original;
 *  3. retire (a delete of the parent's rows) makes the same GET return the
 *     ORIGINAL's bytes;
 *  4. a width with no variant behind it serves the original;
 *  5. a raw GET of the variant's own key is 404 — the object never has an address;
 *  6. a POST after the parent's bytes changed is refused, and stores nothing.
 */
import { encode } from "jpeg-js";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMediaDelete,
	handleMediaGet,
	handleMediaVariantStore,
} from "../../../src/api/handlers/media.js";
import { POST as variantPost } from "../../../src/astro/routes/api/import/wordpress/media-variant.js";
import { GET as fileGet } from "../../../src/astro/routes/api/media/file/[...key].js";
import { runSystemCleanup } from "../../../src/cleanup.js";
import { MediaVariantRepository } from "../../../src/database/repositories/media-variants.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { getCommittedVariants } from "../../../src/media/variant-read.js";
import {
	__setObjectCacheBackendForTests,
	readPageGenerationVector,
} from "../../../src/object-cache/index.js";
import { EmDashStorageError, type DownloadResult } from "../../../src/storage/types.js";
import { MEDIA_VARIANT_STORAGE_PREFIX } from "../../../src/transfer/staging/keys.js";
import { computeContentHash } from "../../../src/utils/hash.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let db: Kysely<Database>;

/** A storage fake: an in-memory bucket, so bytes and keys are real and comparable. */
function storageDouble() {
	const objects = new Map<string, { body: Uint8Array; contentType: string }>();
	return {
		objects,
		upload: async (options: { key: string; body: Uint8Array; contentType: string }) => {
			objects.set(options.key, { body: options.body, contentType: options.contentType });
			return { size: options.body.byteLength };
		},
		exists: async (key: string) => objects.has(key),
		download: async (key: string) => {
			const object = objects.get(key);
			if (!object) throw new EmDashStorageError(`File not found: ${key}`, "NOT_FOUND");
			return { body: object.body, contentType: object.contentType, size: object.body.byteLength };
		},
		delete: async (key: string) => {
			objects.delete(key);
		},
	};
}

// The POST needs a real 300×300 PNG. The storage double serves distinguishable
// original bytes so the GET assertion cannot pass by returning the wrong object.
const REAL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAASwAAAEsCAIAAAD2HxkiAAADWUlEQVR4nO3TMQ0AMAzAsAIbsEEsrMHIMUsGkCez9wChyQvgcyaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIfYAauv4SI1EutgAAAAASUVORK5CYII=",
	"base64",
);
const ORIGINAL_BYTES = new Uint8Array(REAL_PNG.byteLength + 1);
ORIGINAL_BYTES.set(REAL_PNG);
const VARIANT_BYTES = new Uint8Array(REAL_PNG);

async function cleanupReason(key: string): Promise<string | undefined> {
	const row = await db
		.selectFrom("_emdash_media_variant_cleanup")
		.select("reason")
		.where("storage_key", "=", key)
		.executeTakeFirst();
	return row?.reason;
}

async function seedImage(): Promise<{ id: string; storageKey: string }> {
	const repo = new MediaRepository(db);
	const created = await repo.create({
		filename: "photo.jpg",
		mimeType: "image/png",
		storageKey: "2024/01/photo.jpg",
		size: ORIGINAL_BYTES.byteLength,
		width: 1200,
		height: 1200,
		contentHash: "hash-of-the-original",
		status: "ready",
	});
	return { id: created.id, storageKey: created.storageKey };
}

type FileContext = Parameters<typeof fileGet>[0];

/** The file route with a fake storage on locals, and a url carrying `?w=`. */
function fileContext(
	key: string,
	w: string | null,
	storage: ReturnType<typeof storageDouble>,
): FileContext {
	const url = new URL(`https://site.test/media/file/${key}`);
	if (w !== null) url.searchParams.set("w", w);
	return {
		params: { key },
		url,
		locals: { emdash: { db, storage } },
	} as unknown as FileContext;
}

beforeEach(async () => {
	db = await setupTestDatabase();
});
afterEach(async () => {
	await teardownTestDatabase(db);
});

describe("W8: a stored variant is served from the parent's URL, and retiring it restores the original", () => {
	it("stores, serves the variant, then serves the original once the parent is deleted", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		await storage.upload({
			key: image.storageKey,
			body: ORIGINAL_BYTES,
			contentType: "image/jpeg",
		});

		// 1. The POST reaches the handler and stores.
		// MULTIPART, which is the route's real contract, and the real admin role:
		// `import:execute` is an ADMIN-tier permission, so a made-up user is a 403 and
		// an arm that fakes one proves nothing about the door.
		const form = new FormData();
		form.set("mediaId", image.id);
		form.set("sizeName", "medium");
		form.set("width", "300");
		form.set("height", "300");

		form.set("file", new File([VARIANT_BYTES], "medium.png", { type: "image/png" }));
		const post = await variantPost({
			request: new Request("https://site.test/_emdash/api/import/wordpress/media-variant", {
				method: "POST",
				body: form,
			}),
			locals: {
				// The REAL get: the route re-reads the parent through it, so a stub that
				// answers `null` makes the route 404 and the arm proves nothing.
				// The REAL store handler too: the route delegates placement and the row to
				// it, so a missing method is the route failing on its first request — the
				// exact defect W2 was, one layer up.
				emdash: {
					db,
					storage,
					handleMediaGet: (id: string) => handleMediaGet(db, id),
					handleMediaVariantStore: (input: never) =>
						handleMediaVariantStore(db, storage as never, input),
				},
				user: { role: Role.ADMIN },
			},
		} as unknown as Parameters<typeof variantPost>[0]);
		const postBody = await post.clone().text();
		// 201 for a fresh store; 200 is a replay of identical bytes.
		expect(post.status, `the route must be reachable and store; body=${postBody}`).toBe(201);

		// 2. The parent's URL, with the width, serves the VARIANT's bytes.
		const served = await fileGet(fileContext(image.storageKey, "300", storage));
		expect(served.status).toBe(200);
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(VARIANT_BYTES);

		// 4. A width with nothing behind it serves the original.
		const other = await fileGet(fileContext(image.storageKey, "777", storage));
		expect(new Uint8Array(await other.arrayBuffer())).toEqual(ORIGINAL_BYTES);

		// 5. The variant's OWN key is 404: a variant object has no public address.
		const ownKey = [...storage.objects.keys()].find((k) =>
			k.startsWith(MEDIA_VARIANT_STORAGE_PREFIX),
		);
		expect(ownKey, "the object must live under the reserved prefix").toBeTruthy();
		const direct = await fileGet(fileContext(ownKey!, null, storage));
		expect(direct.status).toBe(404);

		// 3. Delete the parent: the variant OBJECTS are retired, and the same GET is the
		// original. The parent's own object is left in place first because
		// `handleMediaDelete` removes that too, and what this arm is about is the
		// VARIANT disappearing, not the image.
		const original = storage.objects.get(image.storageKey)!;
		expect((await handleMediaDelete(db, image.id, storage as never)).success).toBe(true);
		expect(await cleanupReason(ownKey!)).toBe("retired");
		expect(storage.objects.has(ownKey!)).toBe(true);
		await runSystemCleanup(db, storage as never);
		expect(storage.objects.has(ownKey!)).toBe(false);
		expect(await cleanupReason(ownKey!)).toBeUndefined();
		await storage.upload({
			key: image.storageKey,
			body: original.body,
			contentType: original.contentType,
		});
		const afterRetire = await fileGet(fileContext(image.storageKey, "300", storage));
		expect(afterRetire.status).toBe(200);
		expect(new Uint8Array(await afterRetire.arrayBuffer())).toEqual(ORIGINAL_BYTES);
	});

	it("refuses a store whose parent hash is stale, and stores nothing", async () => {
		const storage = storageDouble();
		const image = await seedImage();

		const result = await handleMediaVariantStore(db, storage as never, {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 200,
			parentContentHash: "hash-from-before-the-replace",
			bytes: VARIANT_BYTES,
			contentType: "image/jpeg",
			contentHash: "hash-of-the-variant",
		});
		expect(result.success).toBe(false);
		expect(
			await new MediaVariantRepository(db).forParent(image.id, "hash-from-before-the-replace"),
		).toHaveLength(0);
	});
});

function jpeg(width: number, height: number) {
	return new Uint8Array(
		encode({ width, height, data: new Uint8Array(width * height * 4) }, 50).data,
	);
}

function withJpegSegment(bytes: Uint8Array, marker: number, payload: Uint8Array) {
	const result = new Uint8Array(bytes.length + payload.length + 4);
	result.set(bytes.subarray(0, 2));
	result.set([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff], 2);
	result.set(payload, 6);
	result.set(bytes.subarray(2), 6 + payload.length);
	return result;
}

function withOrientation(
	bytes: Uint8Array,
	orientation: number,
	{ littleEndian = false, marker = 0xe1, tiffMagic = 42 } = {},
) {
	const exif = new Uint8Array(32);
	exif.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
	exif.fill(littleEndian ? 0x49 : 0x4d, 6, 8);
	const tiff = new DataView(exif.buffer, 6);
	tiff.setUint16(2, tiffMagic, littleEndian);
	tiff.setUint32(4, 8, littleEndian);
	tiff.setUint16(8, 1, littleEndian);
	tiff.setUint16(10, 0x0112, littleEndian);
	tiff.setUint16(12, 3, littleEndian);
	tiff.setUint32(14, 1, littleEndian);
	tiff.setUint16(18, orientation, littleEndian);
	return withJpegSegment(bytes, marker, exif);
}

const RAW_JPEG = jpeg(1000, 600);
const UPRIGHT_JPEG = jpeg(300, 500);

async function jpegVariantRequest(parentBytes: Uint8Array, width = 1000, height = 600) {
	const repo = new MediaRepository(db);
	const parent = await repo.create({
		filename: "parent.jpg",
		mimeType: "image/jpeg",
		storageKey: "2024/01/parent.jpg",
		size: parentBytes.byteLength,
		width,
		height,
		contentHash: await computeContentHash(parentBytes),
		status: "ready",
	});
	const storage = {
		...storageDouble(),
		download: async (key: string): Promise<DownloadResult> => {
			if (key !== parent.storageKey) throw new EmDashStorageError("Missing original", "NOT_FOUND");
			return {
				body: new Blob([new Uint8Array(parentBytes)]).stream(),
				contentType: parent.mimeType,
				size: parentBytes.byteLength,
			};
		},
	};
	const post = (bytes = UPRIGHT_JPEG, offerHeight = 500, offerWidth = 300) => {
		const form = new FormData();
		form.set("mediaId", parent.id);
		form.set("sizeName", "medium");
		form.set("width", String(offerWidth));
		form.set("height", String(offerHeight));
		form.set("orientation", "6");
		form.set("file", new File([bytes], "medium.jpg", { type: "image/jpeg" }));
		return variantPost({
			request: new Request("https://site.test/_emdash/api/import/wordpress/media-variant", {
				method: "POST",
				body: form,
			}),
			locals: {
				emdash: {
					storage,
					handleMediaGet: (id: string) => handleMediaGet(db, id),
					handleMediaVariantStore: (input: never) =>
						handleMediaVariantStore(db, storage as never, input),
				},
				user: { role: Role.ADMIN },
			},
		} as unknown as Parameters<typeof variantPost>[0]);
	};
	return {
		parent,
		storage,
		post,
		slots: () => new MediaVariantRepository(db).forParent(parent.id, parent.contentHash!),
	};
}

describe("WordPress JPEG variant orientation", () => {
	it.each([5, 6, 7, 8])("stores an upright derivative with parent EXIF %i", async (orientation) => {
		const { storage, post, slots } = await jpegVariantRequest(
			withOrientation(RAW_JPEG, orientation, { littleEndian: orientation % 2 === 0 }),
		);
		const response = await post();
		expect(response.status, await response.clone().text()).toBe(201);
		const stored = await slots();
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatchObject({ width: 300, height: 500 });
		expect(storage.objects.get(stored[0]!.storageKey)?.body).toEqual(UPRIGHT_JPEG);
	});

	it.each([
		["absent EXIF", RAW_JPEG],
		["EXIF that does not swap axes", withOrientation(RAW_JPEG, 4)],
		["out-of-range EXIF", withOrientation(RAW_JPEG, 9)],
		["malformed TIFF", withOrientation(RAW_JPEG, 6, { tiffMagic: 0 })],
		["an EXIF signature outside APP1", withOrientation(RAW_JPEG, 6, { marker: 0xe2 })],
		["contradictory EXIF", withOrientation(withOrientation(RAW_JPEG, 6), 1)],
	] as const)("rejects a transposed shape with %s", async (_reason, parentBytes) => {
		const { storage, post, slots } = await jpegVariantRequest(parentBytes);
		const response = await post(withOrientation(UPRIGHT_JPEG, 6));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_VARIANT" } });
		expect(await slots()).toEqual([]);
		expect(storage.objects.size).toBe(0);
	});

	it("rejects proof for a raw pixel pair that does not match the parent row", async () => {
		const { post, slots } = await jpegVariantRequest(withOrientation(RAW_JPEG, 6), 900, 540);
		expect((await post()).status).toBe(400);
		expect(await slots()).toEqual([]);
	});

	it("does not combine the transposed ratio with the untransposed size bound", async () => {
		const { post, slots } = await jpegVariantRequest(withOrientation(jpeg(500, 300), 6), 500, 300);
		expect((await post()).status).toBe(400);
		expect(await slots()).toEqual([]);
	});

	it("keeps untransposed validation independent of parent storage", async () => {
		const { storage, post } = await jpegVariantRequest(RAW_JPEG);
		let downloads = 0;
		storage.download = async () => {
			downloads++;
			throw new Error("Storage unavailable");
		};
		expect((await post(jpeg(300, 180), 180)).status).toBe(201);
		expect(downloads).toBe(0);
	});

	it("does not inspect EXIF beyond 64 KiB and cancels the unread body", async () => {
		const late = withJpegSegment(withOrientation(RAW_JPEG, 6), 0xe2, new Uint8Array(65533));
		const { storage, post, slots } = await jpegVariantRequest(late);
		let pulls = 0;
		let cancelled = false;
		storage.download = async () => ({
			contentType: "image/jpeg",
			size: late.byteLength + 1,
			body: new ReadableStream(
				{
					pull(controller) {
						pulls++;
						if (pulls === 1) controller.enqueue(late);
						else controller.error(new Error("Read beyond the prefix"));
					},
					cancel() {
						cancelled = true;
					},
				},
				{ highWaterMark: 0 },
			),
		});
		expect((await post()).status).toBe(400);
		expect(pulls).toBe(1);
		expect(cancelled).toBe(true);
		expect(await slots()).toEqual([]);
	});

	it("refuses a missing original without uploading a variant", async () => {
		const { storage, post, slots } = await jpegVariantRequest(RAW_JPEG);
		storage.download = async () => {
			throw new EmDashStorageError("Missing original", "NOT_FOUND");
		};
		expect((await post()).status).toBe(400);
		expect(await slots()).toEqual([]);
		expect(storage.objects.size).toBe(0);
	});

	it("reports a read failure as a server error without uploading", async () => {
		const { storage, post, slots } = await jpegVariantRequest(RAW_JPEG);
		storage.download = async () => ({
			contentType: "image/jpeg",
			size: RAW_JPEG.byteLength,
			body: new ReadableStream({
				pull(controller) {
					controller.error(new Error("Storage read failed"));
				},
			}),
		});
		const response = await post();
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: "UNAVAILABLE" } });
		expect(await slots()).toEqual([]);
		expect(storage.objects.size).toBe(0);
	});

	it("does not upload if the parent generation changes during the proof read", async () => {
		const { parent, storage, post, slots } = await jpegVariantRequest(withOrientation(RAW_JPEG, 6));
		const download = storage.download;
		storage.download = async (key) => {
			const original = await download(key);
			await new MediaRepository(db).replaceReadyFile(parent.id, key, {
				size: RAW_JPEG.byteLength,
				width: 1000,
				height: 600,
				contentHash: await computeContentHash(RAW_JPEG),
			});
			return original;
		};
		expect((await post()).status).toBe(409);
		expect(await slots()).toEqual([]);
		expect(storage.objects.size).toBe(0);
	});
});

/**
 * CODEX'S FOUR LIFECYCLE PROBES, taken as arms. It measured these on 07349285f1 and got
 * 3 red / 1 green; each one is a case my own W8 arm could not reach because it tested a
 * happy path. The cleanup assertion is adapted to the durable cleanup RECORD, which is
 * the shape the lead ruled on (a flag on the variant row would die with the cascade).
 */
describe("codex's lifecycle probes", () => {
	it("a committed row whose object is missing serves the ORIGINAL, not a 5xx", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		await storage.upload({ key: image.storageKey, body: ORIGINAL_BYTES, contentType: "image/png" });
		const stored = await handleMediaVariantStore(db, storage as never, {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 300,
			parentContentHash: "hash-of-the-original",
			bytes: VARIANT_BYTES,
			contentType: "image/png",
			contentHash: "probe-variant",
		});
		expect(stored.success).toBe(true);

		const key = [...storage.objects.keys()].find((k) =>
			k.startsWith(MEDIA_VARIANT_STORAGE_PREFIX),
		)!;
		await storage.delete(key);

		const served = await fileGet(fileContext(image.storageKey, "300", storage));
		expect(served.status, "a missing object must not be a 5xx").toBe(200);
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(ORIGINAL_BYTES);
	});

	it("a failed object delete leaves a durable cleanup RECORD naming the key", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		await storage.upload({ key: image.storageKey, body: ORIGINAL_BYTES, contentType: "image/png" });
		await handleMediaVariantStore(db, storage as never, {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 300,
			parentContentHash: "hash-of-the-original",
			bytes: VARIANT_BYTES,
			contentType: "image/png",
			contentHash: "probe-variant",
		});
		const key = [...storage.objects.keys()].find((k) =>
			k.startsWith(MEDIA_VARIANT_STORAGE_PREFIX),
		)!;

		const remove = storage.delete;
		storage.delete = async (asked: string) => {
			if (asked === key) throw new Error("Temporary storage failure");
			await remove(asked);
		};
		expect((await handleMediaDelete(db, image.id, storage as never)).success).toBe(true);
		await runSystemCleanup(db, storage as never);
		expect(storage.objects.has(key)).toBe(true);
		expect(await cleanupReason(key)).toBe("retired");
	});

	it("a restored original can carry a size whose prior object was retired", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		await storage.upload({ key: image.storageKey, body: ORIGINAL_BYTES, contentType: "image/png" });
		const input = {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 300,
			parentContentHash: "hash-of-the-original",
			bytes: VARIANT_BYTES,
			contentType: "image/png",
			contentHash: "probe-variant",
		};
		expect((await handleMediaVariantStore(db, storage as never, input)).success).toBe(true);

		const repo = new MediaRepository(db);
		await repo.replaceReadyFile(image.id, image.storageKey, {
			size: 3,
			width: 901,
			height: 901,
			contentHash: "replacement-hash",
		});
		const oldKey = [...storage.objects.keys()].find((key) =>
			key.startsWith(MEDIA_VARIANT_STORAGE_PREFIX),
		)!;
		expect(await cleanupReason(oldKey)).toBe("retired");
		expect(
			await new MediaVariantRepository(db).forParent(image.id, input.parentContentHash),
		).toEqual([]);
		await runSystemCleanup(db, storage as never);

		// Restoring the original hash must admit even a different size at the old slot.
		await repo.replaceReadyFile(image.id, image.storageKey, {
			size: 3,
			width: 1200,
			height: 1200,
			contentHash: input.parentContentHash,
		});
		const replacement = await handleMediaVariantStore(db, storage as never, {
			...input,
			bytes: new Uint8Array([4, 5, 6]),
			contentHash: "replacement-variant",
		});
		expect(replacement).toMatchObject({ success: true, data: { outcome: "stored" } });
		const [variant] = await new MediaVariantRepository(db).forParent(
			image.id,
			input.parentContentHash,
		);
		expect(variant?.storageKey).not.toBe(oldKey);
		expect(storage.objects.get(variant!.storageKey)?.body).toEqual(new Uint8Array([4, 5, 6]));
	});

	it("changing the parent while storing bytes prevents the fresh slot commit", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		await storage.upload({ key: image.storageKey, body: ORIGINAL_BYTES, contentType: "image/png" });

		const upload = storage.upload;
		storage.upload = async (options: { key: string; body: Uint8Array; contentType: string }) => {
			const written = await upload(options);
			await new MediaRepository(db).replaceReadyFile(image.id, image.storageKey, {
				size: 3,
				width: 901,
				height: 901,
				contentHash: "replacement-during-write",
			});
			return written;
		};

		const pending = await handleMediaVariantStore(db, storage as never, {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 300,
			parentContentHash: "hash-of-the-original",
			bytes: VARIANT_BYTES,
			contentType: "image/png",
			contentHash: "probe-variant",
		});
		expect(pending.success, "a parent that moved mid-write must refuse").toBe(false);
		const leaked = [...storage.objects.keys()].filter((k) =>
			k.startsWith(MEDIA_VARIANT_STORAGE_PREFIX),
		);
		expect(leaked).toHaveLength(1);
		for (const key of leaked) expect(await cleanupReason(key)).toBe("retired");
		await runSystemCleanup(db, storage as never);
		expect([...storage.objects.keys()]).toEqual([image.storageKey]);
	});

	it("refreshes a warm variant projection and the page vector on store, replace, and delete", async () => {
		const kv = new Map<string, string>();
		__setObjectCacheBackendForTests({
			async get(key) {
				return kv.get(key) ?? null;
			},
			async set(key, value) {
				kv.set(key, value);
			},
			async delete(key) {
				kv.delete(key);
			},
		});
		try {
			const storage = storageDouble();
			const image = await seedImage();
			const variants = () => getCommittedVariants(db, image);
			const vector = async () => {
				const page = await readPageGenerationVector("variant-test");
				expect(page.certain).toBe(true);
				return page.vector;
			};
			const store = (parentContentHash: string) =>
				handleMediaVariantStore(db, storage as never, {
					mediaId: image.id,
					sizeName: "medium",
					width: 300,
					height: 300,
					parentContentHash,
					bytes: VARIANT_BYTES,
					contentType: "image/png",
					contentHash: "probe-variant",
				});
			const before = await vector();
			expect(await variants()).toEqual([]);
			expect((await store("hash-of-the-original")).success).toBe(true);
			expect(await variants()).toHaveLength(1);
			const stored = await vector();
			expect(stored).not.toBe(before);

			const repo = new MediaRepository(db);
			const replacedHash = "replacement-hash";
			await repo.replaceReadyFile(image.id, image.storageKey, {
				size: 1024,
				width: 900,
				height: 900,
				contentHash: replacedHash,
			});
			expect(await variants()).toEqual([]);
			expect(await vector()).not.toBe(stored);

			expect((await store(replacedHash)).success).toBe(true);
			expect(await variants()).toHaveLength(1);
			const beforeDelete = await vector();
			await repo.deleteWithStorageKey(image.id);
			expect(await variants()).toEqual([]);
			expect(await vector()).not.toBe(beforeDelete);
		} finally {
			__setObjectCacheBackendForTests(null);
		}
	});

	it("does not upload when the pending marker cannot be recorded", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		await sql`CREATE TRIGGER test_reject_pending_variant
			BEFORE INSERT ON _emdash_media_variant_cleanup WHEN NEW.reason = 'pending'
			BEGIN SELECT RAISE(ABORT, 'test candidate cut'); END`.execute(db);
		const result = await handleMediaVariantStore(db, storage as never, {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 300,
			parentContentHash: "hash-of-the-original",
			bytes: VARIANT_BYTES,
			contentType: "image/png",
			contentHash: "probe-variant",
		});
		expect(result).toMatchObject({ success: false, error: { code: "MEDIA_VARIANT_STORE_ERROR" } });
		expect(storage.objects.size).toBe(0);
	});

	it("replays a present variant without a write and repairs a missing one with a new key", async () => {
		const storage = storageDouble();
		const image = await seedImage();
		const input = {
			mediaId: image.id,
			sizeName: "medium",
			width: 300,
			height: 300,
			parentContentHash: "hash-of-the-original",
			bytes: VARIANT_BYTES,
			contentType: "image/png",
			contentHash: "probe-variant",
		};
		const store = () => handleMediaVariantStore(db, storage as never, input);
		const slots = () => new MediaVariantRepository(db).forParent(image.id, input.parentContentHash);
		expect(await store()).toMatchObject({ success: true, data: { outcome: "stored" } });
		const oldKey = (await slots())[0]!.storageKey;
		expect(await cleanupReason(oldKey)).toBeUndefined();
		const upload = storage.upload;
		const writes: string[] = [];
		storage.upload = async (options) => {
			writes.push(options.key);
			return upload(options);
		};
		expect(await store()).toMatchObject({ success: true, data: { outcome: "replayed" } });
		expect(writes).toEqual([]);
		await storage.delete(oldKey);
		expect(await store()).toMatchObject({ success: true, data: { outcome: "replayed" } });
		const newKey = (await slots())[0]!.storageKey;
		expect(newKey).not.toBe(oldKey);
		expect(writes).toEqual([newKey]);
		expect(storage.objects.get(newKey)?.body).toEqual(VARIANT_BYTES);
		expect(await cleanupReason(newKey)).toBeUndefined();
		expect(await cleanupReason(oldKey)).toBe("retired");
	});
});
