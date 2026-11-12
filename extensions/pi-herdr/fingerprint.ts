import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
export const PROJECT_FILES = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"] as const;
/** A symlinked tree deeper than this is not a source layout Pi loads; the guard only stops a link loop. */
const MAX_DEPTH = 12;

/** The agent dir this Pi loads; `PI_CODING_AGENT_DIR` is Pi's own override, the same one its runtime uses. */
export const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

const walk = (dir: string, out: string[], depth: number): void => {
  if (depth > MAX_DEPTH) return;
  let entries;
  // A source that is not there is simply absent from the fingerprint, not an error.
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { walk(path, out, depth + 1); continue; }
    // stat() follows a link: a symlinked source directory is walked and a symlinked file is stamped by its target.
    if (entry.isSymbolicLink() && statSync(path, { throwIfNoEntry: false })?.isDirectory()) { walk(path, out, depth + 1); continue; }
    out.push(path);
  }
};

const collect = (root: string, dirs: readonly string[], files: readonly string[], out: string[]): void => {
  for (const dir of dirs) walk(join(root, dir), out, 0);
  for (const file of files) out.push(join(root, file));
};

/**
 * The stamp of the agent dir's sources plus `projectDir`'s `.pi` sources. `fingerprint` is 16 hex
 * characters; the short form callers show is its first 8. Two Pis on the same machine compute the
 * same value for the same files, which is the point: it names the set, not a moment.
 */
export function sourceFingerprint(projectDir: string, agent = agentDir()): SourceFingerprint {
  const started = performance.now();
  const paths: string[] = [];
  collect(agent, AGENT_DIRS, AGENT_FILES, paths);
  collect(join(projectDir, ".pi"), PROJECT_DIRS, PROJECT_FILES, paths);
  paths.sort();
  const hash = createHash("sha1");
  let entries = 0;
  for (const path of paths) {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isDirectory()) continue; // a symlinked directory listed twice; its files carry the stamp
    hash.update(`${path}\0${stats ? `${Math.round(stats.mtimeMs)}:${stats.size}` : "-"}\n`);
    entries += 1;
  }
  return { fingerprint: hash.digest("hex").slice(0, 16), entries, ms: performance.now() - started };
}
