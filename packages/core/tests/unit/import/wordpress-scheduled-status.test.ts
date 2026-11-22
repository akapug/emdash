// WORDPRESS'S `future` IS A SCHEDULED POST, and it used to arrive as a draft.
//
// MEASURED 2026-11-22 (emb/142): `mapStatus` sent `future` to `default: "draft"`,
// so a site's whole scheduled calendar landed as drafts with no date and the
// operator had to find and re-schedule each one by hand. EmDash already supports
// `scheduled` and a `scheduledAt` moment; the import never used them.
import { describe, expect, it } from "vitest";

import { mapStatus } from "../../../src/astro/routes/api/import/wordpress/execute.js";

const NOW = new Date("2026-11-22T12:00:00Z");

describe("WordPress's status, as EmDash's", () => {
	it("a `future` post whose moment is AHEAD is scheduled", () => {
		expect(mapStatus("future", new Date("2026-12-01T09:00:00Z"), NOW)).toBe("scheduled");
	});

	it("a `future` post whose moment has PASSED is published: WordPress's cron would have", () => {
		expect(mapStatus("future", new Date("2026-11-01T09:00:00Z"), NOW)).toBe("published");
	});

	it("a `future` post with NO date is a draft, and says so by being one", () => {
		expect(mapStatus("future", null, NOW)).toBe("draft");
		expect(mapStatus("future", undefined, NOW)).toBe("draft");
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
