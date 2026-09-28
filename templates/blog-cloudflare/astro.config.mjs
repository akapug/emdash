import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { cloudflareEmail } from "@emdash-cms/cloudflare/plugins";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";

// Email through Cloudflare Email Sending when the build names a sender:
// `EMDASH_EMAIL_FROM=notifications@mail.example.org astro build`. The sender's
// domain must be onboarded for Email Sending. The site's Worker sends nothing
// itself: every message, its forms' and its own sign-in mail (magic links,
// invites, recovery) alike, goes through the site's mail broker, a Worker of
// its own (`@emdash-cms/cloudflare/auth-mail/worker`) bound here as the service
// MAIL_BROKER, which alone holds the send_email bindings and the account's
// mail-budget tokens. This Worker holds only that binding and its generation's
// capability, the secret MAIL_BROKER_CAPABILITY; without either it sends
// nothing. The sender's name is the site's title. Without EMDASH_EMAIL_FROM
// the site has no email provider, and forms store submissions without mailing
// anyone.
const emailFrom = process.env.EMDASH_EMAIL_FROM?.trim();

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
			plugins: [
				formsPlugin(),
				...(emailFrom ? [cloudflareEmail({ from: emailFrom, broker: {} })] : []),
			],
			...(emailFrom
				? { systemMail: { binding: "MAIL_BROKER", capability: "MAIL_BROKER_CAPABILITY" } }
				: {}),
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
