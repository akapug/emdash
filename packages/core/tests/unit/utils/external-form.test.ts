import { EXTERNAL_FORM_HOSTS as IMPORTED } from "@emdash-cms/gutenberg-to-portable-text";
import { describe, expect, it } from "vitest";

import { EXTERNAL_FORM_HOSTS, externalFormAction } from "../../../src/utils/external-form.js";

describe("the hosts a carried payment form may post to", () => {
	it("are the importer's: a form the importer carries is one the renderer draws", () => {
		expect([...EXTERNAL_FORM_HOSTS].toSorted()).toEqual([...IMPORTED].toSorted());
	});

	it("are posted to only over https, read as a browser reads the action", () => {
		expect(externalFormAction("https://www.paypal.com/cgi-bin/webscr")?.hostname).toBe(
			"www.paypal.com",
		);
		for (const a of [
			"http://www.paypal.com/",
			"https://www.paypal.com.evil.example/",
			"https://u:p@www.paypal.com/",
			"https://www.paypal.com\\@evil.example/",
			null,
		]) {
			expect(externalFormAction(a), String(a)).toBeUndefined();
		}
	});
});
