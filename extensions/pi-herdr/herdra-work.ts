import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Envelope } from "../pi-agency/inbox/envelope.ts";
import { headlineOf, splitHeadline } from "../pi-agency/inbox/envelope.ts";
import type { TargetRead } from "../pi-agency/inbox/send.ts";
import { hcJson } from "./core.ts";
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
export type HookReport = { edge: "work-start" | "work-done" | "request-start" | "ask"; key: string; status: "ok" | "failed" | "skipped"; message: string };

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

/** `redact` keeps the call's arguments (Algorant's words) out of the failure text: only the exit code, never stderr or the command line. */
async function runHerdraOpen(args: string[], redact = false): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFileAsync(HERDRA_OPEN, args, { encoding: "utf8", timeout: HOOK_TIMEOUT_MS, maxBuffer: 64 * 1024 });
    return { ok: true, out: stdout.trim().split("\n")[0] ?? "" };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stderr?: string; message?: string };
    if (failure.code === "ENOENT") return { ok: false, error: `herdra-open not found at ${HERDRA_OPEN}` };
    if (failure.killed) return { ok: false, error: `timed out after ${HOOK_TIMEOUT_MS / 1000} s; the row state is unknown` };
    if (redact) return { ok: false, error: `exit ${String(failure.code)}` };
    const stderr = oneLine(failure.stderr ?? "", 300);
    return { ok: false, error: `exit ${String(failure.code)}${stderr ? `: ${stderr}` : failure.message ? `: ${oneLine(failure.message, 300)}` : ""}` };
  }
}

async function call(edge: HookReport["edge"], key: string, args: string[], redact = false): Promise<HookReport> {
  const done = await runHerdraOpen([edge, key, ...args], redact);
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
export function cephMainProject(record: { state?: string; parent?: unknown; status?: { app?: string }; labels?: Record<string, string> }, status?: { state: string }): string | undefined {
  const { state, parent, labels = {} } = record;
  const where = labels.where ?? "";
  if (state !== "live" || record.status?.app !== "pi" || parent !== null || status?.state === "background" || !where.endsWith(" / main")) return undefined;
  if ((labels.kind && labels.kind !== "ceph") || labels.starter || labels["pi.worker.invocation"]) return undefined;
  const project = where.slice(0, -" / main".length);
  return project && !project.includes(" / ") ? project : undefined;
}

/**
 * Whether this terminal is a Ceph for failed-call attribution (task-852): a live, parentless Pi that is not Herdra main
 * and carries no Worker invocation, and either is labelled `kind=ceph` explicitly (a `ceph_start` Ceph) or, with no `kind`
 * label at all, is the project's main-tab Pi by the same `cephMainProject` test requestStart uses (a Ceph started by hand).
 * Any other kind (manus, worker, helper) is refused.
 */
export function isCephTerminal(caller: HookCaller): boolean {
  const { state, parent, status, labels = {} } = caller.record;
  if (isHerdraMain(caller) || state !== "live" || status?.app !== "pi" || parent !== null || labels["pi.worker.invocation"]) return false;
  if (labels.kind) return labels.kind === "ceph";
  return cephMainProject(caller.record) !== undefined;
}

/**
 * After `agent_send` durably queued a request (the send returned; a failed drop threw before any call).
 * Only the current Herdra main terminal, only a plain `request` (no control), only to a Ceph (`cephMainProject`) other than
 * itself: the recipient is judged from the one `hc get` the send's status read already made, at the route it
 * queried (`t1p`, or `machine/t1p` found through the core id in `hc machine ls`). Anything else does nothing.
 * The key is the new envelope's id, even for a request that carries `reply_to`; the label is its headline
 * exactly as `headlineOf` reads it (herdra-open refuses an unfit one, which shows as a failed hook).
 */
export async function requestStart(env: Envelope, sender: HookCaller["record"], target: TargetRead | undefined, redact = false): Promise<HookReport | undefined> {
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
    const report = await call("request-start", key, [project, target.route, headlineOf(env.body)], redact);
    return report.status === "ok" && report.message !== `r-${key}` ? { ...report, status: "failed", message: redact ? `unexpected output (expected r-${key})` : `unexpected output "${report.message}" (expected r-${key})` } : report;
  } catch (error) {
    return { edge: "request-start", key, status: "failed", message: oneLine(error instanceof Error ? error.message : String(error), 300) };
  }
}

/**
 * Tracked ask (task-859 #1): one opt-in `ask` on a Herdra-main request to a Ceph. The queued body is the
 * caller's body plus ASK_MARK plus Algorant's words, byte for byte; after a confirmed queue `request-start`
 * opens r-<id>, then `herdra-open ask ... --thread <id>` adopts that same row with the same words string.
 * They are two separate writes under two separate locks, never atomic; neither is retried, and nothing is
 * resent. A failure or timeout of either leaves that row's state UNKNOWN: the report names the stage and
 * the id and points at the existing inbox thread and the raw row, never at the words or a command line.
 */
export const ASK_MARK = "\n\nAlgorant's words, verbatim:\n";
/** Linux caps one argv string at 131072 bytes including its NUL. */
const ARGV_STRING_MAX = 131071;
/** Room left in that argument for the row's other fields (thread link, flags, JSON punctuation), measured with margin. */
const ARGV_RESERVE = 512;
const HEADLINE_BYTES = 160;

/**
 * herdra-open's `ask` hands the words to jq twice (`words` and `ask`) JSON-escaped in ONE `--argjson`
 * argument, so the real bound is twice the escaped size, not the raw size (measured on the CLI: plain text
 * passes at 65000 bytes and fails at 66000; control bytes, six escaped bytes each, pass at 10000 and fail at
 * 20000). jq also escapes DEL (U+007F) where JSON.stringify does not.
 */
function escapedBytes(words: string): number {
  return Buffer.byteLength(JSON.stringify(words)) - 2 + 5 * (words.match(/\u007f/g)?.length ?? 0);
}

/** Why `words` with the caller's own `body` (before ASK_MARK is appended: the marker must never stand in for a missing headline) cannot be tracked as an ask, or undefined. Names reasons and sizes, never the words. */
export function askRefusal(words: string, body: string): string | undefined {
  if (!/\S/.test(words)) return "ask is empty or only whitespace";
  if (words.includes("\u0000")) return "ask contains a NUL byte, which no command argument can carry";
  const size = escapedBytes(words);
  if (2 * size + ARGV_RESERVE > ARGV_STRING_MAX) return `ask is ${size} JSON-escaped bytes; herdra-open carries it twice in one ${ARGV_STRING_MAX}-byte argument, so at most ${Math.floor((ARGV_STRING_MAX - ARGV_RESERVE) / 2)} escaped bytes fit`;
  const headline = headlineOf(splitHeadline(body));
  if (!headline) return "the headline (first line of body) is empty";
  if (/[\u0000-\u001f\u007f-\u009f]/.test(headline)) return "the headline contains a control character";
  if (headline.startsWith("--")) return "the headline starts with `--`, which herdra-open ask reads as a flag";
  if (Buffer.byteLength(headline) > HEADLINE_BYTES) return `the headline is ${Buffer.byteLength(headline)} bytes; herdra-open counts bytes in some locales, so an ask headline is at most ${HEADLINE_BYTES} bytes`;
  return undefined;
}

/** What `checkAskTarget` validated before anything was queued; the post-queue stage must find the same caller and recipient. */
export type AskPlan = { caller: { core: string; terminal: string }; address: string; project: string };

/** Before the queue, on send's own canonical recipient and caller (send.ts `beforeQueue`): Herdra main to a live project Ceph other than itself. */
export async function checkAskTarget(target: string, caller: { core: string; terminal: string }, self: HookCaller["record"]): Promise<AskPlan> {
  if (!isHerdraMain({ ...caller, record: self })) throw new Error("ask: only Herdra's main terminal tracks an ask; nothing was queued.");
  const record = await hcJson(["get", target]);
  const project = cephMainProject(record);
  if (project === undefined || typeof record.address !== "string") throw new Error(`ask: ${target} is not a live project Ceph (a foreground Pi in a <project> / main tab); nothing was queued.`);
  if (record.address === caller.terminal && !target.includes("/")) throw new Error("ask: the recipient is this terminal; nothing was queued.");
  if (!/^[.]?[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project)) throw new Error(`ask: the recipient's project name is not one herdra-open accepts; nothing was queued.`);
  return { caller, address: record.address, project };
}

/** The no-stage variants: nothing ran after the queue, so this call wrote no row; the id and the no-resend guidance are still exact. */
const NO_STAGE = (id: string, reason: string) => `request ${id} queued; ${reason}; no row stage ran, so this call wrote no row. Do not resend: inspect inbox thread ${id}, then run request-start and ask for that id in order (never a bare ask).`;
const INSPECT = (id: string) => `Inspect inbox thread ${id} and the raw row r-${id} in ~/.local/state/herdra/open.jsonl before repairing; repair in order (request-start, then ask on the open row), never a bare ask, never a resend.`;

/**
 * After a confirmed queue of an `ask` request. One report: `ask` ok when r-<id> was opened and adopted;
 * otherwise the failed stage. The caller and recipient must be exactly the ones `checkAskTarget` saw.
 */
export async function trackAsk(env: Envelope, sender: HookCaller["record"], read: TargetRead | undefined, words: string, plan: AskPlan): Promise<HookReport> {
  const key = env.id;
  const failed = (edge: HookReport["edge"], message: string): HookReport => ({ edge, key, status: "failed", message });
  try {
    if (env.from.core !== plan.caller.core || env.from.terminal !== plan.caller.terminal) return failed("ask", NO_STAGE(key, "the sender differs from the pre-queue check"));
    if (!read?.record || read.route !== plan.address || cephMainProject(read.record, read.status) !== plan.project) return failed("ask", NO_STAGE(key, "the recipient differs from the pre-queue check"));
    const start = await requestStart(env, sender, read, true);
    if (!start) return failed("request-start", NO_STAGE(key, "request-start did not apply to this request"));
    if (start.status !== "ok") return failed("request-start", `${start.message}; ask not run; state of r-${key} UNKNOWN. ${INSPECT(key)}`);
    const done = await runHerdraOpen(["ask", headlineOf(env.body), "--ask", words, "--project", plan.project, "--on", read.route, "--thread", key], true);
    if (!done.ok) return failed("ask", `ask stage NOT confirmed (${done.error}); state of r-${key} UNKNOWN. ${INSPECT(key)}`);
    if (done.out !== `r-${key}`) return failed("ask", `ask stage printed unexpected output (expected r-${key}); state of r-${key} UNKNOWN. ${INSPECT(key)}`);
    return { edge: "ask", key, status: "ok", message: `r-${key} opened and adopted as an ask (two writes; words stored exactly as sent)` };
  } catch (error) {
    return failed("ask", `${oneLine(error instanceof Error ? error.message : String(error), 200)}; state of r-${key} UNKNOWN. ${INSPECT(key)}`);
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
    ? `Herdra row hook ${hook.edge} NOT confirmed (key ${hook.key}): ${hook.message.replace(/[.\s]+$/, "")}. ${hook.edge === "request-start" || hook.edge === "ask" ? "The request is queued in the inbox" : `The native ${hook.edge === "work-start" ? "launch" : "finish or discard"} is complete`} and was not touched or repeated.`
    : hook.status === "skipped" ? `Herdra row hook ${hook.edge} not run: ${hook.message}.`
    : `Herdra row ${hook.edge}: ${hook.message}.`;
  const first = result.content[0] as { type: "text"; text: string };
  return { ...result, content: [{ ...first, text: `${first.text}\n${line}` }, ...result.content.slice(1)], details: { ...(result.details as object), herdraHook: hook } };
}
