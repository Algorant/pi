import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createObsidianClient } from "../../lib/obsidian-cli.ts";
import { loadMemoryConfig } from "../../pi-memory/settings";
import { runCurate } from "./curate.ts";
import { FORBIDDEN_TITLE_CHARS, layoutFor } from "./paths.ts";
import { runRead } from "./read.ts";
import { DEEP_PAGE_SIZE, NORMAL_PAGE_SIZE, runSync, SAFETY_CAP } from "./sync.ts";
import { MAX_NOTES_PER_CALL, MAX_TAGS_PER_NOTE } from "./tags.ts";
import { XurlError } from "./xurl.ts";

// x_bookmarks: save X bookmarks as notes in Agentic/bookmarks/posts (read-only toward X; the vault is the only
// record of progress), curate them (title, summary, tags, status, related links), and read one saved note back.

function result(outcome: { text: string; details: Record<string, unknown> }) {
	return { content: [{ type: "text" as const, text: outcome.text }], details: outcome.details };
}

export function registerXBookmarks(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "x_bookmarks",
		exposure: "codemode",
		label: "X Bookmarks",
		description:
			`Save Algorant's X bookmarks as notes in the vault (Agentic/bookmarks/posts/<Title>.md, one note per post, plus authors/@handle.md and a generated cover when needed) and curate them. action=sync (default) reads bookmarks read-only through xurl, newest first, and writes a note for every post not yet saved until it reaches a page of only saved posts (the saved frontier) or the end of the list X serves, ${NORMAL_PAGE_SIZE} per page; a safety cap stops it at ${SAFETY_CAP} new notes and says so. The saved frontier does not prove older bookmarks are saved: after a cap, an error with notes written, deleted notes or never-synced history, pass deep:true, which ignores the frontier and reads the whole accessible list (X serves at most the 800 most recent bookmarks), ${DEEP_PAGE_SIZE} per page. X bills reads per resource returned, so a deep sweep pays for up to that whole list on every run even when nothing is new; X usually does not charge the same resource twice in one UTC day, a soft guarantee. It returns the new notes with bounded saved source text (clipped paths named), curate rules, preferred existing tags, and cover/thread warnings. action=curate renames notes to a final title, rewrites the summary, sets the ordered tags (primary topic first) and status, and adds related links; it plans every note before any write. action=read returns the exact text of one saved post note named by note (title or path), up to 2000 lines or 50KB, without calling X. See the xurl skill.`,
		parameters: Type.Object({
			action: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("curate"), Type.Literal("read")], { description: "sync (default), curate, or read." })),
			note: Type.Optional(Type.String({ description: "read only: the saved post's title, posts/<Title>.md, or Agentic/bookmarks/posts/<Title>.md." })),
			deep: Type.Optional(
				Type.Boolean({
					description: `sync only: opt-in paid sweep that reads the whole accessible list (up to the 800 most recent bookmarks) past saved pages, to recover gaps left by the safety cap, an error, deleted notes or never-synced history. Billed per resource read; use it only when Algorant requests or approves a deep sweep; cap/error advice alone is not permission for another paid sweep. Default false. The ${SAFETY_CAP}-note safety cap still applies; repeat deep:true if it stops a sweep.`,
				}),
			),
			notes: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "Saved post, e.g. Agentic/bookmarks/posts/<Title>.md (or posts/<Title>.md)." }),
						title: Type.Optional(Type.String({ description: `Final note title; the file is renamed and links are kept. No ${FORBIDDEN_TITLE_CHARS.join(" ")}.` })),
						summary: Type.Optional(Type.String({ description: "One-line summary; replaces the frontmatter summary and the lede." })),
						tags: Type.Optional(Type.Array(Type.String(), { description: `Final ordered tag list, primary topic first, no '#', at most ${MAX_TAGS_PER_NOTE}. Reuse existing vault tags.` })),
						status: Type.Optional(Type.Union([Type.Literal("inbox"), Type.Literal("active"), Type.Literal("archived")])),
						related: Type.Optional(Type.Array(Type.String(), { description: "Titles of other saved posts to link. Write only links Algorant approved." })),
					}),
					{ description: `curate only: up to ${MAX_NOTES_PER_CALL} notes; give at least one of title, summary, tags, status, related per note.` },
				),
			),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const action = params.action ?? "sync";
			const client = createObsidianClient({ exec: (command, args, options) => pi.exec(command, args, options), vault: loadMemoryConfig(ctx.cwd).vault });
			const layout = layoutFor();
			if (action === "read") {
				if (params.deep !== undefined) throw new Error('"deep" applies to action "sync" only.');
				if (params.notes !== undefined) throw new Error('"notes" applies to action "curate" only.');
				return result(await runRead({ client, layout, note: params.note, signal }));
			}
			if (params.note !== undefined) throw new Error('"note" applies to action "read" only.');
			if (action === "curate") {
				if (params.deep !== undefined) throw new Error('"deep" applies to action "sync" only.');
				return result(await runCurate({ client, layout, notes: params.notes, signal }));
			}
			if (params.notes !== undefined) throw new Error('"notes" applies to action "curate" only.');
			try {
				return result(await runSync({ client, exec: (command, args, options) => pi.exec(command, args, options), layout, deep: params.deep === true, signal }));
			} catch (error) {
				if (error instanceof XurlError) throw new Error(`X bookmarks sync failed (${error.kind}): ${error.message}`);
				throw error;
			}
		},
	});
}
