/**
 * No-code visual design tweaks plugin for EmDash CMS (emb/27).
 *
 * - Trusted `page:fragments` hook emits one `<style data-embark-design>` in
 *   `<head>` after the site/shell CSS from active rules stored in plugin KV.
 * - Admin-only API routes (`rules/list`, `rules/upsert`, `rules/delete`,
 *   `rules/flag-mismatch`, `rules/undo`, `rules/css`) enforce selector and CSS
 *   value sanitization and maintain bounded undo history (last 25 versions).
 * - Admin page `/design` embeds the live site in a same-origin iframe with
 *   the vanilla JS picker and sidebar style controls.
 */

import type { PluginContext, PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

import { version } from "../package.json";
import {
	compileDesignCss,
	MAX_HISTORY,
	MAX_RULES,
	sanitizeDeclarations,
	sanitizePagePath,
	sanitizeSelector,
	type DesignRule,
	type ElementFingerprint,
} from "./css.js";

export {
	ALLOWED_CSS_PROPERTIES,
	compileDesignCss,
	MAX_HISTORY,
	MAX_RULES,
	MAX_SELECTOR_LEN,
	MAX_SELECTOR_PARTS,
	MAX_VALUE_LEN,
	sanitizeCssDeclaration,
	sanitizeDeclarations,
	sanitizePagePath,
	sanitizeSelector,
	type DesignRule,
	type DesignRuleStatus,
	type ElementFingerprint,
} from "./css.js";
export {
	buildStableSelector,
	computeFingerprint,
	fingerprintsMatch,
	hashElementText,
	PICKER_SCRIPT,
	type SelectorNodeInfo,
} from "./picker.js";

const RULES_KV_KEY = "design:rules";
const HISTORY_KV_KEY = "design:history";

export interface DesignPluginOptions {
	/** Maximum undo snapshots retained in plugin KV (default 25). */
	maxHistory?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readRules(ctx: PluginContext): Promise<DesignRule[]> {
	const raw = await ctx.kv.get<DesignRule[]>(RULES_KV_KEY);
	return Array.isArray(raw) ? raw : [];
}

async function readHistory(ctx: PluginContext): Promise<DesignRule[][]> {
	const raw = await ctx.kv.get<DesignRule[][]>(HISTORY_KV_KEY);
	return Array.isArray(raw) ? raw : [];
}

async function pushHistory(ctx: PluginContext, snapshot: DesignRule[], maxHistory: number): Promise<number> {
	const history = await readHistory(ctx);
	const next = [...history, snapshot].slice(-Math.max(1, maxHistory));
	await ctx.kv.set(HISTORY_KV_KEY, next);
	return next.length;
}

function parseFingerprint(raw: unknown): ElementFingerprint | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.tag !== "string" || typeof raw.textHash !== "string") return null;
	const tag = raw.tag.trim().toLowerCase();
	const textHash = raw.textHash.trim().toLowerCase();
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(tag) || !/^[0-9a-f]{8}$/.test(textHash)) return null;
	return { tag, textHash };
}

function makeRuleId(): string {
	return `dr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function designPlugin(options: DesignPluginOptions = {}): PluginDescriptor<DesignPluginOptions> {
	return {
		id: "design",
		version,
		entrypoint: "@emdash-cms/plugin-design",
		options,
		adminEntry: "@emdash-cms/plugin-design/admin",
		adminPages: [{ path: "/design", label: "Design", icon: "paint-brush" }],
	};
}

export function createPlugin(options: DesignPluginOptions = {}): ResolvedPlugin {
	const maxHistory = options.maxHistory ?? MAX_HISTORY;

	return definePlugin({
		id: "design",
		version,
		capabilities: [],

		admin: {
			entry: "@emdash-cms/plugin-design/admin",
			pages: [{ path: "/design", label: "Design", icon: "paint-brush" }],
		},

		hooks: {
			"page:fragments": {
				handler: async (event, ctx) => {
					const rules = await readRules(ctx);
					if (rules.length === 0) return null;
					const pathname = event.page?.path ?? event.page?.url;
					const css = compileDesignCss(rules, pathname);
					if (!css) return null;
					return {
						kind: "html",
						placement: "head",
						html: `<style data-embark-design>${css}</style>`,
						key: "embark-design-css",
					};
				},
			},
		},

		// All routes are admin-only (never `public: true`).
		routes: {
			"rules/list": {
				handler: async (ctx) => {
					const [rules, history] = await Promise.all([readRules(ctx), readHistory(ctx)]);
					const pagePath = isRecord(ctx.input) && typeof ctx.input.pagePath === "string" ? ctx.input.pagePath : undefined;
					return {
						rules,
						historyCount: history.length,
						css: compileDesignCss(rules, pagePath),
					};
				},
			},

			"rules/upsert": {
				handler: async (ctx) => {
					if (!isRecord(ctx.input)) {
						return { ok: false, error: "input must be an object" };
					}
					const selRes = sanitizeSelector(ctx.input.selector);
					if (!selRes.ok) return { ok: false, error: selRes.error };
					const declRes = sanitizeDeclarations(ctx.input.declarations);
					if (!declRes.ok) return { ok: false, error: declRes.error };
					const pathRes = sanitizePagePath(ctx.input.pagePath);
					if (!pathRes.ok) return { ok: false, error: pathRes.error };
					const fingerprint = parseFingerprint(ctx.input.fingerprint);
					if (!fingerprint) return { ok: false, error: "valid fingerprint { tag, textHash } is required" };

					const rules = await readRules(ctx);
					const requestedId = typeof ctx.input.id === "string" && ctx.input.id.trim() ? ctx.input.id.trim() : null;
					const existingIdx = requestedId
						? rules.findIndex((r) => r.id === requestedId)
						: rules.findIndex((r) => r.selector === selRes.value && (r.pagePath ?? undefined) === pathRes.value);

					if (existingIdx < 0 && rules.length >= MAX_RULES) {
						return { ok: false, error: `rule limit (${MAX_RULES}) reached` };
					}

					const historyCount = await pushHistory(ctx, rules, maxHistory);
					const updatedBy =
						typeof ctx.input.updatedBy === "string" && ctx.input.updatedBy.trim()
							? ctx.input.updatedBy.trim().slice(0, 64)
							: "admin";

					const nextRule: DesignRule = {
						id: existingIdx >= 0 ? rules[existingIdx]!.id : makeRuleId(),
						selector: selRes.value,
						declarations: declRes.value,
						fingerprint,
						...(pathRes.value !== undefined ? { pagePath: pathRes.value } : {}),
						status: "active",
						updatedBy,
						at: new Date().toISOString(),
					};

					const nextRules =
						existingIdx >= 0
							? rules.map((r, i) => (i === existingIdx ? nextRule : r))
							: [...rules, nextRule];
					await ctx.kv.set(RULES_KV_KEY, nextRules);

					return {
						ok: true,
						rule: nextRule,
						rules: nextRules,
						historyCount,
						css: compileDesignCss(nextRules, pathRes.value),
					};
				},
			},

			"rules/delete": {
				handler: async (ctx) => {
					const id = isRecord(ctx.input) && typeof ctx.input.id === "string" ? ctx.input.id.trim() : "";
					if (!id) return { ok: false, error: "id is required" };
					const rules = await readRules(ctx);
					const nextRules = rules.filter((r) => r.id !== id);
					if (nextRules.length === rules.length) {
						return { ok: false, error: "rule not found" };
					}
					const historyCount = await pushHistory(ctx, rules, maxHistory);
					await ctx.kv.set(RULES_KV_KEY, nextRules);
					return { ok: true, rules: nextRules, historyCount, css: compileDesignCss(nextRules) };
				},
			},

			"rules/flag-mismatch": {
				handler: async (ctx) => {
					const ids =
						isRecord(ctx.input) && Array.isArray(ctx.input.ids)
							? ctx.input.ids.filter((v): v is string => typeof v === "string")
							: [];
					if (ids.length === 0) return { ok: true, flagged: 0 };
					const idSet = new Set(ids);
					const rules = await readRules(ctx);
					let flagged = 0;
					const nextRules = rules.map((r) => {
						if (idSet.has(r.id) && r.status !== "element_changed") {
							flagged++;
							return { ...r, status: "element_changed" as const };
						}
						return r;
					});
					if (flagged > 0) {
						await ctx.kv.set(RULES_KV_KEY, nextRules);
					}
					return { ok: true, flagged, rules: nextRules, css: compileDesignCss(nextRules) };
				},
			},

			"rules/undo": {
				handler: async (ctx) => {
					const history = await readHistory(ctx);
					if (history.length === 0) {
						const rules = await readRules(ctx);
						return { ok: true, restored: false, rules, historyCount: 0, css: compileDesignCss(rules) };
					}
					const previous = history[history.length - 1]!;
					const nextHistory = history.slice(0, -1);
					await ctx.kv.set(RULES_KV_KEY, previous);
					await ctx.kv.set(HISTORY_KV_KEY, nextHistory);
					return {
						ok: true,
						restored: true,
						rules: previous,
						historyCount: nextHistory.length,
						css: compileDesignCss(previous),
					};
				},
			},

			"rules/css": {
				handler: async (ctx) => {
					const rules = await readRules(ctx);
					const pagePath = isRecord(ctx.input) && typeof ctx.input.pagePath === "string" ? ctx.input.pagePath : undefined;
					return { css: compileDesignCss(rules, pagePath) };
				},
			},
		},
	});
}

export default createPlugin;
