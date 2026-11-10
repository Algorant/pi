import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { err, ok, type Health, type Result } from "./types";

type GrepMode = "plain" | "regex" | "fuzzy";

const DISPOSED = "FFF finder was disposed";
const HOST_SCRIPT = fileURLToPath(new URL("./host.ts", import.meta.url));

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function canonicalFffBunEntry(agentDirectory = agentDir()): string {
  return join(agentDirectory, "npm", "node_modules", "@ff-labs", "fff-bun", "src", "index.ts");
}

function describeExit(exitCode: number | null, signalCode: string | null): string {
  const how = signalCode ? `signal ${signalCode}` : `exit code ${exitCode}`;
  return `FFF search process crashed (${how}); Pi is unaffected. ` +
    "This usually means a file was rewritten while FFF was reading it. Retry the search; FFF restarts and re-indexes automatically.";
}

// One child process that owns a native FileFinder (see host.ts). A native
// crash ends only this process; its pending calls fail with a clear error.
class FffHost {
  ready = false;
  private exited: string | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, (result: Result<any>) => void>();
  private readonly proc: ReturnType<typeof Bun.spawn>;

  constructor(entry: string, onExit: (host: FffHost) => void) {
    this.proc = Bun.spawn({
      cmd: [process.execPath, HOST_SCRIPT, entry],
      // Pi is a compiled Bun executable; BUN_BE_BUN makes it run the host
      // script with Pi's own Bun runtime.
      env: { ...process.env, BUN_BE_BUN: "1" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      serialization: "json",
      ipc: (message: { id: number; result: Result<any> }) => {
        const settle = this.pending.get(message.id);
        if (!settle) return;
        this.pending.delete(message.id);
        settle(message.result);
      },
      onExit: (_proc, exitCode, signalCode) => {
        if (!this.exited) this.fail(describeExit(exitCode, signalCode));
        onExit(this);
      },
    });
  }

  call<T = any>(op: string, args?: unknown): Promise<Result<T>> {
    if (this.exited) return Promise.resolve(err(this.exited));
    const id = ++this.nextId;
    return new Promise((settle) => {
      this.pending.set(id, settle);
      try {
        this.proc.send({ id, op, args });
      } catch (e) {
        this.pending.delete(id);
        settle(err(`FFF search process is unavailable: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  kill(reason: string): void {
    if (this.exited) return;
    this.fail(reason);
    this.proc.kill();
  }

  private fail(reason: string): void {
    this.exited = reason;
    this.ready = false;
    for (const settle of this.pending.values()) settle(err(reason));
    this.pending.clear();
  }
}

export class NativeFffFinder {
  private host: FffHost | null = null;
  private initPromise: Promise<Result<void>> | null = null;
  private generation = 0;
  private destroyed = false;

  public readonly basePath: string;

  constructor(
    public cwd: string,
    private readonly stateNamespace?: string,
    basePath?: string,
  ) {
    this.basePath = resolve(basePath ?? cwd);
  }

  async ensure(): Promise<Result<void>> {
    if (this.destroyed) return err(DISPOSED);
    if (this.host?.ready) return ok(undefined);
    if (this.initPromise) return this.initPromise;

    const generation = this.generation;
    const pending = (async (): Promise<Result<void>> => {
      if (!(process as { versions?: { bun?: string } }).versions?.bun) {
        return err("pi-fff requires Pi to run under Bun");
      }
      const entry = canonicalFffBunEntry();
      if (!existsSync(entry)) {
        return err(`@ff-labs/fff-bun not found at the canonical package path: ${entry}. Run ~/.pi/agent/scripts/bootstrap-pi.mjs or: pi install npm:@ff-labs/fff-bun.`);
      }
      const host = new FffHost(entry, (exited) => {
        if (this.host === exited) this.host = null;
      });
      this.host = host;
      const initialized = await host.call<void>("init", { basePath: this.basePath, stateNamespace: this.stateNamespace });
      if (generation !== this.generation) {
        host.kill(DISPOSED);
        return err("FFF finder was disposed during initialization");
      }
      if (!initialized.ok) {
        host.kill(initialized.error);
        return initialized;
      }
      host.ready = true;
      return ok(undefined);
    })();
    this.initPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.initPromise === pending) this.initPromise = null;
    }
  }

  // Final: a destroyed finder never starts a host again.
  destroy() {
    this.destroyed = true;
    this.generation += 1;
    this.host?.kill(DISPOSED);
    this.host = null;
    this.initPromise = null;
  }

  private async call<T = any>(op: string, args?: unknown): Promise<Result<T>> {
    const ready = await this.ensure();
    if (!ready.ok) return ready;
    return this.host ? this.host.call<T>(op, args) : err("FFF not initialized");
  }

  find(q: string, page: number, limit: number) {
    return this.call("find", { q, page, limit });
  }

  glob(pattern: string) {
    return this.call("glob", { pattern });
  }

  mixed(q: string, page: number, limit: number) {
    return this.call("mixed", { q, page, limit });
  }

  grep(q: string, mode: GrepMode, offset: number, limit: number, ctx: number, smart: boolean) {
    return this.call("grep", { q, mode, offset, limit, ctx, smart });
  }

  multiGrep(patterns: string[], constraints: string, offset: number, limit: number, ctx: number, smart: boolean) {
    return this.call("multiGrep", { patterns, constraints, offset, limit, ctx, smart });
  }

  rescan() {
    return this.call("rescan");
  }

  progress() {
    return this.call("progress");
  }

  health(): Promise<Result<Health>> {
    return this.call<Health>("health");
  }
}
