import { homedir } from "node:os";
import { resolve } from "node:path";
import { normalizeExcludes } from "../query";
import { fileConstraint, subtreeConstraint, type SearchScope } from "./scope";
import {
  suffixForAcquiredRoot,
  type AuxFinderPool,
  type ExternalRoute,
  type ExternalSearch,
} from "../native/external";

type IndexedPathRoute = Extract<ExternalRoute, { kind: "file" | "directory" }>;

type ResolvedPathSearch = {
  ok: true;
  finder: any;
  query: string;
  /** The query's scope tokens without the pattern. */
  constraints: string;
  expectedPath: string;
  /** The directory ("" for a file) and exclusions every returned match must satisfy. */
  scope: SearchScope;
  externalSearch?: ExternalSearch;
  release?: () => void;
} | {
  ok: false;
  message: string;
  details: Record<string, unknown>;
  release?: () => void;
};

export async function preparePathSearch(options: {
  route: IndexedPathRoute;
  cwd: string;
  pattern: string;
  exclude?: string | string[];
  finder: any;
  externalFinders: AuxFinderPool;
  tool: "find" | "grep";
}): Promise<ResolvedPathSearch> {
  let finder = options.finder;
  let searchRoot = options.cwd;
  let suffix = options.route.suffix;
  let release: (() => void) | undefined;
  let externalSearch: ExternalSearch | undefined;

  try {
    if (options.route.external) {
      const acquired = await options.externalFinders.acquire(options.route.root);
      finder = acquired.finder;
      release = acquired.release;
      searchRoot = acquired.root;
      suffix = suffixForAcquiredRoot(acquired.root, options.route.root, options.route.suffix);
      externalSearch = {
        requestedPath: options.route.requestedPath,
        root: acquired.root,
        suffix,
        created: acquired.created,
        reused: acquired.reused,
        scanning: acquired.scanning,
      };
    }

    const isDirectory = options.route.kind === "directory";
    const indexed = await finder.glob(isDirectory ? `${suffix ? `${suffix}/` : ""}**` : suffix);
    if (!indexed.ok) {
      return { ok: false, message: `FFF ${options.tool} failed: ${indexed.error}`, details: { error: indexed.error }, release };
    }
    const indexedPath = isDirectory
      ? indexed.value.items.some((item: any) => item.relativePath.startsWith(suffix ? `${suffix}/` : ""))
      : indexed.value.items.some((item: any) => item.relativePath === suffix);
    if (!indexedPath) {
      const sessionsPath = resolve(homedir(), ".pi", "sessions");
      const isSessionsPath = options.route.absolutePath === sessionsPath;
      const guidance = isSessionsPath
        ? " For past Pi conversations, use the bounded ~/.pi/sessions transcript recipe in the global tool-use policy."
        : " Use the read tool to inspect a known file.";
      const message = `${options.route.absolutePath} is not indexed by FFF.${guidance}`;
      return {
        ok: false,
        message: `FFF ${options.tool} refused: ${message}`,
        details: { error: isDirectory ? "unindexed-directory-path" : "unindexed-file-path", requestedPath: options.route.requestedPath, absolutePath: options.route.absolutePath },
        release,
      };
    }

    const excludes = normalizeExcludes(options.exclude, searchRoot);
    const pattern = options.pattern.trim();
    if (!isDirectory) {
      const file = fileConstraint(suffix);
      if (!file.ok) {
        return {
          ok: false,
          message: `FFF ${options.tool} refused: ${file.reason} Use the read tool to inspect this file.`,
          details: { error: "unsupported-file-path", requestedPath: options.route.requestedPath, absolutePath: options.route.absolutePath },
          release,
        };
      }
      return {
        ok: true,
        finder,
        query: [file.token, ...excludes, pattern].filter(Boolean).join(" "),
        constraints: [file.token, ...excludes].join(" "),
        expectedPath: suffix,
        scope: { subtree: "", excludes },
        externalSearch,
        release,
      };
    }

    // FFF's `dir/` token matches that segment at any depth (`x/dir/...` too), so
    // an existing directory is anchored to the index root with a `dir/**` glob.
    const subtree = subtreeConstraint(suffix);
    if (!subtree.ok) {
      return {
        ok: false,
        message: `FFF ${options.tool} refused: ${subtree.reason} Use the read tool to inspect known files there.`,
        details: { error: "unsupported-directory-path", requestedPath: options.route.requestedPath, absolutePath: options.route.absolutePath },
        release,
      };
    }
    return {
      ok: true,
      finder,
      query: [subtree.token, ...excludes, pattern].filter(Boolean).join(" "),
      constraints: [subtree.token, ...excludes].filter(Boolean).join(" "),
      expectedPath: "",
      scope: { subtree: suffix, excludes },
      externalSearch,
      release,
    };
  } catch (error) {
    release?.();
    throw error;
  }
}

/** Collect an exact-path result page while advancing over fuzzy path false positives. */
export async function collectExactPathItems<TPage extends { items: any[] }>(options: {
  firstPage: TPage;
  expectedPath: string;
  maxMatches: number;
  pageSize: number;
  stopOnMatch?: boolean;
  startPosition: number;
  nextPosition: (page: TPage, position: number) => number | null;
  fetchPage: (position: number, pageSize: number) => Promise<{ ok: true; value: TPage } | { ok: false; error: string }>;
}): Promise<{ ok: true; items: any[]; nextPosition: number | null } | { ok: false; error: string }> {
  const items: any[] = [];
  let page = options.firstPage;
  let position = options.startPosition;

  while (true) {
    const matches = page.items.filter((item: any) => item.relativePath === options.expectedPath);
    items.push(...matches);
    const next = options.nextPosition(page, position);
    if ((options.stopOnMatch && matches.length > 0) || items.length >= options.maxMatches || next === null) {
      return { ok: true, items, nextPosition: null };
    }

    const fetched = await options.fetchPage(next, options.pageSize);
    if (!fetched.ok) return fetched;
    page = fetched.value;
    position = next;
  }
}
