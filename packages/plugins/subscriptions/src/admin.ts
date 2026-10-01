/**
 * The Subscribers admin page, in Block Kit: how many subscribers the site
 * has and what waits to be sent, and the import of the list WordPress kept
 * (Jetpack keeps it on WordPress.com, not in the site's database).
 */

import {
	importSubscribers,
	stats,
	type ImportReport,
	type SubscriptionsEnv,
} from "./subscriptions.js";

/** How to get the list out of the platform that kept it, in the owner's steps. */
const EXPORT_STEPS =
	"From WordPress.com (or the WordPress admin: Jetpack, then Newsletter): open Subscribers and download the list as a CSV file. From Substack: Settings, then Exports, then download a zip of all your data, and open the email_list file inside it. Paste the file's text here. Each address becomes a confirmed subscriber, its consent recorded as brought over; a reader the file marks as not subscribed, or as having turned email off, is left out. No email is sent.";

async function page(env: SubscriptionsEnv, report?: ImportReport) {
	const s = await stats(env);
	return {
		blocks: [
			{ type: "header", text: "Subscribers" },
			{
				type: "stats",
				items: [
					{ label: "Confirmed", value: s.confirmed },
					{ label: "Waiting to confirm", value: s.pending },
					{ label: "Emails waiting", value: s.queued },
					{ label: "Emails that failed", value: s.failed },
				],
			},
			s.mail
				? {
						type: "context",
						text: "This site sends email: confirmations and new posts go out within five minutes.",
					}
				: {
						type: "banner",
						variant: "alert",
						title: "This site cannot send email yet",
						description:
							"Sign-ups are saved and visitors are told no email was sent. Confirmations and new posts wait, and go out once the site's email is set up.",
					},
			...(report ? [reportBlock(report)].flat() : []),
			{ type: "divider" },
			{ type: "header", text: "Import a subscriber list from another platform" },
			{ type: "context", text: EXPORT_STEPS },
			{
				type: "form",
				block_id: "import",
				fields: [
					{
						type: "text_input",
						action_id: "csv",
						label: "The CSV file's text",
						multiline: true,
					},
				],
				submit: { label: "Import", action_id: "import" },
			},
		],
	};
}

function reportBlock(r: ImportReport) {
	if (r.refused)
		return {
			type: "banner",
			variant: "error",
			title: "Nothing was imported",
			description: r.refused,
		};
	return r.paid > 0 ? [reportFields(r), paidBanner(r)] : [reportFields(r)];
}

/** Paying readers' payments stay where they were: a person moves them. */
function paidBanner(r: ImportReport) {
	return {
		type: "banner",
		variant: "alert",
		title: `${r.paid} reader(s) pay for this newsletter`,
		description:
			"This import moves addresses, not payments: paid subscriptions keep running where they were until a person moves them. Ask whoever hosts your site for help before you stop the old one.",
	};
}

function reportFields(r: ImportReport) {
	const skipped = Object.entries(r.notSubscribed)
		.map(([state, n]) => `${n} marked "${state || "blank"}"`)
		.join(", ");
	return {
		type: "fields",
		fields: [
			{ label: "Rows read", value: String(r.rows) },
			{ label: "Imported", value: String(r.imported) },
			{ label: "Confirmed by the list", value: String(r.confirmed) },
			{ label: "Already subscribed", value: String(r.already) },
			{ label: "Not an address", value: String(r.invalid) },
			{ label: "Not subscribed in the file", value: skipped || "0" },
		],
	};
}

/** The admin route: the page, and the import it submits. */
export async function adminPage(env: SubscriptionsEnv, input: unknown) {
	const interaction = (input ?? {}) as {
		type?: string;
		action_id?: string;
		values?: Record<string, unknown>;
	};
	if (interaction.type === "form_submit" && interaction.action_id === "import") {
		const csv = typeof interaction.values?.csv === "string" ? interaction.values.csv : "";
		const report = await importSubscribers(env, csv);
		return {
			...(await page(env, report)),
			toast: report.refused
				? { type: "error", message: "Nothing was imported" }
				: {
						type: "success",
						message: `${report.imported + report.confirmed} subscriber(s) imported`,
					},
		};
	}
	return page(env);
}
