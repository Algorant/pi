import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFffToolRenderer } from "../../pi-ui/tool-ui/custom-tools/fff";
import {
  routePathConstraint,
  type ExternalSearch,
} from "../native/external";
import { buildQuery, clamp, dangerousGrep, grepMode, nativePatternText, normalizeExcludes } from "../query";
import { hasScope, outsideScope, uncheckableExcludes, type SearchScope } from "./scope";
import { GREP_PROMPT_SNIPPET, grepFallbackHint } from "./fallback";
import { collectExactPathItems, preparePathSearch } from "./path-search";
import { disposedToolResult, type FffSessionGetter } from "../session.ts";

const DEFAULT_LIMIT = 50;

export function registerGrepTool(pi: ExtensionAPI, fallbackCwd: string, getSession: FffSessionGetter, notify?: (message: string) => void) {
  pi.registerTool({
    name: "grep",
    exposure: "direct",
    label: "Grep",
    description: "FFF-backed content search through indexed workspace files or an explicitly requested external path.",
    promptSnippet: GREP_PROMPT_SNIPPET,
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      caseSensitive: Type.Optional(Type.Boolean()),
      context: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number({ description: "Target matching lines per page (default 50, range 1-200). Whole files are returned: files are added until the total reaches limit, so one file with many matches can return all of them. Narrow path or pattern, or use read, for large files." })),
      cursor: Type.Optional(Type.String({ description: "Cursor from the previous page's output; pages advance by whole files and keep that search's limit unless limit is given." })),
    }),
    ...createFffToolRenderer("grep"),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = getSession();
      if (!session?.isActive()) return disposedToolResult("grep");
      const cwd = ctx?.cwd ?? fallbackCwd;
      const pattern = String(params.pattern || "");
      if (!pattern.trim()) return { content: [{ type: "text", text: "Error: pattern is required." }], details: { error: "missing-pattern" } };
      if (dangerousGrep(pattern)) return { content: [{ type: "text", text: "Error: wildcard-only grep patterns are disabled; provide a more specific pattern." }], details: { error: "dangerous-pattern", pattern } };

      let releaseExternal: (() => void) | undefined;
      try {
      let limit = clamp(params.limit, DEFAULT_LIMIT, 1, 200);
      let context = clamp(params.context, 0, 0, 5);
      let offset = Number(params.cursor || 0) || 0;
      let mode: "plain" | "regex" | "fuzzy" = grepMode(pattern);
      let smartCase = params.caseSensitive !== true;
      let query = "";
      // Scope tokens alone, kept apart from the pattern for the literal search below.
      let constraints = "";
      let searchPattern = pattern;
      let finder: any = session.finder;
      let externalSearch: ExternalSearch | undefined;
      let exactFilePath: string | undefined;
      let scope: SearchScope | undefined;
      let unenforcedPath: string | undefined;

      const resumed = session.externalCursors.get(params.cursor, "grep");
      if (params.cursor?.startsWith("ext-") && !resumed) {
        return { content: [{ type: "text", text: "FFF grep cursor expired; repeat the search." }], details: { error: "expired-external-cursor" } };
      }

      try {
        if (resumed) {
          // A stored cursor resumes its own query and scope; later calls cannot drop them.
          query = resumed.query;
          constraints = resumed.constraints ?? "";
          searchPattern = resumed.pattern ?? pattern;
          offset = resumed.position;
          if (params.limit === undefined) limit = resumed.limit ?? limit;
          mode = resumed.grepMode ?? mode;
          context = resumed.context ?? context;
          smartCase = resumed.smartCase ?? smartCase;
          scope = resumed.scope;
          unenforcedPath = resumed.unenforcedPath;
          if (!resumed.workspace) {
            const acquired = await session.externalFinders.acquire(resumed.root, { exact: true });
            finder = acquired.finder;
            releaseExternal = acquired.release;
            externalSearch = {
              requestedPath: resumed.requestedPath,
              root: acquired.root,
              suffix: resumed.suffix,
              created: acquired.created,
              reused: acquired.reused,
              scanning: acquired.scanning,
            };
          }
        } else {
          // Refuse exclusions pi-fff cannot check before any index is touched.
          const uncheckable = uncheckableExcludes(normalizeExcludes(params.exclude, cwd));
          if (uncheckable.length) {
            return {
              content: [{ type: "text", text: `FFF grep refused: exclude ${uncheckable.join(", ")} cannot be enforced. When a scoped grep finds nothing, FFF retries without its exclusions, and pi-fff can verify only directory (dir/ or dir/**), *.ext and file-name (name.ext, dir/name.ext) exclusions. Rewrite the exclusions in those forms.` }],
              details: { error: "unenforceable-exclude", exclude: uncheckable },
            };
          }
          const route = routePathConstraint(params.path, cwd);
          if (route?.kind === "unsafe") {
            return {
              content: [{ type: "text", text: `FFF external search refused: ${route.reason}` }],
              details: { error: "unsafe-external-root", requestedPath: route.requestedPath, externalRoot: route.root },
            };
          }
          if (route?.kind === "file" || route?.kind === "directory") {
            const prepared = await preparePathSearch({
              route,
              cwd,
              pattern,
              exclude: params.exclude,
              finder,
              externalFinders: session.externalFinders,
              tool: "grep",
            });
            releaseExternal = prepared.release;
            if (!prepared.ok) {
              return { content: [{ type: "text", text: prepared.message }], details: prepared.details };
            }
            finder = prepared.finder;
            query = prepared.query;
            constraints = prepared.constraints;
            exactFilePath = route.kind === "file" ? prepared.expectedPath : undefined;
            scope = prepared.scope;
            externalSearch = prepared.externalSearch;
          } else if (route?.kind === "external") {
            // A missing or glob path outside the workspace would become a fuzzy
            // or glob token in an ancestor's index, which FFF's unscoped retry
            // drops and pi-fff cannot check: refuse instead of searching it.
            return {
              content: [{ type: "text", text: `FFF grep refused: ${route.absolutePath} is not an existing directory or file, so pi-fff cannot enforce it as a scope outside the workspace (nearest existing directory: ${route.root}). Pass an existing directory (narrow with pattern and exclude) or file, or use the read tool.` }],
              details: { error: "unenforceable-external-path", requestedPath: route.requestedPath, externalRoot: route.root },
            };
          } else {
            query = buildQuery(pattern, params.path, params.exclude, cwd);
            constraints = buildQuery("", params.path, params.exclude, cwd);
            scope = { subtree: "", excludes: normalizeExcludes(params.exclude, cwd) };
            if (params.path?.trim()) unenforcedPath = params.path.trim();
          }
        }
      } catch (error) {
        if (!session.isActive()) return disposedToolResult("grep");
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `FFF grep failed: ${message}` }], details: { error: message } };
      }

      if (!session.isActive()) return disposedToolResult("grep");
      // Regex and fuzzy patterns go through FFF's query parser (see
      // nativePatternText); a plain pattern goes to multiGrep unchanged.
      const nativePattern = nativePatternText(searchPattern);
      const wireQuery = nativePattern.ok ? [constraints, nativePattern.text].filter(Boolean).join(" ") : null;
      if (mode !== "plain") {
        if (!nativePattern.ok) {
          return {
            content: [{ type: "text", text: `FFF grep refused: regex pattern ${JSON.stringify(searchPattern)} cannot be sent to FFF unchanged. FFF reads whitespace-separated query words as file filters, and ${nativePattern.token} has no escape: ${nativePattern.reason}. Rewrite that word, or use the read tool for a known file.` }],
            details: { error: "unrepresentable-pattern", pattern: searchPattern, token: nativePattern.token, reason: nativePattern.reason },
          };
        }
        query = wireQuery!;
      } else if (/[\r\n]/.test(searchPattern)) {
        return {
          content: [{ type: "text", text: `FFF grep refused: pattern ${JSON.stringify(searchPattern)} contains a line break, and grep matches single lines. Search for one line at a time.` }],
          details: { error: "unrepresentable-pattern", pattern: searchPattern, reason: "line break" },
        };
      }
      if (externalSearch?.created && session.isActive()) {
        const message = `FFF is indexing external root: ${externalSearch.root}${externalSearch.scanning ? " (indexing continues in the background)" : ""}`;
        if (notify) notify(message);
        else if (ctx?.hasUI) ctx.ui.notify(message, "info");
      }

      // Every native page is checked against the requested scope (see
      // scope.ts). Any match outside it withholds the page and ends this call
      // with a scope-violation error; nothing from such a page is returned.
      let violation: string | undefined;
      const inScope = (value: any): boolean => {
        if (!hasScope(scope)) return true;
        const outside = value.items.filter((match: any) => outsideScope(match.relativePath, scope!));
        if (!outside.length) return true;
        violation ??= `${outside.length} of ${value.items.length} matches on a returned page fell outside it (first: ${outside[0].relativePath})`;
        return false;
      };
      const scopeViolation = () => ({
        content: [{ type: "text" as const, text: `FFF grep scope violation: ${violation}. Requested scope: ${scope!.subtree ? `${scope!.subtree}/` : "index root"}${scope!.excludes.length ? ` excluding ${scope!.excludes.map((token) => token.slice(1)).join(", ")}` : ""}. FFF returns such a page when its scoped search finds nothing and it retries the raw query without path or exclude constraints; the page was withheld, so this call returns no matches and no cursor, and pi-fff cannot confirm the scope has none. Rephrase or narrow the pattern (regex alternation and fuzzy text widen that retry), or read known files.` }],
        details: { error: "scope-violation", violation, scope, query, externalSearch },
      });

      // FFF's grep query parses every whitespace-separated token, so pattern
      // words such as `!name`, `*.rs` or `dir/` would become file constraints.
      // multiGrep takes the literal pattern apart from the scope tokens.
      const search = (searchMode: typeof mode, position: number, pageSize: number) => searchMode === "plain"
        ? finder.multiGrep([searchPattern], constraints, position, pageSize, context, smartCase)
        : finder.grep(wireQuery!, searchMode, position, pageSize, context, smartCase);

      let result = await search(mode, offset, limit);
      if (!session.isActive()) return disposedToolResult("grep");
      if (!result.ok) {
        return { content: [{ type: "text", text: `FFF grep failed: ${result.error}` }], details: { error: result.error, query, externalSearch } };
      }
      if (!inScope(result.value)) return scopeViolation();

      const filterExactFile = async (firstPage: typeof result.value, startOffset: number, searchMode = mode) => collectExactPathItems({
        firstPage,
        expectedPath: exactFilePath!,
        maxMatches: Number.POSITIVE_INFINITY,
        pageSize: limit,
        stopOnMatch: true,
        startPosition: startOffset,
        nextPosition: (page: any) => (page.nextCursor as any)?._offset ?? null,
        fetchPage: async (position, pageSize) => {
          const page = await search(searchMode, position, pageSize);
          return page.ok && !inScope(page.value) ? { ok: false as const, error: "scope-violation" } : page;
        },
      });
      let exactNextOffset: number | null | undefined;
      if (exactFilePath) {
        const exact = await filterExactFile(result.value, offset);
        if (!session.isActive()) return disposedToolResult("grep");
        if (violation) return scopeViolation();
        if (!exact.ok) {
          return { content: [{ type: "text", text: `FFF grep failed: ${exact.error}` }], details: { error: exact.error, query, externalSearch } };
        }
        result.value.items = exact.items;
        result.value.totalMatched = exact.items.length;
        result.value.totalFilesSearched = 1;
        result.value.filteredFileCount = 1;
        exactNextOffset = exact.nextPosition;
        result.value.nextCursor = exactNextOffset === null ? null : { _offset: exactNextOffset };
      }

      // A pattern FFF cannot represent is not retried as fuzzy text.
      if (!result.value.items.length && mode !== "fuzzy" && wireQuery) {
        let fuzzyResult = await search("fuzzy", offset, limit);
        if (!session.isActive()) return disposedToolResult("grep");
        if (fuzzyResult.ok && !inScope(fuzzyResult.value)) return scopeViolation();
        if (fuzzyResult.ok && fuzzyResult.value.items.length) {
          if (exactFilePath) {
            const exact = await filterExactFile(fuzzyResult.value, offset, "fuzzy");
            if (!session.isActive()) return disposedToolResult("grep");
            if (violation) return scopeViolation();
            if (!exact.ok) {
              return { content: [{ type: "text", text: `FFF grep failed: ${exact.error}` }], details: { error: exact.error, query, externalSearch } };
            }
            if (exact.items.length) {
              fuzzyResult.value.items = exact.items;
              fuzzyResult.value.totalMatched = exact.items.length;
              fuzzyResult.value.totalFilesSearched = 1;
              fuzzyResult.value.filteredFileCount = 1;
              fuzzyResult.value.nextCursor = exact.nextPosition === null ? null : { _offset: exact.nextPosition };
              exactNextOffset = exact.nextPosition;
              Object.assign(fuzzyResult.value, { fuzzyFallback: true });
              result = fuzzyResult;
              mode = "fuzzy";
            }
          } else {
            Object.assign(result.value, fuzzyResult.value, { fuzzyFallback: true });
            result = fuzzyResult;
            mode = "fuzzy";
          }
        }
      }

      if (mode === "fuzzy") query = wireQuery!;
      const nextOffset = exactFilePath ? exactNextOffset ?? undefined : (result.value.nextCursor as any)?._offset;
      const nextCursor = nextOffset != null
        ? externalSearch || hasScope(scope) || unenforcedPath || limit !== DEFAULT_LIMIT
          ? session.externalCursors.put({
              kind: "grep",
              root: externalSearch?.root ?? cwd,
              query,
              constraints,
              pattern: searchPattern,
              position: nextOffset,
              limit,
              requestedPath: externalSearch?.requestedPath ?? params.path ?? "",
              suffix: externalSearch?.suffix ?? "",
              grepMode: mode,
              context,
              smartCase,
              scope,
              workspace: !externalSearch,
              unenforcedPath,
            })
          : String(nextOffset)
        : null;
      const fallbackHint = grepFallbackHint(result.value, pattern, params.path);
      const externalNotice = externalSearch
        ? `[External FFF index: root=${externalSearch.root}; ${externalSearch.created ? "new" : "reused"}${externalSearch.scanning ? "; scanning" : ""}]`
        : null;
      const unenforcedNotice = unenforcedPath
        ? `[Path ${unenforcedPath} is not an existing directory or file: FFF applies it as a fuzzy or glob filter that pi-fff cannot verify, so matches outside it are possible]`
        : null;
      const lines = [
        `## FFF grep: ${query}`,
        ...(externalNotice ? [externalNotice] : []),
        ...(unenforcedNotice ? [unenforcedNotice] : []),
        `Matched ${result.value.totalMatched}; searched ${result.value.totalFilesSearched}/${result.value.filteredFileCount} files${nextCursor ? `; cursor=${nextCursor}` : ""}`,
        "",
        ...(fallbackHint ? [fallbackHint, ""] : []),
        ...result.value.items.map((match: any) => `${match.relativePath}:${match.lineNumber}:${match.col}: ${match.lineContent}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kind: "grep", query, ...result.value, nextCursor, fallbackHint, externalSearch, ...(unenforcedPath ? { unenforcedPath } : {}) },
      };
      } finally {
        releaseExternal?.();
      }
    },
  });
}
