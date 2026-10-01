import { describe, expect, it } from "vitest";

import { isIframeHostname } from "../../../src/utils/iframe-hosts.js";

describe("isIframeHostname takes exactly one host, nothing around it", () => {
	it("takes a plain lowercase host", () => {
		expect(isIframeHostname("www.google.com")).toBe(true);
	});

	// Readers trim and lowercase, so the validator must refuse anything that is not exactly a host.
	it.each([
		"www.google.com\n",
		"www.google.com\r\n",
		" www.google.com",
		"www.google.com ",
		"\twww.google.com",
	])("refuses %j", (value) => expect(isIframeHostname(value)).toBe(false));

	it("refuses a reserved domain hidden behind a final line break", () => {
		expect(isIframeHostname("site.workers.dev\n")).toBe(false);
	});
});
