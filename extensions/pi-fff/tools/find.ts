import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFffToolRenderer } from "../../pi-ui/tool-ui/custom-tools/fff";
import {
  routePathConstraint,
  suffixForAcquiredRoot,
  type ExternalSearch,
} from "../native/external";
import { buildQuery, clamp, isWeak, pageFromCursor } from "../query";
import { FIND_PROMPT_SNIPPET, findFallbackHint } from "./fallback";
import { collectExactPathItems, preparePathSearch } from "./path-search";
import { disposedToolResult, type FffSessionGetter } from "../session.ts";

export function registerFindTool(pi: ExtensionAPI, fallbackCwd: string, getSession: FffSessionGetter, notify?: (message: string) => void) {
  pi.registerTool({
    name: "find",
    exposure: "direct",
    label: "Find",
    description: "FFF-backed fuzzy file path search in the current workspace or an explicitly requested external path.",
    promptSnippet: FIND_PROMPT_SNIPPET,
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      exclude: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
      limit: Type.Optional(Type.Number()),
      cursor: Type.Optional(Type.String()),
    }),
    ...createFffToolRenderer("find"),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const session = getSession();
      if (!session?.isActive()) return disposedToolResult("find");
      const cwd = ctx?.cwd ?? fallbackCwd;
      let releaseExternal: (() => void) | undefined;
      try {
      const pattern = String(params.pattern || "");
      let limit = clamp(params.limit, 50, 1, 200);
      let page = pageFromCursor(params.cursor);
      let query = "";
      let finder: any = session.finder;
      let externalSearch: ExternalSearch | undefined;
      let exactFilePath: string | undefined;

      const resumed = session.externalCursors.get(params.cursor, "find");
      if (params.cursor?.startsWith("ext-") && !resumed) {
        return { content: [{ type: "text", text: "FFF find cursor expired; repeat the external search." }], details: { error: "expired-external-cursor" } };
      }

      try {
        if (resumed) {
          const acquired = await session.externalFinders.acquire(resumed.root, { exact: true });
          finder = acquired.finder;
          releaseExternal = acquired.release;
          page = resumed.position;
          limit = resumed.limit ?? limit;
          query = resumed.query;
          externalSearch = {
            requestedPath: resumed.requestedPath,
            root: acquired.root,
            suffix: resumed.suffix,
            created: acquired.created,
            reused: acquired.reused,
            scanning: acquired.scanning,
          };
        } else {
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
              tool: "find",
            });
            releaseExternal = prepared.release;
            if (!prepared.ok) {
              return { content: [{ type: "text", text: prepared.message }], details: prepared.details };
            }
            finder = prepared.finder;
            query = prepared.query;
            exactFilePath = route.kind === "file" ? prepared.expectedPath : undefined;
            externalSearch = prepared.externalSearch;
          } else if (route?.kind === "external") {
            const acquired = await session.externalFinders.acquire(route.root);
            finder = acquired.finder;
            releaseExternal = acquired.release;
            const suffix = suffixForAcquiredRoot(acquired.root, route.root, route.suffix);
            query = buildQuery(pattern, suffix || undefined, params.exclude, acquired.root);
            externalSearch = {
              requestedPath: route.requestedPath,
              root: acquired.root,
              suffix,
              created: acquired.created,
              reused: acquired.reused,
              scanning: acquired.scanning,
            };
          } else {
            query = buildQuery(pattern, params.path, params.exclude, cwd);
          }
        }
      } catch (error) {
        if (!session.isActive()) return disposedToolResult("find");
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `FFF find failed: ${message}` }], details: { error: message } };
      }

      if (!session.isActive()) return disposedToolResult("find");
      if (!query) return { content: [{ type: "text", text: "Error: pattern is required." }], details: { error: "missing-pattern" } };
      if (externalSearch?.created && session.isActive()) {
        const message = `FFF is indexing external root: ${externalSearch.root}${externalSearch.scanning ? " (indexing continues in the background)" : ""}`;
        if (notify) notify(message);
        else if (ctx?.hasUI) ctx.ui.notify(message, "info");
      }

      const result = await finder.find(query, page, limit);
      if (!session.isActive()) return disposedToolResult("find");
      if (!result.ok) {
        return { content: [{ type: "text", text: `FFF find failed: ${result.error}` }], details: { error: result.error, query, externalSearch } };
      }

      if (exactFilePath) {
        const exact = await collectExactPathItems({
          firstPage: result.value,
          expectedPath: exactFilePath,
          maxMatches: 1,
          pageSize: limit,
          startPosition: page,
          nextPosition: (value: any, position: number) => (position + 1) * limit < value.totalMatched ? position + 1 : null,
          fetchPage: (position) => finder.find(query, position, limit),
        });
        if (!session.isActive()) return disposedToolResult("find");
        if (!exact.ok) {
          return { content: [{ type: "text", text: `FFF find failed: ${exact.error}` }], details: { error: exact.error, query, externalSearch } };
        }
        result.value.items = exact.items;
        result.value.totalMatched = exact.items.length;
        result.value.totalFiles = 1;
      }

      const hasMore = (page + 1) * limit < result.value.totalMatched;
      const nextCursor = hasMore
        ? externalSearch
          ? session.externalCursors.put({ kind: "find", root: externalSearch.root, query, position: page + 1, limit, requestedPath: externalSearch.requestedPath, suffix: externalSearch.suffix })
          : String(page + 1)
        : null;
      const weak = isWeak(pattern, result.value.totalMatched, result.value.items.length);
      const fallbackHint = findFallbackHint(result.value, pattern, params.path);
      const externalNotice = externalSearch
        ? `[External FFF index: root=${externalSearch.root}; ${externalSearch.created ? "new" : "reused"}${externalSearch.scanning ? "; scanning" : ""}]`
        : null;
      const lines = [
        `## FFF find: ${query}`,
        ...(externalNotice ? [externalNotice] : []),
        `Matched ${result.value.totalMatched}/${result.value.totalFiles}${nextCursor ? `; cursor=${nextCursor}` : ""}${weak ? "; weak fuzzy match" : ""}`,
        "",
        ...(fallbackHint ? [fallbackHint, ""] : []),
        ...result.value.items.map((item: any, index: number) => `${index + 1 + page * limit}. ${item.relativePath}${item.gitStatus ? ` [${item.gitStatus}]` : ""}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kind: "find", query, ...result.value, nextCursor, weak, fallbackHint, externalSearch },
      };
      } finally {
        releaseExternal?.();
      }
    },
  });
}
