/**
 * /mem <text>: capture a memory snippet through the shared capture panel.
 *
 * The handler returns at once and the capture runs detached, like /task. The panel confirms
 * the scope, the target (a new note, or appending to a likely duplicate that memory search
 * finds) and the path. Confirming writes through the same session and write helpers as the
 * memory_write and memory_edit tools; cancelling writes nothing. No LLM is involved and no
 * LLM-callable tool is added.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CaptureSession, mountCapturePanel, type ChoiceRow, type Outcome } from "../lib/capture-panel";
import { okfReasons } from "./okf";
import { relativeToRoot, resolveNotePath, scopeRoot, type NoteScope } from "./paths";
import { editNote, openSession, writeNote, type MemorySession } from "./session";

const SEARCH_FILE_LIMIT = 50;
const MAX_KEYWORDS = 4;
const MAX_DUPLICATES_PER_SCOPE = 3;
const TITLE_LIMIT = 80;
const PREVIEW_LINES = 12;
const SCOPES: readonly NoteScope[] = ["project", "global"];

const STOPWORDS = new Set([
	"about", "also", "been", "being", "does", "doing", "from", "have", "having", "into", "just", "like", "make", "more",
	"much", "must", "need", "only", "over", "should", "some", "than", "that", "their", "them", "then", "there", "these",
	"they", "this", "those", "very", "want", "were", "what", "when", "where", "which", "while", "will", "with", "would", "your",
]);

type Candidate = { scope: NoteScope; path: string; hits: number };
type Saved = { scope: NoteScope; path: string; mode: "new" | "appended"; okf: string[] };

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function localDate(now: Date): string {
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** ISO-8601 with the local UTC offset, like the timestamps in existing notes. */
function localTimestamp(now: Date): string {
	const offset = -now.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	return `${localDate(now)}T${time}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** The first line, cut at its first sentence end when that leaves a real sentence, at most TITLE_LIMIT characters. */
export function noteTitle(text: string): string {
	const line = text.trim().split(/\r?\n/)[0].trim();
	const sentence = /^(.{12,}?[.!?])\s/.exec(line);
	const title = (sentence ? sentence[1] : line).replace(/\.$/, "");
	return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1).trimEnd()}…` : title;
}

/** Lower-case ASCII words of the title, at most six and 50 characters; a timestamp name when nothing is left. */
export function defaultPath(title: string, now: Date): string {
	const words = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9]+/g) ?? [];
	const slug = words.slice(0, 6).join("-").slice(0, 50).replace(/-+$/, "");
	return `${slug || `note-${localDate(now).replace(/-/g, "")}-${pad(now.getHours())}${pad(now.getMinutes())}`}.md`;
}

/** Up to four distinctive words (longest first) to search for: Obsidian search ANDs words, so a whole sentence would match nothing. */
export function keywords(text: string): string[] {
	const seen = new Set<string>();
	for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
		if (word.length >= 4 && !STOPWORDS.has(word)) seen.add(word);
	}
	return [...seen].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS);
}

/** One search per keyword (the disk backend has no OR); a note is a candidate when it matches at least two of them (one when there is only one). */
async function findDuplicates(s: MemorySession, words: string[], signal: AbortSignal): Promise<Candidate[]> {
	if (words.length === 0) return [];
	await s.client.verifyVault(signal);
	const needed = Math.min(2, words.length);
	const found: Candidate[] = [];
	for (const scope of SCOPES) {
		const root = scopeRoot(scope, s.projectId);
		const hits = new Map<string, number>();
		for (const word of words) {
			for (const match of await s.client.searchContext(word, root, SEARCH_FILE_LIMIT, signal)) {
				const relative = relativeToRoot(root, match.file);
				if (relative !== null) hits.set(relative, (hits.get(relative) ?? 0) + 1);
			}
		}
		[...hits]
			.filter(([, count]) => count >= needed)
			.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
			.slice(0, MAX_DUPLICATES_PER_SCOPE)
			.forEach(([path, count]) => found.push({ scope, path, hits: count }));
	}
	return found;
}

/** A new OKF concept. type and the memory/inbox tag are placeholders to curate later with memory_edit. */
export function newNoteContent(title: string, text: string, now: Date): string {
	const quoted = JSON.stringify(title);
	return [
		"---",
		"type: Note",
		`title: ${quoted}`,
		`description: ${quoted}`,
		"tags:",
		"  - memory/inbox",
		`created: "${localDate(now)}"`,
		`updated: "${localDate(now)}"`,
		`timestamp: "${localTimestamp(now)}"`,
		"---",
		"",
		text.trim(),
		"",
	].join("\n");
}

/** The note with the text appended; `updated` and `timestamp` are refreshed when its frontmatter has them. */
export function appendedNote(note: string, text: string, now: Date): string {
	let head = "";
	let rest = note;
	const end = note.startsWith("---\n") ? note.indexOf("\n---", 3) : -1;
	if (end >= 0) {
		head = note.slice(0, end)
			.replace(/^updated:[^\r\n]*$/m, `updated: "${localDate(now)}"`)
			.replace(/^timestamp:[^\r\n]*$/m, `timestamp: "${localTimestamp(now)}"`);
		rest = note.slice(end);
	}
	return `${head}${rest.trimEnd()}\n\n${text.trim()}\n`;
}

function previewLines(note: string): string[] {
	const body = note.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
	return body.split(/\r?\n/).filter((line) => line.trim()).slice(0, PREVIEW_LINES);
}

async function capture(pi: ExtensionAPI, ctx: ExtensionCommandContext, text: string, abort: AbortController): Promise<void> {
	const { cwd, ui } = ctx;
	const signal = abort.signal;
	const now = new Date();
	const title = noteTitle(text);
	const defaultNotePath = defaultPath(title, now);
	let store!: MemorySession;
	const words = keywords(text);
	let candidates: Candidate[] = [];
	let newPath = defaultNotePath;

	const scopeOf = (session: CaptureSession<Saved>): NoteScope => (session.choice("scope").index === 0 ? "project" : "global");
	const candidatesFor = (scope: NoteScope) => candidates.filter((candidate) => candidate.scope === scope);
	const idOf = (candidate: Candidate) => `${candidate.scope}:${candidate.path}`;
	const chosen = (session: CaptureSession<Saved>): Candidate | undefined => {
		const index = session.choice("target").index;
		return index === 0 ? undefined : candidatesFor(scopeOf(session))[index - 1];
	};

	/** The target row and the path row follow the scope and the target. */
	const syncTarget = (session: CaptureSession<Saved>, resetTarget: boolean) => {
		const target = session.choice("target");
		const path = session.text("path");
		const append = chosen(session);
		if (resetTarget) {
			target.options = ["new note", ...candidatesFor(scopeOf(session)).map((candidate) => `append → ${candidate.path}`)];
			target.index = 0;
		}
		if (append) {
			path.value = append.path;
			path.editable = false;
		} else {
			path.value = newPath;
			path.editable = true;
		}
	};

	const session = new CaptureSession<Saved>(title, {
		chip: "/mem",
		loadingText: "Searching memory for similar notes…",
		action: { verb: "save", busy: "saving", failed: "Saving" },
		previewHint: "preview duplicate",
		hooks: {
			confirm: async (current) => {
				const scope = scopeOf(current);
				const append = chosen(current);
				const stamp = new Date();
				if (!append) {
					const path = current.text("path").value.trim();
					const { okf } = await writeNote(store, scope, path, newNoteContent(title, text, stamp), "create", signal);
					return { scope, path, mode: "new", okf };
				}
				const old = await store.client.read(resolveNotePath(scopeRoot(scope, store.projectId), append.path), signal);
				const next = appendedNote(old, text, stamp);
				await editNote(store, scope, append.path, old, next, signal);
				return { scope, path: append.path, mode: "appended", okf: okfReasons(append.path, next) };
			},
			preview: async (id) => {
				const split = id.indexOf(":");
				const scope = id.slice(0, split) as NoteScope;
				const note = await store.client.read(resolveNotePath(scopeRoot(scope, store.projectId), id.slice(split + 1)), signal);
				const lines = previewLines(note);
				return lines.length > 0 ? lines : ["(empty note)"];
			},
			previewTarget: (current) => {
				const append = chosen(current);
				return append ? idOf(append) : current.duplicates[0]?.id;
			},
			choiceChanged: (current, row: ChoiceRow) => {
				// The path row is edited by typing, so remember it before the target or scope replaces it.
				if (current.text("path").editable) newPath = current.text("path").value;
				syncTarget(current, row.id === "scope");
			},
		},
	});
	const unmount = mountCapturePanel(ui, session);

	const prepare = async () => {
		try {
			store = openSession(pi, cwd);
			candidates = await findDuplicates(store, words, signal);
		} catch (error) {
			if (session.settled) return;
			session.fatal = messageOf(error);
			session.phase = "blocked";
			session.changed();
			return;
		}
		if (session.settled) return;
		session.duplicates = candidates.map((candidate) => ({
			id: idOf(candidate),
			detail: `${candidate.hits}/${words.length} words`,
		}));
		session.rows = [
			{ kind: "choice", id: "scope", label: "scope", options: [`project ${store.projectId}`, "global"], index: 0 },
			{ kind: "choice", id: "target", label: "target", options: ["new note"], index: 0, compact: true },
			{ kind: "text", id: "path", label: "path", value: newPath, editable: true },
		];
		syncTarget(session, true);
		session.phase = "ready";
		session.changed();
	};

	let outcome: Outcome<Saved>;
	try {
		void prepare();
		outcome = await session.done;
	} finally {
		abort.abort();
		unmount();
	}

	if (outcome.choice === "confirmed") {
		const { scope, path, mode, okf } = outcome.result;
		ui.notify(`Saved ${scope}:${path} (${mode === "new" ? "new note" : "appended"})`, "info");
		if (okf.length > 0) ui.notify(`${scope}:${path} is not a valid OKF concept (${okf.join(", ")}).`, "warning");
	}
}

export function registerMemoryCommand(pi: ExtensionAPI): void {
	let active: AbortController | undefined;

	pi.on("session_shutdown", () => {
		active?.abort();
	});

	pi.registerCommand("mem", {
		description: "Capture a memory snippet: /mem <text>",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/mem needs the interactive Pi UI.", "warning");
				return;
			}
			if (!text) {
				ctx.ui.notify("Usage: /mem <text>", "warning");
				return;
			}
			if (active) {
				ctx.ui.notify("A /mem capture is already open. Finish or cancel it first.", "warning");
				return;
			}
			const abort = new AbortController();
			active = abort;
			// Detached on purpose: the handler returns now, so a running turn is never held up.
			void capture(pi, ctx, text, abort)
				.catch((error) => ctx.ui.notify(`/mem failed: ${messageOf(error)}`, "error"))
				.finally(() => {
					if (active === abort) active = undefined;
				});
		},
	});
}
