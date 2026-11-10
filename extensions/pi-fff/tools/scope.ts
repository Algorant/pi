// Scope guard for FFF grep pages.
//
// When a constrained grep scans every candidate and finds nothing, fff-core
// (grep_search, fff-bun 0.11) retries the whole raw query as search text with
// its path and exclude constraints dropped (only an exact file-path constraint
// survives). fff-bun does not report that retry, and with regex alternation or
// fuzzy mode it can match anywhere in the index. pi-fff therefore accepts only
// path and exclude forms whose effect it can check on every returned match, and
// treats a page with any match outside them as a scope violation.

export type SearchScope = {
  /** Index-relative directory every match must be under; "" for the whole index. */
  subtree: string;
  /** Exclusion tokens exactly as sent to FFF (`!target/`, `!*.lock`, `!Cargo.lock`). */
  excludes: string[];
};

const GLOB_CHARS = /[*?[\]{}]/;

type Exclusion = { kind: "segment" | "extension" | "file"; value: string };

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => c.toLowerCase()).replaceAll("\\", "/");
}

// The three exclusion forms fff-core parses unambiguously in grep's query
// syntax, with its own match rule (ASCII case-insensitive, `/` or `\`):
//   `!dir/` -> Not(PathSegment): the path contains segment `dir` at any depth;
//   `!*.ext` -> Not(Extension): the file name ends with `.ext`;
//   `!name.ext`, `!a/name.ext` -> Not(FilePath): the path ends with it at a separator.
// Anything else (globs, `type:`, bare words) returns null and is refused.
function parseExclusion(token: string): Exclusion | null {
  const inner = asciiLower(token.slice(1));
  if (!inner || /^[/\\]/.test(inner)) return null;
  const extension = inner.match(/^\*\.([^*?[\]{}/:]+)$/);
  if (extension) return { kind: "extension", value: extension[1] };
  if (GLOB_CHARS.test(inner) || inner.includes(":")) return null;
  if (inner.endsWith("/")) {
    const segment = inner.replace(/\/+$/, "");
    return segment ? { kind: "segment", value: segment } : null;
  }
  const fileName = inner.slice(inner.lastIndexOf("/") + 1);
  return /\.[a-z][a-z0-9]{0,9}$/.test(fileName) ? { kind: "file", value: inner } : null;
}

function excludedBy(path: string, exclusion: Exclusion): boolean {
  const { kind, value } = exclusion;
  if (kind === "segment") return path.startsWith(`${value}/`) || path.includes(`/${value}/`);
  if (kind === "file") return path === value || path.endsWith(`/${value}`);
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.length > value.length + 1 && name.endsWith(`.${value}`);
}

/** Exclusion tokens pi-fff cannot check on returned matches; grep refuses them before searching. */
export function uncheckableExcludes(excludes: string[]): string[] {
  return excludes.filter((token) => !parseExclusion(token)).map((token) => token.slice(1));
}

export function outsideScope(relativePath: string, scope: SearchScope): boolean {
  if (scope.subtree && !relativePath.startsWith(`${scope.subtree}/`)) return true;
  if (!scope.excludes.length) return false;
  const path = asciiLower(relativePath);
  // grep refuses uncheckable exclusions before searching; one reaching here fails closed.
  return scope.excludes.some((token) => {
    const exclusion = parseExclusion(token);
    return !exclusion || excludedBy(path, exclusion);
  });
}

export function hasScope(scope: SearchScope | undefined): scope is SearchScope {
  return Boolean(scope && (scope.subtree || scope.excludes.length));
}

function unexpressible(path: string): { ok: false; reason: string } | null {
  if (/\s/.test(path) || GLOB_CHARS.test(path) || /^[!\\]/.test(path)) {
    return { ok: false, reason: `FFF cannot scope a search to ${path}: its path contains whitespace, glob characters or a leading ! or \\.` };
  }
  return null;
}

/** Token anchoring a search to an index-relative directory, or an error for paths FFF cannot express as one token. */
export function subtreeConstraint(subtree: string): { ok: true; token: string | null } | { ok: false; reason: string } {
  if (!subtree) return { ok: true, token: null };
  return unexpressible(subtree) ?? { ok: true, token: `${subtree}/**` };
}

/**
 * Token selecting an index-relative file. fff-query-parser reads a token as a
 * file path only when its name has an extension (`README.md`, `a/b.ts`); an
 * extensionless name (`LICENSE`, `Makefile`) needs a path glob, which grep
 * accepts only when it contains `/`. Both forms also select same-named files
 * elsewhere, so callers keep only the exact path.
 */
export function fileConstraint(path: string): { ok: true; token: string } | { ok: false; reason: string } {
  const failure = unexpressible(path);
  if (failure) return failure;
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  return { ok: true, token: /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(fileName) ? path : `**/${path}` };
}
