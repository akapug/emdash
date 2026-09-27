/**
 * The comment form's client: CommentForm.astro's submit handler.
 *
 * Every form marked `data-ec-comment-form` posts, as JSON with the
 * `X-EmDash-Request` header, to its `data-endpoint`: its named fields, the
 * signed-in user's name and email from `data-user-name` and
 * `data-user-email`, and a Turnstile token when the widget left one. It
 * writes the answer into the form's `.ec-comment-form-status`, and disables
 * the form's `.ec-comment-form-submit` while the request runs.
 *
 * Its own module, so a template that draws the same form in markup of its own
 * (the blog template's WordPress comment area) loads the same client
 * (`emdash/ui/comments/client`). One listener on `document` serves every such
 * form on the page, however many components start it.
 */

declare global {
	interface Window {
		/** Cloudflare Turnstile's widget API, once its script (CommentForm's `turnstileSiteKey`) has loaded. */
		turnstile?: { reset(): void };
	}
}

let started = false;

/** Start the comment form client: once per page. */
export function initCommentForms(): void {
	if (started) return;
	started = true;
	document.addEventListener("submit", async (e) => {
		const form = e.target;
		if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-ec-comment-form")) return;
		e.preventDefault();

		const endpoint = form.dataset.endpoint;
		if (!endpoint) return;

		const submitBtn = form.querySelector<HTMLButtonElement>(".ec-comment-form-submit");
		const statusEl = form.querySelector<HTMLElement>(".ec-comment-form-status");
		if (!submitBtn || !statusEl) return;

		submitBtn.disabled = true;
		submitBtn.textContent = "Submitting...";
		statusEl.textContent = "";
		statusEl.className = "ec-comment-form-status";

		const data = new FormData(form);
		const body: Record<string, string> = {};

		// Include user info from data attributes (for authenticated users)
		const userName = form.dataset.userName;
		const userEmail = form.dataset.userEmail;
		if (userName) body.authorName = userName;
		if (userEmail) body.authorEmail = userEmail;

		for (const [key, value] of data.entries()) {
			if (typeof value === "string") {
				body[key] = value;
			}
		}

		// Get Turnstile token if present
		const turnstileInput = form.querySelector<HTMLInputElement>("[name='cf-turnstile-response']");
		if (turnstileInput?.value) {
			body.turnstileToken = turnstileInput.value;
		}

		try {
			const res = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
				},
				body: JSON.stringify(body),
			});

			const result = await res.json();

			if (res.ok) {
				statusEl.textContent = result.message || "Comment submitted!";
				statusEl.classList.add("ec-comment-form-success");
				// Reset form fields (but not disabled pre-filled fields)
				const textarea = form.querySelector<HTMLTextAreaElement>("textarea[name='body']");
				if (textarea) textarea.value = "";
			} else {
				statusEl.textContent =
					result.error?.message || result.message || "Failed to submit comment.";
				statusEl.classList.add("ec-comment-form-error");
			}
		} catch {
			statusEl.textContent = "Network error. Please try again.";
			statusEl.classList.add("ec-comment-form-error");
		} finally {
			// Reset Turnstile on success and failure alike (incl. network
			// errors) — tokens are single-use, so any retry needs a fresh
			// challenge
			if (typeof window.turnstile !== "undefined") {
				window.turnstile.reset();
			}
			submitBtn.disabled = false;
			submitBtn.textContent = "Post Comment";
		}
	});
}
