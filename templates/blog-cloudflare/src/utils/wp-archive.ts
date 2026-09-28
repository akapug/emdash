/**
 * WordPress's date archives, at the paths WordPress served them.
 *
 * WordPress answers every year, month and day that has a published post at a
 * path of its own: `/2023/07/` lists July 2023's posts, `/2023/` the year's,
 * `/2023/07/05/` the day's, each paginated at `page/2/`. The path starts with
 * the "front" of the site's permalink structure (`/`, `/blog/`,
 * `/index.php/`), and moves under `date/` when the structure starts with the
 * post's id (wp-includes/class-wp-rewrite.php get_date_permastruct). A site
 * with plain permalinks has no such paths: its archives are `/?m=202307`.
 *
 * WordPress puts a post in the month its local date falls in, in the site's
 * time zone, not in UTC: a post published at 23:30 on July 31 in Los Angeles is
 * July's, though it is August in UTC. So every range here is taken in the
 * site's time zone.
 *
 * This module is pure (no EmDash runtime import) so the unit tests reach it.
 */

/** A site's time zone: an IANA name, or a fixed offset from UTC in minutes. UTC when it has neither. */
export interface WpZone {
	timeZone?: string;
	utcOffset?: number;
}

/** Where a site's date archives are: WordPress's front, or its plain `?m=` query. */
export interface WpDatePaths {
	/** The path before the year, with its slashes: `/`, `/blog/`, `/date/`. */
	front: string;
	/** Plain permalinks: an archive is `/?m=YYYYMM`, and has no path of its own. */
	plain?: boolean;
}

/** WordPress's own date archive paths, on a site that says nothing else. */
export const DEFAULT_DATE_PATHS: WpDatePaths = { front: "/" };

/** A year, a month of it, or a day of that; and which page of it. */
export interface WpDateArchive {
	y: number;
	m?: number;
	d?: number;
	page: number;
}

export const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/** A front: a path of plain segments, none of them `.` or `..`, starting and ending with a slash. */
export const DATE_FRONT = /^\/(?:(?!\.\.?\/)[A-Za-z0-9_.~-]{1,64}\/){0,4}$/;

const YEAR = /^\d{4}$/;
const NUMBER = /^\d{1,2}$/;
const PAGE = /^[1-9]\d{0,5}$/;
const QUERY_DATE = /^(\d{4})(\d{2})?(\d{2})?$/;

/** Whether `y`, `m`, `d` is a day the calendar has. */
function isDay(y: number, m: number, d: number): boolean {
	const t = new Date(Date.UTC(y, m - 1, d));
	return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** The archive a year, month and day (strings as a path or `?m=` has them) name, or null. */
function archiveOf(y: string, m?: string, d?: string, page = 1): WpDateArchive | null {
	const year = Number(y);
	if (!YEAR.test(y) || year < 1000) return null;
	if (m === undefined) return { y: year, page };
	const month = Number(m);
	if (!NUMBER.test(m) || month < 1 || month > 12) return null;
	if (d === undefined) return { y: year, m: month, page };
	const day = Number(d);
	if (!NUMBER.test(d) || !isDay(year, month, day)) return null;
	return { y: year, m: month, d: day, page };
}

/**
 * The archive `pathname` names under the site's front (`/2023/07/`,
 * `/2023/07/page/2/`, `/2023/`, `/2023/07/05/`, with or without the last
 * slash), or null when it names none. WordPress's rewrite rules take a month
 * or a day of one or two digits (`/2023/7/`), and so does this.
 */
export function parseDatePath(pathname: string, front = "/"): WpDateArchive | null {
	const base = DATE_FRONT.test(front) ? front : "/";
	if (!pathname.startsWith(base)) return null;
	const segments = pathname.slice(base.length).split("/");
	if (segments.at(-1) === "") segments.pop();
	let page = 1;
	if (segments.length >= 3 && segments.at(-2) === "page") {
		const n = segments.at(-1) ?? "";
		if (!PAGE.test(n)) return null;
		page = Number(n);
		segments.length -= 2;
	}
	if (segments.length < 1 || segments.length > 3 || segments.some((s) => s === "")) return null;
	const [y, m, d] = segments;
	return archiveOf(y ?? "", m, d, page);
}

/**
 * The archive WordPress's `m` query names (plain permalinks: `?m=2023`,
 * `?m=202307`, `?m=20230705`), with its `paged` page, or null.
 */
export function parseDateQuery(m: string | null, paged?: string | null): WpDateArchive | null {
	const match = m ? QUERY_DATE.exec(m) : null;
	if (!match) return null;
	const page = paged && PAGE.test(paged) ? Number(paged) : 1;
	return archiveOf(match[1] ?? "", match[2], match[3], page);
}

const two = (n: number) => String(n).padStart(2, "0");

/** The archive's path on the site, in its permalinks: `/2023/07/`, `/2023/07/page/2/`, or `/?m=202307&paged=2`. */
export function datePath(a: WpDateArchive, paths: WpDatePaths = DEFAULT_DATE_PATHS): string {
	if (paths.plain) {
		const m = `${a.y}${a.m ? two(a.m) : ""}${a.m && a.d ? two(a.d) : ""}`;
		return `/?m=${m}${a.page > 1 ? `&paged=${a.page}` : ""}`;
	}
	const front = DATE_FRONT.test(paths.front) ? paths.front : "/";
	const date = [String(a.y), ...(a.m ? [two(a.m)] : []), ...(a.m && a.d ? [two(a.d)] : [])].join(
		"/",
	);
	return `${front}${date}/${a.page > 1 ? `page/${a.page}/` : ""}`;
}

/** The calendar day and time `date` falls on in the site's time zone (UTC when it has none, or an unknown one). */
function wallClock(
	date: Date,
	zone: WpZone,
): { y: number; m: number; d: number; h: number; i: number; s: number } {
	if (zone.timeZone) {
		try {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: zone.timeZone,
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "numeric",
				minute: "numeric",
				second: "numeric",
				hourCycle: "h23",
			}).formatToParts(date);
			const part = (type: string) => Number(parts.find((x) => x.type === type)?.value);
			return {
				y: part("year"),
				m: part("month"),
				d: part("day"),
				h: part("hour"),
				i: part("minute"),
				s: part("second"),
			};
		} catch {
			// An unknown zone: UTC, below.
		}
	}
	const t = new Date(date.getTime() + (zone.utcOffset ?? 0) * 60_000);
	return {
		y: t.getUTCFullYear(),
		m: t.getUTCMonth() + 1,
		d: t.getUTCDate(),
		h: t.getUTCHours(),
		i: t.getUTCMinutes(),
		s: t.getUTCSeconds(),
	};
}

/** The calendar day `date` falls on in the site's time zone (UTC when it has none, or an unknown one). */
export function dayIn(date: Date, zone: WpZone): { y: number; m: number; d: number } {
	const { y, m, d } = wallClock(date, zone);
	return { y, m, d };
}

/** How far the site's clock is ahead of UTC at `t`, in milliseconds. */
function offsetAt(t: number, zone: WpZone): number {
	const w = wallClock(new Date(t), zone);
	return Date.UTC(w.y, w.m - 1, w.d, w.h, w.i, w.s) - Math.floor(t / 1000) * 1000;
}

/**
 * The first instant of a local day, in the site's time zone. Where the offset
 * changes at midnight, it is the first instant the site's clock shows that
 * day's date: a zone whose clock jumps from 00:00 to 01:00 starts the day at
 * 01:00, one whose clock goes back from 00:00 to 23:00 starts it when the
 * clock next reaches midnight.
 */
function localMidnight(y: number, m: number, d: number, zone: WpZone): number {
	const wall = Date.UTC(y, m - 1, d);
	const first = wall - offsetAt(wall, zone);
	const second = wall - offsetAt(first, zone);
	const onTheDay = [first, second].filter((t) => {
		const at = dayIn(new Date(t), zone);
		return at.y === y && at.m === m && at.d === d;
	});
	return onTheDay.length > 0 ? Math.min(...onTheDay) : first;
}

/**
 * The instants the archive spans in the site's time zone, as the half-open
 * range EmDash's `published_at` filter takes: `gte` its first instant, `lt`
 * the first instant after it.
 */
export function dateRange(a: WpDateArchive, zone: WpZone = {}): { gte: string; lt: string } {
	// The first day after the archive, by the calendar: Date.UTC carries a month or a day past its end.
	const after = new Date(
		a.m === undefined
			? Date.UTC(a.y + 1, 0, 1)
			: a.d === undefined
				? Date.UTC(a.y, a.m, 1)
				: Date.UTC(a.y, a.m - 1, a.d + 1),
	);
	const at = (y: number, m: number, d: number) =>
		new Date(localMidnight(y, m, d, zone)).toISOString();
	return {
		gte: at(a.y, a.m ?? 1, a.d ?? 1),
		lt: at(after.getUTCFullYear(), after.getUTCMonth() + 1, after.getUTCDate()),
	};
}

/** A month (or a year) that has published posts, and how many. */
export interface WpArchiveGroup {
	y: number;
	m?: number;
	count: number;
}

/**
 * The months (or years) the site's published posts fall in, newest first,
 * each with its count, in the site's time zone: WordPress's Archives widget
 * (wp_get_archives, grouped by the local post_date).
 */
export function archiveGroups(
	dates: readonly Date[],
	type: "monthly" | "yearly",
	zone: WpZone = {},
): WpArchiveGroup[] {
	const groups = new Map<number, WpArchiveGroup>();
	for (const date of dates) {
		if (Number.isNaN(date.getTime())) continue;
		const { y, m } = dayIn(date, zone);
		const key = type === "yearly" ? y * 100 : y * 100 + m;
		const g = groups.get(key);
		if (g) g.count++;
		else groups.set(key, type === "yearly" ? { y, count: 1 } : { y, m, count: 1 });
	}
	return [...groups.entries()].toSorted((a, b) => b[0] - a[0]).map(([, g]) => g);
}

/** A group's line, as WordPress prints it in English: `July 2023`, `2023`. */
export function archiveLabel(g: { y: number; m?: number }): string {
	return g.m ? `${MONTH_NAMES[g.m - 1]} ${g.y}` : String(g.y);
}

/**
 * The archive's name as WordPress's document title says it: the year, `July
 * 2023`, or the day in the site's date format (`F j, Y`, WordPress's default).
 */
export function archiveName(a: WpDateArchive): string {
	if (a.m === undefined) return String(a.y);
	if (a.d === undefined) return archiveLabel(a);
	return `${MONTH_NAMES[a.m - 1]} ${a.d}, ${a.y}`;
}

/** The theme's heading for each kind of date archive: its phrase, `%s` the archive's name. */
export interface WpArchiveTitles {
	year?: string;
	month?: string;
	day?: string;
}

/**
 * The heading WordPress prints on the archive (get_the_archive_title): the
 * theme's own phrase where the record carries one ("Monthly Archive: %s"),
 * WordPress's otherwise ("Month: %s").
 */
export function archiveTitle(a: WpDateArchive, titles: WpArchiveTitles = {}): string {
	const kind = a.m === undefined ? "year" : a.d === undefined ? "month" : "day";
	const phrase = titles[kind] ?? { year: "Year: %s", month: "Month: %s", day: "Day: %s" }[kind];
	return phrase.replace("%s", archiveName(a));
}
