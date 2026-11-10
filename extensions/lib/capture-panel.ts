/**
 * Docked capture panel shared by `/task` and `/mem`.
 *
 * The session object owns the state; the component only renders it and turns
 * keys into session actions. The panel mounts as a shared widget-layout section
 * below the editor, the same way the ask_me dock mounts above it.
 *
 * A command supplies the chip, the title, the option rows (a choice cycled with
 * the arrow keys, or an editable text line), the possible duplicates, and the
 * hook that performs the capture. It never writes anything itself.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	registerWidgetSection,
	unregisterWidgetSection,
	type WidgetLayoutContext,
} from "../pi-ui/widget-layout";

/** A choice cycled with ←→. `compact` shows only the selected option and its position. */
export type ChoiceRow = {
	kind: "choice";
	id: string;
	label: string;
	options: string[];
	index: number;
	compact?: boolean;
	/** Dim text after the options, evaluated at render time. */
	note?: () => string;
};

/** A single editable line. Read-only rows are shown dim and ignore typing. */
export type TextRow = { kind: "text"; id: string; label: string; value: string; editable: boolean };

export type Row = ChoiceRow | TextRow;

export type Duplicate = { id: string; detail: string; title?: string };

export type Outcome<T> = { choice: "cancelled" } | { choice: "confirmed"; result: T };

export type SessionOptions<T> = {
	/** Command chip, for example "/task". */
	chip: string;
	title: string;
	loadingText: string;
	/** Verb for the confirm key, the busy line and failure label: "file" / "filing" / "Filing". */
	action: { verb: string; busy: string; failed: string };
	/** Hint for the `o` key, for example "open top duplicate". */
	previewHint: string;
	hooks: {
		confirm(session: CaptureSession<T>): Promise<T>;
		preview(id: string): Promise<string[]>;
		/** The duplicate `o` previews; defaults to the first one. */
		previewTarget?(session: CaptureSession<T>): string | undefined;
		/** A choice row changed by the keyboard. */
		choiceChanged?(session: CaptureSession<T>, row: ChoiceRow): void;
	};
};

export class CaptureSession<T> {
	phase: "loading" | "ready" | "blocked" = "loading";
	rows: Row[] = [];
	focus = 0;
	duplicates: Duplicate[] = [];
	/** Why the panel cannot continue (no workspace, missing CLI, vault error). */
	fatal?: string;
	/** Extra warning lines, evaluated at render time. */
	warnings: () => string[] = () => [];
	confirmError?: string;
	busy = false;
	preview?: { id: string; lines?: string[]; error?: string };
	settled = false;
	readonly done: Promise<Outcome<T>>;
	private resolve!: (outcome: Outcome<T>) => void;
	private listeners = new Set<() => void>();

	constructor(
		/** Mutable: a command may replace it once the real title is known. */
		public title: string,
		private readonly options: Omit<SessionOptions<T>, "title">,
	) {
		this.done = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	get chip(): string {
		return this.options.chip;
	}
	get loadingText(): string {
		return this.options.loadingText;
	}
	get action(): SessionOptions<T>["action"] {
		return this.options.action;
	}
	get previewHint(): string {
		return this.options.previewHint;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	changed(): void {
		for (const listener of this.listeners) listener();
	}

	settle(outcome: Outcome<T>): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(outcome);
		this.changed();
	}

	choice(id: string): ChoiceRow {
		const row = this.rows.find((candidate) => candidate.id === id);
		if (row?.kind !== "choice") throw new Error(`No choice row ${id}`);
		return row;
	}

	text(id: string): TextRow {
		const row = this.rows.find((candidate) => candidate.id === id);
		if (row?.kind !== "text") throw new Error(`No text row ${id}`);
		return row;
	}

	/** The selected option of a choice row. */
	selected(id: string): string {
		const row = this.choice(id);
		return row.options[row.index];
	}

	setChoice(id: string, index: number): void {
		this.choice(id).index = index;
		this.changed();
	}

	cycle(step: 1 | -1): void {
		const row = this.rows[this.focus];
		if (row?.kind !== "choice") return;
		row.index = (row.index + step + row.options.length) % row.options.length;
		this.options.hooks.choiceChanged?.(this, row);
		this.changed();
	}

	moveFocus(step: 1 | -1): void {
		this.focus = (this.focus + step + this.rows.length) % this.rows.length;
		this.changed();
	}

	async confirm(): Promise<void> {
		if (this.busy || this.settled) return;
		this.busy = true;
		this.confirmError = undefined;
		this.changed();
		try {
			const result = await this.options.hooks.confirm(this);
			this.settle({ choice: "confirmed", result });
		} catch (error) {
			this.busy = false;
			this.confirmError = error instanceof Error ? error.message : String(error);
			this.changed();
		}
	}

	/** The duplicate `o` previews, if any. */
	previewId(): string | undefined {
		return this.options.hooks.previewTarget?.(this) ?? this.duplicates[0]?.id;
	}

	async togglePreview(): Promise<void> {
		const id = this.previewId();
		if (!id) return;
		if (this.preview) {
			this.preview = undefined;
			this.changed();
			return;
		}
		const shown = { id } as NonNullable<CaptureSession<T>["preview"]>;
		this.preview = shown;
		this.changed();
		try {
			shown.lines = await this.options.hooks.preview(id);
		} catch (error) {
			shown.error = error instanceof Error ? error.message : String(error);
		}
		this.changed();
	}
}

export type CapturePanelComponent = Component & Focusable & { dispose(): void };

export function createCapturePanel<T>(tui: TUI, theme: Theme, session: CaptureSession<T>): CapturePanelComponent {
	const fg = (tone: string, value: string) => theme.fg(tone as never, value);
	const bold = (value: string) => (typeof theme.bold === "function" ? theme.bold(value) : value);
	let focused = false;
	const unsubscribe = session.onChange(() => tui.requestRender());
	const inputs = new Map<string, Input>();

	function inputFor(row: TextRow): Input {
		let input = inputs.get(row.id);
		if (!input) {
			input = new Input({ prompt: "" });
			inputs.set(row.id, input);
		}
		// The session owns the value; commands may reset it (for example when the scope changes).
		if (input.getValue() !== row.value) {
			input.setValue(row.value);
			input.handleInput("\x05"); // Ctrl+E: cursor to the end, where editing continues
		}
		return input;
	}

	function block(lines: string[], text: string, width: number, style: (value: string) => string, indent = " "): void {
		for (const line of wrapTextWithAnsi(text, Math.max(4, width - visibleWidth(indent)))) lines.push(indent + style(line));
	}

	function labelWidth(): number {
		return Math.max(...session.rows.map((row) => visibleWidth(row.label)));
	}

	function rowLine(row: Row, index: number, width: number): string {
		const multi = session.rows.length > 1;
		const active = multi && index === session.focus;
		const marker = multi ? (active ? fg("mdLink", "›") : " ") : " ";
		const label = fg(active ? "text" : "muted", row.label.padEnd(labelWidth()));
		const prefix = `${marker}${label}  `;
		if (row.kind === "choice") {
			if (row.compact) {
				const position = row.options.length > 1 ? fg("dim", `  (${row.index + 1}/${row.options.length})`) : "";
				return `${prefix}${bold(fg("mdLink", `[${row.options[row.index]}]`))}${position}${row.note ? `  ${fg("dim", row.note())}` : ""}`;
			}
			const choices = row.options
				.map((option, i) => (i === row.index ? bold(fg("mdLink", `[${option}]`)) : fg("dim", option)))
				.join("  ");
			return `${prefix}${choices}${row.note ? `  ${fg("dim", row.note())}` : ""}`;
		}
		if (!row.editable) return `${prefix}${fg("dim", row.value)}`;
		const input = inputFor(row);
		input.focused = focused && active;
		const room = Math.max(4, width - visibleWidth(prefix));
		return `${prefix}${input.render(room)[0] ?? ""}`;
	}

	function hints(): string {
		const verb = session.action.verb;
		if (session.busy) return `${session.action.busy}…`;
		if (session.phase === "blocked") return "esc close";
		if (session.phase === "loading") return "esc cancel";
		const row = session.rows[session.focus];
		const typing = row?.kind === "text" && row.editable;
		const parts = [`enter ${verb}`];
		if (session.rows.length > 1) parts.push("↑↓ row");
		if (row?.kind === "choice") parts.push(session.rows.length > 1 ? "←→ change" : `←→ ${row.label}`);
		if (typing) parts.push("type to edit");
		if (session.preview) {
			if (!typing) parts.push("o close preview");
			parts.push("esc close preview");
			return parts.join(" · ");
		}
		if (!typing && session.previewId()) parts.push(`o ${session.previewHint}`);
		parts.push("esc cancel");
		return parts.join(" · ");
	}

	function render(width: number): string[] {
		if (session.settled) return [];
		const body = Math.max(8, width);
		const chip = fg("mdLink", ` ${session.chip} `);
		const lines: string[] = [fg("border", "─") + chip + fg("border", "─".repeat(Math.max(1, body - 2 - visibleWidth(chip))))];
		const title: string[] = [];
		block(title, session.title, body, (value) => bold(fg("text", value)));
		lines.push(...title.slice(0, 3));
		lines.push("");

		if (session.phase === "blocked") {
			block(lines, session.fatal ?? "Cannot capture here.", body, (value) => fg("error", value));
		} else if (session.phase === "loading") {
			lines.push(fg("dim", ` ${session.loadingText}`));
		} else {
			lines.push(fg("muted", " Possible duplicates"));
			if (session.duplicates.length === 0) lines.push(fg("dim", "   none likely"));
			for (const duplicate of session.duplicates) {
				const title = duplicate.title ? ` ${fg("dim", "·")} ${fg("text", duplicate.title)}` : "";
				lines.push(`   ${fg("mdLink", duplicate.id)} ${fg("dim", `· ${duplicate.detail}`)}${title}`);
			}
			if (session.preview) {
				lines.push("");
				if (session.preview.error) block(lines, session.preview.error, body, (value) => fg("error", value), "   ");
				else if (!session.preview.lines) lines.push(fg("dim", "   loading…"));
				else for (const line of session.preview.lines) block(lines, line, body, (value) => fg("muted", value), "   ");
			}
			lines.push("");
			session.rows.forEach((row, index) => lines.push(rowLine(row, index, body)));
			const warnings = session.warnings();
			if (warnings.length > 0) {
				lines.push("");
				for (const warning of warnings) block(lines, warning, body, (value) => fg("warning", value));
			}
			if (session.confirmError) {
				lines.push("");
				block(lines, `${session.action.failed} failed: ${session.confirmError}`, body, (value) => fg("error", value));
			}
		}

		lines.push("");
		block(lines, hints(), body, (value) => fg("dim", value));
		return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	function handleInput(data: string): void {
		if (session.settled || session.busy) return;
		if (matchesKey(data, Key.escape)) {
			if (session.preview) {
				session.preview = undefined;
				session.changed();
			} else {
				session.settle({ choice: "cancelled" });
			}
			return;
		}
		if (session.phase !== "ready") return;
		const row = session.rows[session.focus];
		const typing = row?.kind === "text" && row.editable;
		if (matchesKey(data, Key.enter)) {
			void session.confirm();
		} else if (matchesKey(data, Key.up)) {
			if (session.rows.length > 1) session.moveFocus(-1);
			else session.cycle(-1);
		} else if (matchesKey(data, Key.down)) {
			if (session.rows.length > 1) session.moveFocus(1);
			else session.cycle(1);
		} else if (typing) {
			const input = inputFor(row);
			input.handleInput(data);
			row.value = input.getValue();
			session.changed();
		} else if (data === "o") {
			void session.togglePreview();
		} else if (matchesKey(data, Key.left)) {
			session.cycle(-1);
		} else if (matchesKey(data, Key.right)) {
			session.cycle(1);
		}
	}

	return {
		get focused() {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
		},
		render,
		handleInput,
		invalidate() {},
		dispose() {
			unsubscribe();
			// Reload or teardown must never leave the capture waiting for a key.
			session.settle({ choice: "cancelled" });
		},
	};
}

/** Mount the panel and return an unmount function. Throws when it cannot mount. */
export function mountCapturePanel<T>(ui: WidgetLayoutContext["ui"], session: CaptureSession<T>): () => void {
	const layoutCtx = { ui };
	const id = `capture-panel:${session.chip}`;
	let component: CapturePanelComponent | undefined;
	registerWidgetSection(layoutCtx, {
		id,
		order: 300,
		placement: "belowEditor",
		visible: () => !session.settled,
		render: ({ width }) => component?.render(width) ?? [],
		interactive: ({ tui, theme, focus }) => {
			component = createCapturePanel(tui, theme, session);
			focus();
			return component;
		},
	});
	return () => unregisterWidgetSection(layoutCtx, id);
}
