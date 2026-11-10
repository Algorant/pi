import type { ObsidianClient } from "../../lib/obsidian-cli.ts";
import { BOOKMARKS_FOLDER, type Layout } from "./paths.ts";

/**
 * Obsidian Bases definition for the bookmark index. The tool owns it: every sync creates it when absent and
 * replaces it when its parsed definition differs from this one (Obsidian re-serializes the YAML, so the
 * comparison is on the parsed structure, not the text). The global filter keeps
 * everything inside the bookmarks folder; each view narrows to posts or authors. Every groupBy is an object with
 * `property` and `direction` (a kanban without `direction` fails to parse).
 */
export function bookmarksBase(folder = BOOKMARKS_FOLDER): string {
	const inPosts = `file.inFolder(${JSON.stringify(`${folder}/posts`)})`;
	const inAuthors = `file.inFolder(${JSON.stringify(`${folder}/authors`)})`;
	const postFilter = (extra?: string) => ["    filters:", "      and:", `        - ${inPosts}`, ...(extra ? [`        - ${extra}`] : [])];
	const newestFirst = ["    sort:", "      - property: posted", "        direction: DESC"];
	const group = (property: string, direction: "ASC" | "DESC") => ["    groupBy:", `      property: ${property}`, `      direction: ${direction}`];
	const order = (...props: string[]) => ["    order:", ...props.map((p) => `      - ${p}`)];
	const cards = (name: string, lines: string[]) => [
		"  - type: cards",
		`    name: ${name}`,
		...lines,
		"    image: note.cover",
		"    imageFit: cover",
		"    imageAspectRatio: 0.625",
	];
	return [
		"filters:",
		"  and:",
		`    - file.inFolder(${JSON.stringify(folder)})`,
		"formulas:",
		"  when: 'if(posted.year == now().year, posted.format(\"MMM D\"), posted.format(\"MMM D, YYYY\"))'",
		// Groups sort by value and Bases has no custom group order: a hidden "YYYY-MM" prefix keeps the months
		// chronological while the heading shows "Oct 2026".
		"  month: 'html(\"<span hidden>\" + posted.format(\"YYYY-MM\") + \"</span>\" + posted.format(\"MMM YYYY\"))'",
		"  topic: tags[0]",
		"  topics: 'tags.join(\" · \")'",
		"properties:",
		"  file.name:",
		"    displayName: Title",
		"  formula.when:",
		"    displayName: Posted",
		"  formula.month:",
		"    displayName: Month",
		"  formula.topic:",
		"    displayName: Topic",
		"  formula.topics:",
		"    displayName: Topics",
		"views:",
		...cards("Gallery", [...postFilter(), ...group("formula.month", "DESC"), ...newestFirst, ...order("file.name", "formula.when", "author", "formula.topics")]),
		...cards("By topic", [...postFilter(), ...group("formula.topic", "ASC"), ...newestFirst, ...order("file.name", "formula.when", "author", "formula.topics")]),
		"  - type: kanban",
		"    name: Triage",
		...postFilter(),
		...group("status", "ASC"),
		...newestFirst,
		...order("file.name", "formula.when", "author", "formula.topics"),
		"  - type: table",
		"    name: Authors",
		"    filters:",
		"      and:",
		`        - ${inAuthors}`,
		"    sort:",
		"      - property: file.name",
		"        direction: ASC",
		...order("file.name", "name", "profile", "bio"),
		"  - type: table",
		"    name: All",
		...postFilter(),
		...newestFirst,
		...order("file.name", "author", "formula.when", "status", "formula.topics"),
		...cards("This author", [...postFilter("author == this"), ...newestFirst, ...order("file.name", "formula.when", "formula.topics")]),
		"",
	].join("\n");
}

const canonical = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === "object"
			? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
			: value;

/** Create the base when absent, or replace it when its parsed definition differs from the generated one. */
export async function ensureBookmarksBase(client: ObsidianClient, layout: Layout, signal?: AbortSignal): Promise<"created" | "updated" | "current"> {
	const wanted = bookmarksBase(layout.folder);
	if ((await client.stat(layout.base, signal)) === null) {
		await client.create(layout.base, wanted, signal);
		return "created";
	}
	const same = JSON.stringify(canonical(Bun.YAML.parse(await client.read(layout.base, signal)))) === JSON.stringify(canonical(Bun.YAML.parse(wanted)));
	if (same) return "current";
	await client.overwrite(layout.base, wanted, signal);
	return "updated";
}
