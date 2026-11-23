export const MAX_NOTIFY_EMAILS = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SPLIT_RE = /[\n,;]+/;

export function formatNotifyEmails(emails: readonly string[] | undefined): string {
	return (emails ?? []).join(", ");
}

export function parseNotifyEmails(raw: string): { emails: string[]; error: string | null } {
	const parts = raw
		.split(SPLIT_RE)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	const seen = new Set<string>();
	const emails: string[] = [];
	const invalid: string[] = [];
	for (const part of parts) {
		const key = part.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		if (!EMAIL_RE.test(part)) {
			invalid.push(part);
			continue;
		}
		emails.push(part);
	}
	if (invalid.length > 0) {
		return { emails: [], error: `Invalid notification email address: ${invalid.join(", ")}` };
	}
	if (emails.length > MAX_NOTIFY_EMAILS) {
		return {
			emails: [],
			error: `At most ${MAX_NOTIFY_EMAILS} notification email addresses are allowed`,
		};
	}
	return { emails, error: null };
}
