import { getViteConfig } from "astro/config";

// Render tests compile .astro components, which needs Astro's Vite plugin; the
// plain-node config in vitest.config.ts cannot load them.
export default getViteConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.render.test.ts"],
	},
});
