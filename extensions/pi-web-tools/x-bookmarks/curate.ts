import type { ObsidianClient } from "../../lib/obsidian-cli.ts";
import { escapeMarkdown, yamlString } from "./note.ts";
import { checkTitle, postPath, resolvePostNote, type Layout } from "./paths.ts";
import { MAX_NOTES_PER_CALL, MAX_TAGS_PER_NOTE, parseTagCounts, validateTag } from "./tags.ts";

// Curate: give saved posts their final title (a rename that keeps links intact), summary (frontmatter and lede),
// ordered tags, status, and Algorant-approved related links. Every note is read and the whole batch is planned
// and validated before the first write. The `## Notes` section and everything after the lede is never touched.

export const STATUSES = ["inbox", "active", "archived"] as const;
export const MAX_SUMMARY = 400;

export type CurateRequest = { path: string; title?: string; summary?: string; tags?: string[]; status?: string; related?: string[] };

export type CuratedNote = { from: string; path: string; renamed: boolean; changes: string[]; written: boolean };
export type CurateOutcome = { text: string; details: Record<string, unknown> };

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function parseRequests(raw: unknown, layout: Layout): Array<CurateRequest & { resolved: string }> {
	if (!Array.isArray(raw) || !raw.length) throw new Error('action "curate" needs notes: [{ path, title?, summary?, tags?, status?, related? }].');
	if (raw.length > MAX_NOTES_PER_CALL) throw new Error(`Curate at most ${MAX_NOTES_PER_CALL} notes per call.`);
	const requests = raw.map((entry: Record<string, unknown>) => {
		const resolved = resolvePostNote(entry?.path, layout);
		const request: CurateRequest & { resolved: string } = { path: String(entry.path), resolved };
		if (entry.title !== undefined) request.title = checkTitle(entry.title);
		if (entry.summary !== undefined) {
			if (typeof entry.summary !== "string" || !entry.summary.trim()) throw new Error(`Summary must be a non-empty string (${resolved}).`);
			const summary = entry.summary.trim();
			if (/[\r\n]/.test(summary)) throw new Error(`Summary must be one line (${resolved}).`);
			if (summary.length > MAX_SUMMARY) throw new Error(`Summary is too long (max ${MAX_SUMMARY} characters; ${resolved}).`);
			request.summary = summary;
		}
		if (entry.tags !== undefined) {
			if (!Array.isArray(entry.tags) || !entry.tags.length) throw new Error(`Tags must be a non-empty ordered list (${resolved}).`);
			if (entry.tags.length > MAX_TAGS_PER_NOTE) throw new Error(`At most ${MAX_TAGS_PER_NOTE} tags per note (${resolved}).`);
			request.tags = [...new Set(entry.tags.map(validateTag))];
		}
		if (entry.status !== undefined) {
			if (!STATUSES.includes(entry.status as (typeof STATUSES)[number])) throw new Error(`Status must be one of ${STATUSES.join(", ")} (${resolved}).`);
			request.status = String(entry.status);
		}
		if (entry.related !== undefined) {
			if (!Array.isArray(entry.related) || !entry.related.length) throw new Error(`Related must be a non-empty list of post titles (${resolved}).`);
			request.related = entry.related.map((value) => relatedTitle(value, resolved));
		}
		if (request.title === undefined && request.summary === undefined && !request.tags && request.status === undefined && !request.related) {
			throw new Error(`Nothing to change for ${resolved}: give a title, summary, tags, status, or related.`);
		}
		return request;
	});
	if (new Set(requests.map((r) => r.resolved)).size !== requests.length) throw new Error("Each note may appear once per call.");
	return requests;
}

/** A related target as a bare post title; `[[Title]]` is accepted and stripped. */
function relatedTitle(value: unknown, path: string): string {
	if (typeof value !== "string") throw new Error(`Related links must be post titles (${path}).`);
	const title = value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
	return checkTitle(title);
}

type Doc = { fm: string[]; rest: string[] };

function splitNote(text: string, path: string): Doc {
	const lines = text.split("\n");
	const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
	if (end < 0) throw new Error(`${path} has no closed YAML frontmatter; it is not a v0.2 post note.`);
	return { fm: lines.slice(1, end), rest: lines.slice(end + 1) };
}

function joinNote(doc: Doc): string {
	return ["---", ...doc.fm, "---", ...doc.rest].join("\n");
}

/** Index range of a frontmatter key and its indented continuation lines. */
function keyRange(fm: string[], key: string): [number, number] | null {
	const start = fm.findIndex((line) => line.startsWith(`${key}:`));
	if (start < 0) return null;
	let end = start + 1;
	while (end < fm.length && /^[ \t]+\S/.test(fm[end])) end++;
	return [start, end];
}

export function readScalar(fm: string[], key: string): string | undefined {
	const range = keyRange(fm, key);
	return range ? fm[range[0]].slice(key.length + 1).trim() : undefined;
}

function setKey(fm: string[], key: string, lines: string[], path: string, appendIfMissing = false): void {
	const range = keyRange(fm, key);
	if (range) fm.splice(range[0], range[1] - range[0], ...lines);
	else if (appendIfMissing) fm.push(...lines);
	else throw new Error(`${path} has no "${key}:" property; it is not a v0.2 post note.`);
}

export function listItems(fm: string[], key: string): string[] {
	const range = keyRange(fm, key);
	if (!range) return [];
	return fm.slice(range[0] + 1, range[1]).map((line) => /^\s+-\s+(.*)$/.exec(line)?.[1].trim().replace(/^["']|["']$/g, "") ?? "");
}

function wikilink(title: string): string {
	return `[[${title}]]`;
}

type Plan = {
	request: CurateRequest & { resolved: string };
	text: string;
	doc: Doc;
	handle: string;
	target: string;
	title: string;
	changes: string[];
};

export async function runCurate(options: { client: ObsidianClient; layout: Layout; notes: unknown; signal?: AbortSignal }): Promise<CurateOutcome> {
	const { client, layout, signal } = options;
	const requests = parseRequests(options.notes, layout);
	await client.verifyVault(signal);

	// Plan phase: read every note and check the whole batch before any write.
	const postFiles = new Set((await client.listMarkdown(layout.posts, false, signal)).map((f) => f.path.toLowerCase()));
	const claimed = new Set<string>();
	const plans: Plan[] = [];
	for (const request of requests) {
		const text = await client.read(request.resolved, signal);
		const doc = splitNote(text, request.resolved);
		const handle = /\[\[@([A-Za-z0-9_]+)\]\]/.exec(readScalar(doc.fm, "author") ?? "")?.[1];
		if (!handle) throw new Error(`${request.resolved} has no author link; it is not a v0.2 post note.`);
		const current = request.resolved.slice(layout.posts.length + 1, -3);
		let title = current;
		let target = request.resolved;
		if (request.title !== undefined && request.title !== current) {
			const candidates = [request.title, `${request.title} (@${handle})`];
			const own = request.resolved.toLowerCase();
			const free = candidates.find((candidate) => {
				const path = postPath(layout, candidate).toLowerCase();
				// The note's own file is not a collision: a case-only rename keeps its title (task-464).
				return (path === own || !postFiles.has(path)) && !claimed.has(path);
			});
			if (!free) throw new Error(`Both ${JSON.stringify(candidates[0])} and ${JSON.stringify(candidates[1])} are taken in ${layout.posts}/; ${request.resolved} was not changed.`);
			title = free;
			target = postPath(layout, title);
			claimed.add(target.toLowerCase());
		}
		plans.push({ request, text, doc, handle, target, title, changes: [] });
	}

	// Related links must name a post that exists after the batch (an existing title or a new title in this batch).
	const finalTitles = new Set<string>();
	for (const path of postFiles) finalTitles.add(path.slice(layout.posts.length + 1, -3));
	for (const plan of plans) {
		finalTitles.delete(plan.request.resolved.slice(layout.posts.length + 1, -3).toLowerCase());
	}
	for (const plan of plans) finalTitles.add(plan.title.toLowerCase());

	let known: Set<string> | undefined;
	if (plans.some((p) => p.request.tags)) {
		try {
			known = new Set(parseTagCounts(await client.run(["tags", "counts", "format=json"], signal)).map((c) => c.tag));
		} catch (error) {
			throw new Error(`Nothing was written: the vault tag list is needed to report new vs reused tags. ${message(error)}`);
		}
	}

	const newTags = new Set<string>();
	const reusedTags = new Set<string>();
	for (const plan of plans) {
		const { request, doc } = plan;
		const path = request.resolved;
		if (plan.target !== path) plan.changes.push("title");
		const lede = doc.rest.findIndex((line) => line.trim() !== "");
		if (lede < 0 || doc.rest[lede].startsWith("![](") || doc.rest[lede].startsWith("#")) throw new Error(`${path} has no summary lede paragraph; it is not a v0.2 post note.`);
		if (request.summary !== undefined) {
			setKey(doc.fm, "summary", [`summary: ${yamlString(request.summary)}`], path);
			doc.rest[lede] = escapeMarkdown(request.summary);
			plan.changes.push("summary");
		}
		if (request.tags) {
			setKey(doc.fm, "tags", ["tags:", ...request.tags.map((t) => `  - ${t}`)], path);
			for (const tag of request.tags) (known?.has(tag) ? reusedTags : newTags).add(tag);
			plan.changes.push("tags");
		}
		if (request.status !== undefined) {
			setKey(doc.fm, "status", [`status: ${request.status}`], path);
			plan.changes.push("status");
		}
		if (request.related) {
			const self = plan.title.toLowerCase();
			for (const title of request.related) {
				if (title.toLowerCase() === self) throw new Error(`${path} cannot be related to itself.`);
				if (!finalTitles.has(title.toLowerCase())) throw new Error(`Related target ${JSON.stringify(title)} for ${path} is not a saved post note.`);
			}
			const items = [...new Set([...listItems(doc.fm, "related"), ...request.related.map(wikilink)])];
			setKey(doc.fm, "related", ["related:", ...items.map((l) => `  - ${yamlString(l)}`)], path, true);
			plan.changes.push("related");
		}
	}

	// Write phase: content first (guarded against concurrent edits), then the rename.
	const results: CuratedNote[] = plans.map((p) => ({ from: p.request.resolved, path: p.target, renamed: p.target !== p.request.resolved, changes: p.changes, written: false }));
	let failure: string | undefined;
	for (const [index, plan] of plans.entries()) {
		try {
			const next = joinNote(plan.doc);
			if (next !== plan.text) await client.replaceIfUnchanged(plan.request.resolved, plan.text, next, signal);
			if (plan.target !== plan.request.resolved) await client.rename(plan.request.resolved, plan.target, signal);
			results[index].written = true;
		} catch (error) {
			failure = `${plan.request.resolved}: ${message(error)}`;
			break;
		}
	}
	const done = results.filter((r) => r.written);
	const lines = [
		failure
			? `Curate STOPPED by an error after ${done.length}/${results.length} note(s): ${failure}`
			: `Curated ${done.length} note(s).`,
		...results.map((r) => {
			const label = r.written ? (r.changes.length ? r.changes.join(", ") : "unchanged") : "NOT written";
			return `- ${r.renamed ? `${r.from} → ${r.path}` : r.path}: ${label}`;
		}),
	];
	const appliedNew = new Set<string>();
	const appliedReused = new Set<string>();
	for (const [index, plan] of plans.entries()) {
		if (!results[index].written || !plan.request.tags) continue;
		for (const tag of plan.request.tags) (newTags.has(tag) ? appliedNew : appliedReused).add(tag);
	}
	if (known) lines.push(appliedNew.size ? `New tags (not previously in the vault; list them for Algorant): ${[...appliedNew].join(", ")}` : "No new tags introduced.");
	if (appliedReused.size) lines.push(`Reused tags: ${[...appliedReused].join(", ")}`);
	return {
		text: lines.join("\n"),
		details: {
			action: "curate",
			noteCount: results.length,
			writtenCount: done.length,
			notes: results.map((r, i) => ({ path: r.path, handle: plans[i].handle, renamed: r.renamed, changes: r.changes, written: r.written })),
			newTags: [...appliedNew],
			reusedTags: [...appliedReused],
			error: failure,
		},
	};
}
