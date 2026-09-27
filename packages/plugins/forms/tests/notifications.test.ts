/**
 * The mail a submission sends: who a reply reaches, and when a form has sent enough.
 *
 * The count of submissions is the form's own stored rows, so these tests hand the handler a
 * `count` that answers what a real collection would for the window it is asked about.
 */
import { describe, expect, it, vi } from "vitest";

import { handleDigest } from "../src/handlers/cron.js";
import { submitHandler } from "../src/handlers/submit.js";
import type { FormDefinition } from "../src/types.js";

type Field = { name: string; label: string; type: string; required: boolean };

function form(fields: Field[], settings: Record<string, unknown> = {}): FormDefinition {
	return {
		name: "Contact",
		slug: "contact",
		status: "active",
		pages: [{ fields }],
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		settings: {
			spamProtection: "none",
			notifyEmails: ["office@example.org"],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			submitLabel: "Send",
			confirmationMessage: "Thanks",
			...settings,
		},
	} as unknown as FormDefinition;
}

const EMAIL: Field = { name: "email", label: "Email", type: "email", required: true };
const MESSAGE: Field = { name: "message", label: "Message", type: "textarea", required: true };

/** `stored` = how many submissions of the form each window holds, the new one included. */
function context(f: FormDefinition, data: Record<string, unknown>, stored = { hour: 1, day: 1 }) {
	const send = vi.fn(async () => {});
	const put = vi.fn(async () => {});
	const count = vi.fn(async (where?: { createdAt?: { gte?: string } }) => {
		const since = where?.createdAt?.gte;
		if (!since) return stored.day;
		return Date.now() - Date.parse(since) <= 3_600_000 + 5_000 ? stored.hour : stored.day;
	});
	const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const ctx = {
		input: { formId: "contact", data },
		storage: {
			forms: {
				get: async (id: string) => (id === "contact" ? f : null),
				put: async () => {},
				query: async () => ({ items: [] }),
			},
			submissions: { put, count },
		},
		kv: { get: async () => null },
		log,
		email: { send },
		requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
	};
	return { ctx, send, put, count, log };
}

describe("a notification's reply-to", () => {
	it("is the visitor, when the form asks for their address", async () => {
		const { ctx, send } = context(form([EMAIL, MESSAGE]), {
			email: "visitor@example.net",
			message: "Hello",
		});

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).toMatchObject({
			to: "office@example.org",
			replyTo: "visitor@example.net",
		});
	});

	it("is left to the email provider (the site's own address) when the form asks for none", async () => {
		const { ctx, send } = context(form([MESSAGE]), { message: "Hello" });

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).not.toHaveProperty("replyTo");
	});
});

describe("a form's mail limits", () => {
	it("sends up to the hour's limit, counting this submission", async () => {
		const { ctx, send } = context(
			form([EMAIL]),
			{ email: "visitor@example.net" },
			{ hour: 10, day: 10 },
		);

		await submitHandler(ctx as never, { perHour: 10, perDay: 50 });

		expect(send).toHaveBeenCalledOnce();
	});

	it("stores a submission past the hour's limit and mails nobody about it", async () => {
		const { ctx, send, put, log } = context(
			form([EMAIL]),
			{ email: "visitor@example.net" },
			{ hour: 11, day: 11 },
		);

		const result = await submitHandler(ctx as never, { perHour: 10, perDay: 50 });

		expect(result).toMatchObject({ success: true });
		expect(put).toHaveBeenCalledOnce();
		expect(send).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledWith("Submission stored; no email sent for it", {
			formId: "contact",
			why: "the form has taken 11 submissions in the last hour, past its limit of 10",
		});
	});

	it("holds the day's limit when every hour is under its own", async () => {
		const { ctx, send, log } = context(
			form([EMAIL]),
			{ email: "visitor@example.net" },
			{ hour: 2, day: 51 },
		);

		await submitHandler(ctx as never, { perHour: 10, perDay: 50 });

		expect(send).not.toHaveBeenCalled();
		expect(log.warn.mock.calls[0]![1]).toMatchObject({
			why: expect.stringMatching(/last day, past its limit of 50/),
		});
	});

	it("counts this form's submissions only, over the last hour and the last day", async () => {
		const { ctx, count } = context(form([EMAIL]), { email: "visitor@example.net" });
		const before = Date.now();

		await submitHandler(ctx as never);

		const windows = count.mock.calls
			.map(([w]) => w as { formId: string; createdAt?: { gte: string } })
			.filter((w): w is { formId: string; createdAt: { gte: string } } => Boolean(w.createdAt));
		expect(windows.map((w) => w.formId)).toEqual(["contact", "contact"]);
		const ages = windows.map((w) => before - Date.parse(w.createdAt.gte));
		expect(ages[0]).toBeGreaterThanOrEqual(3_600_000 - 1_000);
		expect(ages[0]).toBeLessThanOrEqual(3_600_000 + 1_000);
		expect(ages[1]).toBeGreaterThanOrEqual(86_400_000 - 1_000);
	});

	it("refuses the autoresponder past the limit too: it mails the address a visitor typed", async () => {
		const f = form([EMAIL], {
			notifyEmails: [],
			autoresponder: { subject: "Thanks", body: "We got it" },
		});
		const over = context(f, { email: "visitor@example.net" }, { hour: 11, day: 11 });
		const under = context(f, { email: "visitor@example.net" }, { hour: 1, day: 1 });

		await submitHandler(over.ctx as never, { perHour: 10, perDay: 50 });
		await submitHandler(under.ctx as never, { perHour: 10, perDay: 50 });

		expect(over.send).not.toHaveBeenCalled();
		expect(under.send).toHaveBeenCalledOnce();
	});

	it("asks nothing when the submission would mail nobody", async () => {
		const { ctx, count } = context(form([EMAIL], { notifyEmails: [] }), {
			email: "visitor@example.net",
		});

		await submitHandler(ctx as never);

		expect(
			count.mock.calls.filter(([w]) => (w as { createdAt?: unknown } | undefined)?.createdAt),
		).toHaveLength(0);
	});
});

describe("a mail that fails to send", () => {
	const refused = () => {
		throw new Error("E_RECIPIENT_NOT_ALLOWED: office@example.org is not allowed");
	};

	it("is logged with the recipient's domain, never the address, and the submission is kept", async () => {
		const { ctx, send, put, log } = context(form([EMAIL]), { email: "visitor@example.net" });
		send.mockImplementation(async () => refused());

		const result = await submitHandler(ctx as never);

		expect(result).toMatchObject({ success: true });
		expect(put).toHaveBeenCalledOnce();
		expect(log.error).toHaveBeenCalledWith("Failed to send notification email", {
			error: "Error: E_RECIPIENT_NOT_ALLOWED: <an address at example.org> is not allowed",
			toDomain: "example.org",
		});
		expect(JSON.stringify(log.error.mock.calls)).not.toContain("office@");
	});

	it("keeps no address in any letter case, quoted or in the error's cause", async () => {
		const { ctx, send, log } = context(form([EMAIL]), { email: "visitor@example.net" });
		send.mockImplementation(async () => {
			throw new Error('E_RECIPIENT_NOT_ALLOWED: "Office@Example.ORG" is not allowed', {
				cause: new Error("rejected <OFFICE@example.org>; reply-to Visitor@Example.net"),
			});
		});

		await submitHandler(ctx as never);

		expect(log.error).toHaveBeenCalledWith("Failed to send notification email", {
			error:
				'Error: E_RECIPIENT_NOT_ALLOWED: "<an address at example.org>" is not allowed [cause: Error: rejected <<an address at example.org>>; reply-to <an address at Example.net>]',
			toDomain: "example.org",
		});
		expect(JSON.stringify(log.error.mock.calls).toLowerCase()).not.toMatch(/office@|visitor@/);
	});

	it("is logged with the visitor's domain, never the address, from the autoresponder", async () => {
		const { ctx, send, log } = context(
			form([EMAIL], {
				notifyEmails: [],
				autoresponder: { subject: "Thanks", body: "We got it" },
			}),
			{ email: "Visitor@Example.net" },
		);
		send.mockImplementation(async () => {
			throw new Error("E_RECIPIENT_NOT_ALLOWED: visitor@example.NET is not allowed");
		});

		await submitHandler(ctx as never);

		expect(send).toHaveBeenCalledOnce();
		expect(log.error).toHaveBeenCalledWith("Failed to send autoresponder", {
			error: "Error: E_RECIPIENT_NOT_ALLOWED: <an address at Example.net> is not allowed",
			toDomain: "Example.net",
		});
		expect(JSON.stringify(log.error.mock.calls).toLowerCase()).not.toContain("visitor@");
	});

	it("is logged the same way from the daily digest", async () => {
		const f = form([EMAIL], { digestEnabled: true });
		const send = vi.fn(async () => refused());
		const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
		const ctx = {
			storage: {
				forms: { get: async () => f },
				submissions: {
					// A stored submission: its row's data is the Submission, whose own data is what the visitor sent.
					query: async () => ({
						items: [
							{
								id: "S1",
								data: {
									formId: "contact",
									data: { email: "visitor@example.net" },
									createdAt: "2026-01-01T00:00:00.000Z",
								},
							},
						],
					}),
				},
			},
			log,
			email: { send },
			site: { url: "https://example.org", name: "Example", locale: "en" },
		};

		await handleDigest("contact", ctx as never);

		expect(send).toHaveBeenCalledOnce();
		expect(log.error).toHaveBeenCalledWith("Failed to send digest email", {
			error: "Error: E_RECIPIENT_NOT_ALLOWED: <an address at example.org> is not allowed",
			toDomain: "example.org",
		});
		expect(JSON.stringify(log.error.mock.calls)).not.toContain("office@");
	});
});
