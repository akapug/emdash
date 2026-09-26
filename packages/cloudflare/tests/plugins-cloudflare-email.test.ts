import { definePlugin, type PluginContext, type PluginDefinition } from "emdash";
import type { EmailDeliverEvent } from "emdash/plugin";
import { describe, it, expect, vi } from "vitest";

import {
	cloudflareEmail,
	createCloudflareEmailDeliver,
	createCloudflareEmailStatus,
	createPlugin,
	displayName,
	domainOf,
	headerText,
	mailbox,
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

	it("holds the day across hours, and a new hour clears the last hour's count", async () => {
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
			"budget:h:2026-01-01T12:x",
		]);
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
		const deliver = deliverWith({ perHour: 10, perDay: 10, perDayTotal: 3 }, env);

		for (const source of ["emdash-forms", "emdash-comments", "admin"])
			await deliver({ message, source }, fakeCtx({ kv }));
		await expect(deliver({ message, source: "another-plugin" }, fakeCtx({ kv }))).rejects.toThrow(
			/every source together this day has reached 3 recipient\(s\), and 1 more would pass its limit of 3/,
		);

		expect(send).toHaveBeenCalledTimes(3);
		expect(kv.rows.get("budget:t:2026-01-01")?.value).toBe(3);
		// The next day is a new total.
		await createCloudflareEmailDeliver(
			{ from: "notify@mail.example.org", limits: { perDayTotal: 3 } },
			async () => env,
			at("2026-01-02T00:01:00Z"),
		)({ message, source: "another-plugin" }, fakeCtx({ kv }));
		expect(send).toHaveBeenCalledTimes(4);
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

	it("domainOf and withoutAddresses keep the domain and nothing of the local part", () => {
		expect(domainOf("o'brien+forms@sub.example.org")).toBe("sub.example.org");
		expect(
			withoutAddresses("to A@x.example.org and a@x.example.org, not b@x.example.org", [
				"a@x.example.org",
			]),
		).toBe(
			"to <an address at x.example.org> and <an address at x.example.org>, not b@x.example.org",
		);
		expect(withoutAddresses("İstanbul a@x.example.org", ["a@x.example.org"])).toBe(
			"İstanbul <an address at x.example.org>",
		);
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
			from: "notify@mail.example.org",
			senderName: "site title",
			binding: { name: "EMAIL", present: true },
			replyTo: "site",
			limits: { perHour: 50, perDay: 200, perDayTotal: 300, systemPerRecipient: 10 },
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
