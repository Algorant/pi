import { execFile, type ExecFileException } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/**
 * pi-agency's local-state primitives (task-597): one state root, one atomic
 * writer, one Tandem record reader and one id generator. No Pi imports, so the
 * inbox and whois CLIs load it too.
 */

/** `$XDG_STATE_HOME` (else `~/.local/state`), joined with `parts`. */
export const stateDir = (...parts: string[]) => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), ...parts);

/** `prefix` plus a UUID, or plus `hex` random hex digits (short ids such as inbox `m1234abcd`). */
export const newId = (prefix = "", hex?: number) => `${prefix}${hex ? randomBytes(Math.ceil(hex / 2)).toString("hex").slice(0, hex) : randomUUID()}`;

/** Replace `path` atomically: a private dot-temp beside it, then rename. Readers never see a partial file. */
export function writeAtomic(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${newId("", 12)}.tmp`);
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** A Tandem record (`tandem show <id> --json` data) from the board of `cwd`; Tandem's own error otherwise. */
export function tandemShow(id: string, cwd: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const command = `tandem show ${id} --json`;
    const timeout = 30_000;
    const started = Date.now();
    execFile("tandem", ["show", id, "--json"], { cwd, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const elapsed = Date.now() - started;
      let shown: any;
      try { shown = JSON.parse(stdout); } catch {
        return reject(tandemShowError({ command, id, cwd, elapsed, timeout, error, stderr, detail: "no JSON output" }));
      }
      if (shown?.ok !== true || typeof shown.data?.id !== "string") {
        return reject(tandemShowError({ command, id, cwd, elapsed, timeout, error, stderr, detail: shown?.error?.message ?? "no record" }));
      }
      resolve(shown.data);
    });
  });
}

function tandemShowError({ command, id, cwd, elapsed, timeout, error, stderr, detail }: {
  command: string; id: string; cwd: string; elapsed: number; timeout: number;
  error: ExecFileException | null; stderr: string; detail: string;
}): Error {
  const parts = [`${command} (task ${id}) failed`, `cwd=${cwd}`, `elapsed=${elapsed}ms`, `timeout=${timeout}ms`];
  if (error?.code !== undefined) parts.push(`code=${error.code}`);
  if (error?.signal) parts.push(`signal=${error.signal}`);
  if (error?.killed) parts.push("killed=true");
  const diagnostic = stderr.trim();
  if (diagnostic) parts.push(`stderr=${diagnostic.length > 1200 ? `${diagnostic.slice(0, 1200)}… [truncated]` : diagnostic}`);
  else if (error?.message) parts.push(error.message);
  parts.push(`result=${detail}`);
  return new Error(parts.join("; "));
}
