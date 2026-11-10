import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ObsidianClient } from "../../lib/obsidian-cli.ts";
import { listItems, readScalar } from "./curate.ts";
import { resolvePostNote, type Layout } from "./paths.ts";

// Read: the exact text of one saved post note, named by title or path, through the shared Obsidian client.
// Read-only toward the vault and never calls X.

export type ReadOutcome = { text: string; details: Record<string, unknown> };

export async function runRead(options: { client: ObsidianClient; layout: Layout; note: unknown; signal?: AbortSignal }): Promise<ReadOutcome> {
	const { client, layout, signal } = options;
	if (options.note === undefined) throw new Error('action "read" needs note: a saved post title, posts/<Title>.md, or the full vault path.');
	const path = resolvePostNote(options.note, layout);
	const text = await client.read(path, signal);

	const lines = text.split("\n");
	const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
	const fm = end > 0 ? lines.slice(1, end) : [];
	const handle = /\[\[@([A-Za-z0-9_]+)\]\]/.exec(readScalar(fm, "author") ?? "")?.[1];

	const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	const output = truncation.truncated
		? `${truncation.content}\n\n[Note truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}) shown; the rest of ${path} was not returned.]`
		: text;
	return {
		text: output,
		details: {
			action: "read",
			path,
			handle,
			status: readScalar(fm, "status"),
			tags: listItems(fm, "tags").filter(Boolean),
			chars: Array.from(text).length,
			lines: lines.length,
			truncation: truncation.truncated ? truncation : undefined,
		},
	};
}
