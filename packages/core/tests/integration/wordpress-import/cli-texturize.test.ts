/**
 * The CLI's WordPress import stores a post's title and excerpt as WordPress
 * printed them (the_title and the_excerpt run wptexturize), like its content.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	executeWordPressImport,
	prepareWordPressImport,
} from "../../../src/cli/commands/import/wordpress.js";

const wxr = (language: string | null) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example Garden</title>
    <link>https://example.org</link>
    ${language === null ? "" : `<language>${language}</language>`}
    <item>
      <title><![CDATA[Tom's "Big" Day -- Live...]]></title>
      <link>https://example.org/toms-big-day/</link>
      <dc:creator><![CDATA[admin]]></dc:creator>
      <wp:post_id>7</wp:post_id>
      <wp:post_name><![CDATA[toms-big-day]]></wp:post_name>
      <wp:post_type>post</wp:post_type>
      <wp:status>publish</wp:status>
      <excerpt:encoded><![CDATA[It's "short" - really.]]></excerpt:encoded>
      <content:encoded><![CDATA[<p>It's "here" - now...</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

describe("WordPress CLI import: the text as WordPress printed it", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-wp-texturize-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	async function run(language: string | null) {
		const file = join(dir, `export-${language ?? "none"}.xml`);
		await writeFile(file, wxr(language));
		const configPath = join(dir, `.wp-migration-${language ?? "none"}.json`);
		const outputDir = join(dir, language ?? "none");
		const common = { outputDir, configPath, verbose: false, dryRun: false, json: true };
		await prepareWordPressImport(file, common);
		const result = await executeWordPressImport(file, {
			...common,
			skipMedia: true,
			resume: false,
		});
		const post = JSON.parse(
			await readFile(join(outputDir, "posts", "toms-big-day.json"), "utf-8"),
		) as {
			title: string;
			excerpt: string;
			content: Array<{ children: Array<{ text: string }> }>;
		};
		return {
			result,
			said: [post.title, post.excerpt, post.content[0]!.children.map((c) => c.text).join("")],
		};
	}

	it("curls the title and the excerpt like the content", async () => {
		const { said } = await run(null);
		expect(said).toEqual([
			"Tom’s “Big” Day — Live…",
			"It’s “short” – really.",
			"It’s “here” – now…",
		]);
	});
});
