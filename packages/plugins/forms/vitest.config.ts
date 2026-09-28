import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Render tests run under vitest.render.config.ts, with Astro's Vite plugin.
		exclude: ["tests/**/*.render.test.ts", "**/node_modules/**"],
	},
});
