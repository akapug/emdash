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
			{
				sendImpl,
				contended = false,
			}: { sendImpl?: () => Promise<never>; contended?: boolean } = {},
		) => {
			const kv = memoryKv(seeded);
			const calls: string[] = [];
			const watched = {
				...kv,
				list: async (prefix?: string) => (calls.push(`list ${prefix}`), kv.list(prefix)),
				delete: async (key: string) => (calls.push(`delete ${key}`), kv.delete(key)),
				compareAndDelete: async (key: string, rev: string) => (
					calls.push(`compareAndDelete ${key}`),
					kv.compareAndDelete(key, rev)
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

const CAP = "cap_0123456789abcdef0123456789abcdef0123456";

/**
 * The site's mail broker as its service binding exposes it: `send` answers
 * from `answer` (default: sent), and every call is kept.
 */
function fakeBroker(
	answer: (req: { message: Record<string, unknown> }) => unknown = () => ({
		protocol: 2,
		status: "sent",
		seq: 1,
	}),
) {
	type Send = {
		protocol: number;
		capability: string;
		requestId: string;
		message: Record<string, unknown>;
	};
	const sends: Send[] = [];
	const statuses: Array<Record<string, unknown>> = [];
	const service = {
		send: vi.fn(async (req: Send) => {
			sends.push(req);
			return answer(req);
		}),
		status: vi.fn(async (req: Record<string, unknown>) => {
			statuses.push(req);
			return { protocol: 2, marker: "emdash-auth-mail:broker;v=2", capability: "unknown" };
		}),
	};
	return { service, sends, statuses, env: { MAIL_BROKER: service, MAIL_BROKER_CAPABILITY: CAP } };
}

describe("the site's mail broker", () => {
	const withBroker = (env: Record<string, unknown>, over: Partial<CloudflareEmailConfig> = {}) =>
		createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", broker: {}, allowCc: true, ...over },
			async () => env,
		);

	it("every message goes to the broker as its envelope with this site's capability and a request id, and nothing goes through a binding of this Worker's", async () => {
		const mail = fakeEnv();
		const broker = fakeBroker();
		await withBroker({ ...mail.env, ...broker.env })(
			{
				message: {
					...message,
					to: "User@Example.com",
					cc: ["team@example.com"],
					html: "<p>hi</p>",
				},
				source: "system",
			},
			fakeCtx(),
		);
		// Even with a send_email binding in the env, this Worker never calls it.
		expect(mail.send).not.toHaveBeenCalled();
		expect(broker.sends).toHaveLength(1);
		const [sent] = broker.sends;
		// The request is the envelope, the capability and a request id: no source, no lane, no sender, no token.
		expect(Object.keys(sent!).toSorted()).toEqual([
			"capability",
			"message",
			"protocol",
			"requestId",
		]);
		expect(sent).toMatchObject({ protocol: 2, capability: CAP });
		expect(sent!.requestId).toMatch(/^[0-9a-f-]{36}$/);
		expect(sent!.message).toEqual({
			to: "User@Example.com",
			cc: ["team@example.com"],
			subject: "Your magic link",
			text: "Click here",
			html: "<p>hi</p>",
		});
		expect(JSON.stringify(broker.sends)).not.toMatch(/system|lane|source|from/);
		// A form's mail asks the same way: nothing a source says reaches the request.
		await withBroker({ ...broker.env })({ message, source: "emdash-forms" }, fakeCtx());
		expect(Object.keys(broker.sends[1]!).toSorted()).toEqual([
			"capability",
			"message",
			"protocol",
			"requestId",
		]);
		expect(broker.sends[1]!.requestId).not.toBe(sent!.requestId);
	});

	it("a Worker without the broker's service binding or the capability sends nothing, spends nothing of the site's, and says why", async () => {
		for (const [env, why] of [
			[{ MAIL_BROKER_CAPABILITY: CAP }, /no service binding "MAIL_BROKER" in this Worker/],
			[
				{ MAIL_BROKER: { send: async () => ({}) }, MAIL_BROKER_CAPABILITY: CAP },
				/no service binding "MAIL_BROKER"/,
			],
			[
				{ MAIL_BROKER: fakeBroker().service },
				/no generation capability for the mail broker: the secret "MAIL_BROKER_CAPABILITY" is not set/,
			],
			[
				{ MAIL_BROKER: fakeBroker().service, MAIL_BROKER_CAPABILITY: "  " },
				/no generation capability/,
			],
		] as const) {
			const mail = fakeEnv();
			const kv = memoryKv();
			await expect(
				withBroker({ ...mail.env, ...env })({ message, source: "emdash-forms" }, fakeCtx({ kv })),
			).rejects.toThrow(why);
			expect(mail.send).not.toHaveBeenCalled();
			expect([...kv.rows.keys()]).toEqual([]);
		}
	});

	it("a refusal there sends nothing and gives the site's places back, and names no address", async () => {
		const kv = memoryKv();
		const broker = fakeBroker(() => ({
			protocol: 2,
			status: "refused",
			why: "1 of its recipients (at example.com) are not on the broker's recipient list: user@example.com",
			seq: 4,
		}));
		const error = (await withBroker(broker.env)(
			{ message, source: "emdash-forms" },
			fakeCtx({ kv }),
		).catch((e: unknown) => e)) as Error;
		expect(error.message).toMatch(
			/the mail broker refused it: 1 of its recipients \(at example\.com\) are not on the broker's recipient list/,
		);
		expect(error.message.toLowerCase()).not.toContain("user@");
		expect(Array.from(kv.rows.values(), (r) => r.value)).toEqual([0, 0, 0]);
	});

	it("an error asking it is asked once more with the SAME request id, and an answer that says neither sent nor refused is not known to be sent: the site's places stay taken", async () => {
		// Thrown once, then sent: the retry carries the same request id, which the broker answers as the first.
		let calls = 0;
		const flaky = fakeBroker(() => {
			calls++;
			if (calls === 1) throw new Error("the connection was lost for User@Example.com");
			return { protocol: 2, status: "sent", seq: 2, replayed: true };
		});
		await withBroker(flaky.env)({ message, source: "system" }, fakeCtx());
		expect(flaky.sends).toHaveLength(2);
		expect(flaky.sends[0]!.requestId).toBe(flaky.sends[1]!.requestId);
		for (const [answer, why] of [
			[
				() => {
					throw new Error("service unavailable for User@Example.com");
				},
				/could not be asked \(Error: service unavailable for <an address at example\.com>\), so whether it was sent is not known/,
			],
			[() => ({ protocol: 2 }), /answered neither sent nor refused/],
			[() => ({ protocol: 2, status: "refused" }), /answered neither sent nor refused/],
			// The broker's own "not known": a retry of a first attempt that never finished there.
			[
				() => ({
					protocol: 2,
					status: "unknown",
					why: "an earlier attempt with this request id did not finish (user@example.com)",
					seq: 7,
					replayed: true,
				}),
				/the mail broker says it is not known whether it was sent \(an earlier attempt with this request id did not finish \(<an address at example\.com>\)\)/,
			],
			[
				() => ({ protocol: 1, status: "sent" }),
				/answered in protocol 1, and this provider speaks 2/,
			],
			[() => ({ status: "sent" }), /answered in protocol null/],
		] as const) {
			const kv = memoryKv();
			const broker = fakeBroker(answer);
			const error = (await withBroker(broker.env)(
				{ message: { ...message, to: "user@example.com" }, source: "system" },
				fakeCtx({ kv }),
			).catch((e: unknown) => e)) as Error;
			expect(error.message).toMatch(why);
			expect(error.message.toLowerCase()).not.toContain("user@");
			// Not known to be unsent: the site's own counts keep the places.
			expect(Array.from(kv.rows.values(), (r) => r.value)).toEqual([1, 1, 1, 1]);
		}
	});

	it("a send the broker has not answered in time is NOT known to be unsent: it is reported so, and asked no second time", async () => {
		const kv = memoryKv();
		const broker = fakeBroker();
		broker.service.send.mockImplementation(
			(req) => (broker.sends.push(req), new Promise(() => {})),
		);
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", broker: { timeoutMs: 20 } },
			async () => broker.env,
		);
		await expect(deliver({ message, source: "emdash-forms" }, fakeCtx({ kv }))).rejects.toThrow(
			/the mail broker did not answer within 20 ms, so whether it was sent is not known/,
		);
		expect(broker.sends).toHaveLength(1);
		expect(Array.from(kv.rows.values(), (r) => r.value)).toEqual([1, 1, 1]);
	});

	it("a site that has spent its own day asks the broker nothing", async () => {
		const broker = fakeBroker();
		const deliver = createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", broker: {}, limits: { perDay: 1 } },
			async () => broker.env,
			() => new Date("2026-01-01T10:00:00Z"),
		);
		const kv = memoryKv();
		await deliver({ message, source: "x" }, fakeCtx({ kv }));
		await expect(deliver({ message, source: "x" }, fakeCtx({ kv }))).rejects.toThrow(
			/"x" this day/,
		);
		expect(broker.sends).toHaveLength(1);
	});

	it("without broker in the config, no broker is asked, whatever the env holds, and the Worker's own binding sends", async () => {
		const broker = fakeBroker();
		const mail = fakeEnv();
		await createCloudflareEmailDeliver({ from: "notify@mail.example.org" }, async () => ({
			...mail.env,
			...broker.env,
		}))(event, fakeCtx());
		expect(broker.sends).toEqual([]);
		expect(mail.send).toHaveBeenCalledOnce();
	});

	it("names other bindings when the config does", async () => {
		const broker = fakeBroker();
		await createCloudflareEmailDeliver(
			{
				from: "notify@mail.example.org",
				broker: { binding: "BROKER2", capability: "BROKER2_CAP" },
			},
			async () => ({ BROKER2: broker.service, BROKER2_CAP: CAP }),
		)(event, fakeCtx());
		expect(broker.sends).toHaveLength(1);
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
			capability: "emdash-cloudflare-email:checked-headers,site-budget,mail-broker;v=3",
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
			broker: null,
			attestation: {
				v: 3,
				provider: "cloudflare-email",
				capability: CLOUDFLARE_EMAIL_CAPABILITY,
				guarantees: {
					headersChecked: true,
					siteBudget: true,
					broker: false,
					cancellation: "reported",
					redaction: "addresses",
				},
				broker: null,
			},
		});
	});

	/** The broker's status for this site's capability, as a staged generation 3 answers it. */
	const brokerStatus = (over: Record<string, unknown> = {}) => ({
		protocol: 2,
		marker: "emdash-auth-mail:broker;v=2",
		seq: 9,
		tenant: "acme",
		deployment: "artifact:code",
		send: { plugin: true, system: true },
		site: true,
		recipients: 3,
		generations: { active: null, staged: 3 },
		capability: "staged",
		generation: 3,
		capabilityHash: "c".repeat(64),
		tokenHashes: { plugin: "a".repeat(64), system: "b".repeat(64) },
		budget: {
			plugin: {
				ok: true,
				tenant: "acme",
				lane: "plugin",
				generation: 3,
				state: "staged",
				caps: { tenantPerDay: 100 },
			},
			system: {
				ok: true,
				tenant: "acme",
				lane: "system",
				generation: 3,
				state: "staged",
				caps: { tenantPerDay: 100 },
			},
		},
		...over,
	});

	it("attests what the build enforces and, live, what the broker says of this site's capability: its generation, the hashes and each lane's report; never the capability; it sends, takes and refunds nothing", async () => {
		const broker = fakeBroker();
		broker.service.status.mockImplementation(
			async (req) => (
				broker.statuses.push(req),
				brokerStatus({ extra: "must-not-pass", tokens: { plugin: "raw" } })
			),
		);
		const status = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org", broker: {} },
			async () => ({ ...broker.env, MAIL_GENERATION: "3" }),
		);
		const answer = await status(fakeCtx());
		const capabilityHash = await crypto.subtle
			.digest("SHA-256", new TextEncoder().encode(CAP))
			.then((d) => Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join(""));
		expect(answer.attestation).toEqual({
			v: 3,
			provider: "cloudflare-email",
			capability: CLOUDFLARE_EMAIL_CAPABILITY,
			guarantees: {
				headersChecked: true,
				siteBudget: true,
				broker: true,
				cancellation: "reported",
				redaction: "addresses",
			},
			broker: {
				protocol: 2,
				ready: true,
				generation: "3",
				capabilityHash,
				live: {
					ok: true,
					marker: "emdash-auth-mail:broker;v=2",
					seq: 9,
					tenant: "acme",
					deployment: "artifact:code",
					capability: "staged",
					generations: { active: null, staged: 3 },
					generation: 3,
					capabilityHash: "c".repeat(64),
					tokenHashes: { plugin: "a".repeat(64), system: "b".repeat(64) },
					send: { plugin: true, system: true },
					site: true,
					recipients: 3,
					budget: {
						plugin: {
							ok: true,
							tenant: "acme",
							lane: "plugin",
							generation: 3,
							state: "staged",
							caps: { tenantPerDay: 100 },
						},
						system: {
							ok: true,
							tenant: "acme",
							lane: "system",
							generation: 3,
							state: "staged",
							caps: { tenantPerDay: 100 },
						},
					},
				},
			},
		});
		expect(broker.statuses).toEqual([{ protocol: 2, capability: CAP }]);
		expect(broker.sends).toEqual([]);
		expect(JSON.stringify(answer)).not.toContain(CAP);
		expect(JSON.stringify(answer)).not.toMatch(/must-not-pass|"raw"/);
	});

	it("attests the site and the lanes the broker says the capability's tokens are registered to, whichever Worker asks: a capability swapped in from another site names that site's broker's answer", async () => {
		const byCap: Record<string, Record<string, unknown>> = {
			[CAP]: brokerStatus({ tenant: "alpha" }),
			cap_bravo_0123456789abcdef0123456789abcdef0: brokerStatus({ tenant: "bravo" }),
		};
		const service = {
			...fakeBroker().service,
			status: vi.fn(
				async (req: { capability: string }) =>
					byCap[req.capability] ??
					brokerStatus({
						capability: "unknown",
						generation: undefined,
						tokenHashes: undefined,
						budget: undefined,
					}),
			),
		};
		const attested = async (capability: string) =>
			(
				await createCloudflareEmailStatus(
					{ from: "notify@mail.example.org", broker: {} },
					async () => ({ MAIL_BROKER: service, MAIL_BROKER_CAPABILITY: capability }),
				)(fakeCtx())
			).attestation.broker?.live;
		expect(await attested("cap_bravo_0123456789abcdef0123456789abcdef0")).toMatchObject({
			ok: true,
			tenant: "bravo",
		});
		expect(await attested(CAP)).toMatchObject({ ok: true, tenant: "alpha" });
		// A capability the broker does not know is live, and says so: neither active nor staged, no generation, no lanes.
		expect(await attested("cap_stale_0123456789abcdef0123456789abcdef0")).toMatchObject({
			ok: true,
			capability: "unknown",
			generation: null,
			tokenHashes: { plugin: null, system: null },
			budget: { plugin: { ok: false }, system: { ok: false } },
		});
	});

	it("attests the broker NOT live, and why, for every answer short of a status in its protocol with its marker", async () => {
		const at = async (
			status: unknown,
			{ capability = CAP, timeoutMs }: { capability?: string; timeoutMs?: number } = {},
		) => {
			const service = { ...fakeBroker().service, status };
			return (
				await createCloudflareEmailStatus(
					{ from: "notify@mail.example.org", broker: timeoutMs ? { timeoutMs } : {} },
					async () => ({
						MAIL_BROKER: service,
						...(capability ? { MAIL_BROKER_CAPABILITY: capability } : {}),
					}),
				)(fakeCtx())
			).attestation.broker;
		};
		for (const [status, why, opts] of [
			[async () => brokerStatus({ protocol: 1 }), /answered in protocol 1, not 2/, {}],
			[async () => brokerStatus({ protocol: undefined }), /answered in protocol null, not 2/, {}],
			[async () => "sent", /answered in protocol null/, {}],
			[async () => brokerStatus({ marker: undefined }), /carries no marker/, {}],
			[
				async () => {
					throw new Error("service unavailable for User@Example.com");
				},
				/could not be asked \(Error: service unavailable for <an address at Example\.com>\)/,
				{},
			],
			[() => new Promise(() => {}), /did not answer within 20 ms/, { timeoutMs: 20 }],
		] as const) {
			const b = await at(status, opts);
			expect(b?.live, String(why)).toMatchObject({ ok: false, why: expect.stringMatching(why) });
			expect(JSON.stringify(b).toLowerCase()).not.toContain("user@");
		}
		const none = await at(async () => brokerStatus(), { capability: "" });
		expect(none).toMatchObject({
			ready: false,
			generation: null,
			capabilityHash: null,
			live: { ok: false, why: expect.stringMatching(/no generation capability/) },
		});
	});

	it("says whether the Worker has what the broker needs, and never the capability", async () => {
		const ready = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org", broker: {} },
			async () => fakeBroker().env,
		);
		const noCap = createCloudflareEmailStatus(
			{ from: "notify@mail.example.org", broker: {} },
			async () => ({ MAIL_BROKER: fakeBroker().service }),
		);

		const on = await ready(fakeCtx());
		expect(on.broker).toEqual({
			binding: "MAIL_BROKER",
			capability: "MAIL_BROKER_CAPABILITY",
			ready: true,
		});
		expect(on.binding).toEqual({ name: "MAIL_BROKER", present: true });
		expect(JSON.stringify(on)).not.toContain(CAP);
		expect((await noCap(fakeCtx())).broker).toMatchObject({
			ready: false,
			why: expect.stringMatching(/the secret "MAIL_BROKER_CAPABILITY" is not set/),
		});
		expect((await noCap(fakeCtx())).binding.present).toBe(false);
	});

	it("answers the capability marker through the plugin's own status route, the string a built Worker carries", async () => {
		// v=3: every message through the site's mail broker, which alone holds the send bindings and budget tokens.
		expect(CLOUDFLARE_EMAIL_CAPABILITY).toBe(
			"emdash-cloudflare-email:checked-headers,site-budget,mail-broker;v=3",
		);
		const plugin = createPlugin({ from: "cms@mails.example.com", broker: {} });
		const answer = (await plugin.routes.status?.handler(fakeCtx() as never)) as Record<
			string,
			unknown
		>;
		expect(answer).toMatchObject({
			capability: CLOUDFLARE_EMAIL_CAPABILITY,
			broker: { ready: false },
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
