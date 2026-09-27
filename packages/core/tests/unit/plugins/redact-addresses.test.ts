/**
 * The one redaction every logged email error goes through: each known address
 * in any letter case (and URL-encoded), then every other address-shaped run,
 * a quoted local part included, over a whole error: message, stack, own
 * string properties and causes.
 */

import { describe, expect, it } from "vitest";

import {
	describeRedacted,
	redactAddresses,
	scrubAddresses,
} from "../../../src/plugins/redact-addresses.js";

/** Any address left in `text`, in any case: the test's own witness, not the code's pattern. */
const leaks = (text: string, locals: string[]) =>
	locals.filter((local) => text.toLowerCase().includes(`${local.toLowerCase()}@`));

describe("redactAddresses", () => {
	it("replaces a known address in any letter case, and URL-encoded", () => {
		expect(
			redactAddresses("E_RECIPIENT_NOT_ALLOWED: User@Example.COM (user@example.com)", [
				"user@example.com",
			]),
		).toBe("E_RECIPIENT_NOT_ALLOWED: <an address at example.com> (<an address at example.com>)");
		expect(redactAddresses("GET /x?to=USER%40example.com", ["user@example.com"])).toBe(
			"GET /x?to=<an address at example.com>",
		);
	});

	it("replaces a quoted, bracketed or JSON-quoted address, and a quoted local part", () => {
		const text = [
			`to "Owner@Example.org" failed`,
			"<OWNER@EXAMPLE.ORG>",
			"'owner@example.org'",
			'{"to":"Owner@Example.org","cc":["Team.Lead+forms@Sub.Example.net"]}',
			'"john doe"@example.net refused',
			'"quote\\"inside"@example.net refused',
		].join("\n");
		const out = redactAddresses(text, ["owner@example.org"]);
		expect(leaks(out, ["owner", "team.lead+forms", '"john doe"', "doe", "inside"])).toEqual([]);
		expect(out).toContain('to "<an address at example.org>" failed');
		expect(out).toContain("<<an address at example.org>>");
		expect(out).toContain('"cc":["<an address at Sub.Example.net>"]');
		expect(out).toContain("<an address at example.net> refused");
		expect(out).not.toContain("@");
	});

	it("replaces addresses nobody named, and leaves what is not an address", () => {
		expect(redactAddresses("cc other.person@example.net and x@y failed @ 10:00")).toBe(
			"cc <an address at example.net> and x@y failed @ 10:00",
		);
		expect(redactAddresses("İstanbul a@x.example.org", [])).toBe(
			"İstanbul <an address at x.example.org>",
		);
		expect(redactAddresses("no address here")).toBe("no address here");
	});

	it("takes linear time on a long line of address characters", () => {
		const long = `${"a".repeat(200_000)}@${"@b".repeat(50_000)}`;
		const t0 = Date.now();
		redactAddresses(long);
		expect(Date.now() - t0).toBeLessThan(2_000);
	});
});

describe("describeRedacted", () => {
	it("prints the error as String() does, then each cause, all redacted", () => {
		const error = new Error("send failed for Owner@Example.org", {
			cause: new Error("E_RECIPIENT_NOT_ALLOWED: OWNER@example.org", {
				cause: "upstream said owner@EXAMPLE.org",
			}),
		});
		const line = describeRedacted(error, ["owner@example.org"]);
		expect(line).toBe(
			"Error: send failed for <an address at example.org> [cause: Error: E_RECIPIENT_NOT_ALLOWED: <an address at example.org>] [cause: upstream said <an address at example.org>]",
		);
		expect(describeRedacted({ to: "Owner@Example.org" })).toBe(
			'{"to":"<an address at Example.org>"}',
		);
	});
});

describe("scrubAddresses", () => {
	it("redacts the error in place, its stack, its own string properties and its causes, keeping its identity and code", () => {
		const inner = new Error("E_RECIPIENT_NOT_ALLOWED: Owner@Example.org");
		const error = Object.assign(new Error("binding refused OWNER@EXAMPLE.ORG", { cause: inner }), {
			code: "E_RECIPIENT_NOT_ALLOWED",
			to: "owner@example.org",
		});
		const scrubbed = scrubAddresses(error, ["owner@example.org"]);
		expect(scrubbed).toBe(error);
		expect(scrubbed).toMatchObject({
			code: "E_RECIPIENT_NOT_ALLOWED",
			to: "<an address at example.org>",
		});
		for (const text of [scrubbed.message, scrubbed.stack ?? "", inner.message, inner.stack ?? ""]) {
			expect(leaks(text, ["owner"])).toEqual([]);
		}
	});

	it("replaces an error that will not take the change, and a thrown value that is not an Error", () => {
		// A message with a getter and no setter, as some host errors have.
		const original = Object.defineProperty(Object.assign(new Error(), { code: 42 }), "message", {
			get: () => "refused Owner@Example.org",
		});
		const frozen = scrubAddresses(original, ["owner@example.org"]);
		expect(frozen).not.toBe(original);
		expect(frozen.message).toMatch(/refused <an address at example\.org>/);
		expect(frozen).toMatchObject({ code: 42 });
		expect(leaks(`${frozen.message}${frozen.stack}`, ["owner"])).toEqual([]);

		const thrown = scrubAddresses("OWNER@example.org bounced");
		expect(thrown).toBeInstanceOf(Error);
		expect(thrown.message).toBe("<an address at example.org> bounced");

		const withStringCause = scrubAddresses(new Error("x", { cause: "owner@Example.org" }));
		expect(withStringCause.cause).toBe("<an address at Example.org>");
	});
});
