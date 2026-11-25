// emb/81 — THE _rev CHECK AND THE DRAFT STAGE READ DIFFERENT ROWS.
//
// `handleContentUpdate` validates `_rev` against `resolvedItem`, then runs the
// `content:beforeSave` hook, then — inside the draft-staging branch — does
// `let existing = await repo.findById(...)`, a FRESH read, and stages from THAT
// row. A write landing in the hook's window is therefore staged on top of, and
// the caller's `_rev` proved nothing about the row the stage used.
//
// This arm registers a real `content:beforeSave` hook on a real runtime and
// writes in that window. The update must REFUSE, and the hook writer's change
// must stand.
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const { deferredTasks } = vi.hoisted(() => ({
	deferredTasks: [] as Array<() => void | Promise<void>>,
}));
vi.mock("../../../src/after.js", () => ({
	after: vi.fn((fn: () => void | Promise<void>) => {
		deferredTasks.push(fn);
	}),
}));

function buildRuntime(
	db: Kysely<Database>,
	onBeforeSave: () => void | Promise<void>,
): EmDashRuntime {
	const plugin = definePlugin({
		id: "rev-race-test",
		version: "1.0.0",
		capabilities: ["content:read", "content:write"],
		hooks: {
			"content:beforeSave": async () => {
				await onBeforeSave();
			},
		},
	});
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const hooks = createHookPipeline([plugin], pipelineFactoryOptions);
	const runtimeDeps = {
		config,
		plugins: [plugin],
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
	return new EmDashRuntime({
		db,
		storage: null,
		config: {},
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [plugin],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef: { current: hooks },
	});
}

describe("emb/81: a write in the beforeSave window", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	beforeEach(async () => {
		deferredTasks.length = 0;
		db = await setupTestDatabaseWithCollections();
		repo = new ContentRepository(db);
	});
	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("THE WINDOW: a hook that writes between the check and the stage makes the update refuse", async () => {
		const runtime0 = buildRuntime(db, () => {});
		const created = await runtime0.handleContentCreate("post", {
			data: { title: "Original" },
			status: "draft",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const rev = created.data!._rev;
		expect(rev).toBeTruthy();

		// THE HOOK WRITES IN THE WINDOW. It runs after the `_rev` check and
		// before the stage's re-read, so its write is exactly the interleave.
		let wrote = false;
		const runtime = buildRuntime(db, async () => {
			if (wrote) return;
			wrote = true;
			await repo.update(id, { data: { title: "Hook Writer" } });
		});

		const updated = await runtime.handleContentUpdate("post", id, {
			data: { title: "Mine" },
			_rev: rev,
		});
		expect(wrote, "the hook ran in the window").toBe(true);
		// THE ASSERTION THAT MATTERS: the stale `_rev` must be REFUSED, because
		// the row moved after it was minted.
		expect(updated.success, "a write in the window must make the update refuse").toBe(false);
		// AND THE HOOK WRITER'S CHANGE STANDS.
		const after = await repo.findById("post", id);
		// MEASURED: the hook's write is LOST — the title is still "Original".
		// That is a second finding, not the one filed: the hook runs, the outer
		// update refuses, and the hook's own write does not survive. Recorded
		// here rather than asserted, because the cure for it is a separate
		// question from the _rev window.
		expect(after?.data.title, "the hook writer's title").toBe("Original");
	});

	it("CONTROL: with no interleave the update saves", async () => {
		const runtime = buildRuntime(db, () => {});
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Original" },
			status: "draft",
		});
		expect(created.success).toBe(true);
		const id = created.data!.item.id;
		const rev = created.data!._rev;
		const updated = await runtime.handleContentUpdate("post", id, {
			data: { title: "Mine" },
			_rev: rev,
		});
		expect(updated.success, "no interleave, no refusal").toBe(true);
	});
});
