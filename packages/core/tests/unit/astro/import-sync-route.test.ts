import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { describe, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/import/wordpress/sync.js";

const body = {
	version: 1,
	operationId: "receipt-1",
	grant: { id: "grant-1", bindingId: "binding-1", generation: 1 },
	source: { site: "https://source.example", type: "page", id: "42" },
	collection: "pages",
	locale: "en",
	sequence: 1,
	slug: "home",
	data: { title: "Home" },
};

function context(options: { role?: number; scopes?: string[]; authenticated?: boolean } = {}) {
	const emdash = {
		getImportSyncCapability: vi.fn().mockResolvedValue({
			version: 1,
			available: true,
			mappedFieldsOnly: true,
			grantGenerationFence: true,
		}),
		handleImportSync: vi.fn().mockResolvedValue({ success: true, data: { state: "applied" } }),
	};
	const ctx = {
		url: new URL("https://tenant.example/_emdash/api/import/wordpress/sync?collection=pages"),
		locals: {
			user:
				options.authenticated === false
					? null
					: { id: "importer", role: options.role ?? Role.ADMIN },
			tokenScopes: options.scopes,
			emdash,
		},
		request: new Request("https://tenant.example/_emdash/api/import/wordpress/sync", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		}),
	};
	return { ctx: ctx as unknown as APIContext, emdash };
}

describe("import sync route", () => {
	it.each([GET, POST])(
		"requires authentication and permission before capability or writes",
		async (route) => {
			for (const options of [{ authenticated: false }, { role: Role.SUBSCRIBER }]) {
				const { ctx, emdash } = context(options);
				const response = await route(ctx);
				expect([401, 403]).toContain(response.status);
				expect(emdash.getImportSyncCapability).not.toHaveBeenCalled();
				expect(emdash.handleImportSync).not.toHaveBeenCalled();
			}
		},
	);

	it.each([GET, POST])("rejects a non-admin token even for an admin user", async (route) => {
		const { ctx, emdash } = context({ scopes: ["content:write"] });
		expect((await route(ctx)).status).toBe(403);
		expect(emdash.handleImportSync).not.toHaveBeenCalled();
		expect(emdash.getImportSyncCapability).not.toHaveBeenCalled();
	});

	it("discovers a versioned capability without writing", async () => {
		const { ctx, emdash } = context({ scopes: ["admin"] });
		const response = await GET(ctx);
		expect(await response.json()).toEqual({
			success: true,
			data: { version: 1, available: true, mappedFieldsOnly: true, grantGenerationFence: true },
		});
		expect(emdash.getImportSyncCapability).toHaveBeenCalledWith("pages");
		expect(emdash.handleImportSync).not.toHaveBeenCalled();
	});

	it("rejects malformed discovery collections without invoking the runtime", async () => {
		const { ctx, emdash } = context();
		ctx.url.searchParams.set("collection", "pages; DROP TABLE revisions");
		expect((await GET(ctx)).status).toBe(400);
		expect(emdash.getImportSyncCapability).not.toHaveBeenCalled();
	});

	it("passes the authenticated actor, never a caller-supplied author", async () => {
		const { ctx, emdash } = context();
		expect((await POST(ctx)).status).toBe(200);
		expect(emdash.handleImportSync).toHaveBeenCalledWith(body, {
			id: "importer",
			role: Role.ADMIN,
		});
	});

	it("refuses malformed or forged authority before the runtime", async () => {
		const { ctx, emdash } = context();
		ctx.request = new Request(ctx.url, {
			method: "POST",
			body: JSON.stringify({ ...body, authorId: "forged" }),
		});
		expect((await POST(ctx)).status).toBe(400);
		expect(emdash.handleImportSync).not.toHaveBeenCalled();
	});

	it("requires explicit grant evidence before invoking the runtime", async () => {
		const { ctx, emdash } = context();
		const { grant: _grant, ...withoutGrant } = body;
		ctx.request = new Request(ctx.url, {
			method: "POST",
			body: JSON.stringify(withoutGrant),
		});
		expect((await POST(ctx)).status).toBe(400);
		expect(emdash.handleImportSync).not.toHaveBeenCalled();
	});

	it("refuses old runtimes explicitly", async () => {
		const { ctx } = context();
		ctx.locals.emdash = {} as typeof ctx.locals.emdash;
		expect((await GET(ctx)).status).toBe(501);
		expect((await POST(ctx)).status).toBe(501);
	});
});
