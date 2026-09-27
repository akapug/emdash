import { definePlugin, type PluginContext, type PluginDefinition } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";
import { describe, it, expect, vi } from "vitest";

import {
	CLOUDFLARE_EMAIL_CAPABILITY,
	cloudflareEmail,
	createCloudflareEmailDeliver,
	createCloudflareEmailStatus,
	createPlugin,
	displayName,
	domainOf,
	headerText,
	limitsOf,
	mailbox,
	PRUNE_TASK,
	pruneBudgets,
	withoutAddresses,
	type CloudflareEmailConfig,
} from "../src/plugins/cloudflare-email.js";

const message = {
	to: "user@example.com",
	subject: "Your magic link",
	text: "Click here",
};

const event: EmailDeliverEvent = { message, source: "system" };

/** Plugin KV as the host gives it: get/set/list/delete plus compare-and-set on a revision. */
function memoryKv(initial: Record<string, unknown> = {}) {
	const rows = new Map<string, { value: unknown; revision: string }>();
	let rev = 0;
	for (const [k, v] of Object.entries(initial)) rows.set(k, { value: v, revision: String(++rev) });
	return {
		rows,
		async get<T>(key: string) {
			return (rows.get(key)?.value ?? null) as T | null;
		},
		async getVersioned<T>(key: string) {
			const row = rows.get(key);
			return row ? { value: row.value as T, revision: row.revision } : null;
		},
		async compareAndSet(key: string, expected: string | null, value: unknown) {
			const row = rows.get(key);
			if ((row?.revision ?? null) !== expected) return { applied: false as const };
			const revision = String(++rev);
			rows.set(key, { value, revision });
			return { applied: true as const, revision };
		},
		async compareAndDelete(key: string, expected: string) {
			if (rows.get(key)?.revision !== expected) return { applied: false as const };
			rows.delete(key);
			return { applied: true as const };
		},
		async set(key: string, value: unknown) {
			rows.set(key, { value, revision: String(++rev) });
		},
		async delete(key: string) {
			return rows.delete(key);
		},
		async list(prefix = "") {
			return [...rows]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, r]) => ({ key, value: r.value }));
		},
	};
}

function fakeCtx(opts: { site?: string; kv?: ReturnType<typeof memoryKv> } = {}): PluginContext {
	return {
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		kv: opts.kv ?? memoryKv(),
		site: { name: opts.site ?? "", url: "https://example.org", locale: "en" },
	} as unknown as PluginContext;
}

/** What the binding is handed. */
type Sent = {
	from: { email: string; name?: string };
	to: string;
	subject: string;
	replyTo?: string;
} & Record<string, unknown>;

function fakeEnv(sendImpl?: () => Promise<{ messageId?: string }>) {
	const send = vi.fn<(message: Sent) => Promise<{ messageId?: string }>>(
		sendImpl ?? (async () => ({ messageId: "msg-1" })),
	);
	return { env: { EMAIL: { send } }, send };
}

describe("cloudflareEmail()", () => {
	it("returns a descriptor with a bundlable entrypoint (not an in-process definition)", () => {
		// The astro integration rejects `plugins: []` entries without an
		// `entrypoint` (#1721), so the documented usage must produce a
		// descriptor the integration can statically import at build time.
		const descriptor = cloudflareEmail({ from: "cms@mails.example.com" });
		expect(descriptor.id).toBe("cloudflare-email");
		expect(descriptor.entrypoint).toBe("@emdash-cms/cloudflare/plugins/cloudflare-email");
		expect(descriptor.format).toBe("native");
		expect(descriptor.options).toEqual({ from: "cms@mails.example.com" });
		expect(descriptor.capabilities).toEqual(["hooks.email-transport:register"]);
	});

	it("rejects a missing or invalid from address", () => {
		expect(() => cloudflareEmail({ from: "" })).toThrow(/config\.from is required/);
		expect(() =>
			cloudflareEmail({ from: { email: "not-an-address" } } as CloudflareEmailConfig),
		).toThrow(/config\.from is required/);
	});

	it("cannot be wrapped in definePlugin(), which would drop its hooks", () => {
		const descriptor = cloudflareEmail({ from: "cms@mails.example.com" });
		expect(() => definePlugin(descriptor as unknown as PluginDefinition)).toThrow(
			/plugin descriptor for "cloudflare-email"/,
		);
	});
});

describe("createPlugin()", () => {
	it("returns a resolved plugin with an exclusive email:deliver hook", () => {
		const plugin = createPlugin({ from: "cms@mails.example.com" });
		expect(plugin.id).toBe("cloudflare-email");
		expect(plugin.capabilities).toEqual(["hooks.email-transport:register"]);
		const hook = plugin.hooks["email:deliver"];
		expect(hook).toBeDefined();
		expect(hook).toMatchObject({ exclusive: true });
	});

	it("rejects a missing or invalid from address", () => {
		expect(() => createPlugin({ from: "" })).toThrow(/config\.from is required/);
	});

	it("round-trips the descriptor options the virtual plugins module passes back", async () => {
		const descriptor = cloudflareEmail({ from: "cms@mails.example.com" });
		// Simulate what the generated virtual:emdash/plugins module does:
		// `createPlugin(descriptor.options)`.
		const plugin = createPlugin(descriptor.options as CloudflareEmailConfig);
		const hook = plugin.hooks["email:deliver"];
		expect(hook).toBeDefined();

		// The handler resolves the env via cloudflare:workers, which is not
		// available in vitest — assert it fails with the runtime-guard error
		// rather than a config error, proving the wiring is intact.
		await expect(hook?.handler(event, fakeCtx())).rejects.toThrow(
			/cloudflare:workers is not available/,
		);
	});
});

describe("createCloudflareEmailDeliver()", () => {
	it("sends through the binding with from/replyTo applied", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: { email: "cms@mails.example.com", name: "CMS" }, replyTo: "hello@example.com" },
			async () => env,
		);

		await deliver(event, fakeCtx());

		expect(send).toHaveBeenCalledWith({
			from: { email: "cms@mails.example.com", name: "CMS" },
			to: "user@example.com",
			subject: "Your magic link",
			text: "Click here",
			replyTo: "hello@example.com",
		});
	});

	it("accepts a bare string from and omits optional fields", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await deliver(event, fakeCtx());

		expect(send).toHaveBeenCalledWith({
			from: { email: "cms@mails.example.com" },
			to: "user@example.com",
			subject: "Your magic link",
			text: "Click here",
		});
	});

	it("passes html through when present", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await deliver(
			{ message: { ...message, html: "<p>Click here</p>" }, source: "system" },
			fakeCtx(),
		);

		expect(send).toHaveBeenCalledWith(expect.objectContaining({ html: "<p>Click here</p>" }));
	});

	it("passes cc through when the config allows it, and prefers the message's replyTo over the configured one", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com", replyTo: "hello@example.com", allowCc: true },
			async () => env,
		);

		await deliver(
			{
				message: { ...message, cc: ["team@example.com"], replyTo: "visitor@example.com" },
				source: "forms",
			},
			fakeCtx(),
		);

		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ cc: ["team@example.com"], replyTo: "visitor@example.com" }),
		);
	});

	it("resolves the binding by its configured name", async () => {
		const send = vi.fn(async () => ({ messageId: "msg-2" }));
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com", binding: "MAILER" },
			async () => ({ MAILER: { send } }),
		);

		await deliver(event, fakeCtx());

		expect(send).toHaveBeenCalledOnce();
	});

	it("throws a descriptive error when the binding is missing", async () => {
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => ({}),
		);

		await expect(deliver(event, fakeCtx())).rejects.toThrow(/binding "EMAIL" not found/);
	});

	it("refuses a cc unless the config allows it, before the budget or the binding", async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await expect(
			deliver(
				{ message: { ...message, cc: ["team@example.com"] }, source: "forms" },
				fakeCtx({ kv }),
			),
		).rejects.toThrow(/a cc is not sent unless the config allows it \(allowCc\)/);

		expect(send).not.toHaveBeenCalled();
		expect([...kv.rows.keys()]).toEqual([]);
		// An empty cc is no cc.
		await deliver({ message: { ...message, cc: [] }, source: "forms" }, fakeCtx({ kv }));
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]![0]).not.toHaveProperty("cc");
	});

	it("propagates provider errors so the pipeline can surface them", async () => {
		const { env } = fakeEnv(async () => {
			throw new Error("sender domain not verified");
		});
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await expect(deliver(event, fakeCtx())).rejects.toThrow("sender domain not verified");
	});
});

describe("the sender's name", () => {
	it("is the site's title when the config names nobody", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org" },
			async () => env,
		);

		await deliver(event, fakeCtx({ site: "Example Garden Club" }));

		expect(send.mock.calls[0]![0]).toMatchObject({
			from: { email: "notify@mail.example.org", name: "Example Garden Club" },
		});
	});

	it("is the configured name when the config gives one", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: { email: "notify@mail.example.org", name: "Example CMS" } },
			async () => env,
		);

		await deliver(event, fakeCtx({ site: "Example Garden Club" }));

		expect(send.mock.calls[0]![0].from).toEqual({
			email: "notify@mail.example.org",
			name: "Example CMS",
		});
	});

	it("carries no line break, quote or angle bracket from the title", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org" },
			async () => env,
		);

		await deliver(event, fakeCtx({ site: 'Club"\r\nBcc: victim@example.net <boss@example.org>' }));

		const { name } = send.mock.calls[0]![0].from;
		expect(name).toBe("Club Bcc: victim@example.net boss@example.org");
		expect(name).not.toMatch(/[\r\n"<>]/);
	});
});

describe("headers a visitor or an admin can reach", () => {
	it("a subject loses its CR and LF, so it cannot start another header", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org" },
			async () => env,
		);

		await deliver(
			{
				message: { ...message, subject: "New submission\r\nBcc: victim@example.net" },
				source: "emdash-forms",
			},
			fakeCtx(),
		);

		expect(send.mock.calls[0]![0].subject).toBe("New submission Bcc: victim@example.net");
	});

	it("a reply-to that is not one plain address is dropped, and the message still goes", async () => {
		for (const replyTo of [
			"visitor@example.net\r\nBcc: victim@example.net",
			"visitor@example.net, victim@example.net",
			"Visitor <visitor@example.net>",
			"visitor@example.net\u0000",
		]) {
			const { env, send } = fakeEnv();
			const ctx = fakeCtx();
			const deliver = createCloudflareEmailDeliver(
				{ from: "notify@mail.example.org" },
				async () => env,
			);

			await deliver({ message: { ...message, replyTo }, source: "emdash-forms" }, ctx);

			expect(send).toHaveBeenCalledOnce();
			expect(send.mock.calls[0]![0]).not.toHaveProperty("replyTo");
			expect(ctx.log.warn).toHaveBeenCalledWith("reply-to dropped: it is not one plain address", {
				source: "emdash-forms",
			});
		}
	});

	it("a recipient that is not one plain address is refused before the binding", async () => {
		for (const to of [
			"a@example.org, b@example.org",
			"a@example.org\r\nBcc: b@example.org",
			"nobody",
		]) {
			const { env, send } = fakeEnv();
			const deliver = createCloudflareEmailDeliver(
				{ from: "notify@mail.example.org" },
				async () => env,
			);

			await expect(
				deliver({ message: { ...message, to }, source: "emdash-forms" }, fakeCtx()),
			).rejects.toThrow(/every recipient must be one plain address/);
			expect(send).not.toHaveBeenCalled();
		}
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org" },
			async () => env,
		);
		await expect(
			deliver(
				{
					message: { ...message, cc: ["ok@example.org", "x@example.org;y@example.org"] },
					source: "x",
				},
				fakeCtx(),
			),
		).rejects.toThrow(/one plain address/);
		expect(send).not.toHaveBeenCalled();
	});

	it("mailbox, headerText and displayName are exact about what they keep", () => {
		expect(mailbox(" someone+tag@sub.example.org ")).toBe("someone+tag@sub.example.org");
		expect(mailbox("someone@localhost")).toBeNull();
		expect(mailbox(`${"a".repeat(250)}@example.org`)).toBeNull();
		expect(headerText("a\tb\u2028c\u0085d   e", 250)).toBe("a b c d e");
		expect(headerText("x".repeat(300), 250)).toHaveLength(250);
		expect(displayName("\r\n")).toBeUndefined();
	});
});

describe("reply-to when the message names nobody", () => {
	it("is the site's own address from the plugin's Reply-To setting", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", replyTo: "fallback@example.org" },
			async () => env,
		);

		await deliver(event, fakeCtx({ kv: memoryKv({ "settings:replyTo": "office@example.org" }) }));

		expect(send.mock.calls[0]![0].replyTo).toBe("office@example.org");
	});

	it("is the visitor when the message names one, over the site's own address", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org" },
			async () => env,
		);

		await deliver(
			{ message: { ...message, replyTo: "visitor@example.net" }, source: "emdash-forms" },
			fakeCtx({ kv: memoryKv({ "settings:replyTo": "office@example.org" }) }),
		);

		expect(send.mock.calls[0]![0].replyTo).toBe("visitor@example.net");
	});
});

describe("the sending budget", () => {
	const at = (iso: string) => () => new Date(iso);

	it("refuses a source past its hourly limit, and never calls the binding for it", async () => {
		const { env, send } = fakeEnv();
		const ctx = fakeCtx();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perHour: 2, perDay: 10 } },
			async () => env,
			at("2026-01-01T10:15:00Z"),
		);
		const forms = { message, source: "emdash-forms" };

		await deliver(forms, ctx);
		await deliver(forms, ctx);
		await expect(deliver(forms, ctx)).rejects.toThrow(/would pass its limit of 2/);

		expect(send).toHaveBeenCalledTimes(2);
		expect(ctx.log.warn).toHaveBeenCalledWith(
			"email refused: sending budget spent",
			expect.objectContaining({ source: "emdash-forms" }),
		);
	});

	it("gives each source its own budget, so a flooded form leaves the login email its own", async () => {
		const { env, send } = fakeEnv();
		const ctx = fakeCtx();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perHour: 1, perDay: 10 } },
			async () => env,
			at("2026-01-01T10:15:00Z"),
		);

		await deliver({ message, source: "emdash-forms" }, ctx);
		await expect(deliver({ message, source: "emdash-forms" }, ctx)).rejects.toThrow(/limit/);
		await deliver({ message, source: "system" }, ctx);

		expect(send).toHaveBeenCalledTimes(2);
	});

	it("counts every recipient, cc included", async () => {
		const { env, send } = fakeEnv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perHour: 2, perDay: 10 }, allowCc: true },
			async () => env,
			at("2026-01-01T10:15:00Z"),
		);

		await expect(
			deliver(
				{ message: { ...message, cc: ["b@example.org", "c@example.org"] }, source: "x" },
				fakeCtx(),
			),
		).rejects.toThrow(/3 more|and 3/);
		expect(send).not.toHaveBeenCalled();
	});

	it("holds the day across hours, and a send deletes no hour's count, its own or another's", async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const ctx = fakeCtx({ kv });
		const cfg = { from: "notify@mail.example.org", limits: { perHour: 1, perDay: 2 } };

		await createCloudflareEmailDeliver(
			cfg,
			async () => env,
			at("2026-01-01T10:15:00Z"),
		)({ message, source: "x" }, ctx);
		await createCloudflareEmailDeliver(
			cfg,
			async () => env,
			at("2026-01-01T11:15:00Z"),
		)({ message, source: "x" }, ctx);
		await expect(
			createCloudflareEmailDeliver(
				cfg,
				async () => env,
				at("2026-01-01T12:15:00Z"),
			)({ message, source: "x" }, ctx),
		).rejects.toThrow(/this day/);

		expect(send).toHaveBeenCalledTimes(2);
		expect([...kv.rows.keys()].filter((k) => k.startsWith("budget:h:")).toSorted()).toEqual([
			"budget:h:2026-01-01T10:x",
			"budget:h:2026-01-01T11:x",
			"budget:h:2026-01-01T12:x",
		]);
	});

	it("a send that read its clock before midnight and ran after it deletes no count of the new day, so no cap is reset", async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const cfg = {
			from: "notify@mail.example.org",
			limits: { perHour: 100, perDay: 2, perDayTotal: 2, systemReserve: 0 },
		};
		const sendAt = (iso: string) =>
			createCloudflareEmailDeliver(
				cfg,
				async () => env,
				at(iso),
			)({ message, source: "x" }, fakeCtx({ kv }));

		await sendAt("2026-01-02T00:05:00Z");
		await sendAt("2026-01-02T00:06:00Z");
		await expect(sendAt("2026-01-02T00:07:00Z")).rejects.toThrow(/"x" this day has reached 2/);
		// The stalled send: its windows are yesterday's, which hold nothing, so it goes.
		await sendAt("2026-01-01T23:59:59Z");

		// Today's counts are as they were: the cap still refuses.
		expect(kv.rows.get("budget:d:2026-01-02:x")?.value).toBe(2);
		expect(kv.rows.get("budget:t:2026-01-02")?.value).toBe(2);
		expect(kv.rows.get("budget:h:2026-01-02T00:x")?.value).toBe(2);
		await expect(sendAt("2026-01-02T00:08:00Z")).rejects.toThrow(/"x" this day has reached 2/);
		expect(send).toHaveBeenCalledTimes(3);
	});

	it("a send stalled across an hour deletes no count of the new hour", async () => {
		const { env } = fakeEnv();
		const kv = memoryKv();
		const cfg = { from: "notify@mail.example.org", limits: { perHour: 1, perDay: 100 } };
		const sendAt = (iso: string) =>
			createCloudflareEmailDeliver(
				cfg,
				async () => env,
				at(iso),
			)({ message, source: "x" }, fakeCtx({ kv }));

		await sendAt("2026-01-01T11:00:01Z");
		await sendAt("2026-01-01T10:59:59Z");
		expect(kv.rows.get("budget:h:2026-01-01T11:x")?.value).toBe(1);
		await expect(sendAt("2026-01-01T11:30:00Z")).rejects.toThrow(/"x" this hour has reached 1/);
	});

	it("no send lists or deletes a count, on any path: sent, refused, contended or refunded", async () => {
		// Counts of every kind from earlier windows, which any cleanup on the send path would find.
		const seeded = {
			"budget:h:2026-01-01T08:x": 1,
			"budget:h:2026-01-01T09:x": 1,
			"budget:d:2025-12-30:x": 1,
			"budget:t:2025-12-30": 1,
			"budget:r:2025-12-30:0123456789abcdef0123456789abcdef": 1,
		};
		const run = async (
			limits: CloudflareEmailConfig["limits"],
			{ sendImpl, contended = false }: { sendImpl?: () => Promise<never>; contended?: boolean } = {},
		) => {
			const kv = memoryKv(seeded);
			const calls: string[] = [];
			const watched = {
				...kv,
				list: async (prefix?: string) => (calls.push(`list ${prefix}`), kv.list(prefix)),
				delete: async (key: string) => (calls.push(`delete ${key}`), kv.delete(key)),
				compareAndDelete: async (key: string, rev: string) => (
					calls.push(`compareAndDelete ${key}`), kv.compareAndDelete(key, rev)
				),
				// Every compare-and-set loses: the take is contended, and refused.
				...(contended ? { compareAndSet: async () => ({ applied: false as const }) } : {}),
			};
			const outcome = await createCloudflareEmailDeliver(
				{ from: "notify@mail.example.org", limits },
				async () => fakeEnv(sendImpl).env,
				at("2026-01-01T10:00:01Z"),
			)({ message, source: "system" }, fakeCtx({ kv: watched as typeof kv })).then(
				() => "sent",
				(e: Error) => e.message,
			);
			for (const key of Object.keys(seeded)) expect(kv.rows.has(key), key).toBe(true);
			return { outcome, calls };
		};

		expect(await run({ perHour: 5, perDay: 5 })).toEqual({ outcome: "sent", calls: [] });
		const refused = await run({ perHour: 0, perDay: 5 });
		expect(refused.outcome).toMatch(/"system" this hour has reached 0/);
		expect(refused.calls).toEqual([]);
		const contended = await run({ perHour: 5, perDay: 5 }, { contended: true });
		expect(contended.outcome).toMatch(/kept changing under concurrent sends/);
		expect(contended.calls).toEqual([]);
		const refunded = await run(
			{ perHour: 5, perDay: 5 },
			{
				sendImpl: async () => {
					throw new Error("E_RECIPIENT_NOT_ALLOWED");
				},
			},
		);
		expect(refunded.outcome).toMatch(/E_RECIPIENT_NOT_ALLOWED/);
		expect(refunded.calls).toEqual([]);
	});

	it("a message the day refuses spends nothing of the hour", async () => {
		const { env } = fakeEnv();
		const kv = memoryKv();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perHour: 5, perDay: 1 } },
			async () => env,
			at("2026-01-01T10:15:00Z"),
		);

		await deliver({ message, source: "x" }, fakeCtx({ kv }));
		await expect(deliver({ message, source: "x" }, fakeCtx({ kv }))).rejects.toThrow(
			/"x" this day/,
		);

		expect(kv.rows.get("budget:h:2026-01-01T10:x")?.value).toBe(1);
		expect(kv.rows.get("budget:t:2026-01-01")?.value).toBe(1);
	});

	it("never lets two sends at once take the last place", async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		// Every read answers what it answered first: a writer that loses the race must read again.
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perHour: 1, perDay: 10 } },
			async () => env,
			at("2026-01-01T10:15:00Z"),
		);

		const results = await Promise.allSettled([
			deliver({ message, source: "x" }, fakeCtx({ kv })),
			deliver({ message, source: "x" }, fakeCtx({ kv })),
		]);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(send).toHaveBeenCalledOnce();
	});
});

describe("the site's totals", () => {
	const at = (iso: string) => () => new Date(iso);
	const deliverWith = (limits: CloudflareEmailConfig["limits"], env: Record<string, unknown>) =>
		createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits },
			async () => env,
			at("2026-01-01T10:15:00Z"),
		);

	it("every source together has a daily total, whatever each source has left", async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const deliver = deliverWith({ perHour: 10, perDay: 10, perDayTotal: 3, systemReserve: 0 }, env);

		for (const source of ["emdash-forms", "emdash-comments", "admin"])
			await deliver({ message, source }, fakeCtx({ kv }));
		await expect(deliver({ message, source: "another-plugin" }, fakeCtx({ kv }))).rejects.toThrow(
			/every source together this day has reached 3 recipient\(s\), and 1 more would pass its limit of 3/,
		);

		expect(send).toHaveBeenCalledTimes(3);
		expect(kv.rows.get("budget:t:2026-01-01")?.value).toBe(3);
		// The next day is a new total.
		await createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perDayTotal: 3, systemReserve: 0 } },
			async () => env,
			at("2026-01-02T00:01:00Z"),
		)({ message, source: "another-plugin" }, fakeCtx({ kv }));
		expect(send).toHaveBeenCalledTimes(4);
	});

	it('a part of the daily total is kept for "system" mail: forms and comments together cannot spend the day the login email needs', async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const deliver = deliverWith({ perHour: 10, perDay: 10, perDayTotal: 4, systemReserve: 2 }, env);

		await deliver({ message, source: "emdash-forms" }, fakeCtx({ kv }));
		await deliver({ message, source: "emdash-comments" }, fakeCtx({ kv }));
		await expect(deliver({ message, source: "emdash-forms" }, fakeCtx({ kv }))).rejects.toThrow(
			/every source together this day, less the 2 kept for "system" mail, has reached 2 recipient\(s\), and 1 more would pass its limit of 2/,
		);
		// The login email still goes, up to the whole total.
		await deliver(event, fakeCtx({ kv }));
		await deliver(
			{ message: { ...message, to: "editor@example.com" }, source: "system" },
			fakeCtx({ kv }),
		);
		await expect(deliver(event, fakeCtx({ kv }))).rejects.toThrow(
			/every source together this day has reached 4/,
		);
		expect(send).toHaveBeenCalledTimes(4);
		expect(kv.rows.get("budget:t:2026-01-01")?.value).toBe(4);
	});

	it("the reserve is 50 of the 300 a day by default, and never more than the total", async () => {
		expect(limitsOf({ from: "notify@mail.example.org" })).toMatchObject({
			perDayTotal: 300,
			systemReserve: 50,
		});
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const deliver = deliverWith({ perDayTotal: 1, systemReserve: 5 }, env);
		await expect(deliver({ message, source: "emdash-forms" }, fakeCtx({ kv }))).rejects.toThrow(
			/its limit of 0/,
		);
		await deliver(event, fakeCtx({ kv }));
		expect(send).toHaveBeenCalledOnce();
	});

	it('"system" mail reaches one address only so often a day; other addresses, and other sources, still get theirs', async () => {
		const { env, send } = fakeEnv();
		const kv = memoryKv();
		const ctx = fakeCtx({ kv });
		const deliver = deliverWith({ perHour: 100, perDay: 100, systemPerRecipient: 2 }, env);

		await deliver(event, ctx);
		await deliver({ message: { ...message, to: "USER@example.com" }, source: "system" }, ctx);
		const refused = deliver(event, ctx);
		await expect(refused).rejects.toThrow(
			/"system" mail to an address at example\.com today has reached 2 recipient\(s\), and 1 more would pass its limit of 2/,
		);
		await refused.catch((e: Error) => expect(e.message).not.toContain("user@"));

		await deliver({ message: { ...message, to: "other@example.com" }, source: "system" }, ctx);
		await deliver({ message, source: "emdash-forms" }, ctx);
		expect(send).toHaveBeenCalledTimes(4);
		// The count per address is kept under a hash: the site's database holds no address for it.
		const perAddress = [...kv.rows.keys()].filter((k) => k.startsWith("budget:r:"));
		expect(perAddress).toHaveLength(2);
		expect(perAddress.join(" ")).not.toContain("@");
		// And the refused one took nothing of the hour.
		expect(kv.rows.get("budget:h:2026-01-01T10:system")?.value).toBe(3);
	});

	it("a message the binding refuses gives its places back: only a send Cloudflare accepts is counted", async () => {
		const kv = memoryKv();
		let refuse = true;
		const { env, send } = fakeEnv(async () => {
			if (refuse) throw new Error("E_RECIPIENT_NOT_ALLOWED");
			return { messageId: "msg-9" };
		});
		const deliver = deliverWith(
			{ perHour: 1, perDay: 1, perDayTotal: 1, systemPerRecipient: 1 },
			env,
		);

		await expect(deliver(event, fakeCtx({ kv }))).rejects.toThrow("E_RECIPIENT_NOT_ALLOWED");
		expect(
			[...kv.rows.entries()].filter(([k]) => k.startsWith("budget:")).map(([, r]) => r.value),
		).toEqual([0, 0, 0, 0]);

		refuse = false;
		await deliver(event, fakeCtx({ kv }));
		expect(send).toHaveBeenCalledTimes(2);
		await expect(deliver(event, fakeCtx({ kv }))).rejects.toThrow(/would pass its limit of 1/);
	});
});

describe("what a log carries", () => {
	it("the delivered log names the recipient's domain, never the address", async () => {
		const { env } = fakeEnv();
		const ctx = fakeCtx();
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await deliver({ message, source: "emdash-forms" }, ctx);

		expect(ctx.log.info).toHaveBeenCalledWith("email delivered via Cloudflare Email Sending", {
			toDomain: "example.com",
			subject: "Your magic link",
			source: "emdash-forms",
			messageId: "msg-1",
		});
		expect(JSON.stringify(vi.mocked(ctx.log.info).mock.calls)).not.toContain("user@");
	});

	it("an error the binding throws names the recipient's domain in place of the address", async () => {
		const { env } = fakeEnv(async () => {
			throw Object.assign(
				new Error("E_RECIPIENT_NOT_ALLOWED: User@Example.com is not allowed (user@example.com)"),
				{ code: "E_RECIPIENT_NOT_ALLOWED" },
			);
		});
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		await expect(deliver(event, fakeCtx())).rejects.toMatchObject({
			message:
				"E_RECIPIENT_NOT_ALLOWED: <an address at example.com> is not allowed (<an address at example.com>)",
			code: "E_RECIPIENT_NOT_ALLOWED",
		});
	});

	it("an error the binding throws keeps no address in any case, quoted, in its stack or in its cause", async () => {
		const { env } = fakeEnv(async () => {
			throw new Error('E_RECIPIENT_NOT_ALLOWED: "USER@example.com"', {
				cause: new Error("upstream: <User@Example.Com> refused, reply-to Visitor@Example.net"),
			});
		});
		const deliver = createCloudflareEmailDeliver(
			{ from: "cms@mails.example.com" },
			async () => env,
		);

		const error = (await deliver(
			{ message: { ...message, replyTo: "visitor@example.net" }, source: "emdash-forms" },
			fakeCtx(),
		).catch((e: unknown) => e)) as Error & { cause: Error };

		expect(error.message).toBe('E_RECIPIENT_NOT_ALLOWED: "<an address at example.com>"');
		const told =
			`${error.message}${error.stack}${error.cause.message}${error.cause.stack}`.toLowerCase();
		expect(told).not.toMatch(/user@|visitor@/);
	});

	it("domainOf and withoutAddresses keep the domain and nothing of the local part", () => {
		expect(domainOf("o'brien+forms@sub.example.org")).toBe("sub.example.org");
		// The named address in any case, and every other address in the text too.
		expect(
			withoutAddresses("to A@x.example.org and a@x.example.org, not b@x.example.org", [
				"a@x.example.org",
			]),
		).toBe(
			"to <an address at x.example.org> and <an address at x.example.org>, not <an address at x.example.org>",
		);
		expect(withoutAddresses("İstanbul a@x.example.org", ["a@x.example.org"])).toBe(
			"İstanbul <an address at x.example.org>",
		);
	});
});

const TOKEN = "tok_0123456789abcdef0123456789abcdef0123456";

/**
 * The mail-budget service as its service binding exposes it: `take` answers a
 * take or a refusal from `answer` (default: a take), and every call is kept.
 */
function fakeBudget(
	answer: (req: { recipients: string[] }) => unknown = () => ({
		ok: true,
		protocol: 2,
		takeId: "take-1",
	}),
) {
	type Take = { protocol: number; token: string; recipients: string[] };
	type Refund = { protocol: number; token: string; takeId: string };
	const takes: Take[] = [];
	const refunds: Refund[] = [];
	const service = {
		take: vi.fn(async (req: Take) => {
			takes.push(req);
			return answer(req);
		}),
		refund: vi.fn(async (req: Refund) => {
			refunds.push(req);
			return { ok: true, protocol: 2, refunded: 1 };
		}),
	};
	return { service, takes, refunds, env: { MAIL_BUDGET: service, MAIL_BUDGET_TOKEN: TOKEN } };
}

describe("the account's budget", () => {
	const withBudget = (env: Record<string, unknown>) =>
		createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", accountBudget: {}, allowCc: true },
			async () => env,
		);

	it("every message takes its place there too, and only the recipients' hashes leave the Worker", async () => {
		const mail = fakeEnv();
		const budget = fakeBudget();
		await withBudget({ ...mail.env, ...budget.env })(
			{
				message: { ...message, to: "User@Example.com", cc: ["team@example.com"] },
				source: "system",
			},
			fakeCtx(),
		);

		expect(mail.send).toHaveBeenCalledOnce();
		expect(budget.takes).toHaveLength(1);
		const [take] = budget.takes;
		// The request carries the token and the hashes only: no source, no lane, no
		// `system`. The lane is the token's registration, and this Worker's token is
		// its plugin lane's, so EmDash's own "system" mail from here takes no reserve.
		expect(Object.keys(take!).sort()).toEqual(["protocol", "recipients", "token"]);
		expect(take).toMatchObject({ protocol: 2, token: TOKEN });
		expect(take!.recipients).toHaveLength(2);
		for (const h of take!.recipients) expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(JSON.stringify(budget.takes)).not.toContain("@");
		// The hash is of the address in lower case: one recipient, whatever its case.
		const again = fakeBudget();
		await withBudget({ ...fakeEnv().env, ...again.env })(
			{ message: { ...message, to: "user@example.com" }, source: "system" },
			fakeCtx(),
		);
		expect(again.takes[0]!.recipients[0]).toBe(take!.recipients[0]);
		// A form's mail asks the same way: nothing a source says reaches the request.
		await withBudget({ ...fakeEnv().env, ...again.env })(
			{ message, source: "emdash-forms" },
			fakeCtx(),
		);
		expect(Object.keys(again.takes[1]!).sort()).toEqual(["protocol", "recipients", "token"]);
		expect(JSON.stringify(again.takes)).not.toMatch(/system|lane|source/);
	});

	it("a Worker without the service binding or the token sends nothing, spends nothing of the site's, and says why", async () => {
		for (const [env, why] of [
			[{ MAIL_BUDGET_TOKEN: TOKEN }, /no service binding "MAIL_BUDGET" in this Worker/],
			[
				{ MAIL_BUDGET: { take: async () => ({}) }, MAIL_BUDGET_TOKEN: TOKEN },
				/no service binding "MAIL_BUDGET"/,
			],
			[
				{ MAIL_BUDGET: fakeBudget().service },
				/no token: the secret "MAIL_BUDGET_TOKEN" is not set/,
			],
			[{ MAIL_BUDGET: fakeBudget().service, MAIL_BUDGET_TOKEN: "  " }, /no token/],
		] as const) {
			const mail = fakeEnv();
			const kv = memoryKv();
			await expect(
				withBudget({ ...mail.env, ...env })({ message, source: "emdash-forms" }, fakeCtx({ kv })),
			).rejects.toThrow(why);
			expect(mail.send).not.toHaveBeenCalled();
			expect([...kv.rows.keys()]).toEqual([]);
		}
	});

	it("a refusal there sends nothing and gives the site's places back", async () => {
		const mail = fakeEnv();
		const kv = memoryKv();
		const budget = fakeBudget(() => ({
			ok: false,
			protocol: 2,
			refused: "the account has sent 200 of its 200 today",
		}));
		await expect(
			withBudget({ ...mail.env, ...budget.env })(
				{ message, source: "emdash-forms" },
				fakeCtx({ kv }),
			),
		).rejects.toThrow(
			/the account's mail budget refused it: the account has sent 200 of its 200 today/,
		);
		expect(mail.send).not.toHaveBeenCalled();
		expect(Array.from(kv.rows.values(), (r) => r.value)).toEqual([0, 0, 0]);
	});

	it("an error asking it, or an answer that is neither a take nor a refusal, sends nothing", async () => {
		for (const [answer, why] of [
			[
				() => {
					throw new Error("service unavailable for User@Example.com");
				},
				/could not be asked \(Error: service unavailable for <an address at example\.com>\), so nothing is sent/,
			],
			[() => ({ protocol: 2 }), /answered neither a take nor a refusal/],
			[() => ({ ok: true, protocol: 2 }), /answered neither a take nor a refusal/],
		] as const) {
			const mail = fakeEnv();
			const budget = fakeBudget(answer);
			const error = (await withBudget({ ...mail.env, ...budget.env })(
				{ message: { ...message, to: "user@example.com" }, source: "system" },
				fakeCtx(),
			).catch((e: unknown) => e)) as Error;
			expect(error.message).toMatch(why);
			expect(error.message.toLowerCase()).not.toContain("user@");
			expect(mail.send).not.toHaveBeenCalled();
		}
	});

	/**
	 * The host's lifetime extender as a test sees it: every piece of work the
	 * provider hands it, kept. Nothing else keeps an isolate alive after the
	 * response: work that is not handed here is work Cloudflare may never run.
	 */
	const lifetime = () => {
		const held: Promise<unknown>[] = [];
		return { held, extend: (work: Promise<unknown>) => void held.push(work) };
	};

	it("a take that does not answer in time sends nothing, gives the site's places back, and its give-back is held alive by the host", async () => {
		const mail = fakeEnv();
		const kv = memoryKv();
		let answer: (v: unknown) => void = () => {};
		const budget = fakeBudget();
		budget.service.take.mockImplementation(
			(req) => (budget.takes.push(req), new Promise((resolve) => (answer = resolve))),
		);
		const host = lifetime();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", accountBudget: { timeoutMs: 20 } },
			async () => ({ ...mail.env, ...budget.env }),
			undefined,
			host.extend,
		);
		await expect(deliver({ message, source: "emdash-forms" }, fakeCtx({ kv }))).rejects.toThrow(
			/the account's mail budget did not answer within 20 ms, so nothing is sent/,
		);
		expect(mail.send).not.toHaveBeenCalled();
		expect(Array.from(kv.rows.values(), (r) => r.value)).toEqual([0, 0, 0]);
		// The request is over, and the give-back is the host's to keep alive, not a
		// detached promise: exactly one piece of work was handed to it, and it is
		// still pending (the take has not answered).
		expect(host.held).toHaveLength(1);
		expect(budget.refunds).toEqual([]);
		// The take arrives after all: the work the host holds gives it back, and
		// settles only once it has.
		answer({ ok: true, protocol: 2, takeId: "take-late" });
		await Promise.all(host.held);
		expect(budget.refunds).toEqual([{ protocol: 2, token: TOKEN, takeId: "take-late" }]);
	});

	it("a refund that does not answer in time is not waited for, and is held alive by the host: the binding's error still reaches the caller", async () => {
		const mail = fakeEnv(async () => {
			throw new Error("E_RECIPIENT_NOT_ALLOWED");
		});
		const budget = fakeBudget();
		let refunded: (v: unknown) => void = () => {};
		budget.service.refund.mockImplementation(
			(req) => (budget.refunds.push(req), new Promise((resolve) => (refunded = resolve))),
		);
		const ctx = fakeCtx();
		const host = lifetime();
		await expect(
			createCloudflareEmailDeliver(
				{ from: "notify@mail.example.org", accountBudget: { timeoutMs: 20 } },
				async () => ({ ...mail.env, ...budget.env }),
				undefined,
				host.extend,
			)({ message, source: "system" }, ctx),
		).rejects.toThrow("E_RECIPIENT_NOT_ALLOWED");
		expect(ctx.log.warn).toHaveBeenCalledWith(
			"the account's mail budget did not answer a refund in time",
			{ timeoutMs: 20 },
		);
		// The pending refund is the host's to keep alive, and settles when it answers.
		expect(host.held).toHaveLength(1);
		let settled = false;
		void Promise.all(host.held).then(() => (settled = true));
		await Promise.resolve();
		expect(settled).toBe(false);
		refunded({ ok: true, protocol: 2, refunded: 1 });
		await Promise.all(host.held);
		expect(budget.refunds).toEqual([{ protocol: 2, token: TOKEN, takeId: "take-1" }]);
	});

	it("an answer in another protocol, or in none, sends nothing, and a take in it is given back before the refusal returns", async () => {
		for (const [answer, spoke] of [
			[{ ok: true, protocol: 1, takeId: "take-v1" }, "1"],
			[{ ok: true, takeId: "take-v0" }, "null"],
			[{ ok: false, protocol: "2", refused: "no" }, '"2"'],
		] as const) {
			const mail = fakeEnv();
			const kv = memoryKv();
			const budget = fakeBudget(() => answer);
			// A refund that takes a moment to answer: only one that was awaited has
			// settled by the time the refusal returns.
			const settled: string[] = [];
			budget.service.refund.mockImplementation(async (req) => {
				budget.refunds.push(req);
				await new Promise((resolve) => setTimeout(resolve, 5));
				settled.push(req.takeId);
				return { ok: true, protocol: 2, refunded: 1 };
			});
			const host = lifetime();
			await expect(
				createCloudflareEmailDeliver(
					{ from: "notify@mail.example.org", accountBudget: {}, allowCc: true },
					async () => ({ ...mail.env, ...budget.env }),
					undefined,
					host.extend,
				)({ message, source: "emdash-forms" }, fakeCtx({ kv })),
			).rejects.toThrow(
				`the account's mail budget answered in protocol ${spoke}, and this provider speaks 2, so nothing is sent`,
			);
			expect(mail.send).not.toHaveBeenCalled();
			expect(Array.from(kv.rows.values(), (r) => r.value)).toEqual([0, 0, 0]);
			// Given back already, awaited in the request: nothing left for the host.
			expect(settled).toEqual(answer.ok ? [answer.takeId] : []);
			expect(budget.refunds).toEqual(
				answer.ok ? [{ protocol: 2, token: TOKEN, takeId: answer.takeId }] : [],
			);
			expect(host.held).toEqual([]);
		}
	});

	it("a message the binding refuses gives its place back to the account's budget too", async () => {
		const mail = fakeEnv(async () => {
			throw new Error("E_RECIPIENT_NOT_ALLOWED");
		});
		const budget = fakeBudget(() => ({ ok: true, protocol: 2, takeId: "take-7" }));
		await expect(
			withBudget({ ...mail.env, ...budget.env })({ message, source: "system" }, fakeCtx()),
		).rejects.toThrow("E_RECIPIENT_NOT_ALLOWED");
		expect(budget.refunds).toEqual([{ protocol: 2, token: TOKEN, takeId: "take-7" }]);
	});

	it("a site that has spent its own day asks the account nothing", async () => {
		const budget = fakeBudget();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", accountBudget: {}, limits: { perDay: 1 } },
			async () => ({ ...fakeEnv().env, ...budget.env }),
			() => new Date("2026-01-01T10:00:00Z"),
		);
		const kv = memoryKv();
		await deliver({ message, source: "x" }, fakeCtx({ kv }));
		await expect(deliver({ message, source: "x" }, fakeCtx({ kv }))).rejects.toThrow(
			/"x" this day/,
		);
		expect(budget.takes).toHaveLength(1);
	});

	it("without accountBudget in the config, no account budget is asked, whatever the env holds", async () => {
		const budget = fakeBudget();
		await createCloudflareEmailDeliver({ from: "notify@mail.example.org" }, async () => ({
			...fakeEnv().env,
			...budget.env,
		}))(event, fakeCtx());
		expect(budget.takes).toEqual([]);
	});

	it("names other bindings when the config does", async () => {
		const budget = fakeBudget();
		const mail = fakeEnv();
		await createCloudflareEmailDeliver(
			{
				from: "notify@mail.example.org",
				accountBudget: { binding: "BUDGET2", token: "BUDGET2_TOKEN" },
			},
			async () => ({ ...mail.env, BUDGET2: budget.service, BUDGET2_TOKEN: TOKEN }),
		)(event, fakeCtx());
		expect(budget.takes).toHaveLength(1);
	});
});

describe("pruning the counts of windows that are over", () => {
	const seeded = () =>
		memoryKv({
			"budget:h:2026-01-03T10:x": 1, // the current hour
			"budget:h:2026-01-03T09:x": 1, // the one before it
			"budget:h:2026-01-03T08:x": 1,
			"budget:h:2026-01-02T23:system": 1,
			"budget:h:2026-01-04T00:x": 1, // later than now (another isolate's clock)
			"budget:d:2026-01-03:x": 1, // today
			"budget:t:2026-01-02": 1, // yesterday
			"budget:r:2026-01-01:0123456789abcdef0123456789abcdef": 1,
			"budget:t:2026-01-01": 1,
			"budget:d:2025-12-31:x": 1,
			"budget:q:2020-01-01": 1, // a kind it does not know
			"settings:replyTo": "office@example.org",
		});

	it("deletes only windows two or more before now's, never the current one, the one before it, or a later one", async () => {
		const kv = seeded();
		expect(await pruneBudgets(kv, new Date("2026-01-03T10:30:00Z"))).toEqual({
			deleted: 5,
			more: false,
		});
		expect([...kv.rows.keys()].toSorted()).toEqual([
			"budget:d:2026-01-03:x",
			"budget:h:2026-01-03T09:x",
			"budget:h:2026-01-03T10:x",
			"budget:h:2026-01-04T00:x",
			"budget:q:2020-01-01",
			"budget:t:2026-01-02",
			"settings:replyTo",
		]);
	});

	it("a prune that read an earlier clock deletes less, and still none of the current windows", async () => {
		const kv = seeded();
		await pruneBudgets(kv, new Date("2026-01-02T05:00:00Z"));
		for (const key of ["budget:h:2026-01-03T10:x", "budget:d:2026-01-03:x", "budget:t:2026-01-02"])
			expect(kv.rows.has(key)).toBe(true);
		expect(kv.rows.has("budget:d:2025-12-31:x")).toBe(false);
		expect(kv.rows.has("budget:t:2026-01-01")).toBe(true);
	});

	it("deletes at most max counts a run, and says more is left", async () => {
		const kv = seeded();
		expect(await pruneBudgets(kv, new Date("2026-01-03T10:30:00Z"), 2)).toEqual({
			deleted: 2,
			more: true,
		});
		expect(await pruneBudgets(kv, new Date("2026-01-03T10:30:00Z"), 2)).toEqual({
			deleted: 2,
			more: true,
		});
		expect(await pruneBudgets(kv, new Date("2026-01-03T10:30:00Z"), 2)).toEqual({
			deleted: 1,
			more: false,
		});
	});

	it("runs as the plugin's daily cron task, which activating it or reading its status schedules", async () => {
		const plugin = createPlugin({ from: "cms@mails.example.com" });
		const schedule = vi.fn(async () => {});
		const kv = memoryKv({
			"budget:t:2020-01-01": 5,
			[`budget:t:${new Date().toISOString().slice(0, 10)}`]: 1,
		});
		const ctx = { ...fakeCtx({ kv }), cron: { schedule } } as unknown as PluginContext;

		await plugin.hooks["plugin:activate"]?.handler({} as never, ctx);
		expect(schedule).toHaveBeenLastCalledWith(PRUNE_TASK, { schedule: "@daily" });
		await plugin.routes.status?.handler(ctx as never);
		expect(schedule).toHaveBeenCalledTimes(2);

		await plugin.hooks.cron?.handler({ name: "something-else", scheduledAt: "" }, ctx);
		expect(kv.rows.has("budget:t:2020-01-01")).toBe(true);
		await plugin.hooks.cron?.handler({ name: PRUNE_TASK, scheduledAt: "" }, ctx);
		expect([...kv.rows.keys()]).toEqual([`budget:t:${new Date().toISOString().slice(0, 10)}`]);
	});
});

describe("createCloudflareEmailStatus()", () => {
	it("says the sender, whether the binding is there, and where replies go", async () => {
		const { env } = fakeEnv();
		const status = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org" },
			async () => env,
		);

		expect(
			await status(fakeCtx({ kv: memoryKv({ "settings:replyTo": "office@example.org" }) })),
		).toEqual({
			provider: "cloudflare-email",
			capability: "emdash-cloudflare-email:checked-headers,site-budget,account-budget;v=2",
			from: "notify@mail.example.org",
			senderName: "site title",
			binding: { name: "EMAIL", present: true },
			replyTo: "site",
			limits: {
				perHour: 50,
				perDay: 200,
				perDayTotal: 300,
				systemReserve: 50,
				systemPerRecipient: 10,
			},
			accountBudget: null,
			attestation: {
				v: 2,
				provider: "cloudflare-email",
				capability: CLOUDFLARE_EMAIL_CAPABILITY,
				guarantees: {
					headersChecked: true,
					siteBudget: true,
					accountBudget: false,
					cancellation: "reported",
					redaction: "addresses",
				},
				accountBudget: null,
			},
		});
	});

	it("attests what the build enforces and, live, what the account's budget holds this site to, and never the token; it takes and refunds nothing", async () => {
		const budget = fakeBudget();
		const caps = {
			accountPerDay: 200,
			accountSystemReserve: 50,
			tenantPerDay: 100,
			tenantSystemReserve: 10,
			systemPerRecipient: 10,
		};
		const report = vi.fn(async (req: { protocol: number; token: string }) =>
			req.token === TOKEN
				? { ok: true, protocol: 2, tenant: "acme", lane: "plugin", site: { used: 3, cap: 90 }, caps }
				: { ok: false, protocol: 2, scope: "token", refused: "unknown" },
		);
		const service = { ...budget.service, report };
		const status = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org", accountBudget: {} },
			async () => ({ ...fakeEnv().env, MAIL_BUDGET: service, MAIL_BUDGET_TOKEN: TOKEN }),
		);
		const answer = await status(fakeCtx());
		expect(answer.attestation).toEqual({
			v: 2,
			provider: "cloudflare-email",
			capability: CLOUDFLARE_EMAIL_CAPABILITY,
			guarantees: {
				headersChecked: true,
				siteBudget: true,
				accountBudget: true,
				cancellation: "reported",
				redaction: "addresses",
			},
			accountBudget: {
				protocol: 2,
				ready: true,
				live: { ok: true, tenant: "acme", lane: "plugin", limits: caps },
			},
		});
		expect(report).toHaveBeenCalledWith({ protocol: 2, token: TOKEN });
		expect(budget.takes).toEqual([]);
		expect(budget.refunds).toEqual([]);
		expect(JSON.stringify(answer)).not.toContain(TOKEN);
	});

	it("attests the tenant the token is registered to, whichever Worker holds it: a token swapped in from another tenant names that tenant", async () => {
		const caps = {
			accountPerDay: 200,
			accountSystemReserve: 50,
			tenantPerDay: 100,
			tenantSystemReserve: 10,
			systemPerRecipient: 10,
		};
		// The service derives the tenant from the token: bravo's Worker holding alpha's token is alpha to it.
		const byToken: Record<string, string> = { [TOKEN]: "alpha", tok_bravo_0123456789abcdef0123456789abcdef0: "bravo" };
		const service = {
			...fakeBudget().service,
			report: vi.fn(async (req: { protocol: number; token: string }) =>
				byToken[req.token]
					? { ok: true, protocol: 2, tenant: byToken[req.token], lane: "plugin", caps }
					: { ok: false, protocol: 2, scope: "token", refused: "unknown or revoked" },
			),
		};
		const attested = async (token: string) =>
			(
				await createCloudflareEmailStatus(
					{ from: "notify@mail.example.org", accountBudget: {} },
					async () => ({ ...fakeEnv().env, MAIL_BUDGET: service, MAIL_BUDGET_TOKEN: token }),
				)(fakeCtx())
			).attestation.accountBudget?.live;
		expect(await attested("tok_bravo_0123456789abcdef0123456789abcdef0")).toMatchObject({
			ok: true,
			tenant: "bravo",
		});
		// Swapped: bravo's Worker with alpha's still-valid token attests alpha.
		expect(await attested(TOKEN)).toMatchObject({ ok: true, tenant: "alpha" });
		// A stale secret the service has revoked is not live at all.
		expect(await attested("tok_stale_0123456789abcdef0123456789abcdef0")).toMatchObject({
			ok: false,
			why: expect.stringMatching(/refused this site's token/),
		});
	});

	it("attests the account's budget NOT live, and why, for every answer short of a report in its protocol with the limits", async () => {
		const at = async (
			report: unknown,
			{ token = TOKEN, timeoutMs }: { token?: string; timeoutMs?: number } = {},
		) => {
			const service = { ...fakeBudget().service, ...(report === undefined ? {} : { report }) };
			const status = createCloudflareEmailStatus(
				{ from: "notify@mail.example.org", accountBudget: timeoutMs ? { timeoutMs } : {} },
				async () => ({
					...fakeEnv().env,
					MAIL_BUDGET: service,
					...(token ? { MAIL_BUDGET_TOKEN: token } : {}),
				}),
			);
			return (await status(fakeCtx())).attestation.accountBudget;
		};
		const caps = {
			accountPerDay: 200,
			accountSystemReserve: 50,
			tenantPerDay: 100,
			tenantSystemReserve: 10,
			systemPerRecipient: 10,
		};
		for (const [report, why, opts] of [
			[undefined, /has no report/, {}],
			[async () => ({ ok: false, protocol: 2, scope: "token", refused: "unknown or revoked" }), /refused this site's token \(unknown or revoked\)/, {}],
			[async () => ({ ok: true, protocol: 1, tenant: "acme", lane: "plugin", caps }), /answered in protocol 1, not 2/, {}],
			[async () => ({ ok: true, tenant: "acme", lane: "plugin", caps }), /answered in protocol null, not 2/, {}],
			[async () => ({ ok: true, protocol: 2, lane: "plugin", caps }), /does not say which tenant this site's token belongs to/, {}],
			[async () => ({ ok: true, protocol: 2, tenant: "", lane: "plugin", caps }), /does not say which tenant/, {}],
			[async () => ({ ok: true, protocol: 2, tenant: "acme", caps }), /does not say which lane this site's token holds/, {}],
			[async () => ({ ok: true, protocol: 2, tenant: "acme", lane: "plugin" }), /does not say the limits/, {}],
			[
				async () => ({ ok: true, protocol: 2, tenant: "acme", lane: "plugin", caps: { ...caps, tenantPerDay: "100" } }),
				/does not say the limits/,
				{},
			],
			[
				async () => {
					const { tenantSystemReserve: _, ...protocol1Caps } = caps;
					return { ok: true, protocol: 2, tenant: "acme", lane: "plugin", caps: protocol1Caps };
				},
				/does not say the limits/,
				{},
			],
			[
				async () => {
					throw new Error("service unavailable for User@Example.com");
				},
				/could not be asked \(Error: service unavailable for <an address at Example\.com>\)/,
				{},
			],
			[() => new Promise(() => {}), /did not answer within 20 ms/, { timeoutMs: 20 }],
			[async () => ({ ok: true, protocol: 2, tenant: "acme", lane: "plugin", caps }), /no token: the secret "MAIL_BUDGET_TOKEN" is not set/, { token: "" }],
		] as const) {
			const live = await at(report, opts);
			expect(live?.live, String(why)).toMatchObject({ ok: false, why: expect.stringMatching(why) });
			expect(JSON.stringify(live).toLowerCase()).not.toContain("user@");
		}
	});

	it("says whether the Worker has what the account budget needs, and never the token", async () => {
		const ready = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org", accountBudget: {} },
			async () => ({ ...fakeEnv().env, ...fakeBudget().env }),
		);
		const noToken = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org", accountBudget: {} },
			async () => ({ MAIL_BUDGET: fakeBudget().service }),
		);

		const on = await ready(fakeCtx());
		expect(on.accountBudget).toEqual({
			binding: "MAIL_BUDGET",
			token: "MAIL_BUDGET_TOKEN",
			ready: true,
		});
		expect(JSON.stringify(on)).not.toContain(TOKEN);
		expect((await noToken(fakeCtx())).accountBudget).toMatchObject({
			ready: false,
			why: expect.stringMatching(/no token: the secret "MAIL_BUDGET_TOKEN" is not set/),
		});
	});

	it("answers the capability marker through the plugin's own status route, the string a built Worker carries", async () => {
		// v=2: the account's budget in protocol 2, where this Worker's token is its plugin lane's.
		expect(CLOUDFLARE_EMAIL_CAPABILITY).toBe(
			"emdash-cloudflare-email:checked-headers,site-budget,account-budget;v=2",
		);
		const plugin = createPlugin({ from: "cms@mails.example.com", accountBudget: {} });
		const answer = (await plugin.routes.status?.handler(fakeCtx() as never)) as Record<
			string,
			unknown
		>;
		expect(answer).toMatchObject({
			capability: CLOUDFLARE_EMAIL_CAPABILITY,
			accountBudget: { ready: false },
		});
	});

	it("says the binding is missing, and sends nothing to find out", async () => {
		const status = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org" },
			async () => ({}),
		);
		const missing = createCloudflareEmailStatus({ from: "notify@mail.example.org" }, async () => {
			throw new Error("not on workerd");
		});

		expect((await status(fakeCtx())).binding).toEqual({ name: "EMAIL", present: false });
		expect((await missing(fakeCtx())).binding.present).toBe(false);
		expect((await status(fakeCtx())).replyTo).toBeNull();
	});
});
