import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { compactCommandSummary, isShellSetupSegment, summarizeCommand, type CommandSummary } from "./command-summary";
import { classifyOutputShape, cleanOutputLine, outputLines, parseSearchMatchLine, type OutputShape, type SearchMatch } from "./output-shape";
import type { BashRenderInput, BashSubRenderResult } from "./types";
import { hiddenHint, joinTitleParts, paint, section, truncatePlain } from "../core/text";
import { renderDiffLines as renderSharedDiffLines } from "../core/diff";

const MAX_RENDERED_LINE_WIDTH = 220;
const COMMAND_PREVIEW_WIDTH = 112;
const MAX_PATH_WIDTH = 180;

export function renderUniversalBash(input: BashRenderInput): BashSubRenderResult {
  const command = summarizeCommand(input.command, input.cwd);
  const outputShape = classifyOutputShape(input.outputText, command);
  const semanticNoMatches = isSemanticNoMatches(input, command.displayName, outputShape);
  const label = joinTitleParts([
    command.displayName,
    command.label,
    semanticNoMatches ? "no matches" : outputShape === "empty" && !input.pending && !input.failed ? "no output" : undefined,
  ]);
  const structured = renderShapeSection(input, outputShape);

  return {
    toolName: "Bash",
    label,
    body: commandPreviewBody(input, command),
    sections: structured.sections,
    suppressRawOutput: structured.coversOutput,
    commandSummary: command.cwdChange
      ? `${compactCommandSummary(command.primarySegment)} (cd ${truncatePlain(command.cwdChange, 48)})`
      : compactCommandSummary(command.primarySegment),
    treatAsSuccess: semanticNoMatches,
  };
}

type ShapeRender = {
  sections: BashSubRenderResult["sections"];
  coversOutput: boolean;
};

function renderShapeSection(input: BashRenderInput, outputShape: OutputShape): ShapeRender {
  switch (outputShape) {
    case "empty":
      return { sections: [], coversOutput: true };
    case "path-list":
      return { sections: [section("Paths", renderPathLines(input))], coversOutput: true };
    case "search-results":
      return { sections: [section("Matches", renderSearchMatches(input))], coversOutput: true };
    case "diff":
      return { sections: [section("Diff", renderDiffLines(input))], coversOutput: true };
    case "plain":
      return { sections: [], coversOutput: false };
  }
}

function commandPreviewBody(input: BashRenderInput, summary: CommandSummary): string[] {
  const fullCommand = input.command.replace(/\s+/g, " ").trim();
  if (fullCommand.length === 0) return [];

  const primaryCommand = summary.primarySegment.replace(/\s+/g, " ").trim();
  const displayCommand = primaryCommand.length > 0 && primaryCommand !== fullCommand ? primaryCommand : fullCommand;
  const preview = paint(input.theme, "muted", "$ ") + paint(input.theme, "toolOutput", paintlessTruncate(displayCommand, COMMAND_PREVIEW_WIDTH));
  const lines = [safeLine(preview)];

  const setup = summary.segments.filter((segment) => segment !== summary.primarySegment && isShellSetupSegment(segment));
  if (setup.length > 0) {
    lines.push(safeLine(paint(input.theme, "muted", `shell setup: ${paintlessTruncate(setup.map((segment) => segment.replace(/\s+/g, " ").trim()).join("; "), 96)}`)));
  }

  if (displayCommand !== fullCommand && input.expanded) {
    lines.push(safeLine(paint(input.theme, "muted", `full: ${paintlessTruncate(fullCommand, COMMAND_PREVIEW_WIDTH)}`)));
  }

  return lines;
}

function renderPathLines(input: BashRenderInput): string[] {
  const paths = outputLines(input.outputText).map(cleanOutputLine).filter((line) => line.trim().length > 0);
  if (paths.length === 0) return [mutedLine(input, input.pending ? "waiting for paths…" : "no paths")];

  const limit = input.expanded ? 64 : 14;
  const shown = paths.slice(0, limit).map((path) => safeLine(paint(input.theme, "toolOutput", compactPath(path, MAX_PATH_WIDTH))));
  appendHiddenHint(input, shown, paths.length, shown.length, "path");
  return shown;
}

function renderSearchMatches(input: BashRenderInput): string[] {
  const matches = outputLines(input.outputText).map(parseSearchMatchLine).filter((match): match is SearchMatch => Boolean(match));
  if (matches.length === 0) return renderPlainPreview(input, "match");

  const groups = groupMatches(matches);
  const limit = input.expanded ? 64 : 14;
  const rendered: string[] = [];
  let shownMatches = 0;

  for (const group of groups) {
    if (rendered.length >= limit - 1) break;
    rendered.push(safeLine(paint(input.theme, "accent", input.theme.bold(`${compactPath(group.path, MAX_PATH_WIDTH)} (${group.matches.length})`))));

    for (const match of group.matches) {
      if (rendered.length >= limit) break;
      rendered.push(renderMatchLine(input, match));
      shownMatches++;
    }
  }

  appendHiddenHint(input, rendered, matches.length, shownMatches, "match");
  return rendered;
}

function renderDiffLines(input: BashRenderInput): string[] {
  const lines = outputLines(input.outputText).map(cleanOutputLine);
  if (lines.length === 0) return [mutedLine(input, input.pending ? "waiting for diff…" : "no diff")];

  return renderSharedDiffLines(input.theme, lines, input.expanded, {
    collapsed: 16,
    expanded: 64,
    totalLines: input.details?.truncation?.totalLines ?? lines.length,
    noun: "line",
  });
}

function renderPlainPreview(input: BashRenderInput, noun: string): string[] {
  const lines = outputLines(input.outputText).map(cleanOutputLine).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [mutedLine(input, input.pending ? `waiting for ${noun}s…` : `no ${noun}s`)];
  const limit = input.expanded ? 40 : 10;
  const shown = lines.slice(0, limit).map((line) => safeLine(paint(input.theme, "toolOutput", line.length > 0 ? line : " ")));
  appendHiddenHint(input, shown, lines.length, shown.length, "line");
  return shown;
}

function renderMatchLine(input: BashRenderInput, match: SearchMatch): string {
  const location = match.column === undefined ? String(match.line) : `${match.line}:${match.column}`;
  const text = match.text.length > 0 ? match.text : " ";
  return safeLine(
    paint(input.theme, "muted", `  ${location}`)
    + paint(input.theme, "dim", " │ ")
    + paint(input.theme, "toolOutput", text),
  );
}

function groupMatches(matches: SearchMatch[]): Array<{ path: string; matches: SearchMatch[] }> {
  const byPath = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const records = byPath.get(match.path) ?? [];
    records.push(match);
    byPath.set(match.path, records);
  }
  return Array.from(byPath.entries()).map(([path, records]) => ({ path, matches: records }));
}

function appendHiddenHint(input: BashRenderInput, lines: string[], total: number, shown: number, noun: string): void {
  const explicitTotal = input.details?.truncation?.totalLines ?? total;
  const remaining = Math.max(0, explicitTotal - shown);
  if (remaining > 0) lines.push(safeLine(hiddenHint(input.theme, remaining, noun, input.expanded)));
}

function isSemanticNoMatches(input: BashRenderInput, displayName: string, outputShape: OutputShape): boolean {
  return !input.pending
    && outputShape === "empty"
    && input.exitCode === 1
    && !input.timedOut
    && !input.aborted
    && (displayName === "rg" || displayName === "ripgrep" || displayName === "grep" || displayName === "egrep" || displayName === "fgrep");
}

function compactPath(path: string, maxWidth: number): string {
  const cleanPath = path.trim();
  if (visibleWidth(cleanPath) <= maxWidth) return cleanPath;

  const absolute = cleanPath.startsWith("/");
  const parts = cleanPath.split("/").filter((part) => part.length > 0);
  if (parts.length > 4) {
    const compact = `${absolute ? "/" : ""}${parts[0]}/…/${parts.slice(-2).join("/")}`;
    if (visibleWidth(compact) <= maxWidth) return compact;
  }

  return truncateToWidth(cleanPath, maxWidth, "…", true);
}

function mutedLine(input: BashRenderInput, line: string): string {
  return safeLine(paint(input.theme, "muted", line));
}

function paintlessTruncate(line: string, width: number): string {
  return visibleWidth(line) > width ? truncateToWidth(line, width, "…", true) : line;
}

function safeLine(line: string): string {
  return visibleWidth(line) > MAX_RENDERED_LINE_WIDTH
    ? truncateToWidth(line, MAX_RENDERED_LINE_WIDTH, "…", true)
    : line;
}
