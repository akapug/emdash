import { describe, expect, it } from "vitest";
import { formatNotifyEmails, parseNotifyEmails } from "../src/notify-emails.js";
import { formCreateSchema, formUpdateSchema } from "../src/schemas.js";

describe("forms admin notifyEmails helpers (emb/141)", () => {
	it("parses empty input to an empty list with no error", () => {
		expect(parseNotifyEmails("")).toEqual({ emails: [], error: null });
		expect(parseNotifyEmails(" , \n ; ")).toEqual({ emails: [], error: null });
	});

	it("splits on commas, semicolons, and newlines, trims, and deduplicates case-insensitively", () => {
		const res = parseNotifyEmails(
			" owner@example.org, team@example.org;\nOWNER@example.org\ninfo@example.org ",
		);
		expect(res).toEqual({
			emails: ["owner@example.org", "team@example.org", "info@example.org"],
			error: null,
		});
		expect(formatNotifyEmails(res.emails)).toBe(
			"owner@example.org, team@example.org, info@example.org",
		);
	});

	it("rejects invalid addresses and enforces MAX_NOTIFY_EMAILS (10)", () => {
		const bad = parseNotifyEmails("owner@example.org, not-an-email");
		expect(bad.error).toContain("not-an-email");

		const eleven = Array.from({ length: 11 }, (_, i) => `u${i}@example.org`).join(", ");
		const tooMany = parseNotifyEmails(eleven);
		expect(tooMany.error).toContain("10");
	});

	it("round-trips parsed notifyEmails through formCreateSchema and formUpdateSchema", () => {
		const { emails, error } = parseNotifyEmails("a@example.org, b@example.org");
		expect(error).toBeNull();
		const created = formCreateSchema.parse({
			name: "Contact",
			slug: "contact",
			pages: [{ fields: [{ id: "f1", name: "email", label: "Email", type: "email", required: true }] }],
			settings: { notifyEmails: emails },
		});
		expect(created.settings.notifyEmails).toEqual(["a@example.org", "b@example.org"]);

		const updated = formUpdateSchema.parse({
			id: "form-1",
			settings: { notifyEmails: emails },
		});
		expect(updated.settings?.notifyEmails).toEqual(["a@example.org", "b@example.org"]);
	});
});
