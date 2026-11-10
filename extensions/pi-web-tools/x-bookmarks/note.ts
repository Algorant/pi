import { firstSentence, sanitizeTitle } from "./paths.ts";

// Build bookmark post and author notes from X API v2 objects. Pure functions; no I/O.
// Missing data is omitted, never invented. Media is linked, not downloaded.
// Parser shapes follow the documented X API v2 response (tweet.fields/expansions requested in xurl.ts).

export type ApiImage = { url?: string; width?: number; height?: number };
export type ApiUrl = { url?: string; expanded_url?: string; media_key?: string; images?: ApiImage[]; title?: string };
export type ApiTweet = {
	id: string;
	text?: string;
	author_id?: string;
	created_at?: string;
	lang?: string;
	conversation_id?: string;
	entities?: { urls?: ApiUrl[] };
	note_tweet?: { text?: string; entities?: { urls?: ApiUrl[] } };
	referenced_tweets?: Array<{ type?: string; id?: string }>;
	attachments?: { media_keys?: string[] };
	article?: { title?: string; cover_media?: string };
	public_metrics?: { reply_count?: number };
};
export type ApiUser = {
	id: string;
	username?: string;
	name?: string;
	profile_image_url?: string;
	description?: string;
	entities?: { description?: { urls?: ApiUrl[] } };
};
export type ApiMedia = { media_key: string; type?: string; url?: string; preview_image_url?: string; alt_text?: string };
export type Includes = { tweets?: ApiTweet[]; users?: ApiUser[]; media?: ApiMedia[] };

export type Kind = "original" | "reply" | "quote" | "repost";

/** Follow-ups of the author's self-thread. `unavailable` and `partial` always render a visible "continues on X" marker. */
export type Thread = { state: "none" | "complete" | "partial" | "unavailable"; followUps: ApiTweet[]; media: ApiMedia[] };

export const NO_THREAD: Thread = { state: "none", followUps: [], media: [] };

const OPEN = "\uE000";
const CLOSE = "\uE001";

/** Escape Markdown/Obsidian syntax so untrusted post text cannot forge structure, links, tags, or embeds. */
export function escapeMarkdown(text: string): string {
	return text
		.replace(/[\\`*_\[\]<>#|~^$&]/g, "\\$&")
		.replace(/==/g, "\\=\\=")
		.replace(/%%/g, "\\%\\%")
		.replace(/^([ \t]*)([-+])(\s)/gm, "$1\\$2$3")
		.replace(/^([ \t]*\d+)([.)])(\s)/gm, "$1\\$2$3");
}

export function httpUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

const MEDIA_PERMALINK = /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/\d+\/(?:photo|video)\/\d+/i;

function statusId(url: string): string | undefined {
	return /^https?:\/\/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i.exec(url)?.[1];
}

export function postUrl(handle: string, id: string): string {
	return `https://x.com/${handle}/status/${id}`;
}

/** `titles` holds the link-card titles X already sent for kept links (expanded URL → one-line title). */
type Rendered = { markdown: string; plain: string; links: string[]; titles: Map<string, string> };

function addTitles(into: Map<string, string>, from: Map<string, string>): void {
	for (const [url, title] of from) if (!into.has(url)) into.set(url, title);
}

/** Full text (note_tweet when present) with t.co links expanded, media links dropped, and Markdown escaped. */
function renderText(tweet: ApiTweet, dropStatusIds: Set<string>): Rendered {
	const long = typeof tweet.note_tweet?.text === "string" ? tweet.note_tweet : undefined;
	let raw = long ? long.text! : tweet.text ?? "";
	// v2 `text` carries HTML-escaped &, <, >; note_tweet text does not.
	if (!long) raw = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	raw = raw.split(OPEN).join("").split(CLOSE).join("");
	const entities = (long ? long.entities?.urls : tweet.entities?.urls) ?? [];
	const links: string[] = [];
	const titles = new Map<string, string>();
	const targets: string[] = [];
	for (const entity of entities) {
		if (!entity.url || !raw.includes(entity.url)) continue;
		const expanded = httpUrl(entity.expanded_url);
		const id = expanded ? statusId(expanded) : undefined;
		const drop = !expanded || Boolean(entity.media_key) || MEDIA_PERMALINK.test(expanded) || (id !== undefined && dropStatusIds.has(id));
		let marker = "";
		if (!drop) {
			targets.push(expanded!);
			marker = `${OPEN}${targets.length - 1}${CLOSE}`;
			if (!links.includes(expanded!)) links.push(expanded!);
			const title = typeof entity.title === "string" ? oneLine(entity.title) : "";
			if (title && !titles.has(expanded!)) titles.set(expanded!, title);
		}
		raw = raw.split(entity.url).join(marker);
	}
	const substitute = (value: string, wrap: (url: string) => string) =>
		value.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"), (_m, n: string) => wrap(targets[Number(n)]));
	return {
		markdown: substitute(escapeMarkdown(raw), (url) => `<${url}>`).trim(),
		plain: substitute(raw, (url) => url).trim(),
		links,
		titles,
	};
}

function quote(markdown: string): string[] {
	return markdown.split("\n").map((line) => (line ? `> ${line}` : ">"));
}

export function yamlString(value: string): string {
	return JSON.stringify(value);
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DD`. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Aug 24, 2026`, in local time. */
export function longDate(date: Date): string {
	return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

function parseDate(iso: string | undefined): Date | undefined {
	if (!iso) return undefined;
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

export function safeHandle(user: ApiUser | undefined): string | undefined {
	const handle = user?.username;
	return typeof handle === "string" && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : undefined;
}

function byline(user: ApiUser | undefined): string {
	const handle = safeHandle(user);
	const name = user?.name ? escapeMarkdown(user.name) : undefined;
	if (name && handle) return `**${name}** (@${handle})`;
	if (handle) return `**@${handle}**`;
	return name ? `**${name}**` : "**Unknown author**";
}

function plainByline(user: ApiUser | undefined): string {
	const handle = safeHandle(user);
	const name = user?.name ? oneLine(user.name) : undefined;
	if (name && handle) return `${name} (@${handle})`;
	return handle ? `@${handle}` : name || "Unknown author";
}

export type MediaLink = { type: string; url: string; alt?: string };

function mediaFor(tweet: ApiTweet, media: Map<string, ApiMedia>): MediaLink[] {
	const out: MediaLink[] = [];
	for (const key of tweet.attachments?.media_keys ?? []) {
		const item = media.get(key);
		if (!item) continue;
		const url = httpUrl(item.url) ?? httpUrl(item.preview_image_url);
		if (!url) continue;
		const type = item.type ? item.type : "media";
		out.push({ type: item.url ? type : `${type} preview`, url, alt: item.alt_text?.trim() || undefined });
	}
	return out;
}

/** Everything the post note needs that does not depend on thread or cover lookups. */
export type Parts = {
	tweetId: string;
	handle: string;
	user: ApiUser;
	source: string;
	kind: Kind;
	posted?: string;
	postedLabel?: string;
	/** One-line plain text for the provisional summary and lede. */
	excerpt: string;
	/** Raw text the provisional title is cut from. */
	titleSeed: string;
	/** Plain text for the generated card (no URLs). */
	cardText: string;
	ownBlock: string[];
	refBlocks: string[][];
	/** Plain-text twins of `ownBlock` and `refBlocks` (no Markdown escaping) for the sync report. */
	ownPlain: string[];
	refPlain: string[][];
	links: string[];
	linkTitles: Map<string, string>;
	media: MediaLink[];
	conversationId: string;
	/** A thread read is worth one request: not a repost, and X does not report zero replies. */
	threadable: boolean;
};

const EXCERPT_MAX = 240;

function oneLine(text: string): string {
	return text.replace(/https?:\/\/\S+/g, " ").replace(/\s+/g, " ").trim();
}

function clamp(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	const cut = chars.slice(0, max).join("");
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`;
}

export function describePost(tweet: ApiTweet, includes: Includes): Parts {
	if (!tweet || typeof tweet.id !== "string" || !/^\d+$/.test(tweet.id)) throw new Error(`X returned a post without a usable id: ${JSON.stringify(tweet?.id)}`);
	const users = new Map((includes.users ?? []).map((u) => [u.id, u]));
	const tweets = new Map((includes.tweets ?? []).map((t) => [t.id, t]));
	const media = new Map((includes.media ?? []).map((m) => [m.media_key, m]));

	const author = tweet.author_id ? users.get(tweet.author_id) : undefined;
	const handle = safeHandle(author);
	if (!author || !handle) throw new Error(`Post ${tweet.id} has no usable author handle in the X response; it was not saved.`);
	const source = postUrl(handle, tweet.id);
	const refs = tweet.referenced_tweets ?? [];
	const reposted = refs.find((r) => r.type === "retweeted");
	const quoted = refs.find((r) => r.type === "quoted");
	const replied = refs.find((r) => r.type === "replied_to");
	const kind: Kind = reposted ? "repost" : quoted ? "quote" : replied ? "reply" : "original";
	const postedAt = parseDate(tweet.created_at);

	const refTweet = (ref: { id?: string } | undefined): ApiTweet | undefined => (ref?.id ? tweets.get(ref.id) : undefined);
	const refAuthor = (t: ApiTweet | undefined) => (t?.author_id ? users.get(t.author_id) : undefined);
	const refUrl = (ref: { id?: string } | undefined): string | undefined => {
		const refHandle = safeHandle(refAuthor(refTweet(ref)));
		return ref?.id && /^\d+$/.test(ref.id) && refHandle ? postUrl(refHandle, ref.id) : undefined;
	};

	const dropIds = new Set<string>([reposted?.id, quoted?.id].filter((id): id is string => Boolean(id)));
	const ownText = renderText(tweet, dropIds);
	const links: string[] = [];
	const linkTitles = new Map<string, string>();
	const addLinks = (text: Rendered) => {
		text.links.forEach((l) => links.includes(l) || links.push(l));
		addTitles(linkTitles, text.titles);
	};
	const allMedia: MediaLink[] = [];
	const addMedia = (more: MediaLink[]) => more.forEach((m) => allMedia.some((x) => x.url === m.url) || allMedia.push(m));

	const ownBlock: string[] = [];
	const ownPlain: string[] = [];
	let seed = "";
	const showOwn = kind !== "repost" || !refTweet(reposted);
	if (showOwn) {
		if (ownText.markdown) ownBlock.push(ownText.markdown);
		if (ownText.plain) ownPlain.push(ownText.plain);
		if (tweet.article?.title) {
			ownBlock.push(`Article: ${escapeMarkdown(tweet.article.title)}`);
			ownPlain.push(`Article: ${oneLine(tweet.article.title)}`);
		}
		seed = ownText.plain;
		addLinks(ownText);
		addMedia(mediaFor(tweet, media));
	}

	const refBlocks: string[][] = [];
	const refPlain: string[][] = [];
	const section = (title: string, ref: { id?: string } | undefined) => {
		if (!ref) return;
		const t = refTweet(ref);
		const link = refUrl(ref);
		if (!t) {
			refBlocks.push([`**${title}** — ${link ? `<${link}> ` : ""}(not expanded in the X response)`]);
			refPlain.push([`${title} — ${link ? `${link} ` : ""}(not expanded in the X response)`]);
			return;
		}
		const text = renderText(t, new Set());
		const when = parseDate(t.created_at);
		const block = [`**${title}** — ${[byline(refAuthor(t)), when ? localDate(when) : undefined].filter(Boolean).join(" · ")}`];
		if (text.markdown) block.push("", ...quote(text.markdown));
		if (t.article?.title) block.push("", `Article: ${escapeMarkdown(t.article.title)}`);
		if (link) block.push("", `<${link}>`);
		refBlocks.push(block);
		const plain = [`${title} — ${[plainByline(refAuthor(t)), when ? localDate(when) : undefined].filter(Boolean).join(" · ")}`];
		if (text.plain) plain.push(text.plain);
		if (t.article?.title) plain.push(`Article: ${oneLine(t.article.title)}`);
		if (link) plain.push(link);
		refPlain.push(plain);
		addLinks(text);
		addMedia(mediaFor(t, media));
		if (!oneLine(seed)) seed = text.plain || t.article?.title || "";
	};
	section("Reposted post", reposted);
	section("Quoted post", quoted);
	section("Replying to", replied);
	if (!oneLine(seed) && tweet.article?.title) seed = tweet.article.title;

	const excerpt = clamp(oneLine(seed), EXCERPT_MAX);
	return {
		tweetId: tweet.id,
		handle,
		user: author,
		source,
		kind,
		posted: postedAt ? localDate(postedAt) : undefined,
		postedLabel: postedAt ? longDate(postedAt) : undefined,
		excerpt: excerpt || `Post by @${handle}`,
		titleSeed: seed,
		cardText: oneLine(ownText.plain),
		ownBlock,
		refBlocks,
		ownPlain,
		refPlain,
		links,
		linkTitles,
		media: allMedia,
		conversationId: /^\d+$/.test(tweet.conversation_id ?? "") ? tweet.conversation_id! : tweet.id,
		threadable: kind !== "repost" && tweet.public_metrics?.reply_count !== 0,
	};
}

/** Provisional title: the first sentence of the text, file-name safe. Falls back to the article title, then author and date. */
export function provisionalTitle(parts: Parts): string {
	const fromText = sanitizeTitle(firstSentence(parts.titleSeed));
	if (fromText) return fromText;
	return sanitizeTitle(`Post by @${parts.handle}${parts.posted ? ` (${parts.posted})` : ""}`);
}

/** Thread follow-ups as callout Markdown and as plain text; adds follow-up links, link titles, and media. */
function threadBlock(thread: Thread, source: string, links: string[], titles: Map<string, string>, media: MediaLink[]): { markdown: string[]; plain: string[] } {
	const block: string[] = [];
	const plain: string[] = [];
	if (thread.followUps.length) {
		const mediaMap = new Map(thread.media.map((m) => [m.media_key, m]));
		block.push("**Thread follow-ups**");
		plain.push("Thread follow-ups");
		for (const followUp of thread.followUps) {
			const text = renderText(followUp, new Set());
			block.push("", text.markdown || "*(no text)*");
			plain.push("", text.plain || "(no text)");
			text.links.forEach((l) => links.includes(l) || links.push(l));
			addTitles(titles, text.titles);
			mediaFor(followUp, mediaMap).forEach((m) => media.some((x) => x.url === m.url) || media.push(m));
		}
	}
	const gap = block.length ? [""] : [];
	if (thread.state === "partial") {
		block.push(...gap, `**Thread continues on X** — more follow-ups exist than were read: <${source}>`);
		plain.push(...gap, `Thread continues on X — more follow-ups exist than were read: ${source}`);
	}
	if (thread.state === "unavailable") {
		block.push(`**Thread continues on X** — follow-ups could not be read: <${source}>`);
		plain.push(`Thread continues on X — follow-ups could not be read: ${source}`);
	}
	return { markdown: block, plain };
}

export type PostRender = { parts: Parts; thread: Thread; cover: string; savedOn: Date };

/**
 * `markdown` is the note file. `source` is the same Saved text in plain form (own text, thread follow-ups,
 * quoted/replied/reposted posts, media types and alt text, then the link-card titles X already sent), for the
 * sync report, so curation needs no reread of the note it was just written to.
 */
export type RenderedPost = { markdown: string; source: string };

export function renderPost({ parts, thread, cover, savedOn }: PostRender): RenderedPost {
	const links = [...parts.links];
	const titles = new Map(parts.linkTitles);
	const media = [...parts.media];
	const threadLines = threadBlock(thread, parts.source, links, titles, media);
	const blocks: string[][] = [];
	const plainBlocks: string[][] = [];
	if (parts.ownBlock.length) blocks.push(parts.ownBlock.flatMap((line, i) => (i ? ["", line] : [line])));
	if (parts.ownPlain.length) plainBlocks.push(parts.ownPlain.flatMap((line, i) => (i ? ["", line] : [line])));
	if (threadLines.markdown.length) blocks.push(threadLines.markdown);
	if (threadLines.plain.length) plainBlocks.push(threadLines.plain);
	blocks.push(...parts.refBlocks);
	plainBlocks.push(...parts.refPlain.map((block) => block.flatMap((line, i) => (i > 1 ? ["", line] : [line]))));
	if (media.length) {
		blocks.push(["**Media**", "", ...media.map((m) => `- ${escapeMarkdown(m.type)}: <${m.url}>${m.alt ? ` — ${escapeMarkdown(m.alt)}` : ""}`)]);
		plainBlocks.push(media.map((m) => `Media: ${m.type}${m.alt ? ` — ${oneLine(m.alt)}` : ""}`));
	}
	if (!blocks.length) blocks.push(["*(the X response held no text for this post)*"]);
	if (!plainBlocks.length) plainBlocks.push(["(the X response held no text for this post)"]);
	const known = links.filter((l) => titles.has(l));
	if (known.length) plainBlocks.push(["Link titles (from X link cards):", ...known.map((l) => `${l} — ${titles.get(l)}`)]);
	const callout = blocks
		.flatMap((block, i) => (i ? ["", ...block] : block))
		.join("\n")
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"));

	const front = [
		"---",
		`author: ${yamlString(`[[@${parts.handle}]]`)}`,
		`source: ${yamlString(parts.source)}`,
		...(parts.posted ? [`posted: ${parts.posted}`] : []),
		`saved: ${localDate(savedOn)}`,
		"tags: []",
		"status: inbox",
		`cover: ${yamlString(cover)}`,
		`summary: ${yamlString(parts.excerpt)}`,
		"---",
	];
	const body = [
		escapeMarkdown(parts.excerpt),
		"",
		`![](${parts.source})`,
		"",
		...(links.length ? ["## Links", "", ...links.map((l) => `- <${l}>`), ""] : []),
		"> [!quote]- Saved text",
		...callout,
		"",
		"## Notes",
		"",
	];
	return {
		markdown: [...front, ...body].join("\n"),
		source: plainBlocks.flatMap((block, i) => (i ? ["", ...block] : block)).join("\n"),
	};
}

/** Larger copy of a profile image URL: `_normal` becomes `_400x400`. */
export function avatarUrl(user: ApiUser): string {
	return httpUrl(user.profile_image_url)?.replace(/_normal(\.[A-Za-z0-9]+)$/, "_400x400$1") ?? "";
}

/** One-line profile bio with t.co links expanded. */
export function bioText(user: ApiUser): string {
	let bio = user.description ?? "";
	for (const entity of user.entities?.description?.urls ?? []) {
		const expanded = httpUrl(entity.expanded_url);
		if (entity.url && expanded) bio = bio.split(entity.url).join(expanded);
	}
	return bio.replace(/\s+/g, " ").trim();
}

export function renderAuthor(user: ApiUser, handle: string): string {
	return [
		"---",
		`name: ${yamlString(user.name?.trim() || handle)}`,
		`profile: ${yamlString(`https://x.com/${handle}`)}`,
		`avatar: ${yamlString(avatarUrl(user))}`,
		`bio: ${yamlString(bioText(user))}`,
		"---",
		"![[Bookmarks.base#This author]]",
		"",
	].join("\n");
}
