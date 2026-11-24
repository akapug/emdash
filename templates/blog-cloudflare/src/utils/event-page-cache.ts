import * as emdashModule from "emdash";

import { eventBoundaryClocks, eventCurrentClock, eventToday, type EventSummary } from "./events.js";

const SECOND_MS = 1_000;
const DAY_SECONDS = 86_400;
const FIXED_ETC_ZONE = /^Etc\/GMT(?:[+-]\d{1,2})?$/;

function secondsOfDay(clock: string): number {
	return (
		Number(clock.slice(0, 2)) * 3_600 + Number(clock.slice(3, 5)) * 60 + Number(clock.slice(6))
	);
}

function fixedZone(timezone: string): boolean {
	return (
		timezone === "UTC" ||
		timezone === "Etc/UTC" ||
		timezone.startsWith("+") ||
		timezone.startsWith("-") ||
		FIXED_ETC_ZONE.test(timezone)
	);
}

interface CivilZone {
	today: string;
	secondOfDay: number;
	offset?: Intl.DateTimeFormat;
}

/** Bound an existing or later route opt-in by the validity of this calendar snapshot. */
export function boundEventPageCache(
	events: readonly EventSummary[],
	now: Date,
	siteTimezone?: string,
): void {
	if (!("optOutPageCache" in emdashModule) || typeof emdashModule.optOutPageCache !== "function") {
		return;
	}
	if ("getPageCacheState" in emdashModule && typeof emdashModule.getPageCacheState === "function") {
		const state = emdashModule.getPageCacheState();
		if (!state || state.optedOut) return;
	}
	if (
		!("capPageCacheUntil" in emdashModule) ||
		typeof emdashModule.capPageCacheUntil !== "function"
	) {
		emdashModule.optOutPageCache();
		return;
	}

	const { PAGE_CACHE_MIN_TTL_SECONDS: minSeconds, PAGE_CACHE_MAX_TTL_SECONDS: maxSeconds } =
		emdashModule;
	const nowMs = now.getTime();
	const wholeSecond = Math.floor(nowMs / SECOND_MS) * SECOND_MS;
	const minimumMs = minSeconds * SECOND_MS;
	// Even without a nearby change, slow fills cannot outlive the certified interval.
	let deadline = nowMs + (maxSeconds + minSeconds) * SECOND_MS;
	if (!Number.isSafeInteger(deadline)) {
		emdashModule.optOutPageCache();
		return;
	}

	const byInput = new Map<string, CivilZone>();
	const zones = new Map<string, CivilZone>();
	function getZone(input = "UTC"): CivilZone {
		const known = byInput.get(input);
		if (known) return known;
		let formatter: Intl.DateTimeFormat | undefined;
		if (input !== "UTC") {
			try {
				formatter = new Intl.DateTimeFormat("en-US", {
					timeZone: input,
					timeZoneName: "longOffset",
				});
			} catch {
				// An unknown source zone falls back to UTC, not the site zone.
			}
		}
		const timezone = formatter?.resolvedOptions().timeZone ?? "UTC";
		let zone = zones.get(timezone);
		if (!zone) {
			const reference = timezone === "UTC" ? undefined : timezone;
			zone = {
				today: eventToday(now, reference),
				secondOfDay: secondsOfDay(eventCurrentClock(now, reference)),
				offset: fixedZone(timezone) ? undefined : formatter,
			};
			zones.set(timezone, zone);
			deadline = Math.min(deadline, wholeSecond + (DAY_SECONDS - zone.secondOfDay) * SECOND_MS);
		}
		byInput.set(input, zone);
		return zone;
	}

	// An empty list can still navigate using the site's current month.
	getZone(siteTimezone);
	for (const event of events) {
		if (deadline - nowMs < minimumMs) break;
		const zone = getZone(event.referenceTimezone ?? event.timezone ?? siteTimezone);
		const { start, cutoff } = eventBoundaryClocks(event, zone.today);
		const startIn = start === undefined ? 0 : secondsOfDay(start) - zone.secondOfDay;
		// Selection uses a strict comparison against a clock truncated to whole seconds.
		const cutoffIn = cutoff === undefined ? 0 : secondsOfDay(cutoff) + 1 - zone.secondOfDay;
		if (startIn > 0) deadline = Math.min(deadline, wholeSecond + startIn * SECOND_MS);
		if (cutoffIn > 0) deadline = Math.min(deadline, wholeSecond + cutoffIn * SECOND_MS);
	}

	for (const { offset } of zones.values()) {
		if (deadline - nowMs < minimumMs) break;
		if (!offset) continue;
		const initial = offset.format(wholeSecond);
		// Equal endpoint offsets cannot certify the interval. Check every second the
		// renderer can observe until the first discontinuity or the earliest civil cap.
		for (let instant = wholeSecond + SECOND_MS; instant < deadline; instant += SECOND_MS) {
			if (offset.format(instant) !== initial) {
				deadline = instant;
				break;
			}
		}
	}

	if (deadline - nowMs < minimumMs) emdashModule.optOutPageCache();
	else emdashModule.capPageCacheUntil(deadline);
}
