#!/usr/bin/env bun
/**
 * pi-session-archive - manual, per-machine Pi session archive.
 *
 * A small operator tool, not a scheduler, extension, or backup service. It
 * moves Pi session JSONL files whose filesystem mtime is older than a cutoff
 * out of their live session roots and into a per-machine archive tree, and it
 * restores one exact archived file on request.
 *
 * Guarantees:
 *   - Preview is the default action and writes nothing.
 *   - Archived bytes are identical by construction: a move is a hardlink
 *     publish into the archive followed by unlinking the source, so the same
 *     inode (and therefore the same bytes) is relocated.
 *   - Nothing is ever permanently deleted: unlink happens only after the same
 *     inode is reachable at the other path.
 *   - Collisions, non-session files, symlinks, unsafe roots, ambiguous
 *     restores, and cross-filesystem roots all fail closed without overwriting.
 *
 * Archive and restore run while Pi may be open. A session that is still open
 * and appends after its file was archived writes to the original path, so that
 * history splits between the archive copy and the new file at the original
 * path. Algorant accepted that risk in exchange for running the tool without a
 * shutdown; the tool performs no coordination or cleanup for it.
 *
 *   pi-session-archive.ts --help
 *   pi-session-archive.ts [preview] [--days N] [--root DIR ...] [--json]
 *   pi-session-archive.ts archive  [--days N] [--root DIR ...] [--json]
 *   pi-session-archive.ts restore <archived-file> [--root DIR ...] [--json]
 */
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Per-machine state stays private even when the invoking shell has a loose umask.
process.umask(0o077);

export const DEFAULT_DAYS = 60;
const MAX_HEADER_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

const HELP = `pi-session-archive - manual archive of Pi session JSONL files

Usage:
  pi-session-archive.ts [preview] [options]          list candidates, write nothing
  pi-session-archive.ts archive  [options]           move candidates into the archive
  pi-session-archive.ts restore <archived-file> [options]
                                                     move one archived file back
  pi-session-archive.ts --help

Options:
  --root DIR           session root (repeatable; default: $PI_CODING_AGENT_SESSION_DIR,
                       otherwise <agent-dir>/sessions where agent-dir is
                       $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --archive-root DIR   archive root (default: ~/.pi/sessions_archive)
  --days N             archive sessions whose filesystem mtime is older than N
                       days (default: ${DEFAULT_DAYS})
  --json               machine-readable output

Archive layout:
  <archive-root>/<absolute-root-path-without-leading-separator>/<root-relative-path>
  The mirrored path is lossless, so an archived file keeps its original
  absolute location and restore never has to guess.

Safety:
  Requires one filesystem for every source root and the archive root (the move
  is a hardlink). Never overwrites and never permanently deletes: source bytes
  are unlinked only after the same inode is published in the archive, and vice
  versa for restore.

Running while Pi is open is allowed. A still-open session that appends after
archival writes to the original path, splitting its history between the archive
and that new file; the tool does not prevent, detect, or clean that up.`;

export class ArchiveError extends Error {}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface Deps {
  now: () => number;
}

const defaultIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const defaultDeps: Deps = {
  now: () => Date.now(),
};

export function defaultArchiveRoot(): string {
  return join(homedir(), ".pi", "sessions_archive");
}

/** Explicit roots win; then the native session-dir env; then the agent default. */
export function defaultRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PI_CODING_AGENT_SESSION_DIR;
  if (configured !== undefined) {
    if (configured.trim().length === 0) {
      throw new ArchiveError("PI_CODING_AGENT_SESSION_DIR is set but empty; pass --root explicitly or unset it");
    }
    return [resolve(configured)];
  }
  const agentDir = env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.length > 0 ? env.PI_CODING_AGENT_DIR : join(homedir(), ".pi", "agent");
  return [resolve(join(agentDir, "sessions"))];
}

type Command = "preview" | "archive" | "restore";

interface ParsedArgs {
  command: Command;
  restoreFile: string | null;
  roots: string[];
  archiveRoot: string;
  days: number;
  json: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: "preview",
    restoreFile: null,
    roots: [],
    archiveRoot: defaultArchiveRoot(),
    days: DEFAULT_DAYS,
    json: false,
    help: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new ArchiveError(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--root") {
      const dir = value().trim();
      if (dir.length === 0) throw new ArchiveError("--root requires a non-empty path");
      parsed.roots.push(resolve(dir));
    } else if (arg === "--archive-root") {
      const dir = value().trim();
      if (dir.length === 0) throw new ArchiveError("--archive-root requires a non-empty path");
      parsed.archiveRoot = resolve(dir);
    } else if (arg === "--days") {
      const raw = value().trim();
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new ArchiveError("--days requires a positive integer");
      parsed.days = Number(raw);
    } else if (arg.startsWith("-")) {
      throw new ArchiveError(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (parsed.help) return parsed;
  const first = positionals[0];
  if (first === "preview" || first === "archive" || first === "restore") {
    parsed.command = first;
    positionals.shift();
  } else if (first !== undefined) {
    throw new ArchiveError(`unknown command: ${first}`);
  }

  if (parsed.command === "restore") {
    if (positionals.length !== 1) throw new ArchiveError("restore requires exactly one archived file path");
    parsed.restoreFile = resolve(positionals[0]!);
  } else if (positionals.length > 0) {
    throw new ArchiveError(`${parsed.command} takes no positional arguments`);
  }

  if (parsed.roots.length === 0) parsed.roots = defaultRoots();
  return parsed;
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertPlainDir(dir: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch {
    throw new ArchiveError(`${label} does not exist: ${dir}`);
  }
  if (stats.isSymbolicLink()) throw new ArchiveError(`${label} is a symlink: ${dir}`);
  if (!stats.isDirectory()) throw new ArchiveError(`${label} is not a directory: ${dir}`);
}

/** Lossless mirror of an absolute root below the archive root. */
function mirrorRoot(root: string): string {
  return root.replace(/^\/+/, "");
}

function archivePrefix(archiveRoot: string, root: string): string {
  return join(archiveRoot, mirrorRoot(root));
}

function archivePathFor(archiveRoot: string, root: string, file: string): string {
  return join(archivePrefix(archiveRoot, root), relative(root, file));
}

/** Reject roots that cannot be safely or unambiguously archived from. */
function validateRoots(roots: string[], archiveRoot: string): void {
  const home = resolve(homedir());
  const seen = new Set<string>();
  for (const root of roots) {
    if (root === "/" || root === home) throw new ArchiveError(`unsafe session root (too broad): ${root}`);
    if (seen.has(root)) throw new ArchiveError(`duplicate session root: ${root}`);
    seen.add(root);
    assertPlainDir(root, "session root");
    if (root === archiveRoot) throw new ArchiveError(`unsafe roots: session root and archive root are the same directory (${root})`);
    if (isContained(root, archiveRoot) || isContained(archiveRoot, root)) {
      throw new ArchiveError(`unsafe roots: archive root and session root overlap (${archiveRoot} vs ${root})`);
    }
  }
  for (const a of roots) {
    for (const b of roots) {
      if (a !== b && isContained(a, b)) throw new ArchiveError(`overlapping session roots are ambiguous: ${a} contains ${b}`);
    }
  }
}

function ensureArchiveRoot(archiveRoot: string): void {
  let stats;
  try {
    stats = lstatSync(archiveRoot);
  } catch {
    mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    return;
  }
  if (stats.isSymbolicLink()) throw new ArchiveError(`archive root is a symlink: ${archiveRoot}`);
  if (!stats.isDirectory()) throw new ArchiveError(`archive root is not a directory: ${archiveRoot}`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) throw new ArchiveError(`archive root is not owned by the current user: ${archiveRoot}`);
  if ((stats.mode & 0o077) !== 0) {
    throw new ArchiveError(`archive root is not private (mode ${(stats.mode & 0o777).toString(8)}); expected 0700 with no group/other access`);
  }
}

/**
 * Validate one directory component without following symlinks. Archive
 * components must also be private (0700); restore destination components are
 * Pi-owned and only need to be plain, user-owned directories.
 */
function ensureComponent(dir: string, privateDir: boolean, label: string): void {
  let stats;
  try {
    stats = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dir, { mode: 0o700 });
    return;
  }
  if (stats.isSymbolicLink()) throw new ArchiveError(`${label} component is a symlink: ${dir}`);
  if (!stats.isDirectory()) throw new ArchiveError(`${label} component is not a directory: ${dir}`);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) throw new ArchiveError(`${label} component is not owned by the current user: ${dir}`);
  if (privateDir && (stats.mode & 0o077) !== 0) {
    throw new ArchiveError(`${label} component is not private (mode ${(stats.mode & 0o777).toString(8)}): ${dir}`);
  }
}

/** Walk from `base` down to `dir`, validating every component and creating missing ones privately. */
function ensureTree(base: string, dir: string, privateDir: boolean, label: string): void {
  const rel = relative(base, dir);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel)) throw new ArchiveError(`${label} escapes its base: ${dir}`);
  let current = base;
  for (const part of rel.split(sep)) {
    if (part === "" || part === ".") continue;
    current = join(current, part);
    ensureComponent(current, privateDir, label);
  }
}

function readHeaderLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_HEADER_BYTES);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    closeSync(fd);
  }
}

/** Validate a file is a session JSONL using only its bounded first line. */
function assertSessionFile(file: string): void {
  let header: string;
  try {
    header = readHeaderLine(file);
  } catch {
    throw new ArchiveError(`cannot read session header: ${file}`);
  }
  if (header.trim().length === 0) throw new ArchiveError(`empty session file: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(header);
  } catch {
    throw new ArchiveError(`session header is not valid JSON: ${file}`);
  }
  const type = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).type : undefined;
  if (type !== "session") throw new ArchiveError(`not a Pi session file (header type ${JSON.stringify(type)}): ${file}`);
}

function collectSessionFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) throw new ArchiveError(`symlink found under session root: ${full}`);
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stats.isFile()) throw new ArchiveError(`non-regular file under session root: ${full}`);
      if (!entry.name.endsWith(".jsonl")) throw new ArchiveError(`non-session file under session root: ${full}`);
      assertSessionFile(full);
      found.push(full);
    }
  };
  walk(root);
  return found;
}

/** Publish `source` at `dest` as the same inode, then durably record it. */
function publishLink(source: string, dest: string): "linked" | "exists" {
  try {
    linkSync(source, dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return "exists";
    if (code === "EXDEV") {
      throw new ArchiveError(`archive root is on a different filesystem than ${source}; a hardlink move requires one filesystem`);
    }
    throw error;
  }
  return "linked";
}

/** Directory fsync makes the new directory entry durable before the unlink. */
function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch (error) {
    throw new ArchiveError(`cannot open ${dir} to fsync: ${(error as Error).message}`);
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    throw new ArchiveError(`cannot fsync ${dir}; refusing to continue without durable metadata: ${(error as Error).message}`);
  } finally {
    closeSync(fd);
  }
}

function assertSameInode(a: string, b: string): void {
  const left = statSync(a);
  const right = statSync(b);
  if (left.dev !== right.dev || left.ino !== right.ino) {
    throw new ArchiveError(`published archive entry does not match its source: ${b}`);
  }
}

/** Existing destination inode, or null; symlinks and non-files fail closed. */
function destinationInode(dest: string): { dev: number; ino: number } | null {
  let stats;
  try {
    stats = lstatSync(dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (stats.isSymbolicLink()) throw new ArchiveError(`archive destination is a symlink: ${dest}`);
  if (!stats.isFile()) throw new ArchiveError(`archive destination is not a regular file: ${dest}`);
  return { dev: stats.dev, ino: stats.ino };
}

interface Candidate {
  root: string;
  file: string;
  archiveFile: string;
  sizeBytes: number;
  mtimeMs: number;
}

function findCandidates(roots: string[], archiveRoot: string, days: number, now: number): { candidates: Candidate[]; scanned: number } {
  const cutoff = now - days * DAY_MS;
  const candidates: Candidate[] = [];
  let scanned = 0;
  for (const root of roots) {
    for (const file of collectSessionFiles(root)) {
      scanned += 1;
      const stats = statSync(file);
      if (stats.mtimeMs >= cutoff) continue;
      candidates.push({
        root,
        file,
        archiveFile: archivePathFor(archiveRoot, root, file),
        sizeBytes: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }
  return { candidates, scanned };
}

function formatDays(ms: number): string {
  return (ms / DAY_MS).toFixed(1);
}

function previewReport(io: Io, config: ParsedArgs, candidates: Candidate[], scanned: number, now: number): void {
  const cutoff = now - config.days * DAY_MS;
  if (config.json) {
    io.out(
      JSON.stringify(
        {
          action: "preview",
          roots: config.roots,
          archiveRoot: config.archiveRoot,
          days: config.days,
          cutoff: new Date(cutoff).toISOString(),
          scanned,
          candidates: candidates.map((candidate) => ({
            path: candidate.file,
            root: candidate.root,
            relativePath: relative(candidate.root, candidate.file),
            archivePath: candidate.archiveFile,
            sizeBytes: candidate.sizeBytes,
            mtime: new Date(candidate.mtimeMs).toISOString(),
            ageDays: Number(formatDays(now - candidate.mtimeMs)),
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  const lines = [
    "Pi session archive (preview, no changes)",
    `  roots:        ${config.roots.join(", ")}`,
    `  archive root: ${config.archiveRoot}`,
    `  cutoff:       ${config.days} days (mtime before ${new Date(cutoff).toISOString()})`,
    `  scanned:      ${scanned} session file(s)`,
    `  candidates:   ${candidates.length}`,
  ];
  for (const candidate of candidates) {
    lines.push(
      `    ${relative(candidate.root, candidate.file)}  ${candidate.sizeBytes} B  age ${formatDays(now - candidate.mtimeMs)}d -> ${candidate.archiveFile}`,
    );
  }
  lines.push(`  recent:       ${scanned - candidates.length}`);
  io.out(lines.join("\n"));
}

function runArchive(io: Io, config: ParsedArgs, candidates: Candidate[]): void {
  ensureArchiveRoot(config.archiveRoot);
  const destinations = new Set<string>();
  for (const candidate of candidates) {
    if (destinations.has(candidate.archiveFile)) {
      throw new ArchiveError(`two sources map to one archive path: ${candidate.archiveFile}`);
    }
    destinations.add(candidate.archiveFile);
    ensureTree(config.archiveRoot, dirname(candidate.archiveFile), true, "archive path");
  }
  for (const candidate of candidates) {
    const existing = destinationInode(candidate.archiveFile);
    if (existing === null) continue;
    const source = statSync(candidate.file);
    if (existing.dev !== source.dev || existing.ino !== source.ino) {
      throw new ArchiveError(`archive collision, refusing to overwrite: ${candidate.archiveFile}`);
    }
  }

  const archived: Array<Record<string, unknown>> = [];
  const completed: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const published = publishLink(candidate.file, candidate.archiveFile);
    assertSameInode(candidate.file, candidate.archiveFile);
    syncDir(dirname(candidate.archiveFile));
    unlinkSync(candidate.file);
    syncDir(dirname(candidate.file));
    const record = { path: candidate.file, archivePath: candidate.archiveFile, sizeBytes: candidate.sizeBytes };
    (published === "linked" ? archived : completed).push(record);
  }

  if (config.json) {
    io.out(JSON.stringify({ action: "archive", roots: config.roots, archiveRoot: config.archiveRoot, archived, completed }, null, 2));
    return;
  }
  const lines = [
    `Archived ${archived.length} session file(s); completed ${completed.length} pending move(s).`,
    `  archive root: ${config.archiveRoot}`,
  ];
  for (const record of archived) lines.push(`    moved    ${record.path} -> ${record.archivePath}`);
  for (const record of completed) lines.push(`    finished ${record.path} -> ${record.archivePath}`);
  io.out(lines.join("\n"));
}

function resolveRestore(config: ParsedArgs, file: string): { original: string } {
  if (!isContained(config.archiveRoot, file)) {
    throw new ArchiveError(`restore target is not inside the archive root: ${file}`);
  }
  const matches: Array<{ root: string; original: string }> = [];
  for (const root of config.roots) {
    const prefix = archivePrefix(config.archiveRoot, root);
    if (!isContained(prefix, file)) continue;
    matches.push({ root, original: join(root, relative(prefix, file)) });
  }
  if (matches.length === 0) {
    throw new ArchiveError(`no configured --root matches ${file}; pass the original session root explicitly`);
  }
  if (matches.length > 1) {
    throw new ArchiveError(`ambiguous --root for ${file}: ${matches.map((match) => match.root).join(", ")}`);
  }
  return { original: matches[0]!.original };
}

function runRestore(io: Io, config: ParsedArgs, file: string): void {
  ensureArchiveRoot(config.archiveRoot);
  assertPlainDir(dirname(file), "archived directory");
  const stats = lstatSync(file);
  if (stats.isSymbolicLink()) throw new ArchiveError(`restore target is a symlink: ${file}`);
  if (!stats.isFile()) throw new ArchiveError(`restore target is not a regular file: ${file}`);
  if (!file.endsWith(".jsonl")) throw new ArchiveError(`restore target is not a session file: ${file}`);
  assertSessionFile(file);

  const { original } = resolveRestore(config, file);
  const root = config.roots.find((candidate) => isContained(archivePrefix(config.archiveRoot, candidate), file));
  if (root === undefined) throw new ArchiveError(`no configured --root matches ${file}`);
  assertPlainDir(root, "session root");
  if (isContained(root, config.archiveRoot) || isContained(config.archiveRoot, root)) {
    throw new ArchiveError(`unsafe roots: archive root and session root overlap (${config.archiveRoot} vs ${root})`);
  }

  ensureTree(config.archiveRoot, dirname(file), true, "archive path");
  ensureTree(root, dirname(original), false, "restore destination");
  const existing = destinationInode(original);
  if (existing !== null) {
    if (existing.dev !== stats.dev || existing.ino !== stats.ino) {
      throw new ArchiveError(`restore collision, refusing to overwrite: ${original}`);
    }
    syncDir(dirname(original));
  } else {
    publishLink(file, original);
    assertSameInode(file, original);
    syncDir(dirname(original));
  }
  unlinkSync(file);
  syncDir(dirname(file));

  if (config.json) {
    io.out(JSON.stringify({ action: "restore", archivePath: file, originalPath: original }, null, 2));
    return;
  }
  io.out(`Restored ${file} -> ${original}`);
}

export async function main(argv: string[], io: Io = defaultIo, deps: Partial<Deps> = {}): Promise<number> {
  const now = deps.now ?? defaultDeps.now;

  let config: ParsedArgs;
  try {
    config = parseArgs(argv);
  } catch (error) {
    io.err(`error: ${(error as Error).message}`);
    io.err("");
    io.err(HELP);
    return 2;
  }
  if (config.help) {
    io.out(HELP);
    return 0;
  }

  try {
    validateRoots(config.roots, config.archiveRoot);
    const nowMs = now();

    if (config.command === "preview") {
      const { candidates, scanned } = findCandidates(config.roots, config.archiveRoot, config.days, nowMs);
      previewReport(io, config, candidates, scanned, nowMs);
      return 0;
    }
    if (config.command === "archive") {
      const { candidates } = findCandidates(config.roots, config.archiveRoot, config.days, nowMs);
      runArchive(io, config, candidates);
      return 0;
    }
    runRestore(io, config, config.restoreFile!);
    return 0;
  } catch (error) {
    if (error instanceof ArchiveError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (import.meta.main) {
  // Never process.exit() here: it can truncate a large piped stdout before the
  // write drains. Setting exitCode lets the stream flush and preserves the
  // numeric status.
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`pi-session-archive: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
