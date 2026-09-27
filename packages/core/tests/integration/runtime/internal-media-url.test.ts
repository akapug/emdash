/**
 * A bare internal media URL (`/_emdash/api/media/file/<storageKey>`) names a
 * media item by its storage key, and a storage key is never the item's id:
 * every upload path mints the two apart. The WordPress importer's URL map
 * gives such URLs, and its rewrite step normalizes a post's featured image
 * from one. Through the real local provider and repository, the URL resolves
 * to the item itself: its id, its size and its alt.
 */
import { afterEach, beforeEach, expect, it } from "vitest";

import { MediaRepository } from "../../../src/database/repositories/media.js";
import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { INTERNAL_MEDIA_PREFIX, normalizeMediaValue } from "../../../src/media/normalize.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("a bare internal media URL", (dialect) => {
	let ctx: DialectTestContext;
	let repo: MediaRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new MediaRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	/** The providers as the runtime registers them: the local one, over this database. */
	const providers = () => {
		const local = createMediaProvider({ db: ctx.db });
		return (id: string) => (id === "local" ? local : undefined);
	};

	const hero = () =>
		repo.create({
			filename: "hero.png",
			mimeType: "image/png",
			size: 2048,
			storageKey: "01KEXAMPLEHERO0000000000000.png",
			width: 1237,
			height: 906,
			alt: "A pond at dawn",
		});

	it("resolves to the media item stored under its key: the item's id, its size and its alt", async () => {
		const item = await hero();
		expect(item.id).not.toBe(item.storageKey);

		const value = await normalizeMediaValue(
			`${INTERNAL_MEDIA_PREFIX}${item.storageKey}`,
			providers(),
		);

		expect(value).toEqual({
			provider: "local",
			id: item.id,
			filename: "hero.png",
			mimeType: "image/png",
			width: 1237,
			height: 906,
			alt: "A pond at dawn",
			meta: { storageKey: item.storageKey, caption: null, blurhash: null, dominantColor: null },
		});
	});

	it("still resolves a bare media id to its item", async () => {
		const item = await hero();
		expect(await normalizeMediaValue(item.id, providers())).toMatchObject({
			provider: "local",
			id: item.id,
			width: 1237,
			meta: { storageKey: item.storageKey },
		});
	});

	it("stays the URL it was for a key no ready item is stored under", async () => {
		const pending = await repo.createPending({
			filename: "upload.png",
			mimeType: "image/png",
			storageKey: "01KEXAMPLEPENDING000000000.png",
		});
		for (const key of [pending.storageKey, "01KEXAMPLEMISSING000000000.png"]) {
			const url = `${INTERNAL_MEDIA_PREFIX}${key}`;
			expect(await normalizeMediaValue(url, providers()), key).toEqual({
				provider: "external",
				id: "",
				src: url,
			});
		}
	});
});
