import {
	EXTERNAL_FORM_HOSTS as IMPORTED,
	externalFormAction as importedAction,
} from "@emdash-cms/gutenberg-to-portable-text";
import { describe, expect, it } from "vitest";

import { EXTERNAL_FORM_HOSTS, externalFormAction } from "../../../src/utils/external-form.js";

describe("the hosts a carried payment form may post to", () => {
	it("are the importer's: a form the importer carries is one the renderer draws", () => {
		expect([...EXTERNAL_FORM_HOSTS].toSorted()).toEqual([...IMPORTED].toSorted());
	});

	it("are read as the importer reads an action: a form it carries is drawn, and one it refuses is not", () => {
		for (const a of [
			"https://www.paypal.com/cgi-bin/webscr",
			"https://WWW.PAYPAL.COM/cgi-bin/webscr",
			"https:www.paypal.com/x",
			"https://www.paypal.com:443/x",
			"https://www.paypal.com:8443/x",
			"https://www.paypal.com./x",
			"https://www.paypal.com#@evil.example/",
			"https://evil.example#@www.paypal.com/",
			"https://www.paypal.com%40evil.example/",
			"https://u@www.paypal.com/",
			"https://www.paypal.com\t/x",
			"http://www.paypal.com/",
			"//www.paypal.com/",
			"javascript:alert(1)",
		]) {
			expect(externalFormAction(a)?.href, a).toBe(importedAction(a)?.href);
		}
	});

	it("are posted to only over https, read as a browser reads the action", () => {
		expect(externalFormAction("https://www.paypal.com/cgi-bin/webscr")?.hostname).toBe(
			"www.paypal.com",
		);
		for (const a of [
			"http://www.paypal.com/",
			"https://www.paypal.com.evil.example/",
			"https://u:p@www.paypal.com/",
			"https://www.paypal.com:8443/",
			"https://www.paypal.com\\@evil.example/",
			null,
		]) {
			expect(externalFormAction(a), String(a)).toBeUndefined();
		}
	});
});
