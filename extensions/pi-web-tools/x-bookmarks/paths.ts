// Vault-relative locations and note names for saved X bookmarks. Pure functions; nothing here touches the vault.

export const BOOKMARKS_FOLDER = "Agentic/bookmarks";
export const BASE_NAME = "Bookmarks.base";

export type Layout = { folder: string; posts: string; authors: string; media: string; base: string };

export function layoutFor(folder = BOOKMARKS_FOLDER): Layout {
	return { folder, posts: `${folder}/posts`, authors: `${folder}/authors`, media: `${folder}/media`, base: `${folder}/${BASE_NAME}` };
}

export function postPath(layout: Layout, title: string): string {
	return `${layout.posts}/${title}.md`;
}

export function authorPath(layout: Layout, handle: string): string {
	if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error(`Unsafe handle for a note name: ${JSON.stringify(handle)}`);
	return `${layout.authors}/@${handle}.md`;
}

export function cardPath(layout: Layout, tweetId: string): string {
	if (!/^\d+$/.test(tweetId)) throw new Error(`Unsafe tweet id for a file name: ${JSON.stringify(tweetId)}`);
	return `${layout.media}/${tweetId}.png`;
}

/** Status id of a canonical `https://x.com/<handle>/status/<id>` source (quotes around it tolerated). */
export function statusIdOf(source: string | null | undefined): string | undefined {
	const value = (source ?? "").trim().replace(/^["']|["']$/g, "");
	return /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)\/?$/i.exec(value)?.[1];
}

export const TITLE_MAX = 80;
/** Longest curated title `checkTitle` accepts. */
export const CURATED_TITLE_MAX = 120;
/** Characters a note name cannot contain; the single source for `checkTitle`, `sanitizeTitle`, and the rule text. */
export const FORBIDDEN_TITLE_CHARS = ["\\", "/", ":", "*", "?", '"', "<", ">", "|", "#", "^", "[", "]"];
const FORBIDDEN_IN_TITLE = new RegExp(`[${FORBIDDEN_TITLE_CHARS.map((c) => `\\${c}`).join("")}]`);
const FORBIDDEN_IN_TITLE_ALL = new RegExp(FORBIDDEN_IN_TITLE.source, "g");
/** The rule `checkTitle` enforces, worded for the sync report's curate advice. */
export const TITLE_RULE = `a file name of at most ${CURATED_TITLE_MAX} characters with none of ${FORBIDDEN_TITLE_CHARS.join(" ")} or control characters, not starting or ending with a dot (write " - " where a ":" would go)`;

/** Provisional note title from raw text: file-name safe, at most `max` characters, no leading dot. May be empty. */
export function sanitizeTitle(raw: string, max = TITLE_MAX): string {
	let title = raw
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/:\s/g, " - ")
		.replace(FORBIDDEN_IN_TITLE_ALL, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "");
	const chars = Array.from(title);
	if (chars.length > max) {
		const cut = chars.slice(0, max).join("");
		const space = cut.lastIndexOf(" ");
		title = space > max / 2 ? cut.slice(0, space) : cut;
	}
	return title.replace(/[.\s]+$/, "");
}

/** First sentence of the text (extended until it holds at least ~20 characters), URLs removed. */
export function firstSentence(text: string): string {
	const clean = text.replace(/https?:\/\/\S+/g, " ").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
	const parts = clean.split(/(?<=[.!?])\s+/);
	let out = "";
	for (const part of parts) {
		out = out ? `${out} ${part}` : part;
		if (out.length >= 20) break;
	}
	return out;
}

/** A curated title must already be a legal note name; it is never silently rewritten. */
export function checkTitle(title: unknown): string {
	if (typeof title !== "string" || !title.trim()) throw new Error("Title must be a non-empty string.");
	const value = title.trim();
	if (Array.from(value).length > CURATED_TITLE_MAX) throw new Error(`Title is too long (max ${CURATED_TITLE_MAX} characters): ${JSON.stringify(value.slice(0, 30))}…`);
	if (FORBIDDEN_IN_TITLE.test(value) || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Title has characters a note name cannot contain (${FORBIDDEN_TITLE_CHARS.join(" ")} or control characters): ${JSON.stringify(value)}`);
	if (value.startsWith(".") || value.endsWith(".")) throw new Error(`Title must not start or end with a dot: ${JSON.stringify(value)}`);
	return value;
}

/** Vault path of a post note named by the caller: `posts/<Title>.md`, the full vault path, or the bare title. */
export function resolvePostNote(input: unknown, layout: Layout): string {
	if (typeof input !== "string" || !input.trim()) throw new Error("Note path must not be empty.");
	let name = input.trim();
	if (name.startsWith(`${layout.posts}/`)) name = name.slice(layout.posts.length + 1);
	else if (name.startsWith("posts/")) name = name.slice("posts/".length);
	if (name.endsWith(".md")) name = name.slice(0, -3);
	if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".") || name.includes("..")) {
		throw new Error(`Not a saved post note: ${JSON.stringify(input)}. Use ${layout.posts}/<Title>.md (no subfolders, no dot-prefixed names).`);
	}
	return postPath(layout, name);
}
