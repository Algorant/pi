// FFF host process: owns one native FileFinder outside the Pi process.
//
// The native library reads files through cached mmaps; a file truncated in
// place while mapped raises SIGBUS and kills whichever process loaded it
// (task-353). Running it here confines that crash to this child, which
// NativeFffFinder respawns on the next call.
//
// Protocol (Bun IPC, JSON): { id, op, args } -> { id, result: Result<T> }.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
type Request = { id: number; op: string; args: any };

const entry = process.argv[2];
if (!entry || !process.send) {
  console.error("pi-fff host must be spawned by NativeFffFinder over IPC");
  process.exit(2);
}

let fff: any = null;
let finder: any = null;
let basePath = "";

function stateDir(namespace?: string): string {
  const root = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi-fff");
  const state = namespace ? join(root, namespace) : root;
  mkdirSync(state, { recursive: true });
  return state;
}

function numberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function grepCursor(offset: number) {
  return offset > 0 ? ({ __brand: "GrepCursor", _offset: offset } as any) : null;
}

async function init(args: { basePath: string; stateNamespace?: string }): Promise<Result<void>> {
  fff = await import(pathToFileURL(entry).href);
  basePath = args.basePath;
  const state = stateDir(args.stateNamespace);
  const created = fff.FileFinder.create({
    basePath,
    frecencyDbPath: join(state, "frecency.mdb"),
    historyDbPath: join(state, "history.mdb"),
    logFilePath: join(state, "fff.log"),
    logLevel: process.env.PI_FFF_LOG_LEVEL || "warn",
    disableWatch: process.env.PI_FFF_DISABLE_WATCH === "1",
    disableContentIndexing: process.env.PI_FFF_DISABLE_CONTENT_INDEXING === "1",
    cacheBudgetMaxFiles: numberEnv("PI_FFF_CACHE_MAX_FILES"),
    cacheBudgetMaxBytes: numberEnv("PI_FFF_CACHE_MAX_BYTES"),
    cacheBudgetMaxFileSize: numberEnv("PI_FFF_CACHE_MAX_FILE_SIZE"),
    aiMode: true,
  });
  if (!created.ok) return created;
  finder = created.value;
  const scan = finder.scanFiles();
  if (!scan.ok) return scan;
  const waitMs = Number(process.env.PI_FFF_INIT_WAIT_MS || 1500);
  if (waitMs > 0) {
    const waited = await finder.waitForScan(waitMs);
    if (!waited.ok) return waited;
  }
  return { ok: true, value: undefined };
}

const ops: Record<string, (args: any) => Result<unknown> | Promise<Result<unknown>>> = {
  init,
  find: ({ q, page, limit }) =>
    // FFF names this field pageIndex, but its native API treats it as a result
    // offset. Convert the public page number to keep pages disjoint.
    finder.fileSearch(q, { pageIndex: page * limit, pageSize: limit }),
  glob: ({ pattern }) => finder.glob(pattern),
  mixed: ({ q, page, limit }) => finder.mixedSearch(q, { pageIndex: page * limit, pageSize: limit }),
  grep: ({ q, mode, offset, limit, ctx, smart }) =>
    finder.grep(q, { mode, cursor: grepCursor(offset), pageSize: limit, beforeContext: ctx, afterContext: ctx, smartCase: smart, classifyDefinitions: true }),
  multiGrep: ({ patterns, constraints, offset, limit, ctx, smart }) =>
    finder.multiGrep({ patterns, constraints, cursor: grepCursor(offset), pageSize: limit, beforeContext: ctx, afterContext: ctx, smartCase: smart, classifyDefinitions: true }),
  rescan: () => finder.scanFiles(),
  progress: () => finder.getScanProgress(),
  health: () => {
    const health = finder.healthCheck(basePath);
    if (!health.ok) return health;
    return {
      ok: true,
      value: {
        ...health.value,
        sdkPackage: "@ff-labs/fff-bun",
        binaryPackage: fff.getNpmPackageName(),
        binaryPath: fff.findBinary(),
        binaryExists: fff.binaryExists(),
        hostPid: process.pid,
      },
    };
  },
};

// Idle TTL: the native watcher's debouncer wakes about 40 times a second even when
// nothing is happening (task-662), so a host kept for an idle Pi is pure wakeups.
// The host lives only while searches arrive; it exits after this quiet period and
// NativeFffFinder starts a fresh one on the next call, reusing the on-disk index.
const idleTtlMs = numberEnv("PI_FFF_IDLE_TTL_MS") ?? 120_000;
let inFlight = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;

function armIdleExit(): void {
  if (!(idleTtlMs > 0)) return;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    // A request that arrived in the same tick keeps the host for another period.
    if (inFlight > 0) { armIdleExit(); return; }
    process.exit(0);
  }, idleTtlMs);
}

process.on("message", async (message: Request) => {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
  inFlight += 1;
  let result: Result<unknown>;
  try {
    const op = ops[message.op];
    if (!op) result = { ok: false, error: `Unknown FFF host operation: ${message.op}` };
    else if (message.op !== "init" && !finder) result = { ok: false, error: "FFF host is not initialized" };
    else result = await op(message.args);
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  inFlight -= 1;
  process.send!({ id: message.id, result });
  armIdleExit();
});

// The parent owns this process; never outlive it.
process.on("disconnect", () => process.exit(0));
