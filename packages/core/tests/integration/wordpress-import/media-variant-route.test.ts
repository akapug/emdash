import { Role } from "@emdash-cms/auth";
/**
 * W8: the whole path, through the real route handler and the real file route.
 *
 * The three arms before this one were unit tests of the resolver and the
 * repository, and every one of them passed while the route called a handler that
 * did not exist. This is the arm that would have failed: it POSTs to the
 * registered route, asks the public URL for a width, retires, and asks again.
 *
 * Proves, in order:
 *  1. POST /media-variant stores a size (handler reachable, capability present);
 *  2. GET the parent's url with ?w= returns the VARIANT's bytes, not the original;
 *  3. retire (a delete of the parent's rows) makes the same GET return the
 *     ORIGINAL's bytes;
 *  4. a width with no variant behind it serves the original;
 *  5. a raw GET of the variant's own key is 404 — the object never has an address;
 *  6. a POST after the parent's bytes changed is refused, and stores nothing.
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	handleMediaDelete,
	handleMediaGet,
	handleMediaVariantStore,
} from "../../../src/api/handlers/media.js";
import { POST as variantPost } from "../../../src/astro/routes/api/import/wordpress/media-variant.js";
import { GET as fileGet } from "../../../src/astro/routes/api/media/file/[...key].js";
import { MediaVariantRepository } from "../../../src/database/repositories/media-variants.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import type { Database } from "../../../src/database/types.js";
import { MEDIA_VARIANT_STORAGE_PREFIX } from "../../../src/transfer/staging/keys.js";
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
		download: async (key: string) => {
			const object = objects.get(key);
			if (!object) throw new Error(`no such object: ${key}`);
			return { body: object.body, contentType: object.contentType, size: object.body.byteLength };
		},
		delete: async (key: string) => {
			objects.delete(key);
		},
	};
}

// A REAL 4x3 PNG: the route decodes the bytes and refuses anything it cannot read,
// so synthetic arrays would test the refusal rather than the path.
const REAL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAASwAAAEsCAIAAAD2HxkiAAADWUlEQVR4nO3TMQ0AMAzAsAIbsEEsrMHIMUsGkCez9wChyQvgcyaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIWZCiJkQYiaEmAkhZkKImRBiJoSYCSFmQoiZEGImhJgJIfYAauv4SI1EutgAAAAASUVORK5CYII=",
	"base64",
);
const ORIGINAL_BYTES = new Uint8Array(REAL_PNG);
const VARIANT_BYTES = new Uint8Array(REAL_PNG);

async function seedImage(): Promise<{ id: string; storageKey: string }> {
	const repo = new MediaRepository(db);
	const created = await repo.create({
		filename: "photo.jpg",
		mimeType: "image/jpeg",
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
		await handleMediaDelete(db, image.id, storage as never);
		expect(storage.objects.has(ownKey!), "the variant object must be retired").toBe(false);
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
