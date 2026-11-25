/**
 * The media handlers as MIDDLEWARE binds them, built through the real runtime.
 *
 * A fixture that hands a route its own handler method can pass while the shipped route
 * throws, because "defined" and "bound" are different facts. This builds the object a
 * request actually sees: the runtime constructor, then the same two handler methods the
 * middleware puts on `locals.emdash`.
 */
import type { Kysely } from "kysely";

import { EmDashRuntime } from "../../src/emdash-runtime.js";
import type { Database } from "../../src/database/types.js";

/** A minimal locals object for a route that needs the media handlers and storage. */
export function mediaLocalsFor(db: Kysely<Database>, storage: unknown) {
	const runtime = new EmDashRuntime({
		db,
		storage: storage as never,
		config: {} as never,
	});
	return {
		db,
		storage,
		// The SAME two methods middleware.ts:958-975 binds, taken from the runtime rather
		// than reimplemented here.
		handleMediaGet: runtime.handleMediaGet.bind(runtime),
		// A RED-FIRST PROOF FOR THE BINDING: with the middleware line removed, this
		// expression is `undefined` and the route throws — which is the shipped defect the
		// lead found by grep. The non-null assertion documents that the runtime OWNS the
		// method; if it stops owning it, this fixture fails loudly rather than silently
		// supplying a stand-in.
		handleMediaVariantStore: runtime.handleMediaVariantStore!.bind(runtime),
	};
}
