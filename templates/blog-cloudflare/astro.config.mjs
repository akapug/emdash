import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { embarkHelperPlugin } from "@emdash-cms/plugin-embark-helper";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { subscriptionsPlugin } from "@emdash-cms/plugin-subscriptions";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			// Email subscriptions to new posts: a migrated site's sign-up posts here (layouts/WpShell.astro).
			// The AI Helper stays inert until Embark writes the site's link key.
			plugins: [
				formsPlugin(),
				subscriptionsPlugin({ postPath: "/posts/{slug}" }),
				embarkHelperPlugin(),
			],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
