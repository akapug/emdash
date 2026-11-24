import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import * as collectionRoute from "../../../src/astro/routes/api/schema/collections/[slug]/index.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import type { Collection } from "../../../src/schema/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type RouteContext = Parameters<typeof collectionRoute.GET>[0];

const slug = "events";
const replacement = { label: "Events", labelSingular: "Event" };

function withExpected(item: Collection) {
	return {
		expected: {
			id: item.id,
			label: item.label,
			labelSingular: item.labelSingular ?? null,
			description: item.description ?? null,
			urlPattern: item.urlPattern ?? null,
			updatedAt: item.updatedAt,
		},
		...replacement,
	};
}

describeEachDialect("schema collection label PATCH", (dialect) => {
	let ctx: DialectTestContext;
	let registry: SchemaRegistry;
	let invalidateUrlPatternCache: ReturnType<typeof vi.fn>;
	let body: ReturnType<typeof withExpected>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		registry = new SchemaRegistry(ctx.db);
		invalidateUrlPatternCache = vi.fn();
		await registry.createCollection({
			slug,
			label: "Imported events",
			supports: ["drafts"],
			hidden: true,
		});
		await ctx.db
			.updateTable("_emdash_collections")
			.set({ updated_at: "2020-01-02T03:04:05.000Z" })
			.where("slug", "=", slug)
			.execute();
		body = withExpected(await readCollection());
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("changes only the label pair and timestamp and returns the same envelope as GET", async () => {
		const before = await storedCollection();
		expect(body.expected).toMatchObject({
			labelSingular: null,
			description: null,
			urlPattern: null,
		});

		const response = await patch(body);

		expect(response.status).toBe(200);
		const item = await readCollection();
		expect(item).toMatchObject(replacement);
		expect(item.updatedAt).not.toBe(before.updated_at);
		expect(await response.json()).toEqual({ success: true, data: { item } });
		expect(await storedCollection()).toEqual({
			...before,
			label: replacement.label,
			label_singular: replacement.labelSingular,
			updated_at: item.updatedAt,
		});
		expect(invalidateUrlPatternCache).toHaveBeenCalledTimes(1);
	});

	it("leaves an intervening owner edit intact", async () => {
		await registry.updateCollection(slug, {
			labelSingular: "Owner event",
			description: "Owner description",
			urlPattern: "/calendar/{slug}",
		});
		const before = await storedCollection();

		const response = await patch(body);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(await storedCollection()).toEqual(before);
		expect(invalidateUrlPatternCache).not.toHaveBeenCalled();
	});

	it.each([
		["id", "another-id"],
		["label", "Stale plural"],
		["labelSingular", "Stale singular"],
		["description", "Stale description"],
		["urlPattern", "/old/{slug}"],
		["updatedAt", "2019-01-02T03:04:05.000Z"],
	] as const)("refuses a stale %s even when all other fields match", async (key, value) => {
		const before = await storedCollection();

		const response = await patch({ ...body, expected: { ...body.expected, [key]: value } });

		expect(response.status).toBe(409);
		expect(await storedCollection()).toEqual(before);
		expect(invalidateUrlPatternCache).not.toHaveBeenCalled();
	});

	it("uses the requested slug as part of the precondition", async () => {
		const before = await storedCollection();

		expect((await patch(body, Role.ADMIN, "other_events")).status).toBe(409);
		expect(await storedCollection()).toEqual(before);
	});

	it("lets only one of two competing label pairs replace the same snapshot", async () => {
		await registry.updateCollection(slug, {
			labelSingular: "Imported event",
			description: "Original description",
			urlPattern: "/events/{slug}",
		});
		const withMetadata = withExpected(await readCollection());
		const results = await Promise.all([
			patch(withMetadata),
			patch({ ...withMetadata, label: "Calendar entries", labelSingular: "Calendar entry" }),
		]);

		expect(results.map((response) => response.status).toSorted((a, b) => a - b)).toEqual([
			200, 409,
		]);
		const winner = results.find((response) => response.status === 200);
		expect(await winner?.json()).toEqual({ success: true, data: { item: await readCollection() } });
		expect(invalidateUrlPatternCache).toHaveBeenCalledTimes(1);
	});

	it.each([
		[null, 401],
		[Role.EDITOR, 403],
	] as const)("refuses role %s without schema:manage", async (role, status) => {
		const before = await storedCollection();

		expect((await patch(body, role)).status).toBe(status);
		expect(await storedCollection()).toEqual(before);
	});

	it("requires the complete precondition and rejects extra keys at either level", async () => {
		const before = await storedCollection();
		const incompleteExpected = { ...body.expected, updatedAt: undefined };
		for (const invalid of [
			{ ...body, expected: incompleteExpected },
			{ ...body, description: "Wrong level" },
			{ ...body, expected: { ...body.expected, extra: "Unknown field" } },
			{ ...body, labelSingular: undefined },
		]) {
			expect((await patch(invalid)).status).toBe(400);
		}
		expect(await storedCollection()).toEqual(before);
		expect(invalidateUrlPatternCache).not.toHaveBeenCalled();
	});

	function routeContext(
		method: string,
		requestedSlug: string,
		role: RoleLevel | null,
		input?: unknown,
	) {
		const url = new URL(`http://localhost/_emdash/api/schema/collections/${requestedSlug}`);
		return {
			url,
			params: { slug: requestedSlug },
			request: new Request(url, {
				method,
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify(input),
			}),
			locals: {
				emdash: { db: ctx.db, invalidateUrlPatternCache },
				user: role === null ? undefined : { id: "test-user", role },
			},
		} as RouteContext;
	}

	async function readCollection(): Promise<Collection> {
		const response = await collectionRoute.GET(routeContext("GET", slug, Role.ADMIN));
		expect(response.status).toBe(200);
		const { data } = (await response.json()) as { data: { item: Collection } };
		return data.item;
	}

	function patch(input: unknown, role: RoleLevel | null = Role.ADMIN, requestedSlug = slug) {
		expect(typeof collectionRoute.PATCH).toBe("function");
		return collectionRoute.PATCH(routeContext("PATCH", requestedSlug, role, input));
	}

	function storedCollection() {
		return ctx.db
			.selectFrom("_emdash_collections")
			.selectAll()
			.where("slug", "=", slug)
			.executeTakeFirstOrThrow();
	}
});
