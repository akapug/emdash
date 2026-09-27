/**
 * POST /_emdash/api/settings/email — the test email. It reports "sent" only
 * for a send the pipeline says was sent: one an email:beforeSend plugin
 * cancelled returns normally and sent nothing, and the answer says so.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../../../src/astro/routes/api/settings/email.js";
import type { Database } from "../../../src/database/types.js";
import type { EmailSendResult } from "../../../src/plugins/email.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("the test email route", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function post(outcome: EmailSendResult): Promise<Response> {
		return POST({
			request: new Request("http://test.local/_emdash/api/settings/email", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ to: "owner@example.com" }),
			}),
			locals: {
				user: { id: "u1", role: Role.ADMIN },
				emdash: {
					db,
					email: { isAvailable: () => true, send: async () => outcome },
				},
			},
		} as unknown as Parameters<typeof POST>[0]);
	}

	it("says sent for a send the pipeline sent", async () => {
		const res = await post({ status: "sent" });
		expect(res.status).toBe(200);
		expect((await res.json()).data).toMatchObject({ success: true });
	});

	it("says NOT sent, and names the plugin, for a send an email:beforeSend plugin cancelled", async () => {
		const res = await post({ status: "cancelled", by: "quiet-hours" });
		expect(res.status).toBe(422);
		const body = await res.json();
		expect(body.error).toMatchObject({ code: "EMAIL_CANCELLED" });
		expect(body.error.message).toMatch(/not sent: the plugin "quiet-hours" cancelled it/);
		expect(JSON.stringify(body)).not.toMatch(/"success":true/);
	});
});
