// WORDPRESS'S `future` IS A SCHEDULED POST, and it used to arrive as a draft.
//
// MEASURED 2026-11-22 (emb/142): `mapStatus` sent `future` to `default: "draft"`,
// so a site's whole scheduled calendar landed as drafts with no date and the
// operator had to find and re-schedule each one by hand. EmDash already supports
// `scheduled` and a `scheduledAt` moment; the import never used them.
import { describe, expect, it } from "vitest";

import { mapStatus } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import { parseScheduledWxrDate, parseWxrDate } from "../../../src/import/sources/wxr.js";

const NOW = new Date("2026-11-22T12:00:00Z");

describe("WordPress's status, as EmDash's", () => {
	it("a `future` post whose moment is AHEAD is scheduled", () => {
		expect(mapStatus("future", new Date("2026-12-01T09:00:00Z"), NOW)).toBe("scheduled");
	});

	it("a `future` post whose moment has PASSED is published: WordPress's cron would have", () => {
		expect(mapStatus("future", new Date("2026-11-01T09:00:00Z"), NOW)).toBe("published");
	});

	it("a `future` post with NO date or an INVALID Date stays draft, never published", () => {
		expect(mapStatus("future", null, NOW)).toBe("draft");
		expect(mapStatus("future", undefined, NOW)).toBe("draft");
		expect(mapStatus("future", new Date("not-a-date"), NOW)).toBe("draft");
	});

	it("parseWxrDate never returns Invalid Date or parses 0000-00-00", () => {
		expect(parseWxrDate("not-a-date", undefined, undefined)).toBeUndefined();
		expect(parseWxrDate("0000-00-00 00:00:00", undefined, "0000-00-00 00:00:00")).toBeUndefined();
	});

	it("parseScheduledWxrDate accepts only zoned moments and flags unzoned local post_date", () => {
		const fromGmt = parseScheduledWxrDate("2099-05-01 10:00:00", undefined, "2099-05-01 06:00:00");
		expect(fromGmt.date?.toISOString()).toBe("2099-05-01T10:00:00.000Z");
		expect(fromGmt.unzonedLocalOnly).toBe(false);

		const fromPub = parseScheduledWxrDate("0000-00-00 00:00:00", "Fri, 01 May 2099 10:00:00 -0400", "2099-05-01 10:00:00");
		expect(fromPub.date?.toISOString()).toBe("2099-05-01T14:00:00.000Z");
		expect(fromPub.unzonedLocalOnly).toBe(false);

		const localOnly = parseScheduledWxrDate("0000-00-00 00:00:00", undefined, "2099-05-01 10:00:00");
		expect(localOnly.date).toBeNull();
		expect(localOnly.unzonedLocalOnly).toBe(true);

		const unparseable = parseScheduledWxrDate("not-a-date", undefined, "also-bad");
		expect(unparseable.date).toBeNull();
		expect(unparseable.unzonedLocalOnly).toBe(false);
	});

	it("`publish` is published, and `draft`/`pending`/`private` stay draft", () => {
		expect(mapStatus("publish", null, NOW)).toBe("published");
		expect(mapStatus("draft", null, NOW)).toBe("draft");
		// NEITHER IS PUBLIC: a pending post awaits review, and a private one is
		// admins-only, which a draft is the honest EmDash shape of.
		expect(mapStatus("pending", null, NOW)).toBe("draft");
		expect(mapStatus("private", null, NOW)).toBe("draft");
	});

	it("NEGATIVE CONTROL: an unknown status is a draft, never published", () => {
		expect(mapStatus("something-wordpress-never-wrote", null, NOW)).toBe("draft");
	});
});
