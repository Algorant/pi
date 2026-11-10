import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hiddenHint, paint } from "./text";

const MAX_RENDERED_LINE_WIDTH = 220;
const DIFF_METADATA_PATTERN = /^(index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to)/;

export type DiffStats = {
  additions: number;
  removals: number;
};

export function diffStats(diff = ""): DiffStats {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}

export function diffStatsTitle(theme: Theme, stats: DiffStats): string {
  return `${paint(theme, "toolDiffAdded", `+${stats.additions}`)} ${paint(theme, "toolDiffRemoved", `−${stats.removals}`)}`;
}

export function renderDiffLines(
  theme: Theme,
  lines: string[],
  expanded: boolean,
  opts: { collapsed?: number; expanded?: number; totalLines?: number; noun?: string } = {},
): string[] {
  const meaningfulLines = lines.filter((line) => line.trim().length > 0);
  if (meaningfulLines.length === 0) return [paint(theme, "muted", "No diff")];

  const limit = expanded ? (opts.expanded ?? 64) : (opts.collapsed ?? 16);
  const shownSource = lines.slice(0, limit);
  const rendered = shownSource.map((line) => colorDiffLine(theme, line));
  const total = opts.totalLines ?? lines.length;
  const remaining = Math.max(0, total - shownSource.length);
  if (remaining > 0) rendered.push(safeLine(hiddenHint(theme, remaining, opts.noun ?? "diff line", expanded)));
  return rendered;
}

export function colorDiffLine(theme: Theme, rawLine: string): string {
  const line = rawLine.length > 0 ? rawLine : " ";
  if (line.startsWith("diff --git")) return safeLine(paint(theme, "accent", theme.bold(line)));
  if (line.startsWith("@@")) return safeLine(paint(theme, "warning", line));
  if (line.startsWith("+++")) return safeLine(paint(theme, "toolDiffAdded", line));
  if (line.startsWith("---")) return safeLine(paint(theme, "toolDiffRemoved", line));
  if (DIFF_METADATA_PATTERN.test(line)) return safeLine(paint(theme, "muted", line));

  const statLine = colorDiffStatLine(theme, line);
  if (statLine) return safeLine(statLine);

  if (line.startsWith("+")) return safeLine(paint(theme, "toolDiffAdded", line));
  if (line.startsWith("-")) return safeLine(paint(theme, "toolDiffRemoved", line));
  return safeLine(paint(theme, "toolDiffContext", line));
}

export function colorDiffStatLine(theme: Theme, rawLine: string): string | undefined {
  const totalLine = colorDiffStatTotalLine(theme, rawLine);
  if (totalLine) return totalLine;

  const pipeIndex = rawLine.lastIndexOf("|");
  if (pipeIndex === -1) return undefined;

  const path = rawLine.slice(0, pipeIndex + 1);
  const stats = rawLine.slice(pipeIndex + 1);
  if (!/^\s*(?:\d+\s+)?(?:[+\-]+|Bin\s+.+)$/i.test(stats.trim())) return undefined;

  return paint(theme, "toolOutput", path) + colorDiffStatCell(theme, stats);
}

function colorDiffStatTotalLine(theme: Theme, line: string): string | undefined {
  if (!/^\s*\d+ files? changed\b/i.test(line)) return undefined;
  return line
    .split(/(\d+ insertions?\(\+\)|\d+ deletions?\(-\))/gi)
    .map((part) => {
      if (/\d+ insertions?\(\+\)/i.test(part)) return paint(theme, "toolDiffAdded", part);
      if (/\d+ deletions?\(-\)/i.test(part)) return paint(theme, "toolDiffRemoved", part);
      return paint(theme, "toolOutput", part);
    })
    .join("");
}

function colorDiffStatCell(theme: Theme, stats: string): string {
  let rendered = "";
  for (const char of stats) {
    if (char === "+") rendered += paint(theme, "toolDiffAdded", char);
    else if (char === "-") rendered += paint(theme, "toolDiffRemoved", char);
    else rendered += paint(theme, "muted", char);
  }
  return rendered;
}

function safeLine(line: string): string {
  return visibleWidth(line) > MAX_RENDERED_LINE_WIDTH
    ? truncateToWidth(line, MAX_RENDERED_LINE_WIDTH, "…", true)
    : line;
}
