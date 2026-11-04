/**
 * A sandboxed plugin's ctx.email.send goes through PluginBridge.emailSend,
 * and what the send came to comes back through it: "sent", or "cancelled" by
 * the email:beforeSend plugin that stopped it, so a plugin never reads a
 * cancelled send as a sent one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { PluginBridge, setEmailSendCallback } from "../../src/sandbox/bridge.js";

const message = { to: "reader@example.com", subject: "Subject", text: "Body" };

function bridge(capabilities: string[]) {
	return new PluginBridge(
		{
			props: {
				pluginId: "forms",
				pluginVersion: "1.0.0",
				capabilities,
				allowedHosts: [],
				storageCollections: [],
			},
		} as never,
		{} as never,
	);
}

afterEach(() => {
	setEmailSendCallback(null);
});

describe("PluginBridge.emailSend", () => {
	it("hands the plugin what the send came to: sent, or cancelled and by whom", async () => {
		const send = vi.fn(async () => ({ status: "sent" as const }));
		setEmailSendCallback(send);
		await expect(bridge(["email:send"]).emailSend(message)).resolves.toEqual({ status: "sent" });
		expect(send).toHaveBeenCalledWith(message, "forms");

		setEmailSendCallback(async () => ({ status: "cancelled", by: "quiet-hours" }));
		await expect(bridge(["email:send"]).emailSend(message)).resolves.toEqual({
			status: "cancelled",
			by: "quiet-hours",
		});
	});

	it("sends nothing without the email:send capability", async () => {
		const send = vi.fn(async () => ({ status: "sent" as const }));
		setEmailSendCallback(send);
		await expect(bridge([]).emailSend(message)).rejects.toThrow("Missing capability: email:send");
		expect(send).not.toHaveBeenCalled();
	});
});
