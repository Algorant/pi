import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Envelope } from "../pi-agency/inbox/envelope.ts";
import { headlineOf } from "../pi-agency/inbox/envelope.ts";
import type { TargetRead } from "../pi-agency/inbox/send.ts";
import { readHcWorkerRecord, isManusRecord, type HcWorkerOutcome, type HcWorkerRecord } from "../pi-agency/workers/hc-record.ts";

/**
 * Herdra's lifecycle rows (herdra task-250, task-258). Herdra's main terminal owns the row of each Worker or manus it
 * starts: `work-start` once per confirmed launch, `work-done` once after the native finish/discard succeeded;
 * and of each request it sends a Ceph: `request-start` once after the envelope is durably queued.
 * Herdra's `herdra-open` owns the row, its idempotence and its record; this module only calls it at those three
 * edges. It never throws, never touches native state and never repeats a native side effect: a call that
 * fails or times out is a distinct line on the tool result, and the native outcome stands.
 */
const execFileAsync = promisify(execFile);
export const HERDRA_OPEN = join(homedir(), "Projects/herdra/bin/herdra-open");
/** herdra-open reads no hc and appends to one local file under flock; this bounds a held lock. */
const HOOK_TIMEOUT_MS = 5_000;
/** `where` is the app-written label of the terminal in the `main` tab of the `herdra` space. */
const HERDRA_MAIN_WHERE = "herdra / main";
/** herdra-open refuses a longer outcome or undo; its limits are 300, a multi-byte margin is kept. */
const OUTCOME_MAX = 250;
const UNDO_MAX_BYTES = 300;

/** The caller's own `hc get` payload with its address and core: both owner paths already hold them. */
export type HookCaller = { core: string; terminal: string; record: { state?: string; parent?: unknown; status?: { app?: string }; labels?: Record<string, string> } };
export type HookReport = { edge: "work-start" | "work-done" | "request-start"; key: string; status: "ok" | "failed" | "skipped"; message: string };

/**
 * The current Herdra main terminal, read from its actual `hc get` payload (its hc name is null, so a name
 * proves nothing): a live, parentless Pi (`status.app` pi, `parent` null) whose `where` is exactly
 * "herdra / main", with both native space/tab labels and none of the labels every Worker, manus or helper carries.
 */
export function isHerdraMain(caller: HookCaller): boolean {
  const { state, parent, status, labels = {} } = caller.record;
  return state === "live" && status?.app === "pi" && parent === null && labels.where === HERDRA_MAIN_WHERE && Boolean(labels["herdr.space"]) && Boolean(labels["herdr.tab"]) &&
    !labels.kind && !labels.starter && !labels["pi.worker.invocation"];
}

/** The owner a chain was first launched by: the root of its `recoveryOfDeliveryId` links (existing records, no new state). */
async function originalOwner(record: HcWorkerRecord): Promise<HcWorkerRecord["owner"]> {
  let current = record;
  for (let step = 0; step < 100; step += 1) {
    if (!current.recoveryOfDeliveryId) return current.owner;
    current = await readHcWorkerRecord(current.recoveryOfDeliveryId);
  }
  throw new Error(`delivery chain of ${record.deliveryId} is longer than 100 records`);
}

const oneLine = (value: string, max: number): string => {
  const line = value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

async function runHerdraOpen(args: string[]): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(HERDRA_OPEN, args, { encoding: "utf8", timeout: HOOK_TIMEOUT_MS, maxBuffer: 64 * 1024 });
    return { ok: true, out: stdout.trim().split("\n")[0] ?? "" };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stderr?: string; message?: string };
    if (failure.code === "ENOENT") return { ok: false, error: `herdra-open not found at ${HERDRA_OPEN}` };
    if (failure.killed) return { ok: false, error: `timed out after ${HOOK_TIMEOUT_MS / 1000} s; the row state is unknown` };
    const stderr = oneLine(failure.stderr ?? "", 300);
    return { ok: false, error: `exit ${String(failure.code)}${stderr ? `: ${stderr}` : failure.message ? `: ${oneLine(failure.message, 300)}` : ""}` };
  }
}

async function call(edge: HookReport["edge"], key: string, args: string[]): Promise<HookReport> {
  const done = await runHerdraOpen([edge, key, ...args]);
  return done.ok ? { edge, key, status: "ok", message: done.out || "done" } : { edge, key, status: "failed", message: done.error };
}

/**
 * After a confirmed launch of a child (a Worker's or manus's `record`) at `address`. Only the current Herdra
 * main terminal that FIRST launched this attempt writes its row: a chain first launched by another owner, even
 * one Herdra has since adopted, stays out. The key is the child's session id, which every continuation,
 * redelivery and adoption record carries unchanged; a replacement invocation repeats this at its new address.
 */
export async function workStart(record: HcWorkerRecord, address: string, caller: HookCaller): Promise<HookReport | undefined> {
  const key = record.childSessionId;
  try {
    if (!isHerdraMain(caller)) return undefined;
    const root = await originalOwner(record);
    if (root.core !== caller.core || root.terminal !== caller.terminal) {
      return { edge: "work-start", key, status: "skipped", message: `first launched by ${root.terminal} on core ${root.core}, not by this Herdra terminal` };
    }
    const project = basename(dirname(record.integration.repoKey));
    return await call("work-start", key, [isManusRecord(record) ? "manus" : "worker", project, address, oneLine(record.label ?? record.childAgent, 200), ...(record.taskId ? [`${project}:${record.taskId}`] : [])]);
  } catch (error) {
    return { edge: "work-start", key, status: "failed", message: oneLine(error instanceof Error ? error.message : String(error), 300) };
  }
}

/**
 * After the native finish or discard fully succeeded. Any current Herdra main terminal may close the row: its
 * key is a per-attempt UUID that only a Herdra-main work-start created, and for every other attempt herdra-open
 * answers "no row" with nothing written. This is what lets a restarted Herdra close its own earlier children.
 */
export async function workDone(key: string, outcome: { text: string; undo?: string }, caller: HookCaller | undefined): Promise<HookReport | undefined> {
  try {
    if (!caller || !isHerdraMain(caller)) return undefined;
    const undo = outcome.undo;
    const undoOk = undo !== undefined && undo.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(undo) && Buffer.byteLength(undo) <= UNDO_MAX_BYTES;
    const report = await call("work-done", key, [oneLine(outcome.text, OUTCOME_MAX), ...(undoOk ? [undo!] : [])]);
    return undo !== undefined && !undoOk && report.status === "ok" ? { ...report, message: `${report.message}; the revert line was not sent (not one line of at most ${UNDO_MAX_BYTES} bytes)` } : report;
  } catch (error) {
    return { edge: "work-done", key, status: "failed", message: oneLine(error instanceof Error ? error.message : String(error), 300) };
  }
}

/**
 * The project of a Ceph, read from the recipient's actual `hc get` payload and its status (no further read):
 * a live, parentless Pi in the foreground (`status.app` pi, `parent` null, not the stopped/backgrounded Pi
 * the status read reports) whose `where` is exactly `<project> / main`, carrying no Worker, manus, helper or
 * starter marking (`kind` only ever `ceph`). A label alone never makes a Ceph: undefined for anything else.
 */
function cephMainProject(record: { state?: string; parent?: unknown; status?: { app?: string }; labels?: Record<string, string> }, status: { state: string }): string | undefined {
  const { state, parent, labels = {} } = record;
  const where = labels.where ?? "";
  if (state !== "live" || record.status?.app !== "pi" || parent !== null || status.state === "background" || !where.endsWith(" / main")) return undefined;
  if ((labels.kind && labels.kind !== "ceph") || labels.starter || labels["pi.worker.invocation"]) return undefined;
  const project = where.slice(0, -" / main".length);
  return project && !project.includes(" / ") ? project : undefined;
}

/**
 * After `agent_send` durably queued a request (the send returned; a failed drop threw before any call).
 * Only the current Herdra main terminal, only a plain `request` (no control), only to a Ceph (`cephMainProject`) other than
 * itself: the recipient is judged from the one `hc get` the send's status read already made, at the route it
 * queried (`t1p`, or `machine/t1p` found through the core id in `hc machine ls`). Anything else does nothing.
 * The key is the new envelope's id, even for a request that carries `reply_to`; the label is its headline
 * exactly as `headlineOf` reads it (herdra-open refuses an unfit one, which shows as a failed hook).
 */
export async function requestStart(env: Envelope, sender: HookCaller["record"], target: TargetRead | undefined): Promise<HookReport | undefined> {
  const key = env.id;
  try {
    if (env.kind !== "request" || env.control || !isHerdraMain({ core: env.from.core, terminal: env.from.terminal, record: sender })) return undefined;
    if (env.to.core === env.from.core && env.to.terminal === env.from.terminal) return undefined;
    if (!target) return { edge: "request-start", key, status: "failed", message: "the recipient was never resolved to a core, so no Ceph check or route exists" };
    if (!target.record) {
      return target.status.state === "unknown" ? { edge: "request-start", key, status: "failed", message: `the recipient could not be verified as a Ceph: ${oneLine(target.status.msg ?? "unknown", 300)}` } : undefined;
    }
    const project = cephMainProject(target.record, target.status);
    if (project === undefined) return undefined;
    if (target.record.address !== target.route) return { edge: "request-start", key, status: "failed", message: `hc reports the recipient at ${String(target.record.address)}, not at the queried route ${target.route}` };
    const report = await call("request-start", key, [project, target.route, headlineOf(env.body)]);
    return report.status === "ok" && report.message !== `r-${key}` ? { ...report, status: "failed", message: `unexpected output "${report.message}" (expected r-${key})` } : report;
  } catch (error) {
    return { edge: "request-start", key, status: "failed", message: oneLine(error instanceof Error ? error.message : String(error), 300) };
  }
}

/** A real merge only: an `a..b` range of two different commits in a worktree. Anything else is accepted work. */
export function finishOutcome(receipt: Pick<HcWorkerOutcome, "integration" | "mergeRange" | "revert" | "targetTip">): { text: string; undo?: string } {
  const [from, to] = (receipt.mergeRange ?? "").split("..");
  const source = receipt.integration.source.branch;
  const target = receipt.integration.target.branch;
  if (receipt.integration.worktree !== false && from && to && from !== to && receipt.revert) {
    return { text: `merged ${source} into ${target} at ${(receipt.targetTip ?? to).slice(0, 12)}`, undo: receipt.revert };
  }
  return { text: receipt.integration.worktree === false ? `accepted on ${target}: shared checkout, no merge` : `accepted: ${source} was already on ${target}; no new merge` };
}

/** Appends the hook's one line to a native result: distinct for a failure, silent when the hook did not apply. */
export function withHook<T extends { content: unknown[]; details?: unknown }>(result: T, hook: HookReport | undefined): T {
  if (!hook) return result;
  const line = hook.status === "failed"
    ? `Herdra row hook ${hook.edge} NOT confirmed (key ${hook.key}): ${hook.message}. ${hook.edge === "request-start" ? "The request is queued in the inbox" : `The native ${hook.edge === "work-start" ? "launch" : "finish or discard"} is complete`} and was not touched or repeated.`
    : hook.status === "skipped" ? `Herdra row hook ${hook.edge} not run: ${hook.message}.`
    : `Herdra row ${hook.edge}: ${hook.message}.`;
  const first = result.content[0] as { type: "text"; text: string };
  return { ...result, content: [{ ...first, text: `${first.text}\n${line}` }, ...result.content.slice(1)], details: { ...(result.details as object), herdraHook: hook } };
}
