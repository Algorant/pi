import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * One cheap stamp of the sources a Pi actually loads, for the self-reload in `reload.ts`.
 *
 * It hashes each path with the file's mtime and size and never reads a file's contents, so one
 * turn-start check costs one directory walk (about 1 ms for this machine's ~200 entries) and no
 * child process, timer or watcher. A Pi that compares it with what it recorded at its last
 * session_start knows whether a turn would run on code that is no longer on disk.
 */
export type SourceFingerprint = { fingerprint: string; entries: number; ms: number };

/** Directories under the agent dir whose files Pi loads (and reloads). */
export const AGENT_DIRS = ["extensions", "skills", "prompts", "themes"] as const;
/** Files under the agent dir that change what loads, which models exist, or the keybindings a reload replaces. */
export const AGENT_FILES = ["settings.json", "config-manifest.json", "model-roles.json", "models.json", "keybindings.json"] as const;
/** The current project's own `.pi` resources; Pi loads these per session too. */
export const PROJECT_DIRS = ["extensions", "skills", "prompts", "themes"] as const;
export const PROJECT_FILES = ["settings.json", "AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"] as const;
/** A symlinked tree deeper than this is not a source layout Pi loads; the guard only stops a link loop. */
const MAX_DEPTH = 12;

/** The agent dir this Pi loads; `PI_CODING_AGENT_DIR` is Pi's own override, the same one its runtime uses. */
export const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const walk = (dir: string, out: string[], depth: number, skip?: ReadonlySet<string>): void => {
  if (depth > MAX_DEPTH) return;
  let entries;
  // A source that is not there is simply absent from the fingerprint, not an error.
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (skip?.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path, out, depth + 1, skip); continue; }
    // stat() follows a link: a symlinked source directory is walked and a symlinked file is stamped by its target.
    if (entry.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory()) { walk(path, out, depth + 1, skip); continue; }
    out.push(path);
  }
};

const collect = (root: string, dirs: readonly string[], files: readonly string[], out: string[]): void => {
  for (const dir of dirs) walk(join(root, dir), out, 0);
  for (const file of files) out.push(join(root, file));
};

/** Trees a declared extension directory never loads its own code from; skipped so a dependency install does not dominate the walk. */
const DECLARED_SKIP: ReadonlySet<string> = new Set(["node_modules", ".git"]);
const GLOB = /[*?[\]{}()]/;

/**
 * The local extension paths a project's `.pi/settings.json` declares, resolved as Pi resolves them:
 * relative to the project `.pi` directory, `~` and absolute allowed, `+path` an exact inclusion. `-path`,
 * `!pattern` and `builtin:` entries load nothing of their own and are skipped. A glob entry stamps the
 * directory its pattern starts in (a superset of what it matches, still only the declared tree). A file
 * entry is stamped as that file; a directory entry as every file under it, since the directory's own
 * imports are what Pi loads. Only the `extensions` field is read; trust and package sources are not touched.
 */
const declaredExtensions = (projectPi: string, out: string[]): void => {
  let entries: unknown;
  try { entries = JSON.parse(readFileSync(join(projectPi, "settings.json"), "utf8"))?.extensions; } catch { return; }
  if (!Array.isArray(entries)) return;
  for (const raw of entries) {
    if (typeof raw !== "string") continue;
    let entry = raw.startsWith("+") ? raw.slice(1) : raw;
    if (entry.startsWith("-") || entry.startsWith("!") || entry.startsWith("builtin:")) continue;
    if (entry === "~" || entry.startsWith("~/")) entry = join(homedir(), entry.slice(1));
    const segments = resolve(projectPi, entry).split("/");
    const plain = segments.findIndex((segment) => GLOB.test(segment));
    const path = plain < 0 ? segments.join("/") : segments.slice(0, plain).join("/") || "/";
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isDirectory()) walk(path, out, 0, DECLARED_SKIP);
    else out.push(path); // a file, or one that is not there yet: a missing path stamps as absent
  }
};

/**
 * The stamp of the agent dir's sources plus `projectDir`'s `.pi` sources and the local extension paths its `.pi/settings.json` declares. `fingerprint` is 16 hex
 * characters; the short form callers show is its first 8. Two Pis on the same machine compute the
 * same value for the same files, which is the point: it names the set, not a moment.
 */
export function sourceFingerprint(projectDir: string, agent = agentDir()): SourceFingerprint {
  const started = performance.now();
  const paths: string[] = [];
  collect(agent, AGENT_DIRS, AGENT_FILES, paths);
  collect(join(projectDir, ".pi"), PROJECT_DIRS, PROJECT_FILES, paths);
  declaredExtensions(join(projectDir, ".pi"), paths);
  paths.sort();
  const unique = [...new Set(paths)]; // a declared directory may also sit under a scanned one
  const hash = createHash("sha1");
  let entries = 0;
  for (const path of unique) {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isDirectory()) continue; // a symlinked directory listed twice; its files carry the stamp
    hash.update(`${path}\0${stats ? `${Math.round(stats.mtimeMs)}:${stats.size}` : "-"}\n`);
    entries += 1;
  }
  return { fingerprint: hash.digest("hex").slice(0, 16), entries, ms: performance.now() - started };
}
