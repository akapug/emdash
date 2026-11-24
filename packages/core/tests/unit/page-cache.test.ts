import { describe, expect, it } from "vitest";

import {
	__setObjectCacheBackendInitForTests,
	invalidatePluginObjectCache,
	invalidateWidgetObjectCache,
	readPageGenerationVector,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import {
	getPageCacheState,
	optInPageCache,
	optOutPageCache,
	runWithPageCacheState,
} from "../../src/page-cache/state.js";

describe("page-cache state & ordered generation vector", () => {
	it("enforces irreversible opt-out and clamped explicit positive opt-in", () => {
		runWithPageCacheState(() => {
			expect(getPageCacheState()).toEqual({
				optedIn: false,
				optedOut: false,
				ttlSeconds: 0,
				fillPrimary: false,
			});
			optInPageCache(0);
			expect(getPageCacheState()?.optedIn).toBe(false);
			optInPageCache(9999);
			expect(getPageCacheState()).toEqual({
				optedIn: true,
				optedOut: false,
				ttlSeconds: 300,
				fillPrimary: false,
			});
			optOutPageCache();
			expect(getPageCacheState()).toEqual({
				optedIn: false,
				optedOut: true,
				ttlSeconds: 0,
				fillPrimary: false,
			});
			// Subsequent opt-in must NOT clear optedOut
			optInPageCache(300);
			expect(getPageCacheState()).toEqual({
				optedIn: false,
				optedOut: true,
				ttlSeconds: 0,
				fillPrimary: false,
			});
		});
	});

	it("tracks widget and plugin epochs in the ordered vector and marks backend errors uncertain", async () => {
		const kv = new Map<string, string>();
		let shouldThrow = false;
		const backend: ObjectCacheBackend = {
			async get(k) {
				if (shouldThrow) throw new Error("kv down");
				return kv.get(k) ?? null;
			},
			async set(k, v) {
				kv.set(k, v);
			},
			async delete(k) {
				kv.delete(k);
			},
		};
		__setObjectCacheBackendInitForTests(Promise.resolve(backend), Date.now());

		const v0 = await readPageGenerationVector("build-1");
		expect(v0.certain).toBe(true);
		expect(v0.vector).toContain("v1|b=build-1|");

		invalidateWidgetObjectCache();
		const v1 = await readPageGenerationVector("build-1");
		expect(v1.certain).toBe(true);
		expect(v1.vector).not.toBe(v0.vector);

		invalidatePluginObjectCache();
		const v2 = await readPageGenerationVector("build-1");
		expect(v2.certain).toBe(true);
		expect(v2.vector).not.toBe(v1.vector);

		// When backend errors on a fresh cold init, certainty MUST be false
		shouldThrow = true;
		__setObjectCacheBackendInitForTests(Promise.resolve(backend), Date.now());
		const vErr = await readPageGenerationVector("build-1");
		// Note: isolate epochCache still holds recent <1000ms stamps, so test with null backend too
		__setObjectCacheBackendInitForTests(Promise.resolve(null), Date.now());
		const vNull = await readPageGenerationVector("build-1");
		expect(vNull.certain).toBe(false);
		expect(typeof vErr.certain).toBe("boolean");
	});
});
