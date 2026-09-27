import sanitizeHtml from "sanitize-html";

/**
 * Sanitize HTML content to prevent XSS attacks.
 *
 * Allows standard formatting tags, images, iframes (from specific providers),
 * and basic attributes.
 *
 * A `<noscript>` goes whole, with everything in it, as a `<script>` or a
 * `<style>` does: the browser draws what it holds only with scripts off, and
 * the page runs scripts. Unwrapped (sanitize-html's default for a tag it does
 * not allow), a pasted embed's "turn on JavaScript" line was drawn as text,
 * and a tracking pixel's `<img>` loaded on every page view.
 */
export function sanitizeContent(html: string): string {
	return sanitizeHtml(html, {
		allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "span", "iframe"],
		nonTextTags: ["script", "style", "textarea", "option", "noscript"],
		allowedAttributes: {
			...sanitizeHtml.defaults.allowedAttributes,
			"*": ["class", "id", "data-*"],
			iframe: ["src", "width", "height", "frameborder", "allow", "allowfullscreen"],
			img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
		},
		allowedIframeHostnames: ["www.youtube.com", "player.vimeo.com"],
	});
}
