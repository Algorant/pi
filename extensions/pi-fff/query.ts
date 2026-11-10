import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export function clamp(n: unknown, def: number, min: number, max: number): number {
  const value = Number(n ?? def);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : def;
}

function expandHome(value: string): string {
  return value.replace(/^~(?=\/|$)/, homedir());
}

function safeRealpath(value: string): string | null {
  try {
    return realpathSync.native(value);
  } catch {
    return null;
  }
}

function slash(value: string): string {
  return value.replace(/\\/g, "/");
}

function insideRelative(base: string, target: string): string | null {
  const rel = relative(base, target);
  if (!rel) return ".";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return slash(rel);
}

/** Convert logical, realpath, and project-prefixed paths to workspace-relative form. */
export function normalizePathFilter(value: string, cwd = process.cwd()): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  const expanded = expandHome(trimmed);
  const workspace = resolve(cwd);

  if (isAbsolute(expanded)) {
    const realTarget = safeRealpath(expanded);
    const bases = [workspace, safeRealpath(workspace)].filter((base): base is string => Boolean(base));
    for (const base of [...new Set(bases)]) {
      const rel = insideRelative(base, expanded);
      if (rel) return rel;
      if (realTarget) {
        const realRel = insideRelative(base, realTarget);
        if (realRel) return realRel;
      }
    }
    return slash(expanded);
  }

  // Agents often copy "repo-name/path" from prompts even though FFF indexes
  // paths relative to cwd. Strip that prefix only when it names this workspace.
  const rootName = basename(workspace);
  if (expanded === rootName) return ".";
  if (expanded.startsWith(`${rootName}/`)) return expanded.slice(rootName.length + 1) || ".";

  return slash(expanded);
}

export function normalizePathConstraint(pathConstraint: string, cwd = process.cwd()): string | null {
  let normalized = normalizePathFilter(pathConstraint, cwd).trim();
  if (!normalized) return null;

  if (isAbsolute(normalized)) {
    throw new Error(`Path constraint must be relative to the workspace: ${pathConstraint}`);
  }

  if (normalized === "." || normalized === "./") return null;
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized === "**" || normalized === "**/" || normalized === "**/*") return null;

  const recursiveDir = normalized.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const directory = recursiveDir[1];
    if (directory && !/[*?[{]/.test(directory)) return `${directory}/`;
  }

  if (normalized.startsWith("/") || normalized.endsWith("/")) return normalized;
  if (/[*?[{]/.test(normalized)) return normalized;

  // Existing paths settle ambiguous names (for example a directory containing a dot).
  try {
    if (statSync(resolve(cwd, normalized)).isDirectory()) return `${normalized}/`;
  } catch {
    // FFF deliberately accepts fuzzy/nonexistent constraints.
  }

  const lastSegment = normalized.split("/").pop() ?? "";
  const looksLikeFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment);
  return looksLikeFile ? normalized : `${normalized}/`;
}

export function normalizeExcludes(exclude: string | string[] | undefined, cwd = process.cwd()): string[] {
  if (!exclude) return [];
  const values = Array.isArray(exclude) ? exclude : [exclude];
  const result: string[] = [];
  for (const value of values) {
    for (const part of value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)) {
      const stripped = part.startsWith("!") ? part.slice(1) : part;
      const normalized = normalizePathConstraint(stripped, cwd);
      if (normalized) result.push(`!${normalized}`);
    }
  }
  return result;
}

export function buildQuery(pattern: string, path?: string, exclude?: string | string[], cwd = process.cwd()): string {
  const parts: string[] = [];
  if (path?.trim()) {
    const pathConstraint = normalizePathConstraint(path, cwd);
    if (pathConstraint) parts.push(pathConstraint);
  }
  parts.push(...normalizeExcludes(exclude, cwd));
  if (pattern.trim()) parts.push(pattern.trim());
  return parts.join(" ").trim();
}

// fff-query-parser (AiGrepConfig, fff-bun 0.11) reads whitespace-separated grep
// query tokens as file filters: `*`/`!`/`/`-leading tokens, a trailing `/`, a
// `/` with glob characters, `{a,b}` braces, `type:` and, beside other words,
// `name.ext`. Its documented escape is a leading `\`, stripped only before `*`,
// `!` or `/`. Regex and fuzzy patterns are sent with that escape; a token it
// cannot protect is refused instead of being reinterpreted.
const FILE_NAME = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

export function nativePatternText(pattern: string): { ok: true; text: string } | { ok: false; token: string; reason: string } {
  if (/^\s|\s$|\s\s|[^\S ]/.test(pattern)) {
    return { ok: false, token: JSON.stringify(pattern), reason: "FFF rejoins pattern words with single spaces; write other whitespace as \\s, \\t or \\x20" };
  }
  const tokens = pattern.split(" ");
  const text: string[] = [];
  for (const token of tokens) {
    const refuse = (reason: string) => ({ ok: false as const, token, reason });
    if (/^\\[*!/]/.test(token)) return refuse("FFF strips this backslash; write the character as \\x2A, \\x21 or \\x2F");
    if (/^[*!/]/.test(token)) {
      text.push(`\\${token}`);
      continue;
    }
    if (token.endsWith("/")) return refuse("a trailing / makes it a directory filter; write the / as \\x2F");
    if (token.includes("/") && /[*?[{]/.test(token)) return refuse("a / with *, ?, [ or { makes it a path glob; write the / as \\x2F");
    const open = token.indexOf("{");
    const close = token.lastIndexOf("}");
    const inner = open !== -1 && open < close ? token.slice(open + 1, close) : "";
    if (inner.includes(",") && /[A-Za-z]/.test(inner)) return refuse("{...,...} makes it a brace glob; write the { as \\x7B");
    if (token.startsWith("type:")) return refuse("type: makes it a file-type filter; write the : as \\x3A");
    if (tokens.length > 1 && !/[*?[{]/.test(token) && FILE_NAME.test(token.slice(token.lastIndexOf("/") + 1))) {
      return refuse("beside other words a name.ext token becomes a file-name filter; write its last . as \\x2E (or (?:.) for any character)");
    }
    text.push(token);
  }
  return { ok: true, text: text.join(" ") };
}

export function pageFromCursor(cursor?: string): number {
  const value = Number(cursor || 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export function isWeak(pattern: string, total: number, returned: number): boolean {
  return pattern.trim().length < 2 && total > Math.max(50, returned * 5);
}

export function grepMode(pattern: string): "plain" | "regex" {
  return /[\\^$.*+?()[\]{}|]/.test(pattern) ? "regex" : "plain";
}

export function dangerousGrep(pattern: string): boolean {
  return /^(?:\.?\*|\.\+|\^?\.?\*\$?)$/.test(pattern.trim());
}
