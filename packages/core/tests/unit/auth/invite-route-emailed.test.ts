/**
 * POST /_emdash/api/auth/invite says whether it emailed the invite: `emailed:
 * true` only for a send the pipeline reports "sent". Anything else answers
 * `emailed: false` with the link, so a caller (the admin UI, an operator's
 * tool) never counts an invite as emailed on a 2xx alone.
 */

import type { EmailMessage } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as invitePost } from "../../../src/astro/routes/api/auth/invite/index.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("invite route — whether the invite was emailed", () => {
	let db: Kysely<Database>;
	let admin: { id: string; role: number };

	beforeEach(async () => {
		db = await setupTestDatabase();
		const created = await createKyselyAdapter(db).createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		admin = { id: created.id, role: created.role };
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function invite(email: unknown, to = "invitee@example.com") {
		const res = await invitePost({
			request: new Request("http://test.local/_emdash/api/auth/invite", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: to }),
			}),
			locals: { user: admin, emdash: { db, config: { siteUrl: "https://example.com" }, email } },
		} as unknown as Parameters<typeof invitePost>[0]);
		return { status: res.status, data: (await res.json()).data };
	}

	it("says emailed: true, with no link, when the pipeline reports the invite sent", async () => {
		const sent: EmailMessage[] = [];
		const { status, data } = await invite({
			isAvailable: () => true,
			send: async (message: EmailMessage) => (sent.push(message), { status: "sent" }),
		});
		expect(status).toBe(200);
		expect(data).toMatchObject({ success: true, emailed: true });
		expect(data).not.toHaveProperty("inviteUrl");
		expect(sent).toHaveLength(1);
	});

	it("says emailed: false, with the link, when the send does not report sent", async () => {
		const { data } = await invite({ isAvailable: () => true, send: async () => undefined });
		expect(data).toMatchObject({ success: true, emailed: false });
		expect(data.inviteUrl).toContain("/invite/accept?token=");
		expect(data.message).toMatch(/was not sent/);
	});

	it("says emailed: false, with the link, when no provider is configured", async () => {
		const { data } = await invite(undefined, "other@example.com");
		expect(data).toMatchObject({ success: true, emailed: false });
		expect(typeof data.inviteUrl).toBe("string");
	});
});
