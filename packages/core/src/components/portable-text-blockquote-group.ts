/**
 * Groups consecutive Portable Text blocks with style "blockquote" into a
 * single synthetic `blockquoteGroup` node so they render as ONE
 * `<blockquote>` with a paragraph per block.
 *
 * Portable Text is flat: a multi-paragraph quote (e.g. from a WordPress
 * `core/quote` import) is stored as consecutive blocks with
 * `style: "blockquote"`. Rendering each of those as its own `<blockquote>`
 * visually splits the quote (#1884).
 *
 * A list in a quote is stored as list items styled "blockquote"; they belong
 * to the quote's run, so the list renders inside the one <blockquote>.
 *
 * Runs of a single paragraph are left untouched, so existing single-paragraph
 * quotes render byte-for-byte as before.
 */

interface TextBlockLike {
	_type: string;
	_key?: string;
	style?: string;
	listItem?: string;
}

export interface BlockquoteGroupNode {
	_type: "blockquoteGroup";
	_key: string;
	blocks: TextBlockLike[];
}

function isBlockquoteBlock(block: unknown): block is TextBlockLike {
	if (typeof block !== "object" || block === null) return false;
	const b: Partial<TextBlockLike> = block;
	return b._type === "block" && b.style === "blockquote";
}

export function groupBlockquoteRuns(blocks: unknown[]): unknown[] {
	const result: unknown[] = [];
	let i = 0;

	while (i < blocks.length) {
		const current = blocks[i];
		if (!isBlockquoteBlock(current)) {
			result.push(current);
			i++;
			continue;
		}

		const run: TextBlockLike[] = [];
		let next: unknown = current;
		while (i < blocks.length && isBlockquoteBlock(next)) {
			run.push(next);
			i++;
			next = blocks[i];
		}

		if (run.length === 1 && run[0]?.listItem === undefined) {
			result.push(run[0]);
		} else {
			const group: BlockquoteGroupNode = {
				_type: "blockquoteGroup",
				_key: `${run[0]?._key ?? "quote"}-group`,
				blocks: run,
			};
			result.push(group);
		}
	}

	return result;
}
