/** What the /task capture and search overlays share: the frame, key hints and read-only Tandem reads. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { ToolBoxComponent } from "../../pi-ui/tool-ui/core/card";
import type { ToolUiBoxModel } from "../../pi-ui/tool-ui/core/types";
import { buildReadArgs, tandemJson } from "../index";
import type { TaskRef } from "./questions";

export const OVERLAY_OPTIONS = { overlay: true, overlayOptions: { anchor: "center" as const, width: "80%" as const, minWidth: 48, maxHeight: "90%" as const, margin: 1 } };

export function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function keyHint(theme: Theme, key: string, label: string): string {
	return `${theme.bold(theme.fg("accent", key))}${theme.fg("dim", " · ")}${theme.fg("text", label)}`;
}

/** The accent-bordered card on a selected background that both overlays use. */
export function renderFrame(theme: Theme, title: string, status: string, statusColor: Parameters<Theme["fg"]>[0], body: string[], width: number): string[] {
	const model: ToolUiBoxModel = { title: theme.fg("accent", title), status: theme.fg(statusColor, status), tone: "neutral", body };
	const frameTheme = new Proxy(theme, { get(target, property) { if (property === "fg") return (color: Parameters<Theme["fg"]>[0], value: string) => target.fg(color === "borderMuted" ? "accent" : color, value); const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value; } }) as Theme;
	const fill = new Box(0, 0, line => theme.bg("selectedBg", line));
	fill.addChild(new ToolBoxComponent(model, frameTheme));
	return fill.render(width);
}

/** Active Tasks on the board whose `tandem` runs in `cwd`. */
export async function listTasks(cwd: string, signal: AbortSignal): Promise<TaskRef[]> {
	const data = await tandemJson(buildReadArgs({ action: "list", type: "task" }), cwd, signal);
	if (!Array.isArray(data)) throw new Error("tandem list returned no Task list.");
	return data.map((item: { id: string; title: string }) => ({ id: item.id, title: item.title }));
}

/** A Task's read-only detail lines, shown from the board whose `tandem` runs in `cwd`. */
export async function previewTask(id: string, cwd: string, signal: AbortSignal): Promise<string[]> {
	const data = await tandemJson(buildReadArgs({ action: "show", id }), cwd, signal);
	const lines = [`${data.id} · ${data.state} · ${data.kind ?? "task"} · ${data.priority ?? "no priority"}`, String(data.title)];
	if (data.body) lines.push(String(data.body));
	const acceptance: unknown[] = Array.isArray(data.accord?.acceptance) ? data.accord.acceptance : [];
	for (const item of acceptance) lines.push(`• ${String(item)}`);
	return lines;
}
