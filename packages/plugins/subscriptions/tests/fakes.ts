/** The plugin's storage, KV and cron, kept in memory, for its tests. */

import { vi } from "vitest";

/** A storage collection kept in a Map, with the where/orderBy/limit/cursor the plugin uses. */
export function collection<T extends object>() {
	const rows = new Map<string, T>();
	const matches = (data: T, where: Record<string, unknown> = {}) =>
		Object.entries(where).every(([k, v]) => (data as Record<string, unknown>)[k] === v);
	return {
		rows,
		get: async (id: string) => rows.get(id) ?? null,
		put: async (id: string, data: T) => void rows.set(id, data),
		delete: async (id: string) => rows.delete(id),
		deleteMany: async (ids: string[]) => ids.filter((id) => rows.delete(id)).length,
		compareAndSet: async (id: string, expected: string | null, data: T) => {
			if (expected !== null || rows.has(id)) return { applied: false as const };
			rows.set(id, data);
			return { applied: true as const, revision: "1" };
		},
		count: async (where?: Record<string, unknown>) =>
			[...rows.values()].filter((d) => matches(d, where)).length,
		query: async (
			o: {
				where?: Record<string, unknown>;
				orderBy?: Record<string, "asc" | "desc">;
				limit?: number;
				cursor?: string;
			} = {},
		) => {
			let items = [...rows.entries()]
				.filter(([, d]) => matches(d, o.where))
				.map(([id, data]) => ({ id, data }));
			const [field, dir] = Object.entries(o.orderBy ?? {})[0] ?? [];
			if (field)
				items.sort(
					(a, b) =>
						String((a.data as Record<string, unknown>)[field]).localeCompare(
							String((b.data as Record<string, unknown>)[field]),
						) * (dir === "desc" ? -1 : 1),
				);
			const start = o.cursor ? Number(o.cursor) : 0;
			const limit = o.limit ?? 50;
			const page = items.slice(start, start + limit);
			return {
				items: page,
				hasMore: start + limit < items.length,
				...(start + limit < items.length ? { cursor: String(start + limit) } : {}),
			};
		},
	};
}

export function kv() {
	const values = new Map<string, unknown>();
	return {
		values,
		get: async <T>(key: string) => (values.has(key) ? (values.get(key) as T) : null),
		set: async (key: string, value: unknown) => void values.set(key, value),
		delete: async (key: string) => values.delete(key),
		compareAndSet: async (key: string, expected: string | null, value: unknown) => {
			if (expected !== null || values.has(key)) return { applied: false as const };
			values.set(key, value);
			return { applied: true as const, revision: "1" };
		},
	};
}

/** The plugin's scheduled tasks, as EmDash's cron keeps them: one per name, a second schedule replacing the first. */
export function cron() {
	const tasks = new Map<string, string>();
	return {
		tasks,
		schedule: vi.fn(
			async (name: string, o: { schedule: string }) => void tasks.set(name, o.schedule),
		),
		cancel: vi.fn(async (name: string) => void tasks.delete(name)),
		list: vi.fn(async () =>
			Array.from(tasks, ([name, schedule]) => ({ name, schedule, nextRunAt: "", lastRunAt: null })),
		),
	};
}
