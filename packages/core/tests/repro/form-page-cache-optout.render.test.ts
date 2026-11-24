/**
 * Pages that render a form, sign-up box, captcha, or per-visitor token must
 * always BYPASS the full-page edge cache (`optOutPageCache()`), while plain
 * non-form content keeps page-cache eligibility intact.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it, vi } from "vitest";

const { getCollectionInfoMock } = vi.hoisted(() => ({
	getCollectionInfoMock: vi.fn<() => Promise<{ commentsEnabled: boolean } | null>>(
		async () => null,
	),
}));

vi.mock("../../src/schema/query.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/schema/query.js")>();
	return {
		...actual,
		getCollectionInfo: getCollectionInfoMock,
	};
});

import WpShellWidgetHtmlBlock from "../../../../templates/blog-cloudflare/src/components/WpShellWidgetHtmlBlock.astro";
import FormEmbed from "../../../plugins/forms/src/astro/FormEmbed.astro";
import SubscribeEmbed from "../../../plugins/subscriptions/src/astro/SubscribeEmbed.astro";
import CommentForm from "../../src/components/CommentForm.astro";
import ExternalForm from "../../src/components/ExternalForm.astro";
import HtmlBlock from "../../src/components/HtmlBlock.astro";
import PortableText from "../../src/components/PortableText.astro";
import {
	getPageCacheState,
	optInPageCache,
	runWithPageCacheState,
} from "../../src/page-cache/state.js";

const FORM_DEFINITION = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{
					id: "email",
					type: "email",
					label: "Email",
					name: "email",
					required: true,
					width: "full",
				},
			],
		},
	],
	settings: { spamProtection: "honeypot", submitLabel: "Send" },
	status: "active",
	_turnstileSiteKey: null,
};

const MAILCHIMP_HTML =
	'<form action="https://example.us1.list-manage.com/subscribe/post" method="post"><input type="email" name="EMAIL" /><button type="submit">Join</button></form>';

async function renderInPageCache(
	run: (container: AstroContainer) => Promise<string>,
): Promise<{ html: string; optedOut: boolean; optedIn: boolean }> {
	const container = await AstroContainer.create();
	return runWithPageCacheState(async () => {
		optInPageCache(60);
		const html = await run(container);
		const state = getPageCacheState();
		return {
			html,
			optedOut: state?.optedOut === true,
			optedIn: state?.optedIn === true,
		};
	});
}

describe("Form, sign-up, captcha and token components opt out of full-page cache", () => {
	it("FormEmbed opts out when a form renders, and stays eligible when the form is missing", async () => {
		const rendered = await renderInPageCache((c) =>
			c.renderToString(FormEmbed, {
				props: { node: { formId: "contact" } },
				locals: {
					emdash: {
						handlePublicPluginApiRoute: async () => ({
							success: true,
							data: FORM_DEFINITION,
						}),
					},
				},
			}),
		);
		expect(rendered.html).toContain("<form");
		expect(rendered.optedOut).toBe(true);
		expect(rendered.optedIn).toBe(false);

		const missing = await renderInPageCache((c) =>
			c.renderToString(PortableText, {
				props: {
					value: [{ _type: "emdash-form", _key: "f-missing", formId: "missing" }],
					components: { type: { "emdash-form": FormEmbed } },
				},
				locals: {
					emdash: {
						handlePublicPluginApiRoute: async () => ({ success: false }),
					},
				},
			}),
		);
		expect(missing.html).not.toContain("<form");
		expect(missing.optedOut).toBe(false);
		expect(missing.optedIn).toBe(true);
	});

	it("SubscribeEmbed opts out of full-page cache", async () => {
		const rendered = await renderInPageCache((c) =>
			c.renderToString(SubscribeEmbed, {
				props: { node: { _type: "emdash-subscribe", _key: "s1" } },
				request: new Request("https://site.test/newsletter"),
			}),
		);
		expect(rendered.html).toContain("<form");
		expect(rendered.optedOut).toBe(true);
		expect(rendered.optedIn).toBe(false);
	});

	it("ExternalForm opts out when an allowed form renders, and stays eligible when blocked", async () => {
		const allowed = await renderInPageCache((c) =>
			c.renderToString(ExternalForm, {
				props: {
					node: {
						_type: "externalForm",
						_key: "f1",
						action: "https://www.paypal.com/cgi-bin/webscr",
						method: "post",
						items: [{ _type: "submit", _key: "b1", label: "Donate" }],
					},
				},
			}),
		);
		expect(allowed.html).toContain("<form");
		expect(allowed.optedOut).toBe(true);

		const blocked = await renderInPageCache((c) =>
			c.renderToString(ExternalForm, {
				props: {
					node: {
						_type: "externalForm",
						_key: "f2",
						action: "https://evil.example/collect",
						method: "post",
						items: [],
					},
				},
			}),
		);
		expect(blocked.html).not.toContain("<form");
		expect(blocked.optedOut).toBe(false);
	});

	it("HtmlBlock opts out for carried newsletter forms (Mailchimp) and stays eligible for plain HTML", async () => {
		const withForm = await renderInPageCache((c) =>
			c.renderToString(HtmlBlock, {
				props: { node: { _type: "htmlBlock", _key: "h1", html: MAILCHIMP_HTML } },
			}),
		);
		expect(withForm.html).toContain("<form");
		expect(withForm.optedOut).toBe(true);

		const plain = await renderInPageCache((c) =>
			c.renderToString(HtmlBlock, {
				props: { node: { _type: "htmlBlock", _key: "h2", html: "<p>Hello world</p>" } },
			}),
		);
		expect(plain.html).toContain("Hello world");
		expect(plain.optedOut).toBe(false);
	});

	it("WpShellWidgetHtmlBlock opts out for carried newsletter forms and stays eligible for plain HTML", async () => {
		const withForm = await renderInPageCache((c) =>
			c.renderToString(WpShellWidgetHtmlBlock, {
				props: { node: { _type: "htmlBlock", _key: "w1", html: MAILCHIMP_HTML } },
			}),
		);
		expect(withForm.html).toContain("<form");
		expect(withForm.optedOut).toBe(true);

		const plain = await renderInPageCache((c) =>
			c.renderToString(WpShellWidgetHtmlBlock, {
				props: { node: { _type: "htmlBlock", _key: "w2", html: "<p>Footer note</p>" } },
			}),
		);
		expect(plain.html).toContain("Footer note");
		expect(plain.optedOut).toBe(false);
	});

	it("CommentForm opts out when comments are enabled and stays eligible when disabled", async () => {
		getCollectionInfoMock.mockResolvedValueOnce({ commentsEnabled: true });
		const enabled = await renderInPageCache((c) =>
			c.renderToString(CommentForm, {
				props: { collection: "posts", contentId: "p1", turnstileSiteKey: "ts-key" },
			}),
		);
		expect(enabled.html).toContain("<form");
		expect(enabled.optedOut).toBe(true);

		getCollectionInfoMock.mockResolvedValueOnce({ commentsEnabled: false });
		const disabled = await renderInPageCache((c) =>
			c.renderToString(CommentForm, {
				props: { collection: "posts", contentId: "p1" },
			}),
		);
		expect(disabled.html).not.toContain("<form");
		expect(disabled.optedOut).toBe(false);
	});
});
