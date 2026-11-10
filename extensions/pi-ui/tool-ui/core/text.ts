import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { formatSize } from "@earendil-works/pi-coding-agent";
import type { ToolUiResultLike, ToolUiSectionModel, ToolUiTextTone, ToolUiTone } from "./types";

export const DEFAULT_COLLAPSED_OUTPUT_LINES = 6;
export const DEFAULT_EXPANDED_OUTPUT_LINES = 24;

export function section(title: string | undefined, lines: Array<string | undefined | null | false>): ToolUiSectionModel {
  return { title, lines: lines.filter((line): line is string => typeof line === "string") };
}

export function paint(theme: Theme, tone: ToolUiTextTone, text: string): string {
  if (tone === "toolTitle") return theme.fg("toolTitle", text);
  if (tone === "toolOutput") return theme.fg("toolOutput", text);
  return theme.fg(tone, text);
}

export function fieldLine(theme: Theme, label: string, value: unknown, tone: ToolUiTextTone = "accent"): string {
  const rendered = value === undefined || value === null || value === "" ? "—" : String(value);
  return `${theme.fg("muted", `${label}:`)} ${paint(theme, tone, rendered)}`;
}

export function statusIcon(theme: Theme, tone: ToolUiTone): string {
  if (tone === "error") return theme.fg("error", "✗");
  if (tone === "warning") return theme.fg("warning", "!");
  if (tone === "pending") return theme.fg("muted", "●");
  if (tone === "success") return theme.fg("success", "✓");
  return theme.fg("muted", "•");
}

export function toolName(theme: Theme, name: string): string {
  return theme.fg("accent", name);
}

export function joinTitleParts(parts: Array<string | undefined | null | false>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
}

export function hiddenHint(theme: Theme, count: number, noun = "line", expanded = false): string {
  const hint = expanded ? "preview limited" : "ctrl+o to expand";
  return theme.fg("muted", `… ${count} more ${noun}${count === 1 ? "" : "s"} (${hint})`);
}

export function formatDuration(ms?: number): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function durationLabel(state: { startedAt?: number; endedAt?: number }): string | undefined {
  if (state.startedAt === undefined || state.endedAt === undefined) return undefined;
  return formatDuration(state.endedAt - state.startedAt);
}

export function plainTextLines(
  theme: Theme,
  text: string,
  expanded: boolean,
  opts: { collapsed?: number; expanded?: number; tail?: boolean; empty?: string; totalLines?: number; noun?: string } = {},
): string[] {
  const allLines = text.replace(/\r/g, "").split("\n");
  const meaningfulLines = allLines.filter((line) => line.trim().length > 0);
  if (meaningfulLines.length === 0) return [theme.fg("muted", opts.empty ?? "No output")];

  const limit = expanded ? (opts.expanded ?? DEFAULT_EXPANDED_OUTPUT_LINES) : (opts.collapsed ?? DEFAULT_COLLAPSED_OUTPUT_LINES);
  const source = opts.tail && allLines.length > limit ? allLines.slice(-limit) : allLines.slice(0, limit);
  const lines = source.map((line) => paint(theme, "toolOutput", line.length > 0 ? line : " "));
  const total = opts.totalLines ?? allLines.length;
  const remaining = Math.max(0, total - source.length);
  if (remaining > 0) {
    lines.push(hiddenHint(theme, remaining, opts.noun ?? "line", expanded));
  }
  return lines;
}

export function stripReadContinuationFooters(text: string): string {
  return text.replace(/\n\n\[(?:Showing lines|\d+ more lines in file|Line \d+ is)[\s\S]*?\]\s*$/m, "").trimEnd();
}

export function stripBashDisplayStatus(text: string, details?: { fullOutputPath?: string }): string {
  let output = text.trimEnd();
  if (output === "(no output)") return "";
  output = output.replace(/\n\nCommand (?:exited with code -?\d+|timed out after \d+ seconds|aborted)\s*$/i, "").trimEnd();
  if (details?.fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(details.fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }
  return output;
}

export function truncationLines(theme: Theme, details?: { truncation?: { truncated?: boolean; outputLines?: number; totalLines?: number; outputBytes?: number; totalBytes?: number; maxBytes?: number; truncatedBy?: string | null }; fullOutputPath?: string }): string[] {
  const truncation = details?.truncation;
  if (!truncation?.truncated && !details?.fullOutputPath) return [];

  const parts: string[] = [];
  if (truncation?.outputLines !== undefined && truncation.totalLines !== undefined) {
    parts.push(`${truncation.outputLines}/${truncation.totalLines} lines`);
  }
  if (truncation?.outputBytes !== undefined && truncation.totalBytes !== undefined) {
    parts.push(`${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}`);
  }

  return [
    fieldLine(theme, "truncation", parts.length > 0 ? `${parts.join(", ")} shown` : "output clipped", "warning"),
    details?.fullOutputPath ? fieldLine(theme, "full output", details.fullOutputPath, "muted") : undefined,
  ].filter((line): line is string => Boolean(line));
}

export function getTextOutput(result?: Pick<AgentToolResult<unknown>, "content">): string {
  if (!result?.content) return "";
  return result.content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function truncatePlain(text: unknown, max = 140): string {
  const oneLine = String(text ?? "").replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  if (max <= 1) return "…".slice(0, max);
  return `${oneLine.slice(0, max - 1)}…`;
}

export function statusTone(input: { pending: boolean; error: boolean; warning?: boolean }): ToolUiTone {
  if (input.pending) return "pending";
  if (input.error) return "error";
  if (input.warning) return "warning";
  return "success";
}

export function isErrorResult(result: ToolUiResultLike | undefined, text: string): boolean {
  const details = result?.details as { error?: unknown; critical?: unknown; ok?: unknown } | undefined;
  return Boolean(result?.isError || details?.error || details?.critical || details?.ok === false || /^\s*(error|critical):/i.test(text));
}

export { formatSize };
