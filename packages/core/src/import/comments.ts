/**
 * Comment import functions
 *
 * Import comments from the WordPress plugin API, or from a WXR export's
 * `<wp:comment>` elements, into EmDash's native comments table, preserving
 * authors, dates, threading, and status.
 */

import {
	extractText,
	gutenbergToPortableText,
	type PortableTextBlock,
} from "@emdash-cms/gutenberg-to-portable-text";
import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import type { WxrComment, WxrPost } from "../cli/wxr/parser.js";
import type { Database } from "../database/types.js";
import { invalidateCommentObjectCache } from "../object-cache/index.js";
import { parseWxrDate } from "./sources/wxr.js";
import { isPasswordProtected } from "./utils.js";

/**
 * Plugin API comment format (matches /emdash/v1/comments items)
 */
export interface PluginComment {
	id: number;
	post_id: number;
	parent_id: number | null;
	author_name: string;
	author_email: string;
	/** Plain-text body (the plugin strips HTML) */
	body: string;
	/** ISO 8601 UTC timestamp */
	date_gmt: string;
	status: "approved" | "pending";
}

/**
 * Result of comment import operation
 */
export interface CommentsImportResult {
	/** Number of comments created */
	imported: number;
	/** Comments skipped (unresolvable post reference or already imported) */
	skipped: number;
	/** Errors encountered */
	errors: Array<{ comment: string; error: string }>;
}

/**
 * Import comments from the plugin API.
 *
 * Preserves original timestamps and threading. Comments whose post was
 * not imported (no entry in `contentIdMap`) are skipped. Re-running the
 * import is idempotent: a comment with the same post, author email, and
 * timestamp is not created twice.
 *
 * @param comments - Comments from the plugin API (all pages, flat)
 * @param db - Database connection
 * @param contentIdMap - WP post ID -> EmDash content ID
 * @param collectionMap - WP post ID -> EmDash collection slug
 * @param rootIds - Optional pre-seeded WP-comment-ID -> EmDash-root-ID map.
 *   The chunked import passes the map accumulated from earlier pages so a
 *   reply in page N can thread onto a parent imported in page N-1; the
 *   function adds this page's entries to it.
 */
export async function importCommentsFromPlugin(
	comments: PluginComment[],
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
	collectionMap: Map<number, string>,
	rootIds?: Map<number, string>,
): Promise<CommentsImportResult> {
	const result: CommentsImportResult = {
		imported: 0,
		skipped: 0,
		errors: [],
	};

	// WP comment ID -> EmDash comment ID, for parent threading
	const commentIdMap = new Map<number, string>();

	// WP comment ID -> EmDash ID of its top-level ancestor. EmDash threads
	// are one level deep (assembleThreads nests replies under roots only),
	// so deeper WP threads are flattened onto their root comment.
	const rootIdMap = rootIds ?? new Map<number, string>();

	// Parents must exist before children reference them; WP comment IDs
	// are chronological, so ID order guarantees parents come first.
	const sorted = comments.toSorted((a, b) => a.id - b.id);

	for (const comment of sorted) {
		const label = `${comment.author_name || "Anonymous"} (${comment.date_gmt})`;
		try {
			const contentId = contentIdMap.get(comment.post_id);
			const collection = collectionMap.get(comment.post_id);
			if (!contentId || !collection) {
				result.skipped++;
				continue;
			}

			const parsed = new Date(comment.date_gmt);
			const createdAt = Number.isNaN(parsed.getTime())
				? new Date().toISOString()
				: parsed.toISOString();

			// Idempotency: same post + author + timestamp + body = already
			// imported (body included so same-second comments from one author
			// don't collide). ponytail: one SELECT per comment — fine at
			// import scale; batch with WHERE IN for six-figure comment counts.
			const existing = await db
				.selectFrom("_emdash_comments")
				.select("id")
				.where("content_id", "=", contentId)
				.where("author_email", "=", comment.author_email)
				.where("created_at", "=", createdAt)
				.where("body", "=", comment.body)
				.executeTakeFirst();
			const parentId =
				comment.parent_id !== null ? (rootIdMap.get(comment.parent_id) ?? null) : null;

			if (existing) {
				commentIdMap.set(comment.id, existing.id);
				rootIdMap.set(comment.id, parentId ?? existing.id);
				result.skipped++;
				continue;
			}

			const id = ulid();

			await db
				.insertInto("_emdash_comments")
				.values({
					id,
					collection,
					content_id: contentId,
					parent_id: parentId,
					author_name: comment.author_name || "Anonymous",
					author_email: comment.author_email,
					author_user_id: null,
					body: comment.body,
					status: comment.status,
					ip_hash: null,
					user_agent: null,
					moderation_metadata: null,
					created_at: createdAt,
					updated_at: createdAt,
				})
				.execute();

			commentIdMap.set(comment.id, id);
			rootIdMap.set(comment.id, parentId ?? id);
			result.imported++;
		} catch (error) {
			result.errors.push({
				comment: label,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (result.imported > 0) {
		invalidateCommentObjectCache();
	}

	return result;
}

/**
 * Result of importing a WXR export's comments: what was stored, and every
 * comment that was not, counted by why.
 */
export interface WxrCommentsImportResult extends CommentsImportResult {
	/**
	 * Comments not carried, by reason: WordPress's status for one that was
	 * never approved (`pending`, `spam`, `trash`, `post-trashed`), its type for
	 * one that is not a comment (`pingback`, `trackback`, `review`, …),
	 * `post-not-imported` for one on an item the import did not store,
	 * `unpublished-parent` for one on an item WordPress had not published
	 * (private, draft, pending, future: the import stores it as a draft),
	 * `password-protected-parent` for one on an item behind a password,
	 * `empty` for one with no text a reader saw, and `undated` for one whose
	 * export holds no date that reads as one.
	 */
	notCarried: Record<string, number>;
}

/** WordPress's `comment_approved` values, as `notCarried` names them. */
const WXR_COMMENT_STATUS: Record<string, string> = {
	"0": "pending",
	spam: "spam",
	trash: "trash",
	"post-trashed": "post-trashed",
};

/**
 * Import the comments a WXR export carries on its items.
 *
 * Only APPROVED comments carry, the ones a visitor of the WordPress site
 * could read: a pending, spam or trashed comment, a pingback or a trackback,
 * and every comment on an item WordPress had not published or kept behind a
 * password (`hiddenParentReason`), is counted in `notCarried` and never stored. Each carried comment is
 * stored approved, with its author's name, its date and its place in the
 * thread; its author's email is stored because EmDash's moderation reads it
 * (a returning commenter, `countApprovedByEmail`), and no public surface
 * returns it (`toPublicComment`). The commenter's IP address and URL are
 * never read from the export.
 *
 * The body is the text WordPress showed (`wxrCommentText`). Threads,
 * timestamps and re-runs are `importCommentsFromPlugin`'s.
 *
 * @param posts - The export's items, each with its `comments`
 * @param contentIdMap - WP post ID -> EmDash content ID, for every item this
 *   import stored or found already stored
 * @param collectionMap - WP post ID -> EmDash collection slug
 * @param texturize - Whether WordPress showed this item's text texturized
 */
export async function importWxrComments(
	posts: readonly WxrPost[],
	db: Kysely<Database>,
	contentIdMap: Map<number, string>,
	collectionMap: Map<number, string>,
	texturize: (post: WxrPost) => boolean = () => true,
): Promise<WxrCommentsImportResult> {
	const notCarried: Record<string, number> = {};
	const count = (reason: string) => {
		notCarried[reason] = (notCarried[reason] ?? 0) + 1;
	};
	const carried: PluginComment[] = [];
	const errors: CommentsImportResult["errors"] = [];
	for (const post of posts) {
		const postId = post.id;
		for (const comment of post.comments ?? []) {
			const reason =
				postId === undefined || !contentIdMap.has(postId)
					? "post-not-imported"
					: (hiddenParentReason(post) ?? notCarriedReason(comment));
			if (postId === undefined || reason) {
				count(reason ?? "post-not-imported");
				continue;
			}
			// One comment the converter cannot read is that comment's error, not the import's.
			let body: string;
			try {
				body = wxrCommentText(comment.content, texturize(post));
			} catch (error) {
				errors.push({
					comment: `${comment.author || "Anonymous"} (#${comment.id})`,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			if (!body) {
				count("empty");
				continue;
			}
			// The export's own date, never the time of the import: a comment stamped
			// "now" is stored again by every re-run (the key includes the date).
			const date = wxrCommentDate(comment);
			if (!date) {
				count("undated");
				continue;
			}
			carried.push({
				id: comment.id,
				post_id: postId,
				parent_id: comment.parent > 0 ? comment.parent : null,
				author_name: comment.author,
				author_email: comment.authorEmail,
				body,
				date_gmt: date.toISOString(),
				status: "approved",
			});
		}
	}
	const result = await importCommentsFromPlugin(carried, db, contentIdMap, collectionMap);
	return { ...result, errors: [...errors, ...result.errors], notCarried };
}

/** A date that reads as one, or none: never an Invalid Date. */
const validDate = (d: Date | undefined) => (d && !Number.isNaN(d.getTime()) ? d : undefined);

/**
 * A comment's date: its UTC date, else its site-local one, else none. An
 * export's text that is no date (`2021-13-45`, `garbage`) is none, never an
 * Invalid Date whose `toISOString` throws.
 */
function wxrCommentDate(comment: WxrComment): Date | undefined {
	return (
		validDate(parseWxrDate(comment.dateGmt, undefined, comment.date)) ??
		validDate(parseWxrDate(undefined, undefined, comment.date))
	);
}

/**
 * Why no comment on this item carries, or null when its comments may.
 * WordPress shows an item's comments only where a visitor can read the item:
 * published (`publish`) and not behind a password (`post_password_required`).
 * EmDash's public comment list does not check its entry is published, so a
 * comment carried onto a draft would be readable there.
 */
function hiddenParentReason(post: WxrPost): string | null {
	if (post.status !== "publish") return "unpublished-parent";
	if (isPasswordProtected(post)) return "password-protected-parent";
	return null;
}

/** Why a comment on an imported item does not carry, or null when it does. */
function notCarriedReason(comment: WxrComment): string | null {
	if (comment.type !== "" && comment.type !== "comment") return comment.type;
	if (comment.approved !== "1") return WXR_COMMENT_STATUS[comment.approved] ?? "not-approved";
	return null;
}

/**
 * A WordPress comment's body as the plain text EmDash stores: what a reader
 * of the WordPress site saw, never markup.
 *
 * WordPress shows a comment through `comment_text`, which runs wpautop and
 * wptexturize over it, the same as a classic post; so the body goes through
 * the post converter (`gutenbergToPortableText`), which takes out what no
 * reader sees (`<script>`, `<style>`, `<noscript>`, whole) and reads every
 * other tag as structure. Its paragraphs are kept as blank lines, its line
 * breaks and list items as lines, and a link whose text does not show its
 * address is followed by the address, which EmDash's comment list links
 * again. Nothing of the markup survives: EmDash escapes a comment body when it
 * draws it, so a tag left here would be shown as text.
 */
export function wxrCommentText(html: string, texturize = true): string {
	let out = "";
	let afterListItem = false;
	for (const block of gutenbergToPortableText(html, { texturize })) {
		const text = blockText(block).trim();
		if (!text) continue;
		const listItem = block._type === "block" && Boolean(block.listItem);
		if (out) out += listItem && afterListItem ? "\n" : "\n\n";
		out += text;
		afterListItem = listItem;
	}
	return out;
}

const WEB_ADDRESS = /^https?:\/\//i;

/** The text a reader saw of one converted block. */
function blockText(block: PortableTextBlock): string {
	switch (block._type) {
		case "block": {
			const links = new Map<string, string>();
			for (const def of block.markDefs ?? []) {
				if (def._type === "link" && typeof def.href === "string" && WEB_ADDRESS.test(def.href)) {
					links.set(def._key, def.href);
				}
			}
			const linkOf = (marks: string[] | undefined) => marks?.find((m) => links.has(m));
			let text = "";
			// The text of the link being read, so its address is said once, after all of it.
			let linkText = "";
			for (const [i, span] of block.children.entries()) {
				text += span.text;
				const key = linkOf(span.marks);
				if (!key) continue;
				linkText += span.text;
				if (linkOf(block.children[i + 1]?.marks) === key) continue;
				const href = links.get(key) ?? "";
				if (!linkText.includes(href)) text += ` (${href})`;
				linkText = "";
			}
			return block.listItem ? `- ${text}` : text;
		}
		case "code":
			return block.code;
		case "embed":
			return block.url;
		case "htmlBlock":
			return extractText(block.html);
		default:
			return "";
	}
}
