import { describe, expect, it } from "vitest";

import {
	archiveGroups,
	archiveLabel,
	archiveName,
	archiveTitle,
	datePath,
	dateRange,
	parseDatePath,
	parseDateQuery,
} from "../../../../../templates/blog-cloudflare/src/utils/wp-archive";

describe("a date archive's path, as WordPress served it", () => {
	it("names a year, a month or a day, and a page of it, with or without the last slash", () => {
		expect(parseDatePath("/2023/07/")).toEqual({ y: 2023, m: 7, page: 1 });
		expect(parseDatePath("/2023/07")).toEqual({ y: 2023, m: 7, page: 1 });
		expect(parseDatePath("/2023/")).toEqual({ y: 2023, page: 1 });
		expect(parseDatePath("/2023/07/05/")).toEqual({ y: 2023, m: 7, d: 5, page: 1 });
		expect(parseDatePath("/2023/07/page/2/")).toEqual({ y: 2023, m: 7, page: 2 });
		expect(parseDatePath("/2023/page/3")).toEqual({ y: 2023, page: 3 });
		// WordPress's rewrite rules take a month or a day of one digit too
		expect(parseDatePath("/2023/7/")).toEqual({ y: 2023, m: 7, page: 1 });
	});

	it("names nothing that is not a date: a post's path, a page, a month or a day the calendar has not", () => {
		for (const path of [
			"/",
			"/about/",
			"/2023/policy/",
			"/2014/policy/the-post-office/",
			"/2023/13/",
			"/2023/00/",
			"/2023/02/30/",
			"/2023/07/05/hello/",
			"/0999/",
			"/2023/07/page/0/",
			"/2023/07/page/x/",
			"/2023//07/",
			"/posts/2023/07/",
		])
			expect(parseDatePath(path), path).toBeNull();
	});

	it("is under the site's front (`/blog/`, `/date/`) when its permalinks have one", () => {
		expect(parseDatePath("/blog/2023/07/", "/blog/")).toEqual({ y: 2023, m: 7, page: 1 });
		expect(parseDatePath("/2023/07/", "/blog/")).toBeNull();
		expect(datePath({ y: 2023, m: 7, page: 1 }, { front: "/date/" })).toBe("/date/2023/07/");
		// a front that is not a path is WordPress's own
		expect(parseDatePath("/2023/07/", "javascript:x")).toEqual({ y: 2023, m: 7, page: 1 });
	});

	it("is written back as WordPress writes it: two-digit months and days, `page/N/`, and `?m=` on plain permalinks", () => {
		expect(datePath({ y: 2023, m: 7, page: 1 })).toBe("/2023/07/");
		expect(datePath({ y: 2023, m: 7, d: 5, page: 2 })).toBe("/2023/07/05/page/2/");
		expect(datePath({ y: 2023, page: 1 })).toBe("/2023/");
		expect(datePath({ y: 2023, m: 7, page: 1 }, { front: "/", plain: true })).toBe("/?m=202307");
		expect(datePath({ y: 2023, m: 7, d: 5, page: 3 }, { front: "/", plain: true })).toBe(
			"/?m=20230705&paged=3",
		);
	});

	it("is WordPress's `m` query on plain permalinks, with its `paged` page", () => {
		expect(parseDateQuery("202307")).toEqual({ y: 2023, m: 7, page: 1 });
		expect(parseDateQuery("2023", "2")).toEqual({ y: 2023, page: 2 });
		expect(parseDateQuery("20230705", "x")).toEqual({ y: 2023, m: 7, d: 5, page: 1 });
		for (const m of [null, "", "2023-07", "202313", "20230230", "20237"])
			expect(parseDateQuery(m), String(m)).toBeNull();
	});
});

describe("the posts a date archive holds", () => {
	it("are the ones published in its month in the site's time zone, not in UTC", () => {
		// July 2023 in Los Angeles (UTC-7): from 07:00 on July 1 to 07:00 on August 1, UTC.
		expect(dateRange({ y: 2023, m: 7, page: 1 }, { timeZone: "America/Los_Angeles" })).toEqual({
			gte: "2023-07-01T07:00:00.000Z",
			lt: "2023-08-01T07:00:00.000Z",
		});
		// January in Los Angeles is UTC-8, and December's end is the next year's start
		expect(dateRange({ y: 2022, m: 12, page: 1 }, { timeZone: "America/Los_Angeles" })).toEqual({
			gte: "2022-12-01T08:00:00.000Z",
			lt: "2023-01-01T08:00:00.000Z",
		});
		expect(dateRange({ y: 2023, m: 7, page: 1 }, { utcOffset: 330 })).toEqual({
			gte: "2023-06-30T18:30:00.000Z",
			lt: "2023-07-31T18:30:00.000Z",
		});
		expect(dateRange({ y: 2023, page: 1 })).toEqual({
			gte: "2023-01-01T00:00:00.000Z",
			lt: "2024-01-01T00:00:00.000Z",
		});
		expect(dateRange({ y: 2024, m: 2, d: 29, page: 1 })).toEqual({
			gte: "2024-02-29T00:00:00.000Z",
			lt: "2024-03-01T00:00:00.000Z",
		});
	});

	it("starts a day where the site's clock first shows it, across a change of offset at midnight", () => {
		// Santiago moved its clocks from 00:00 to 01:00 on 2023-09-03 (UTC-4 to UTC-3): the day starts at 01:00, 04:00 UTC.
		expect(dateRange({ y: 2023, m: 9, d: 3, page: 1 }, { timeZone: "America/Santiago" }).gte).toBe(
			"2023-09-03T04:00:00.000Z",
		);
		// and back from 00:00 to 23:00 on 2023-04-02 (UTC-3 to UTC-4): the clock first shows April 2 at 04:00 UTC.
		expect(dateRange({ y: 2023, m: 4, d: 2, page: 1 }, { timeZone: "America/Santiago" }).gte).toBe(
			"2023-04-02T04:00:00.000Z",
		);
	});
});

describe("the Archives widget's months", () => {
	const d = (iso: string) => new Date(iso);

	it("are the months the posts fall in, newest first, each with its count, in the site's time zone", () => {
		const dates = [
			d("2023-07-05T12:00:00Z"),
			// 23:30 on July 31 in Los Angeles: July's, though it is August in UTC
			d("2023-08-01T06:30:00Z"),
			d("2022-12-18T10:00:00Z"),
			d("2022-12-17T10:00:00Z"),
			d("not a date"),
		];
		expect(archiveGroups(dates, "monthly", { timeZone: "America/Los_Angeles" })).toEqual([
			{ y: 2023, m: 7, count: 2 },
			{ y: 2022, m: 12, count: 2 },
		]);
		expect(archiveGroups(dates, "monthly")).toEqual([
			{ y: 2023, m: 8, count: 1 },
			{ y: 2023, m: 7, count: 1 },
			{ y: 2022, m: 12, count: 2 },
		]);
		expect(archiveGroups(dates, "yearly")).toEqual([
			{ y: 2023, count: 2 },
			{ y: 2022, count: 2 },
		]);
	});

	it("are named as WordPress names them, and a date archive's heading is the theme's own phrase", () => {
		expect(archiveLabel({ y: 2023, m: 7 })).toBe("July 2023");
		expect(archiveLabel({ y: 2023 })).toBe("2023");
		expect(archiveName({ y: 2023, m: 7, d: 5, page: 1 })).toBe("July 5, 2023");
		expect(archiveTitle({ y: 2022, m: 12, page: 1 }, { month: "Monthly Archive: %s" })).toBe(
			"Monthly Archive: December 2022",
		);
		expect(archiveTitle({ y: 2022, page: 1 }, { month: "Monthly Archive: %s" })).toBe("Year: 2022");
		expect(archiveTitle({ y: 2022, m: 12, d: 1, page: 1 })).toBe("Day: December 1, 2022");
	});
});
