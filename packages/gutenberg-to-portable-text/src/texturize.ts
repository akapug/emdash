/**
 * WordPress's typography, as `wptexturize()` prints it.
 *
 * WordPress stores what the author typed, straight quotes and all, and curls
 * them as it renders: the_content and the_title run through wptexturize, so a
 * visitor read “quoted” and it’s, an en dash for " - ", an em dash for " -- "
 * and an ellipsis for "...". A converter that keeps the stored text shows the
 * straight ones WordPress never showed. So the conversion stores what
 * WordPress showed.
 *
 * Conversion time is the right time. An editor who later types in EmDash's
 * editor types their own text, and it is stored and shown as they type it,
 * which is what WordPress's own editor showed them too: wptexturize changes
 * the rendered page, never the stored post.
 *
 * The rules are WordPress's documented ones with its English defaults
 * (wp-includes/formatting.php, wptexturize and wptexturize_primes): opening
 * and closing double and single quotes, apostrophes (the "'cause" list among
 * them), primes after digits, "---" and a spaced "--" as an em dash, "--" and
 * a spaced "-" as an en dash, "..." as an ellipsis, " (tm)" as a trademark
 * sign and 9x9 as a multiplication sign. A locale's own quote marks and word
 * list are not ported.
 *
 * What it never changes, as WordPress does not: markup (tags, attributes and
 * comments, so a block's JSON is safe), text inside pre, code, kbd, tt, style
 * and script, shortcode tags, the content of [code], and the content of a
 * code highlighter's shortcodes, which WordPress drew before it texturized
 * (HIGHLIGHTER_SHORTCODES). And, where this port
 * is more careful than WordPress, a bare URL: WordPress embeds or links one
 * before it would texturize it, and this converter finds its embeds in the
 * text after this ran.
 */

/** wp_spaces_regexp(): a space, a tab, a newline, a no-break space or `&nbsp;`. */
const SPACES = "(?:[\\r\\n\\t ]|\\u00a0|&nbsp;)";
/** PHP's `\Z`: the end, or a newline that ends the text. */
const END = "(?:\\n?$)";

const OPEN_DOUBLE = "\u201c";
const CLOSE_DOUBLE = "\u201d";
const OPEN_SINGLE = "\u2018";
const CLOSE_SINGLE = "\u2019";
const APOSTROPHE = "\u2019";
const PRIME = "\u2032";
const DOUBLE_PRIME = "\u2033";
const EN_DASH = "\u2013";
const EM_DASH = "\u2014";

// Placeholders WordPress writes as HTML comments; here private-use characters,
// which no pattern below names.
const APOS_FLAG = "\ue000";
const OPEN_SQ_FLAG = "\ue001";
const OPEN_Q_FLAG = "\ue002";
const PRIME_FLAG = "\ue003";

/** The fixed strings, in WordPress's order. */
const STATIC: ReadonlyArray<readonly [string, string]> = [
	["...", "\u2026"],
	["``", OPEN_DOUBLE],
	["''", CLOSE_DOUBLE],
	[" (tm)", " \u2122"],
	...[
		"'tain't",
		"'twere",
		"'twas",
		"'tis",
		"'twill",
		"'til",
		"'bout",
		"'nuff",
		"'round",
		"'cause",
		"'em",
	].map((w): [string, string] => [w, w.replaceAll("'", APOSTROPHE)]),
];

type Rule = readonly [RegExp, string];

const APOS_RULES: readonly Rule[] = [
	// '99' and '99" are an abbreviated year at the end of a quotation.
	[
		new RegExp(`'(\\d\\d)'(?=${END}|[.,:;!?)}\\-\\]]|&gt;|${SPACES})`, "g"),
		`${APOS_FLAG}$1${CLOSE_SINGLE}`,
	],
	[
		new RegExp(`'(\\d\\d)"(?=${END}|[.,:;!?)}\\-\\]]|&gt;|${SPACES})`, "g"),
		`${APOS_FLAG}$1${CLOSE_DOUBLE}`,
	],
	// '99, '99s, '99's, but never '9, '99%, '999 or '99.0.
	[new RegExp(`'(?=\\d\\d(?:${END}|(?![%\\d]|[.,]\\d)))`, "g"), APOS_FLAG],
	// A quoted number: '0.42'.
	[new RegExp(`(?<=^|${SPACES})'(\\d[.,\\d]*)'`, "g"), `${OPEN_SQ_FLAG}$1${CLOSE_SINGLE}`],
	// At the start, or after (, {, <, [, ", - or a space: an opening quote.
	[new RegExp(`(?<=^|[([{"\\-]|&lt;|${SPACES})'`, "g"), OPEN_SQ_FLAG],
	// Inside a word: an apostrophe.
	[new RegExp(`(?<!${SPACES})'(?!${END}|[.,:;!?"'(){}[\\]\\-]|&[lg]t;|${SPACES})`, "g"), APOS_FLAG],
];

const QUOTE_RULES: readonly Rule[] = [
	// A quoted number: "42".
	[new RegExp(`(?<=^|${SPACES})"(\\d[.,\\d]*)"`, "g"), `${OPEN_Q_FLAG}$1${CLOSE_DOUBLE}`],
	// At the start, or after (, {, <, [, - or a space, and before no space: an opening quote.
	[new RegExp(`(?<=^|[([{\\-]|&lt;|${SPACES})"(?!${SPACES})`, "g"), OPEN_Q_FLAG],
];

const DASH_RULES: readonly Rule[] = [
	[/---/g, EM_DASH],
	[new RegExp(`(?<=^|${SPACES})--(?=$|${SPACES})`, "g"), EM_DASH],
	// Not a punycode host's `xn--`.
	[/(?<!xn)--/g, EN_DASH],
	[new RegExp(`(?<=^|${SPACES})-(?=$|${SPACES})`, "g"), EN_DASH],
];

/** 9x9, never 0x9999 (PCRE's conditional `(?(?<=0)…)`, spelled out). */
const TIMES = /\b(0[\d.,]+|[1-9][\d.,]*)x(\d[\d.,]*)\b/g;
const DIGIT_X = /(?<=\d)x\d/;

const count = (s: string, needle: string) => s.split(needle).length - 1;
const apply = (s: string, rules: readonly Rule[]) =>
	rules.reduce((out, [re, to]) => out.replace(re, to), s);

/**
 * wptexturize_primes: the quote marks left after the rules above are closing
 * quotes or primes, sentence by sentence (a sentence runs from one opening
 * quote to the next).
 */
function primes(
	text: string,
	needle: "'" | '"',
	prime: string,
	openFlag: string,
	close: string,
): string {
	const quote = new RegExp(`${needle}(?=${END}|[.,:;!?)}\\-\\]]|&gt;|${SPACES})`, "g");
	const afterDigit = new RegExp(`(?<=\\d)${needle}`, "g");
	const flagAfterDigit = new RegExp(`(?<=\\d)${PRIME_FLAG}`, "g");
	const flagNoDigit = new RegExp(`(?<!\\d)${PRIME_FLAG}`, "g");
	const sentences = text.split(openFlag).map((s, i) => {
		let out = s;
		if (!out.includes(needle)) return out;
		if (i !== 0 && count(out, close) === 0) {
			const candidates = (out.match(quote) ?? []).length;
			out = out.replace(quote, PRIME_FLAG);
			if (candidates > 1) {
				// Several closing quote candidates: the one not after a digit closes.
				const closers = (out.match(flagNoDigit) ?? []).length;
				out = out.replace(flagNoDigit, close);
				if (closers === 0) {
					// All after digits: the rightmost followed by a period, else the rightmost.
					const at = out.includes(`${PRIME_FLAG}.`)
						? out.lastIndexOf(`${PRIME_FLAG}.`)
						: out.lastIndexOf(PRIME_FLAG);
					out = `${out.slice(0, at)}${close}${out.slice(at + PRIME_FLAG.length)}`;
				}
				out = out
					.replace(afterDigit, prime)
					.replace(flagAfterDigit, prime)
					.replaceAll(PRIME_FLAG, close);
			} else if (candidates === 1) {
				out = out.replaceAll(PRIME_FLAG, close).replace(afterDigit, prime);
			} else {
				out = out.replace(afterDigit, prime);
			}
		} else {
			out = out.replace(afterDigit, prime).replace(quote, close);
		}
		return needle === '"' ? out.replaceAll('"', close) : out;
	});
	return sentences.join(openFlag);
}

/** One run of text between tags, as wptexturize prints it. */
function texturizeRun(text: string): string {
	let out = text;
	for (const [from, to] of STATIC) out = out.replaceAll(from, to);
	if (out.includes("'")) {
		out = primes(apply(out, APOS_RULES), "'", PRIME, OPEN_SQ_FLAG, CLOSE_SINGLE)
			.replaceAll(APOS_FLAG, APOSTROPHE)
			.replaceAll(OPEN_SQ_FLAG, OPEN_SINGLE);
	}
	if (out.includes('"')) {
		out = primes(apply(out, QUOTE_RULES), '"', DOUBLE_PRIME, OPEN_Q_FLAG, CLOSE_DOUBLE).replaceAll(
			OPEN_Q_FLAG,
			OPEN_DOUBLE,
		);
	}
	if (out.includes("-")) out = apply(out, DASH_RULES);
	if (DIGIT_X.test(out)) out = out.replace(TIMES, "$1\u00d7$2");
	return out;
}

/** A bare URL in the text: kept as it is. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;
/**
 * Where a URL stands while its run is texturized: private-use characters, a
 * word to every rule above (no space, digit, quote or dash), so the quotes
 * around it read as they would around the URL.
 */
const URL_MARK = /\ue010([\ue100-\uefff])/g;
/**
 * The private-use characters this file writes as stand-ins (the flags above,
 * URL_MARK's). A run that already holds one, an icon font's glyph typed as
 * its character, stays as it is: its glyph would be read back as a quote
 * mark, or dropped.
 */
const STAND_INS = /[\ue000-\ue003\ue010]/;

function texturizeText(text: string): string {
	if (STAND_INS.test(text)) return text;
	const urls: string[] = [];
	const marked = text.replace(
		URL_IN_TEXT,
		(url) => `\ue010${String.fromCharCode(0xe100 + urls.push(url) - 1)}`,
	);
	if (urls.length > 0xeff) return text;
	return texturizeRun(marked).replace(
		URL_MARK,
		(_, i: string) => urls[i.charCodeAt(0) - 0xe100] ?? "",
	);
}

/** The elements whose text WordPress never texturizes. */
const NO_TEXTURIZE_TAGS = new Set(["pre", "code", "kbd", "style", "script", "tt"]);
/** The shortcodes whose content WordPress never texturizes (core's no_texturize_shortcodes). */
const NO_TEXTURIZE_SHORTCODES = ["code"];
/**
 * A code highlighter's shortcodes, whose content its visitor read as typed:
 * SyntaxHighlighter Evolved draws `[php]…[/php]` as a `<pre>` at the_content
 * priority 7, before wptexturize (10) sees it. Its tags, from
 * syntaxhighlighter.php: sourcecode, source, code and every brush alias but
 * latex and r.
 */
const HIGHLIGHTER_SHORTCODES = `sourcecode source as3 actionscript3 arduino bash shell coldfusion cf
	clojure clj cpp c c-sharp csharp css delphi pas pascal diff patch erl erlang fsharp go golang groovy
	haskell java jfx javafx js jscript javascript tex matlab matlabkey objc obj-c perl pl php plain text
	ps powershell py python splus rails rb ror ruby scala sql swift vb vbnet xml xhtml xslt html yaml
	yml`.split(/\s+/);

/**
 * The shortcodes whose content stays as written in `html`: core's, and a
 * highlighter's that the post also closes, so a bracketed word that only
 * looks like one (`[text]`) does not stop the rest of the post.
 */
function noTexturizeShortcodes(html: string): ReadonlySet<string> {
	const lower = html.toLowerCase();
	return new Set([
		...NO_TEXTURIZE_SHORTCODES,
		...HIGHLIGHTER_SHORTCODES.filter((n) => lower.includes(`[/${n}]`)),
	]);
}

/**
 * A comment (to its end, or to the end of the text), a tag (to its `>`, or to
 * the end), or a shortcode's opening or closing tag: `[name …]`, `[/name]`,
 * with an escaped `[[name]]`. Every alternative starts on a different
 * character and repeats single characters, so a failed match never backtracks.
 */
const DELIMITER =
	/<!--(?:[^-]|-(?!->))*(?:-->)?|<[^>]*>?|\[[/[]?[A-Za-z][\w-]*(?=[\s\]/])(?:[^[\]<>]|<[^[\]>]*>)*\]\]?/g;

const NAME = /^[A-Za-z][\w-]*/;

/** An element's or shortcode's name, and whether the delimiter opens it. */
function nameOf(delimiter: string): { name: string; opening: boolean } {
	const opening = delimiter[1] !== "/";
	const m = NAME.exec(delimiter.slice(opening ? 1 : 2));
	return { name: (m?.[0] ?? "").toLowerCase(), opening };
}

/** _wptexturize_pushpop_element: a disabled element's opener disables texturizing until its closer. */
function pushPop(delimiter: string, stack: string[], disabled: ReadonlySet<string>): void {
	const { name, opening } = nameOf(delimiter);
	if (!disabled.has(name)) return;
	if (opening) stack.push(name);
	else if (stack.at(-1) === name) stack.pop();
}

/**
 * HTML as wptexturize prints it: each run of text between tags, comments and
 * shortcode tags texturized on its own, the rest as it was.
 */
export function wptexturize(html: string): string {
	if (!html) return html;
	const tags: string[] = [];
	const shortcodes: string[] = [];
	const disabled = noTexturizeShortcodes(html);
	let out = "";
	let last = 0;
	const text = (run: string) =>
		tags.length === 0 && shortcodes.length === 0 && run.trim() !== "" ? texturizeText(run) : run;
	for (const m of html.matchAll(DELIMITER)) {
		out += text(html.slice(last, m.index));
		const d = m[0];
		if (d.startsWith("<") && !d.startsWith("<!--")) pushPop(d, tags, NO_TEXTURIZE_TAGS);
		else if (d.startsWith("[") && !d.startsWith("[[") && !d.endsWith("]]"))
			pushPop(d, shortcodes, disabled);
		out += d;
		last = m.index + d.length;
	}
	return out + text(html.slice(last));
}
