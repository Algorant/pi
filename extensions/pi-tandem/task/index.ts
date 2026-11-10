import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { sendAgentMessage } from "../../pi-agency/inbox/send";
import { buildAddArgs, tandemJson } from "../index";
import { boardOptions, loadBoards, reasonFor, type Board } from "./boards";
import {
	BOARD_THRESHOLD, QUESTIONS_VERSION, STANDARD_ACCEPTANCE, buildDuplicateContext, buildFileContext,
	parseSentence, pickDuplicates, priorityFor, type ClassifierContext, type Duplicate, type Kind,
} from "./questions";
import { closeSearch, openSearch } from "./search";
import { OVERLAY_OPTIONS, keyHint as hint, listTasks, messageOf, previewTask, renderFrame } from "./view";

const CLASSIFIER = { type: "classifier", provider: "typesafe", id: "jev-latest" } as const;

type Proposal = {
	ctx: ExtensionCommandContext; tui: TUI; theme: Theme; done: () => void; abort: AbortController;
	original: string; title: string; details: string; acceptance: string; boards: Board[];
	board?: Board; kind: Kind; boardExplicit: boolean; kindExplicit: boolean;
	probabilities: Record<string, number>; duplicates: Duplicate[]; duplicateIndex: number; phase: "preparing" | "review" | "board" | "kind" | "editor" | "preview" | "filing" | "receipt" | "error";
	busy: boolean; addUncertain?: boolean; notice?: string; error?: string; receipt?: { id: string; ceph: "sending" | "told" | "not-told" | "not-needed"; tellError?: string }; preview?: string[]; previewKind?: "duplicate" | "filed"; previewOffset: number; editor?: DraftEditor; choice?: number; filter?: string;
};
type Answers = Record<string, { choice: string; probabilities: Record<string, number> }>;

async function ask(ctx: ExtensionCommandContext, context: ClassifierContext, signal: AbortSignal): Promise<{ answers: Answers; model: string; latencyMs: number }> {
	const model = ctx.modelRegistry.findOfType(CLASSIFIER.type, CLASSIFIER.provider, CLASSIFIER.id);
	if (!model) throw new Error(`Classifier ${CLASSIFIER.provider}/${CLASSIFIER.id} is not available; check its credentials.`);
	const started = performance.now();
	const result = await ctx.modelRegistry.classify(model, context, { signal });
	const latencyMs = Math.round(performance.now() - started);
	if (result.stopReason !== "stop") throw new Error(result.errorMessage ?? `classifier stopped: ${result.stopReason}`);
	const answers: Answers = {};
	for (const id of Object.keys(context.questions)) {
		const answer = result.answers[id];
		if (answer?.type !== "choice") throw new Error(`Jev returned no choice for the ${id} question.`);
		answers[id] = { choice: answer.choice, probabilities: answer.probabilities };
	}
	return { answers, model: `${result.provider}/${result.model}`, latencyMs };
}
async function addTask(p: Proposal, signal: AbortSignal): Promise<string> {
	const board = p.board;
	if (!board) throw new Error("Cannot file without a selected board.");
	const data = await tandemJson(buildAddArgs({ action: "task", title: p.title, body: p.details || undefined, priority: priorityFor(p.kind), acceptance: [p.acceptance], kind: p.kind === "task" ? undefined : p.kind }), board.cwd, signal);
	if (typeof data?.id !== "string") throw new Error("tandem add succeeded but returned no Task id; check the board before retrying.");
	return data.id;
}
async function tellCeph(p: Proposal, id: string): Promise<{ told: boolean; error?: string }> {
	const ceph = p.board?.current ? undefined : p.board?.ceph;
	if (!ceph) return { told: false };
	try {
		const body = `filed ${id} on your board via /task`;
		await sendAgentMessage(p.ctx, { terminal: ceph.terminal, kind: "result", body });
		return { told: true };
	} catch (error) { return { told: false, error: messageOf(error) }; }
}
async function appendCapture(p: Proposal, event: Record<string, unknown>): Promise<void> {
	try {
		const board = p.board;
		if (!board) throw new Error("Cannot log a capture without a selected board.");
		const dir = join(getAgentDir(), "state");
		await mkdir(dir, { recursive: true });
		await appendFile(join(dir, "task-capture.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), cwd: p.ctx.cwd, questionsVersion: QUESTIONS_VERSION, title: p.title, board: board.name, kind: p.kind, ...event })}\n`, "utf8");
	} catch (error) { p.ctx.ui.notify(`/task capture log was not written: ${messageOf(error)}`, "warning"); }
}

class DraftEditor {
	private readonly inputs = [new Input({ prompt: "" }), new Input({ prompt: "" }), new Input({ prompt: "" })];
	private index = 0;
	constructor(p: Proposal) {
		this.inputs[0]!.setValue(p.title); this.inputs[1]!.setValue(p.details); this.inputs[2]!.setValue(p.acceptance);
		this.focus(0);
	}
	value(index: number): string { return this.inputs[index]!.getValue(); }
	focus(index: number): void { this.index = (index + this.inputs.length) % this.inputs.length; this.inputs.forEach((input, i) => input.focused = i === this.index); }
	next(): void { this.focus(this.index + 1); }
	input(data: string): void { this.inputs[this.index]!.handleInput(data); }
	render(width: number, theme: Theme): string[] {
		const labels = ["Title", "Details", "Acceptance"];
		return this.inputs.flatMap((input, i) => [theme.fg("mdLink", `${labels[i]}${i === this.index ? " · focused" : ""}`), ...input.render(width).map(line => theme.fg("text", line))]);
	}
}

class ProposalOverlay implements Component {
	constructor(private readonly p: Proposal, private readonly tui: TUI) {}
	handleInput(data: string): void {
		const p = this.p;
		if (p.phase === "receipt") {
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) p.done();
			else if (data === "o" && p.receipt) void this.openFiled();
			this.tui.requestRender(); return;
		}
		if (p.phase === "preview") {
			if (matchesKey(data, Key.escape)) { p.phase = p.previewKind === "filed" ? "receipt" : "review"; p.preview = undefined; }
			else if (matchesKey(data, Key.up)) p.previewOffset = Math.max(0, p.previewOffset - 1);
			else if (matchesKey(data, Key.down)) p.previewOffset++;
			this.tui.requestRender(); return;
		}
		if (p.phase === "editor") {
			if (matchesKey(data, Key.escape)) { p.editor = undefined; p.phase = "review"; }
			else if (matchesKey(data, "ctrl+s")) void this.saveEditor();
			else if (matchesKey(data, Key.tab)) p.editor?.next();
			else p.editor?.input(data);
			this.tui.requestRender(); return;
		}
		if (p.phase === "board" || p.phase === "kind") {
			const isBoard = p.phase === "board";
			const options = isBoard ? this.filteredBoards().map(board => board.name) : ["papercut", "task", "research"];
			if (matchesKey(data, Key.escape)) { p.phase = "review"; p.filter = undefined; p.choice = undefined; }
			else if (matchesKey(data, Key.up)) p.choice = Math.max(0, (p.choice ?? 0) - 1);
			else if (matchesKey(data, Key.down)) p.choice = Math.min(options.length - 1, (p.choice ?? 0) + 1);
			else if (matchesKey(data, Key.enter)) { const selected = options[p.choice ?? 0]; if (selected) void this.selectChoice(selected); }
			else if (isBoard && (data === "\x7f" || data === "\b" || matchesKey(data, "backspace"))) { p.filter = (p.filter ?? "").slice(0, -1); p.choice = 0; }
			else if (isBoard && data.length === 1 && !data.startsWith("\x1b")) { p.filter = `${p.filter ?? ""}${data}`; p.choice = 0; }
			this.tui.requestRender(); return;
		}
		if (p.phase === "preparing" || p.phase === "filing") {
			if (matchesKey(data, Key.escape) && p.phase === "preparing") { p.abort.abort(); p.done(); }
			this.tui.requestRender(); return;
		}
		if (matchesKey(data, Key.escape)) { p.abort.abort(); p.done(); return; }
		if (p.busy) return;
		// `f` files (task-469): Ctrl+Enter is taken by terminals (Ghostty toggles fullscreen). Only the review phase reaches here with filing allowed; Enter never files.
		if (data === "f") { if (p.phase === "review") void this.file(); return; }
		if (data === "b") { p.phase = "board"; p.filter = ""; p.choice = this.filteredBoards().findIndex(b => b === p.board); if (p.choice < 0) p.choice = 0; }
		else if (data === "k") { p.phase = "kind"; p.filter = undefined; p.choice = ["papercut", "task", "research"].indexOf(p.kind); }
		else if (data === "e") { p.phase = "editor"; p.editor = new DraftEditor(p); }
		else if (data === "o" && p.duplicates[p.duplicateIndex]) void this.openDuplicate();
		else if (matchesKey(data, Key.up) && p.duplicates.length) p.duplicateIndex = (p.duplicateIndex + p.duplicates.length - 1) % p.duplicates.length;
		else if (matchesKey(data, Key.down) && p.duplicates.length) p.duplicateIndex = (p.duplicateIndex + 1) % p.duplicates.length;
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const p = this.p; const theme = p.theme; const inner = Math.max(1, width - 4);
		const boardName = p.board?.name ?? "Board unavailable";
		const title = p.phase === "preparing" ? "Preparing proposal" : p.phase === "filing" ? "Filing proposal" : p.phase === "receipt" ? `Filed · ${boardName} / ${p.receipt?.id}` : p.phase === "preview" ? (p.previewKind === "filed" ? `Filed Task · ${boardName} / ${p.receipt?.id}` : `Possible duplicate · ${boardName} / ${p.duplicates[p.duplicateIndex]?.id ?? ""}`) : p.phase === "editor" ? "Edit proposal" : p.phase === "board" ? "Choose board" : p.phase === "kind" ? "Choose kind" : p.phase === "error" ? "Proposal not filed" : "Proposed Task";
		const lines: string[] = [""];
		const keyHint = (key: string, label: string) => hint(theme, key, label);
		if (p.phase === "preparing") lines.push(theme.fg("text", p.original), theme.fg("muted", "Choosing board and kind · checking possible duplicates"), "", theme.fg("dim", "Nothing filed. No Ceph told."), "", keyHint("Esc", "cancel preparation"));
		else if (p.phase === "review" || p.phase === "filing" || p.phase === "error" || p.phase === "receipt") {
			if (p.phase === "filing") lines.push(theme.fg("warning", "Submitting confirmed proposal"));
			const suggestion = p.boards.reduce((best, board) => (p.probabilities[board.name] ?? 0) > (p.probabilities[best?.name ?? ""] ?? 0) ? board : best, undefined as Board | undefined);
			const why = p.board ? (p.board.current ? "This session's board" : reasonFor(p.board, p.original)) : "Board discovery failed";
			const confidence = p.boardExplicit ? `Original suggestion: ${suggestion?.name ?? "current board"} (${Math.round(Math.max(0, ...Object.values(p.probabilities)) * 100)}%) · board selected by you` : `${Math.round((p.board ? p.probabilities[p.board.name] ?? 1 : 0) * 100)}% route confidence`;
			for (const [label, value] of [["Title", p.title], ["Board", boardName], ["Why", why], ["Kind", p.kind], ["Jev", confidence], ["Details", p.details || "(none)"], ["Acceptance", p.acceptance]]) lines.push(...this.row(label, value, inner));
			if (p.duplicates.length) {
				const selected = p.duplicates[p.duplicateIndex]!;
				lines.push(theme.fg("warning", `Possible duplicates · ${boardName} (${p.duplicateIndex + 1}/${p.duplicates.length})`));
				p.duplicates.forEach((duplicate, index) => lines.push(`${index === p.duplicateIndex ? theme.fg("accent", "› ") : "  "}${theme.fg("text", `${duplicate.id} · ${duplicate.title}`)} ${theme.fg("dim", `· ${Math.round(duplicate.probability * 100)}%`)}`));
				lines.push(`  ${keyHint("↑↓", "select")}    ${keyHint("o", `open ${selected.id}`)}    ${keyHint("f", "files anyway")}`);
			}
			if (p.notice) lines.push(theme.fg("warning", p.notice));
			if (p.error) lines.push(theme.fg("error", p.error));
			if (p.phase === "receipt") {
				const ceph = p.receipt?.ceph ?? "sending";
				const cephText = ceph === "sending" ? "Ceph · sending" : ceph === "told" ? "Ceph · told" : ceph === "not-told" ? `Ceph · not told${p.receipt?.tellError ? `: ${p.receipt.tellError}` : ""}` : "Ceph · not needed";
				lines.push(theme.fg(ceph === "told" ? "success" : ceph === "not-told" ? "warning" : "dim", cephText), "A Task now exists. Dismissing this receipt does not cancel it.", "", `${keyHint("o", "open filed Task")}    ${keyHint("Enter / Esc", "dismiss")}`);
			} else if (p.phase === "filing") lines.push("", theme.fg("dim", "The confirmed add is in progress; no second filing."));
			else if (p.phase === "error") lines.push("", theme.fg("error", p.error ?? "Checks failed · filing disabled"), p.addUncertain ? "Add outcome uncertain · no retry in this proposal" : "Checks failed · filing disabled", "", `${keyHint("b", "board")}    ${keyHint("k", "kind")}    ${keyHint("e", "edit")}    ${keyHint("Esc", "cancel proposal")}`);
			else lines.push("", `  ${keyHint("f", "File Task")}`, `  ${keyHint("b", "board")}    ${keyHint("k", "kind")}    ${keyHint("e", "edit")}    ${keyHint("o", "open duplicate")}    ${keyHint("Esc", "cancel proposal")}`);
		} else if (p.phase === "board" || p.phase === "kind") {
			const options = p.phase === "board" ? this.filteredBoards().map(b => `${b.name} · ${b.oneLiner}${b.ceph ? ` · Ceph ${b.ceph.name}` : " · this session"}`) : ["papercut", "task", "research"];
			lines.push(theme.fg("warning", "Nothing filed"), ...(p.phase === "board" ? [`${theme.fg("mdLink", "Filter:")} ${theme.fg("text", p.filter ?? "")}`] : []));
			for (const [index, value] of options.entries()) lines.push(`${index === (p.choice ?? 0) ? theme.fg("accent", "› ") : "  "}${theme.fg("text", value)}`);
			lines.push("", p.phase === "board" ? `${keyHint("Type", "filter")}    ${keyHint("Backspace", "erase")}    ${keyHint("↑↓", "choose")}    ${keyHint("Enter", "use")}    ${keyHint("Esc", "back")}` : `${keyHint("↑↓", "choose")}    ${keyHint("Enter", "use")}    ${keyHint("Esc", "back")}`);
		} else if (p.phase === "editor") lines.push(theme.fg("warning", "Nothing filed"), ...(p.editor?.render(inner, theme) ?? []), "", `${keyHint("Tab", "next field")}    ${keyHint("Ctrl+S", "save to draft")}    ${keyHint("Esc", "discard edits / back")}`);
		else if (p.phase === "preview") {
			const body = (p.preview ?? ["Loading existing Task…"]).flatMap(line => wrapTextWithAnsi(theme.fg("text", line), inner));
			const page = Math.max(1, p.tui.terminal.rows - 8);
			p.previewOffset = Math.min(p.previewOffset, Math.max(0, body.length - page));
			lines.push(...body.slice(p.previewOffset, p.previewOffset + page), "", `${keyHint("↑↓", "scroll")}    ${keyHint("Esc", "back")}`);
		}
		lines.push("");
		const status = p.phase === "review" ? "NOT FILED" : p.phase === "receipt" ? "Filed" : p.phase === "filing" ? "Filing" : p.phase === "preparing" ? "Preparing" : p.phase === "error" ? (p.addUncertain ? "Outcome uncertain" : "Check error") : p.phase === "preview" && p.previewKind === "filed" ? "Filed · read only" : p.phase === "preview" ? "Read only · not filed" : "Not filed";
		return renderFrame(theme, title, status, p.phase === "review" ? "accent" : p.phase === "receipt" ? "success" : p.phase === "error" ? "warning" : "text", lines, width);
	}
	invalidate(): void {}
	private choice?: number;
	private filter?: string;
	private row(label: string, value: string, width: number): string[] { const wrapped = wrapTextWithAnsi(this.p.theme.fg("text", value), Math.max(1, width - 14)); return [`  ${this.p.theme.fg("mdLink", label.padEnd(10))}  ${wrapped[0] ?? ""}`, ...wrapped.slice(1).map(x => `  ${" ".repeat(12)}${x}`)]; }
	private filteredBoards(): Board[] { const filter = this.p.filter?.toLowerCase() ?? ""; return this.p.boards.filter(board => `${board.name} ${board.oneLiner} ${board.ceph?.name ?? ""}`.toLowerCase().includes(filter)); }
	private async saveEditor(): Promise<void> {
		const p = this.p; if (!p.editor) return;
		const title = p.editor.value(0).trim(); const acceptance = p.editor.value(2).trim();
		if (!title || !acceptance) { p.notice = "Title and acceptance must not be empty."; return; }
		p.title = title; p.details = p.editor.value(1).trim(); p.acceptance = acceptance; p.editor = undefined; p.phase = "review"; p.notice = "Draft saved; refreshing board/kind and duplicate checks…";
		await refresh(p); p.notice = "Draft saved to proposal."; p.tui.requestRender();
	}
	private async selectChoice(value: string): Promise<void> {
		const p = this.p;
		if (p.phase === "board") { p.board = p.boards.find(b => b.name === value)!; p.boardExplicit = true; }
		else { p.kind = value as Kind; p.kindExplicit = true; }
		p.filter = undefined; p.choice = undefined; p.phase = "review"; p.notice = "Choice saved to proposal; refreshing checks…"; p.tui.requestRender(); await refresh(p); p.notice = undefined; p.tui.requestRender();
	}
	private async openDuplicate(): Promise<void> { const p = this.p; const duplicate = p.duplicates[p.duplicateIndex]; if (!duplicate || !p.board) return; p.phase = "preview"; p.previewKind = "duplicate"; p.previewOffset = 0; p.preview = undefined; p.tui.requestRender(); try { p.preview = await previewTask(duplicate.id, p.board.cwd, p.abort.signal); } catch (e) { p.preview = [`Preview failed: ${messageOf(e)}`]; } p.tui.requestRender(); }
	private async openFiled(): Promise<void> { const p = this.p; if (!p.receipt || !p.board) return; p.phase = "preview"; p.previewKind = "filed"; p.previewOffset = 0; p.preview = undefined; p.tui.requestRender(); try { p.preview = await previewTask(p.receipt.id, p.board.cwd, p.abort.signal); } catch (e) { p.preview = [`Preview failed: ${messageOf(e)}`]; } p.tui.requestRender(); }
	private async file(): Promise<void> {
		const p = this.p; if (p.phase !== "review" || p.busy || p.addUncertain || p.abort.signal.aborted) return;
		p.busy = true; p.phase = "filing"; p.tui.requestRender();
		try {
			const id = await addTask(p, p.abort.signal);
			p.receipt = { id, ceph: p.board?.ceph && !p.board.current ? "sending" : "not-needed" };
			p.phase = "receipt"; p.tui.requestRender();
			const notice = await tellCeph(p, id); p.receipt.ceph = notice.told ? "told" : notice.error ? "not-told" : "not-needed"; p.receipt.tellError = notice.error;
			await appendCapture(p, { choice: "filed", filedId: id, cephMessage: notice.told, cephError: notice.error });
		} catch (error) {
			if (!p.abort.signal.aborted) { p.addUncertain = true; p.error = `Add outcome uncertain: ${messageOf(error)}. Check the board before any new proposal.`; p.phase = "error"; await appendCapture(p, { choice: "uncertain", error: messageOf(error) }); }
		} finally { p.busy = false; p.tui.requestRender(); }
	}
}

async function refresh(p: Proposal): Promise<void> {
	const signal = p.abort.signal;
	p.phase = "preparing"; p.tui.requestRender();
	const parsed = parseSentence(p.title);
	const options = boardOptions(p.boards);
	const context = buildFileContext(parsed.title, options, !parsed.kind);
	try {
		if (Object.keys(context.questions).length) {
			const { answers } = await ask(p.ctx, context, signal);
			if (!p.boardExplicit && answers.workspace) {
				const byKey = new Map(options.map((option, index) => [option.key, p.boards[index]!]));
				for (const [key, probability] of Object.entries(answers.workspace.probabilities)) { const board = byKey.get(key); if (board) p.probabilities[board.name] = probability; }
				const picked = byKey.get(answers.workspace.choice); if (picked && (picked.current || (answers.workspace.probabilities[answers.workspace.choice] ?? 0) >= BOARD_THRESHOLD)) p.board = picked;
			}
			if (!p.kindExplicit && !parsed.kind && answers.kind) p.kind = answers.kind.choice as Kind;
		}
		if (parsed.kind && !p.kindExplicit) p.kind = parsed.kind;
		const targetBoard = p.board;
		if (!targetBoard) throw new Error("No selected board is available for duplicate checks.");
		const tasks = await listTasks(targetBoard.cwd, signal);
		p.duplicates = [];
		if (tasks.length) {
			const { answers } = await ask(p.ctx, buildDuplicateContext(parsed.title, tasks), signal);
			p.duplicates = pickDuplicates(answers.duplicate.probabilities, tasks);
		}
		if (!signal.aborted) { p.title = parsed.title; p.phase = p.addUncertain ? "error" : "review"; if (!p.addUncertain) p.error = undefined; p.duplicateIndex = Math.min(p.duplicateIndex, Math.max(0, p.duplicates.length - 1)); }
	} catch (error) {
		if (!signal.aborted) { p.error = `Checks failed: ${messageOf(error)}`; p.phase = "error"; }
	}
	p.tui.requestRender();
}

let current: Proposal | undefined;
export function registerTaskCommand(pi: ExtensionAPI): void {
	pi.on("session_shutdown", () => { current?.abort.abort(); current?.done(); current = undefined; closeSearch(); });
	pi.registerCommand("task", {
		description: "Search active Tasks on local boards (/task) or propose one for review (/task <sentence>)",
		handler: async (args, ctx) => {
			const sentence = args.trim();
			if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("/task needs the interactive Pi UI.", "warning"); return; }
			if (!sentence && !current) { await openSearch(ctx); return; }
			const parsed = parseSentence(sentence); if (sentence && !parsed.title) { ctx.ui.notify("Usage: /task (search) or /task <sentence> (propose)", "warning"); return; }
			if (current) { current.notice = current.phase === "filing" ? "Filing is in progress; wait for the receipt." : "Finish or cancel this proposal first; its draft is preserved."; current.tui.requestRender(); return; }
			const p = {} as Proposal;
			Object.assign(p, { ctx, original: sentence, title: parsed.title, details: "", acceptance: STANDARD_ACCEPTANCE, boards: [], board: undefined, kind: parsed.kind ?? "task", boardExplicit: false, kindExplicit: Boolean(parsed.kind), probabilities: {}, duplicates: [], duplicateIndex: 0, phase: "preparing", busy: false, previewOffset: 0, abort: new AbortController() });
			current = p;
			const overlay = ctx.ui.custom<void>((tui: TUI, theme: Theme, _bindings: unknown, done: () => void) => {
				p.tui = tui; p.theme = theme; p.done = () => { if (current === p) current = undefined; done(); };
				return new ProposalOverlay(p, tui);
			}, OVERLAY_OPTIONS);
			void (async () => {
				try { const loaded = await loadBoards(ctx.cwd, p.abort.signal); p.boards = loaded.boards; p.board = loaded.boards[0]!; if (loaded.missing.length) p.notice = `Add a description: front-matter line to ${loaded.missing.map(f => f.replace(homedir(), "~")).join(", ")}.`; await refresh(p); }
				catch (error) { if (!p.abort.signal.aborted) { p.error = messageOf(error); p.phase = "error"; p.tui.requestRender(); } }
			})();
			await overlay;
		},
	});
}
