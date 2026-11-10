import type { CommandSummary } from "./command-summary";

export type OutputShape = "empty" | "path-list" | "search-results" | "diff" | "plain";

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export type SearchMatch = {
  path: string;
  line: number;
  column?: number;
  text: string;
};

export function classifyOutputShape(outputText: string, command: CommandSummary): OutputShape {
  void command;
  const lines = outputLines(outputText).map(cleanOutputLine);
  const meaningful = lines.filter((line) => line.trim().length > 0);

  if (meaningful.length === 0) return "empty";
  if (looksLikeDiff(meaningful) || looksLikeDiffStat(meaningful)) return "diff";
  if (looksLikeSearchResults(meaningful)) return "search-results";
  if (looksLikePathList(meaningful)) return "path-list";
  return "plain";
}

export function outputLines(text: string): string[] {
  const normalized = text.replace(/\r/g, "").replace(/\n$/, "");
  if (normalized.length === 0) return [];
  return normalized.split("\n");
}

export function cleanOutputLine(line: string): string {
  return line.replace(ANSI_PATTERN, "").replace(/\0/g, "�").replace(/\t/g, "  ").trimEnd();
}

export function parseSearchMatchLine(rawLine: string): SearchMatch | undefined {
  const line = cleanOutputLine(rawLine);
  if (line.trim().length === 0) return undefined;

  const parts = line.split(":");
  if (parts.length < 3) return undefined;

  for (let index = 1; index < parts.length - 1; index++) {
    const maybeLine = parts[index];
    if (!/^\d+$/.test(maybeLine)) continue;

    const path = parts.slice(0, index).join(":");
    if (!looksPathLike(path)) continue;

    const maybeColumn = parts[index + 1];
    const hasColumn = index + 2 < parts.length && /^\d+$/.test(maybeColumn);
    const textStart = hasColumn ? index + 2 : index + 1;
    if (textStart > parts.length) continue;

    return {
      path,
      line: Number(maybeLine),
      column: hasColumn ? Number(maybeColumn) : undefined,
      text: parts.slice(textStart).join(":"),
    };
  }

  return undefined;
}

function looksLikeDiff(lines: string[]): boolean {
  if (lines.some((line) => line.startsWith("diff --git") || line.startsWith("@@ "))) return true;
  const hasOld = lines.some((line) => line.startsWith("--- "));
  const hasNew = lines.some((line) => line.startsWith("+++ "));
  if (hasOld && hasNew) return true;

  return false;
}

function looksLikeDiffStat(lines: string[]): boolean {
  const statLines = lines.filter((line) => isDiffStatLine(line)).length;
  if (statLines === 0) return false;
  return statLines >= 2 || statLines / lines.length >= 0.6;
}

function isDiffStatLine(line: string): boolean {
  if (/^\s*\d+ files? changed\b/i.test(line)) return true;
  const pipeIndex = line.lastIndexOf("|");
  if (pipeIndex === -1) return false;
  const path = line.slice(0, pipeIndex).trim();
  const stats = line.slice(pipeIndex + 1).trim();
  return path.length > 0 && /^(?:\d+\s+)?(?:[+\-]+|Bin\s+.+)$/i.test(stats);
}

function looksLikeSearchResults(lines: string[]): boolean {
  const matches = lines.map(parseSearchMatchLine).filter(Boolean).length;
  if (matches === 0) return false;
  return matches >= 2 || matches / lines.length >= 0.6;
}

function looksLikePathList(lines: string[]): boolean {
  if (lines.length === 0) return false;
  const candidates = lines.filter((line) => looksPathLike(line.trim())).length;
  return candidates >= Math.max(1, Math.ceil(lines.length * 0.75));
}

function looksPathLike(value: string): boolean {
  if (value.length === 0 || value.length > 500) return false;
  if (/\s{2,}/.test(value)) return false;
  if (/^[A-Za-z]:\\/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~/")) return true;
  if (value.includes("/")) return !/[{}<>|]/.test(value);
  return /^[\w.,@%+=:_-]+\.[A-Za-z0-9]{1,8}$/.test(value);
}
