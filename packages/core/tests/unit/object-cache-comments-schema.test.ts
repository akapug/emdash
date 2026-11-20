import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("../../src/loader.js", () => ({ getDb: vi.fn() }));

import { getComments } from "../../src/comments/query.js";
import { CommentReactionRepository } from "../../src/database/repositories/comment-reaction.js";
import { CommentRepository } from "../../src/database/repositories/comment.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { getDb } from "../../src/loader.js";
import {
	__setObjectCacheBackendForTests,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { invalidateUrlPatternCache } from "../../src/query.js";
import { getCollectionByUrlPattern, getCollectionInfo } from "../../src/schema/query.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (k) => Promise.resolve(store.get(k) ?? null),
		set: (k, v) => {
			store.set(k, v);
			return Promise.resolve();
		},
		delete: (k) => {
			store.delete(k);
			return Promise.resolve();
		},
	};
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("object cache: schema (getCollectionInfo)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(getDb).mockResolvedValue(db);
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });
	});
	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("serves the second read from KV, and busts on a schema change", async () => {
		const first = await getCollectionInfo("post");
		expect(first?.slug).toBe("post");
		await flush();

		// D1 down — a cached read must not need it.
		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));
		const second = await getCollectionInfo("post");
		expect(second?.slug).toBe("post");

		// A schema change bumps the schema epoch → next read reloads (and now
		// D1 is down, so it surfaces).
		invalidateUrlPatternCache();
		await flush();
		await expect(getCollectionInfo("post")).rejects.toThrow(/D1 unavailable/);
	});

	it("discovers an empty custom-named collection from its URL pattern", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "mec_events", label: "Unmapped events" });
		await registry.createCollection({
			slug: "community_calendar",
			label: "Community calendar",
			urlPattern: "/events/{slug}",
		});

		const collection = await getCollectionByUrlPattern("/events/{slug}");
		expect(collection?.slug).toBe("community_calendar");
		expect(collection?.urlPattern).toBe("/events/{slug}");
	});

	it("does not expose an unroutable collection or match a different URL pattern", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "internal_calendar",
			label: "Internal calendar",
			urlPattern: "/events/{slug}",
			routable: false,
		});
		await registry.createCollection({
			slug: "public_calendar",
			label: "Public calendar",
			urlPattern: "/calendar/{slug}",
		});

		await expect(getCollectionByUrlPattern("/events/{slug}")).resolves.toBeNull();
		await expect(getCollectionByUrlPattern("/missing/{slug}")).resolves.toBeNull();
	});

	it("refuses ambiguous routable collections rather than picking the first", async () => {
		const registry = new SchemaRegistry(db);
		for (const slug of ["first_calendar", "second_calendar"]) {
			await registry.createCollection({ slug, label: slug, urlPattern: "/events/{slug}" });
		}

		await expect(getCollectionByUrlPattern("/events/{slug}")).rejects.toThrow(/ambiguous/i);
	});

	it("caches pattern discovery and reloads after schema invalidation", async () => {
		await new SchemaRegistry(db).createCollection({
			slug: "community_calendar",
			label: "Community calendar",
			urlPattern: "/events/{slug}",
		});
		expect((await getCollectionByUrlPattern("/events/{slug}"))?.slug).toBe("community_calendar");
		await flush();

		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));
		expect((await getCollectionByUrlPattern("/events/{slug}"))?.slug).toBe("community_calendar");
		invalidateUrlPatternCache();
		await flush();
		await expect(getCollectionByUrlPattern("/events/{slug}")).rejects.toThrow(/D1 unavailable/);
	});

	it("does not collide between distinct URL pattern cache keys", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "community_calendar",
			label: "Community calendar",
			urlPattern: "/events/{slug}",
		});
		await registry.createCollection({
			slug: "sessions",
			label: "Sessions",
			urlPattern: "/sessions/{slug}",
		});

		expect((await getCollectionByUrlPattern("/events/{slug}"))?.slug).toBe("community_calendar");
		await flush();
		expect((await getCollectionByUrlPattern("/sessions/{slug}"))?.slug).toBe("sessions");
	});

	it("invalidates a cached missing collection when routing metadata changes", async () => {
		await expect(getCollectionByUrlPattern("/events/{slug}")).resolves.toBeNull();
		await flush();
		await new SchemaRegistry(db).createCollection({
			slug: "community_calendar",
			label: "Community calendar",
			urlPattern: "/events/{slug}",
		});
		invalidateUrlPatternCache();
		await flush();
		expect((await getCollectionByUrlPattern("/events/{slug}"))?.slug).toBe("community_calendar");
	});
});

describe("object cache: comments (getComments)", () => {
	let db: Kysely<Database>;
	let postId: string;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		vi.mocked(getDb).mockResolvedValue(db);
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });

		const post = await new ContentRepository(db).create({
			type: "post",
			slug: "p1",
			data: { title: "P1" },
		});
		postId = post.id;
		await new CommentRepository(db).create({
			collection: "post",
			contentId: postId,
			authorName: "A",
			authorEmail: "a@example.com",
			body: "first!",
			status: "approved",
		});
		await flush();
	});
	afterEach(async () => {
		__setObjectCacheBackendForTests(null);
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	it("serves the second read from KV, and busts when a comment is written", async () => {
		const first = await getComments({ collection: "post", contentId: postId });
		expect(first.total).toBe(1);
		await flush();

		vi.mocked(getDb).mockRejectedValue(new Error("D1 unavailable"));
		const second = await getComments({ collection: "post", contentId: postId });
		expect(second.total).toBe(1); // served from KV, no D1

		// Posting another comment bumps the comments epoch → reload (D1 down).
		vi.mocked(getDb).mockResolvedValue(db);
		await new CommentRepository(db).create({
			collection: "post",
			contentId: postId,
			authorName: "B",
			authorEmail: "b@example.com",
			body: "second!",
			status: "approved",
		});
		await flush();
		const third = await getComments({ collection: "post", contentId: postId });
		expect(third.total).toBe(2);
	});

	it("does not collide when reactions/sort differ from a prior cached call", async () => {
		const base = await getComments({ collection: "post", contentId: postId });
		const commentId = base.items[0]!.id;
		await new CommentReactionRepository(db).toggle({
			commentId,
			reaction: "like",
			voterHash: "voter-1",
		});
		await flush();

		// Reaction-less call: no counts attached.
		const plain = await getComments({ collection: "post", contentId: postId });
		expect(plain.items[0]!.reactions).toBeUndefined();
		await flush();

		// reactions:true must get its own entry, not the reaction-less snapshot.
		const withReactions = await getComments({
			collection: "post",
			contentId: postId,
			reactions: true,
		});
		expect(withReactions.items[0]!.reactions).toEqual({ like: 1 });
	});

	it("busts the comments cache when a reaction is toggled", async () => {
		const { handleReactionToggle } = await import("../../src/api/handlers/comment-reactions.js");
		const base = await getComments({ collection: "post", contentId: postId, reactions: true });
		const commentId = base.items[0]!.id;
		expect(base.items[0]!.reactions).toBeUndefined();
		await flush();

		const res = await handleReactionToggle(db, {
			collection: "post",
			contentId: postId,
			commentId,
			reaction: "like",
			voterHash: "voter-1",
		});
		expect(res.success).toBe(true);
		await flush();

		const after = await getComments({ collection: "post", contentId: postId, reactions: true });
		expect(after.items[0]!.reactions).toEqual({ like: 1 });
	});
});
