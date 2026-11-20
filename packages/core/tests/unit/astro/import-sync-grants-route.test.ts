import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import * as grantsRoute from "../../../src/astro/routes/api/import/wordpress/sync/grants.js";

const createBody = {
	sourceSite: "https://source.example",
	bindingId: "binding-1",
	actorId: "importer",
};
const revokeBody = { id: "grant-1" };
const grant = { ...createBody, id: "grant-1", generation: 1, revoked: false };
const endpoint = "https://tenant.example/_emdash/api/import/wordpress/sync/grants";
const operations = [
	{ method: "POST", route: grantsRoute.POST, body: createBody },
	{ method: "DELETE", route: grantsRoute.DELETE, body: revokeBody },
] as const;

function context(
	method: string,
	body: unknown,
	options: { role?: number; scopes?: string[]; authenticated?: boolean } = {},
) {
	const emdash = {
		handleImportSyncGrantCreate: vi.fn().mockResolvedValue({ success: true, data: grant }),
		handleImportSyncGrantRevoke: vi.fn().mockResolvedValue({
			success: true,
			data: { ...grant, generation: 2, revoked: true },
		}),
	};
	const ctx = {
		url: new URL(endpoint),
		locals: {
			user:
				options.authenticated === false
					? null
					: { id: "administrator", role: options.role ?? Role.ADMIN },
			tokenScopes: options.scopes,
			emdash,
		},
		request: new Request(endpoint, {
			method,
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		}),
	};
	return { ctx: ctx as unknown as APIContext, emdash };
}

function expectNoGrantMutation(emdash: ReturnType<typeof context>["emdash"]) {
	expect(emdash.handleImportSyncGrantCreate).not.toHaveBeenCalled();
	expect(emdash.handleImportSyncGrantRevoke).not.toHaveBeenCalled();
}

describe("import sync grant route", () => {
	it("registers the explicit grant endpoint without a state-changing GET", () => {
		const routes: Array<{ pattern: string; entrypoint: string }> = [];
		injectCoreRoutes((route) => routes.push(route));
		expect(routes).toContainEqual({
			pattern: new URL(endpoint).pathname,
			entrypoint: expect.stringContaining("api/import/wordpress/sync/grants"),
		});
		expect(grantsRoute).not.toHaveProperty("GET");
	});

	it.each(operations)(
		"$method requires authentication before mutations",
		async ({ method, route, body }) => {
			const { ctx, emdash } = context(method, body, { authenticated: false });
			expect((await route(ctx)).status).toBe(401);
			expectNoGrantMutation(emdash);
		},
	);

	it.each(operations)("$method rejects non-admin users", async ({ method, route, body }) => {
		for (const role of [Role.SUBSCRIBER, Role.EDITOR]) {
			const { ctx, emdash } = context(method, body, { role, scopes: ["admin"] });
			expect((await route(ctx)).status).toBe(403);
			expectNoGrantMutation(emdash);
		}
	});

	it.each(operations)(
		"$method rejects an admin PAT without admin scope",
		async ({ method, route, body }) => {
			for (const scopes of [[], ["content:write"]]) {
				const { ctx, emdash } = context(method, body, { scopes });
				expect((await route(ctx)).status).toBe(403);
				expectNoGrantMutation(emdash);
			}
		},
	);

	it("creates a grant using the authenticated administrator as the authorizing actor", async () => {
		const { ctx, emdash } = context("POST", createBody, { scopes: ["admin"] });
		const response = await grantsRoute.POST(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: grant });
		expect(emdash.handleImportSyncGrantCreate).toHaveBeenCalledWith(createBody, {
			id: "administrator",
			role: Role.ADMIN,
		});
		expect(emdash.handleImportSyncGrantRevoke).not.toHaveBeenCalled();
	});

	it("returns the revoked grant through the explicit DELETE operation", async () => {
		const { ctx, emdash } = context("DELETE", revokeBody);
		const response = await grantsRoute.DELETE(ctx);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: { ...grant, generation: 2, revoked: true },
		});
		expect(emdash.handleImportSyncGrantRevoke).toHaveBeenCalledWith(revokeBody, {
			id: "administrator",
			role: Role.ADMIN,
		});
		expect(emdash.handleImportSyncGrantCreate).not.toHaveBeenCalled();
	});

	it.each(operations)(
		"$method rejects caller-controlled grant state",
		async ({ method, route, body }) => {
			for (const extra of [{ generation: 99 }, { revoked: false }]) {
				const { ctx, emdash } = context(method, { ...body, ...extra });
				expect((await route(ctx)).status).toBe(400);
				expectNoGrantMutation(emdash);
			}
		},
	);

	it.each([
		{ method: "POST", route: grantsRoute.POST, body: { ...createBody, sourceSite: "not a URL" } },
		{ method: "POST", route: grantsRoute.POST, body: { ...createBody, bindingId: " " } },
		{ method: "POST", route: grantsRoute.POST, body: { ...createBody, actorId: "" } },
		{ method: "DELETE", route: grantsRoute.DELETE, body: { id: "" } },
	])("rejects malformed $method requests before mutation", async ({ method, route, body }) => {
		const { ctx, emdash } = context(method, body);
		expect((await route(ctx)).status).toBe(400);
		expectNoGrantMutation(emdash);
	});

	it("maps a missing grant to NOT_FOUND", async () => {
		const { ctx, emdash } = context("DELETE", revokeBody);
		emdash.handleImportSyncGrantRevoke.mockResolvedValue({
			success: false,
			error: { code: "NOT_FOUND", message: "Import grant not found" },
		});
		const response = await grantsRoute.DELETE(ctx);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "Import grant not found" },
		});
	});

	it.each(operations)(
		"$method refuses old runtimes explicitly",
		async ({ method, route, body }) => {
			const { ctx, emdash } = context(method, body);
			ctx.locals.emdash = {} as typeof ctx.locals.emdash;
			const response = await route(ctx);
			expect(response.status).toBe(501);
			expect(await response.json()).toMatchObject({
				success: false,
				error: { code: "IMPORT_SYNC_UNAVAILABLE" },
			});
			expectNoGrantMutation(emdash);
		},
	);
});
