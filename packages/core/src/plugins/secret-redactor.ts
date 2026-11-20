import { redactAddresses } from "./redact-addresses.js";

/**
 * What a plugin logs, sanitized: every log line and its data, natively
 * (createLogAccess) and through both sandbox bridges, go through `redact`.
 */
export interface PluginSecretRedactor {
	add(key: string, value: string): void;
	/**
	 * A copy of `value` with the plugin's secret settings replaced by
	 * `[REDACTED]` and every email address (in any letter case) replaced by
	 * `<an address at DOMAIN>` (redactAddresses), in strings, keys, nested
	 * data and errors.
	 */
	redact<T>(value: T): T;
}

export function createPluginSecretRedactor(): PluginSecretRedactor {
	const secretsByKey = new Map<string, [string, string?]>();
	const secretValues = (): string[] =>
		[
			...new Set(
				[...secretsByKey.values()].flat().filter((value): value is string => value !== undefined),
			),
		].toSorted((a, b) => b.length - a.length);
	const redactString = (value: string): string => {
		let redacted = value;
		for (const secret of secretValues()) {
			redacted = redacted.replaceAll(secret, "[REDACTED]");
		}
		// A plugin's log may name whoever a form, a comment or a send named.
		return redactAddresses(redacted);
	};
	const redactValue = (value: unknown, seen: WeakMap<object, unknown>): unknown => {
		if (typeof value === "string") return redactString(value);
		if (typeof value !== "object" || value === null) return value;
		const existing = seen.get(value);
		if (existing !== undefined) return existing;
		if (value instanceof Error) {
			const redacted = new Error(redactString(value.message));
			redacted.name = value.name;
			redacted.stack = value.stack ? redactString(value.stack) : undefined;
			seen.set(value, redacted);
			return redacted;
		}
		if (Array.isArray(value)) {
			const redacted: unknown[] = [];
			seen.set(value, redacted);
			for (const entry of value) redacted.push(redactValue(entry, seen));
			return redacted;
		}
		if (
			Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null
		) {
			const redacted: Record<string, unknown> = {};
			seen.set(value, redacted);
			for (const [key, entry] of Object.entries(value)) {
				redacted[redactString(key)] = redactValue(entry, seen);
			}
			return redacted;
		}
		return "[NonPlainObject]";
	};

	return {
		add(key, value) {
			if (value.length === 0) return;
			const current = secretsByKey.get(key)?.[0];
			if (current === value) return;
			secretsByKey.set(key, current ? [value, current] : [value]);
		},
		redact<T>(value: T): T {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- redaction preserves the logged value's outer API shape
			return redactValue(value, new WeakMap()) as T;
		},
	};
}
