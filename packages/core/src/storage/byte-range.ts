import type { ByteRange } from "./types.js";

const SINGLE_BYTE_RANGE = /^bytes=(\d*)-(\d*)$/i;

/** Ignore unknown units, malformed headers, and multipart ranges. */
export function parseByteRange(header: string | null): ByteRange | null {
	const match = header?.match(SINGLE_BYTE_RANGE);
	if (!match) return null;
	const [, start, end] = match;
	// Saturation preserves the meaning against any representable object size.
	const first = Math.min(Number(start), Number.MAX_SAFE_INTEGER);
	const last = Math.min(Number(end), Number.MAX_SAFE_INTEGER);
	if (!start) return end ? { suffix: last } : null;
	return end ? { start: first, end: last } : { start: first };
}

export function resolveByteRange(
	range: ByteRange,
	size: number,
): { start: number; end: number } | null {
	if (!Number.isSafeInteger(size) || size <= 0) return null;
	if ("suffix" in range) {
		if (!Number.isSafeInteger(range.suffix) || range.suffix <= 0) return null;
		return { start: Math.max(0, size - range.suffix), end: size - 1 };
	}
	if (!Number.isSafeInteger(range.start) || range.start < 0 || range.start >= size) return null;
	const end = range.end ?? size - 1;
	if (!Number.isSafeInteger(end) || end < range.start) return null;
	return { start: range.start, end: Math.min(end, size - 1) };
}
