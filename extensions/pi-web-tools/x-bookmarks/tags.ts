// Tag handling for saved bookmark notes: validation and the preferred-tag list.

/** Namespaces that would drown out topical tags: the media catalog, pi-memory notes, and the tweet marker. A namespace excludes itself and everything below it. */
export const EXCLUDED_TAG_NAMESPACES = ["mediaDB", "memory", "tweet"];
export const PREFERRED_TAG_LIMIT = 60;
export const MAX_TAGS_PER_NOTE = 15;
export const MAX_NOTES_PER_CALL = 50;
const MAX_TAG_LENGTH = 80;
/** The rule `validateTag` enforces, worded for the sync report's curate advice. */
export const TAG_RULE = `letters, digits, "_", "-", "/" only (no "#", no spaces), at least one non-digit, no empty "/" segment, at most ${MAX_TAG_LENGTH} characters`;

/** Obsidian tag without `#`: letters, digits, `_`, `-`, `/`; at least one non-digit; no empty `/` segments. */
export function validateTag(tag: unknown): string {
	if (typeof tag !== "string" || !tag) throw new Error("Tag must be a non-empty string.");
	if (tag.length > MAX_TAG_LENGTH) throw new Error(`Tag is too long: ${JSON.stringify(tag.slice(0, 20))}…`);
	if (tag.startsWith("#")) throw new Error(`Tag must not start with "#": ${JSON.stringify(tag)}`);
	if (!/^[\p{L}\p{N}_\-/]+$/u.test(tag)) throw new Error(`Tag has characters Obsidian does not allow (use letters, digits, "_", "-", "/"; no spaces): ${JSON.stringify(tag)}`);
	if (!/[^\p{N}]/u.test(tag)) throw new Error(`Tag must contain a non-digit character: ${JSON.stringify(tag)}`);
	if (tag.split("/").some((part) => !part)) throw new Error(`Tag has an empty "/" segment: ${JSON.stringify(tag)}`);
	return tag;
}

export type TagCount = { tag: string; count: number };

export const TAG_COUNTS_COMMAND = "obsidian tags counts format=json";

/** Parse `obsidian tags counts format=json` output (`[{tag:"#x",count:"3"}]`). */
export function parseTagCounts(output: string): TagCount[] {
	const text = output.trim();
	if (!text) throw new Error(`\`${TAG_COUNTS_COMMAND}\` returned no output (Obsidian may still be indexing or busy).`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Unparseable output from \`${TAG_COUNTS_COMMAND}\`: ${text.slice(0, 200)}`);
	}
	if (!Array.isArray(parsed)) throw new Error("Unexpected Obsidian tags output: expected a JSON array.");
	return parsed.flatMap((entry) => {
		const tag = typeof entry?.tag === "string" ? entry.tag.replace(/^#/, "") : "";
		const count = Number(entry?.count);
		return tag && Number.isFinite(count) ? [{ tag, count }] : [];
	});
}

export function isExcluded(tag: string): boolean {
	return EXCLUDED_TAG_NAMESPACES.some((ns) => tag === ns || tag.startsWith(`${ns}/`));
}

/** Most-used topical tags first; excluded namespaces are left out. */
export function preferredTags(counts: TagCount[], limit = PREFERRED_TAG_LIMIT): TagCount[] {
	return counts
		.filter((c) => !isExcluded(c.tag))
		.sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
		.slice(0, limit);
}
