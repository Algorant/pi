import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { normalizePathFilter } from "../query";
import { NativeFffFinder } from "./finder";
import type { SearchScope } from "../tools/scope";

export const MAX_AUX_FINDERS = 3;
export const AUX_IDLE_TTL_MS = 5 * 60 * 1000;
const MAX_EXTERNAL_CURSORS = 200;

type FinderLike = Pick<NativeFffFinder, "ensure" | "destroy" | "progress" | "find" | "grep" | "multiGrep" | "glob"> & {
  cwd: string;
};

type PoolEntry = {
  root: string;
  finder: FinderLike;
  lastUsed: number;
  inUse: number;
};

type AcquiredFinder = {
  finder: FinderLike;
  root: string;
  created: boolean;
  reused: boolean;
  scanning: boolean;
  release: () => void;
};

export type ExternalSearch = {
  requestedPath: string;
  root: string;
  suffix: string;
  created: boolean;
  reused: boolean;
  scanning: boolean;
};

export type ExternalRoute = {
  kind: "external";
  requestedPath: string;
  absolutePath: string;
  root: string;
  suffix: string;
} | {
  kind: "file";
  requestedPath: string;
  absolutePath: string;
  root: string;
  suffix: string;
  external: boolean;
} | {
  kind: "directory";
  requestedPath: string;
  absolutePath: string;
  root: string;
  suffix: string;
  external: boolean;
} | {
  kind: "unsafe";
  requestedPath: string;
  root: string;
  reason: string;
};

export type ExternalCursorState = {
  kind: "find" | "grep";
  root: string;
  query: string;
  /** Grep only: the query's scope tokens and the pattern, kept apart for the literal search. */
  constraints?: string;
  pattern?: string;
  position: number;
  limit?: number;
  requestedPath: string;
  suffix: string;
  grepMode?: "plain" | "regex" | "fuzzy";
  context?: number;
  smartCase?: boolean;
  scope?: SearchScope;
  /** Grep cursor over the session's workspace finder instead of an external root. */
  workspace?: boolean;
  unenforcedPath?: string;
};

function rootCovers(root: string, target: string): boolean {
  if (root === target) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

export class AuxFinderPool {
  private entries: PoolEntry[] = [];
  private acquireGate: Promise<void> = Promise.resolve();
  private generation = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly createFinder: (root: string) => FinderLike = (root) => {
      const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16);
      return new NativeFffFinder(root, join("external", key), root);
    },
    private readonly now: () => number = Date.now,
    private readonly maxFinders = MAX_AUX_FINDERS,
    private readonly idleTtlMs = AUX_IDLE_TTL_MS,
  ) {}

  private sweepIdle(): void {
    const now = this.now();
    const kept: PoolEntry[] = [];
    for (const entry of this.entries) {
      if (entry.inUse === 0 && now - entry.lastUsed > this.idleTtlMs) entry.finder.destroy();
      else kept.push(entry);
    }
    this.entries = kept;
  }

  // One unref'd timer enforces the idle TTL without waiting for the next
  // acquire()/size(): it fires when the earliest idle entry expires and re-arms
  // while entries remain. Busy entries are covered by the re-arm on release.
  private scheduleSweep(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const now = this.now();
    let next = Infinity;
    for (const entry of this.entries) {
      if (entry.inUse === 0) next = Math.min(next, entry.lastUsed + this.idleTtlMs - now);
    }
    if (next === Infinity) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.sweepIdle();
      this.scheduleSweep();
    }, Math.max(next + 1, 1));
    this.idleTimer.unref();
  }

  private lease(entry: PoolEntry, created: boolean, scanning: boolean): AcquiredFinder {
    entry.inUse++;
    let released = false;
    return {
      finder: entry.finder,
      root: entry.root,
      created,
      reused: !created,
      scanning,
      release: () => {
        if (released) return;
        released = true;
        entry.inUse = Math.max(0, entry.inUse - 1);
        entry.lastUsed = this.now();
        this.scheduleSweep();
      },
    };
  }

  async acquire(requestedRoot: string, options?: { exact?: boolean }): Promise<AcquiredFinder> {
    const generation = this.generation;
    let unlock!: () => void;
    const previous = this.acquireGate;
    this.acquireGate = new Promise<void>((resolveGate) => { unlock = resolveGate; });
    await previous;
    try {
      if (generation !== this.generation) throw new Error("External FFF finder pool was disposed");
      const acquired = await this.acquireUnlocked(requestedRoot, options);
      if (generation !== this.generation) {
        acquired.release();
        const stale = this.entries.find((entry) => entry.finder === acquired.finder);
        if (stale) {
          stale.finder.destroy();
          this.entries = this.entries.filter((entry) => entry !== stale);
        }
        this.scheduleSweep();
        throw new Error("External FFF finder pool was disposed during acquisition");
      }
      return acquired;
    } finally {
      unlock();
    }
  }

  private async acquireUnlocked(requestedRoot: string, options?: { exact?: boolean }): Promise<AcquiredFinder> {
    this.sweepIdle();
    let covering: PoolEntry | undefined;
    for (const entry of this.entries) {
      const matches = options?.exact ? entry.root === requestedRoot : rootCovers(entry.root, requestedRoot);
      if (!matches) continue;
      if (!covering || entry.root.length > covering.root.length) covering = entry;
    }

    if (covering) {
      covering.lastUsed = this.now();
      const progress = await covering.finder.progress();
      return this.lease(covering, false, progress.ok && Boolean((progress.value as any)?.isScanning));
    }

    if (this.entries.length >= this.maxFinders) {
      const idle = this.entries.filter((entry) => entry.inUse === 0);
      if (!idle.length) throw new Error("All external FFF indexes are busy; retry the search.");
      const oldest = idle.reduce((candidate, entry) => entry.lastUsed < candidate.lastUsed ? entry : candidate);
      oldest.finder.destroy();
      this.entries = this.entries.filter((entry) => entry !== oldest);
    }

    const finder = this.createFinder(requestedRoot);
    const initialized = await finder.ensure();
    if (!initialized.ok) {
      finder.destroy();
      throw new Error(`Failed to create external FFF index for ${requestedRoot}: ${initialized.error}`);
    }
    const progress = await finder.progress();
    const entry = { root: requestedRoot, finder, lastUsed: this.now(), inUse: 0 };
    this.entries.push(entry);
    return this.lease(entry, true, progress.ok && Boolean((progress.value as any)?.isScanning));
  }

  size(): number {
    this.sweepIdle();
    return this.entries.length;
  }

  destroy(): void {
    this.generation += 1;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const entry of this.entries) entry.finder.destroy();
    this.entries = [];
  }
}

export function resolveExternalRoot(absolutePath: string): { root: string; suffix: string } | null {
  const trimmed = normalize(absolutePath.trim()).replace(/\/+$/, "") || sep;
  if (!isAbsolute(trimmed)) return null;
  if (trimmed === sep) return { root: sep, suffix: "" };

  const parts = trimmed.split(sep);
  const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
  const boundary = firstGlob === -1 ? parts.length : firstGlob;

  for (let index = boundary; index > 0; index--) {
    const candidate = parts.slice(0, index).join(sep) || sep;
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        return {
          root: parts.slice(0, index - 1).join(sep) || sep,
          suffix: parts.slice(index - 1).join("/"),
        };
      }
      if (stat.isDirectory()) {
        return { root: candidate, suffix: parts.slice(index).join("/") };
      }
    } catch {
      // Continue toward the nearest existing ancestor.
    }
  }
  return null;
}

export function routePathConstraint(pathConstraint: string | undefined, cwd: string): ExternalRoute | null {
  if (!pathConstraint?.trim()) return null;
  const requestedPath = pathConstraint.trim();

  const locallyNormalized = normalizePathFilter(requestedPath, cwd);
  let candidate = locallyNormalized;
  if (!isAbsolute(candidate)) candidate = resolve(cwd, candidate);
  let isFile = false;
  let isDirectory = false;
  try {
    const stat = statSync(candidate);
    isFile = stat.isFile();
    isDirectory = stat.isDirectory();
  } catch {
    // Nonexistent and glob constraints continue through normal path routing.
  }

  const workspaceRoot = resolve(cwd);
  const relativeToWorkspace = relative(workspaceRoot, candidate);
  const insideWorkspace = relativeToWorkspace !== ".." && !relativeToWorkspace.startsWith(`..${sep}`) && !isAbsolute(relativeToWorkspace);
  if (insideWorkspace) {
    const suffix = relativeToWorkspace.replaceAll(sep, "/");
    if (isFile) return {
      kind: "file",
      requestedPath,
      absolutePath: candidate,
      root: workspaceRoot,
      suffix,
      external: false,
    };
    return isDirectory ? {
      kind: "directory",
      requestedPath,
      absolutePath: candidate,
      root: workspaceRoot,
      suffix,
      external: false,
    } : null;
  }

  const resolved = resolveExternalRoot(candidate);
  if (!resolved) {
    return { kind: "unsafe", requestedPath, root: candidate, reason: "No existing external directory could be resolved." };
  }

  const home = resolve(homedir());
  if (resolved.root === sep) {
    return {
      kind: "unsafe",
      requestedPath,
      root: resolved.root,
      reason: isFile
        ? `${candidate} is not indexed by FFF. Use the read tool to inspect this file.`
        : "Filesystem-root indexing is disabled; choose a narrower external path.",
    };
  }
  if (resolve(resolved.root) === home) {
    return {
      kind: "unsafe",
      requestedPath,
      root: resolved.root,
      reason: isFile
        ? `${candidate} is not indexed by FFF. Use the read tool to inspect this file.`
        : "Home-directory indexing is disabled; choose a narrower external path.",
    };
  }

  if (isFile) return { kind: "file", requestedPath, absolutePath: candidate, ...resolved, external: true };
  if (isDirectory) return { kind: "directory", requestedPath, absolutePath: candidate, ...resolved, external: true };
  return { kind: "external", requestedPath, absolutePath: candidate, ...resolved };
}

export function suffixForAcquiredRoot(acquiredRoot: string, requestedRoot: string, suffix: string): string {
  const prefix = relative(acquiredRoot, requestedRoot).replaceAll(sep, "/");
  return [prefix, suffix].filter(Boolean).join("/");
}

export class ExternalCursorStore {
  private readonly cursors = new Map<string, { state: ExternalCursorState; lastUsed: number }>();
  private serial = 0;

  private sweep(): void {
    const cutoff = Date.now() - AUX_IDLE_TTL_MS;
    for (const [token, entry] of this.cursors) if (entry.lastUsed < cutoff) this.cursors.delete(token);
    while (this.cursors.size > MAX_EXTERNAL_CURSORS) this.cursors.delete(this.cursors.keys().next().value as string);
  }

  put(state: ExternalCursorState): string {
    this.sweep();
    const token = `ext-${Date.now().toString(36)}-${(++this.serial).toString(36)}`;
    this.cursors.set(token, { state, lastUsed: Date.now() });
    while (this.cursors.size > MAX_EXTERNAL_CURSORS) this.cursors.delete(this.cursors.keys().next().value as string);
    return token;
  }

  get(token: string | undefined, kind: ExternalCursorState["kind"]): ExternalCursorState | null {
    if (!token?.startsWith("ext-")) return null;
    this.sweep();
    const entry = this.cursors.get(token);
    if (!entry || entry.state.kind !== kind) return null;
    entry.lastUsed = Date.now();
    return entry.state;
  }

  clear(): void {
    this.cursors.clear();
  }
}
