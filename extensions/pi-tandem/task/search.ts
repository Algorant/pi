/**
 * `/task` with no argument: a read-only search over the active Tasks of every
 * discovered local board. Every hit keeps its own Board, and its detail is read
 * from that board's cwd, so equal Task IDs on different boards never resolve
 * against the caller's board. No classifier call, no composer text, no writes.
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { discoverBoards, type Board } from "./boards";
import type { TaskRef } from "./questions";
import { OVERLAY_OPTIONS, keyHint, listTasks, messageOf, previewTask, renderFrame } from "./view";

type Hit = { board: Board; id: string; title: string };
type BoardTasks = { board: Board; tasks?: TaskRef[]; error?: string };
type Preview = { hit: Hit; lines?: string[]; offset: number };
type Search = {
	tui: TUI; theme: Theme; done: () => void; abort: AbortController;
	phase: "discovering" | "results" | "error"; error?: string;
	boards: BoardTasks[]; filter: string; choice: number; preview?: Preview;
};

let open: Search | undefined;

/** Session teardown: abort pending reads and close the overlay. */
export function closeSearch(): void { open?.abort.abort(); open?.done(); open = undefined; }

/** Every term must appear in "board/id board id title"; so `home/task-5`, `task-5` or title words all match. */
function hits(s: Search): Hit[] {
	const terms = s.filter.toLowerCase().split(/\s+/).filter(Boolean);
	return s.boards.flatMap(({ board, tasks }) => (tasks ?? []).map(task => ({ board, id: task.id, title: task.title })))
		.filter(hit => { const text = `${hit.board.name}/${hit.id} ${hit.board.name} ${hit.id} ${hit.title}`.toLowerCase(); return terms.every(term => text.includes(term)); });
}

class SearchOverlay implements Component {
	constructor(private readonly s: Search) {}
	handleInput(data: string): void {
		const s = this.s;
		if (s.preview) {
			if (matchesKey(data, Key.escape)) s.preview = undefined;
			else if (matchesKey(data, Key.up)) s.preview.offset = Math.max(0, s.preview.offset - 1);
			else if (matchesKey(data, Key.down)) s.preview.offset++;
			s.tui.requestRender(); return;
		}
		if (matchesKey(data, Key.escape)) { closeSearch(); return; }
		if (s.phase !== "results") return;
		const count = hits(s).length;
		if (matchesKey(data, Key.up)) s.choice = Math.max(0, s.choice - 1);
		else if (matchesKey(data, Key.down)) s.choice = Math.min(Math.max(0, count - 1), s.choice + 1);
		else if (matchesKey(data, Key.enter)) { const hit = hits(s)[s.choice]; if (hit) void this.openPreview(hit); }
		else if (data === "\x7f" || data === "\b" || matchesKey(data, "backspace")) { s.filter = s.filter.slice(0, -1); s.choice = 0; }
		else if (data && !data.startsWith("\x1b") && !/[\x00-\x1f\x7f]/.test(data)) { s.filter += data; s.choice = 0; }
		s.tui.requestRender();
	}
	render(width: number): string[] {
		const s = this.s; const theme = s.theme; const inner = Math.max(1, width - 4);
		const lines: string[] = [""];
		// The overlay is capped at 90% with a one-row margin; reserve its frame,
		// wrapped headers and hints before choosing the visible result/preview rows.
		const bodyRows = Math.max(1, Math.min(Math.floor(s.tui.terminal.rows * 0.9), s.tui.terminal.rows - 2) - 2);
		let title = "Search Tasks";
		if (s.preview) {
			const { hit } = s.preview;
			title = `${hit.board.name} / ${hit.id}`;
			const body = [theme.fg("muted", `Board ${hit.board.name}${hit.board.current ? " (this session)" : ""} · ${hit.board.cwd}`), "", ...(s.preview.lines ?? ["Loading Task…"]).map(line => theme.fg("text", line))].flatMap(line => wrapTextWithAnsi(line, inner));
			const hints = wrapTextWithAnsi(`${keyHint(theme, "↑↓", "scroll")}    ${keyHint(theme, "Esc", "back to results")}`, inner);
			const rows = Math.max(1, bodyRows - lines.length - hints.length - 2);
			s.preview.offset = Math.min(s.preview.offset, Math.max(0, body.length - rows));
			lines.push(...body.slice(s.preview.offset, s.preview.offset + rows), "", ...hints);
		} else if (s.phase === "discovering") lines.push(theme.fg("muted", "Discovering local boards…"), "", keyHint(theme, "Esc", "close"));
		else if (s.phase === "error") lines.push(theme.fg("error", s.error ?? "Board discovery failed."), "", keyHint(theme, "Esc", "close"));
		else {
			const loading = s.boards.filter(b => !b.tasks && !b.error).length;
			const total = s.boards.reduce((sum, b) => sum + (b.tasks?.length ?? 0), 0);
			const found = hits(s);
			s.choice = Math.min(s.choice, Math.max(0, found.length - 1));
			lines.push(...wrapTextWithAnsi(theme.fg("muted", `Scope: active Tasks on ${s.boards.length} local board${s.boards.length === 1 ? "" : "s"} (${s.boards.map(b => b.board.name).join(", ")})${loading ? ` · ${loading} loading` : ""}`), inner));
			for (const failed of s.boards.filter(b => b.error)) lines.push(...wrapTextWithAnsi(theme.fg("warning", `${failed.board.name}: not listed: ${failed.error}`), inner));
			lines.push(`${theme.fg("mdLink", "Filter:")} ${theme.fg("text", s.filter)}${theme.fg("dim", `  ${found.length} of ${total}`)}`, "");
			const hints = wrapTextWithAnsi(`${keyHint(theme, "Type", "filter")}    ${keyHint(theme, "Backspace", "erase")}    ${keyHint(theme, "↑↓", "choose")}    ${keyHint(theme, "Enter", "open read-only")}    ${keyHint(theme, "Esc", "close")}`, inner);
			const page = Math.max(1, bodyRows - lines.length - hints.length - 2);
			const start = Math.max(0, Math.min(s.choice - Math.floor(page / 2), found.length - page));
			for (const [offset, hit] of found.slice(start, start + page).entries()) {
				const selected = start + offset === s.choice;
				lines.push(truncateToWidth(`${selected ? theme.fg("accent", "› ") : "  "}${theme.fg("accent", hit.board.name)}${theme.fg("dim", " / ")}${theme.fg("muted", hit.id)}${theme.fg("dim", " · ")}${theme.fg("text", hit.title)}`, inner));
			}
			if (!found.length) lines.push(theme.fg("dim", loading ? "Loading Tasks…" : "No matching active Task."));
			lines.push("", ...hints);
		}
		lines.push("");
		return renderFrame(theme, title, s.phase === "error" ? "Discovery error" : "Read only", s.phase === "error" ? "warning" : "text", lines, width);
	}
	invalidate(): void {}
	private async openPreview(hit: Hit): Promise<void> {
		const s = this.s; const preview: Preview = { hit, offset: 0 };
		s.preview = preview; s.tui.requestRender();
		let lines: string[];
		try { lines = await previewTask(hit.id, hit.board.cwd, s.abort.signal); } catch (error) { lines = [`Preview failed: ${messageOf(error)}`]; }
		preview.lines = lines; s.tui.requestRender();
	}
}

export async function openSearch(ctx: ExtensionCommandContext): Promise<void> {
	if (open) { ctx.ui.notify("Task search is already open.", "warning"); return; }
	const s = { phase: "discovering", boards: [], filter: "", choice: 0, abort: new AbortController() } as unknown as Search;
	open = s;
	const overlay = ctx.ui.custom<void>((tui: TUI, theme: Theme, _bindings: unknown, done: () => void) => {
		s.tui = tui; s.theme = theme; s.done = () => { if (open === s) open = undefined; done(); };
		return new SearchOverlay(s);
	}, OVERLAY_OPTIONS);
	void (async () => {
		const signal = s.abort.signal;
		try { s.boards = (await discoverBoards(ctx.cwd, signal)).map(board => ({ board })); }
		catch (error) { if (!signal.aborted) { s.error = messageOf(error); s.phase = "error"; s.tui.requestRender(); } return; }
		s.phase = "results"; s.tui.requestRender();
		await Promise.all(s.boards.map(async entry => {
			try { entry.tasks = await listTasks(entry.board.cwd, signal); } catch (error) { entry.error = messageOf(error); }
			if (!signal.aborted) s.tui.requestRender();
		}));
	})();
	await overlay;
}
