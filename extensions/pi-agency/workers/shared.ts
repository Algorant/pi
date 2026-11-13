import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { resolveRole, resolveBenchmarkWorkerModel, type BenchmarkWorkerModel, type RoleRegistry } from "../model-roles.ts";
import type { WorkerProjectRule } from "./brief.ts";
import { tandemShow } from "../state.ts";
import { nstarContractBody } from "../nstar-note.ts";
import { applyTodoEntry, type TodoItem } from "../../pi-todos/state.ts";
import type {
  WorkerAssignment, WorkerCompletionMetrics, WorkerReport,
  WorkerRunnableValidationResult, WorkerTandemCounts, WorkerTaskDefinition,
} from "./handoff-record.ts";

/**
 * Task, Worktrunk, Git and report authority for native HC Workers (pi-herdr).
 * Nothing here knows a terminal identity.
 */

export const execFile = promisify(execFileCallback);

export const RUNNABLE_OUTPUT_TAIL_LENGTH = 4_000;

export type NativeRunnableValidation = { command: string };

// Efforts below medium bypass the dispatch gate and plan handoff.
export const WORKER_LIGHT_EFFORTS = new Set(["trivial", "small"]);

export function taskPlanRequired(task: any): boolean {
  return !WORKER_LIGHT_EFFORTS.has(task.effort) || (Array.isArray(task.tags) && task.tags.includes("plan-first"));
}

export async function tandemAssignment(taskId: string, cwd: string): Promise<NativeRunnableValidation[]> {
  const parsed = JSON.parse(await command("tandem", ["assignment", taskId, "--json"], cwd));
  const root = parsed?.data?.root ?? parsed?.root;
  const planned = root?.plannedValidation;
  if (!Array.isArray(planned)) throw new Error(`Tandem assignment for ${taskId} has no valid root.plannedValidation.`);
  return planned.filter((entry: any) => entry?.kind === "command").map((entry: any) => {
    if (typeof entry.text !== "string" || !entry.text.trim()) throw new Error(`Tandem assignment for ${taskId} has a command validation without text.`);
    return { command: entry.text };
  });
}

export async function tandemProjectRules(cwd: string, signal?: AbortSignal): Promise<WorkerProjectRule[]> {
  let output: string;
  try {
    output = await command("tandem", ["rules", "list", "--json"], cwd, DEFAULT_TIMEOUT_MS, signal);
  } catch (error) {
    throw new Error(`Could not load active Tandem project rules from the captured target checkout: ${diagnosticText(error)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Could not parse active Tandem project rules from the captured target checkout: ${diagnosticText(error)}`);
  }
  if (parsed?.ok !== true || !Array.isArray(parsed.data)) {
    throw new Error(`Tandem rules list --json returned an invalid response for the captured target checkout: ${JSON.stringify(parsed).slice(0, 4_000)}`);
  }

  return parsed.data.map((rule: any, index: number) => {
    if (!rule || typeof rule.category !== "string" || !rule.category.trim() ||
        typeof rule.id !== "string" || !rule.id.trim() ||
        typeof rule.rule !== "string" || !rule.rule.trim()) {
      throw new Error(`Tandem rules list --json returned an invalid rule at index ${index} for the captured target checkout.`);
    }
    return { category: rule.category, id: rule.id, rule: rule.rule };
  });
}

export function outputTail(stdout: unknown, stderr: unknown): string {
  return `${typeof stdout === "string" ? stdout : ""}${typeof stderr === "string" && stderr ? `${typeof stdout === "string" && stdout ? "\\n" : ""}${stderr}` : ""}`.slice(-RUNNABLE_OUTPUT_TAIL_LENGTH);
}

// Long steps (validation gates, Worktrunk merge/removal) have no time limit:
// killing them mid-run is wrong (task-456). Every CHECK_IN_MS a warning says the
// step is still running; it keeps waiting.
export const CHECK_IN_MS = 120_000;

export type CheckIn = (message: string) => void;

export function checkInNotifier(ctx: ExtensionContext): CheckIn {
  return (message) => { if (ctx.hasUI) ctx.ui.notify(message, "warning"); };
}

export async function withCheckIn<T>(checkIn: CheckIn, label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const timer = setInterval(() => checkIn(`${label} still running after ${Math.round((Date.now() - started) / 60_000)} min; waiting for it to finish.`), CHECK_IN_MS);
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}

export async function runRunnableValidation(validation: NativeRunnableValidation, cwd: string, checkIn: CheckIn, signal?: AbortSignal): Promise<WorkerRunnableValidationResult> {
  try {
    const result = await withCheckIn(checkIn, `Validation \`${validation.command}\` (Esc stops it)`, () =>
      execFile("sh", ["-c", validation.command], { cwd, encoding: "utf8", maxBuffer: 1024 * 1024, signal }));
    return { command: validation.command, exitCode: 0, outputTail: outputTail(result.stdout, result.stderr) };
  } catch (error) {
    const failure = error as CommandError & { code?: number | string; stdout?: string; stderr?: string };
    const numericCode = typeof failure.code === "number" ? failure.code : Number(failure.code);
    return { command: validation.command, exitCode: Number.isSafeInteger(numericCode) && numericCode >= 0 ? numericCode : 1, outputTail: outputTail(failure.stdout, failure.stderr || failure.message) };
  }
}

// Validations run one at a time in declared order, because a later one may depend on an earlier
// one (install before test, task-439). The first failure stops the run; the rest are listed as not run.
export async function runRunnableValidations(taskId: string, parseCwd: string, runCwd: string, checkIn: CheckIn, signal?: AbortSignal): Promise<{ results: WorkerRunnableValidationResult[]; notRun: string[] }> {
  const validations = await tandemAssignment(taskId, parseCwd);
  const results: WorkerRunnableValidationResult[] = [];
  for (const [index, validation] of validations.entries()) {
    const result = await runRunnableValidation(validation, runCwd, checkIn, signal);
    results.push(result);
    if (result.exitCode !== 0) return { results, notRun: validations.slice(index + 1).map((later) => later.command) };
  }
  return { results, notRun: [] };
}

/** A short diff fits a notice: the owner reviews it there instead of reading the checkout. */
export const SHORT_DIFF_LINES = 120;
export const SHORT_DIFF_CHARS = 8_000;

export type WorkerDiff = { base: string; head: string; files: string[]; stat: string; diff: string; cut?: string };

/** What the Worker branch changes since it left the target branch, with the diff bounded for a notice. */
export async function workerDiff(sourcePath: string, targetBranch: string, head: string): Promise<WorkerDiff> {
  const base = (await command("git", ["merge-base", targetBranch, head], sourcePath)).trim();
  const [names, stat, full] = await Promise.all([
    command("git", ["diff", "--name-only", "--no-renames", base, head], sourcePath),
    command("git", ["diff", "--stat", base, head], sourcePath),
    command("git", ["diff", base, head], sourcePath, DEFAULT_TIMEOUT_MS),
  ]);
  const lines = full.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let shown = lines.slice(0, SHORT_DIFF_LINES).join("\n");
  if (shown.length > SHORT_DIFF_CHARS) shown = shown.slice(0, SHORT_DIFF_CHARS).replace(/\n[^\n]*$/, "");
  const shownLines = shown ? shown.split("\n").length : 0;
  const cut = shownLines < lines.length
    ? `[diff cut: ${shownLines} of ${lines.length} lines shown; full diff: git -C ${sourcePath} diff ${base.slice(0, 12)} ${head.slice(0, 12)}]` : undefined;
  return { base, head, files: names.split("\n").filter(Boolean), stat: stat.trimEnd(), diff: shown, ...(cut ? { cut } : {}) };
}

export function formatWorkerDiff(diff: WorkerDiff): string {
  return [`DIFFSTAT (${diff.base.slice(0, 12)}..${diff.head.slice(0, 12)}):`, diff.stat || "(no changes)", "DIFF:", "```diff", diff.diff, "```", ...(diff.cut ? [diff.cut] : [])].join("\n");
}

export const MAX_PROMPT_LENGTH = 16_000;

export const DEFAULT_TIMEOUT_MS = 120_000;

export const WORKER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type WorkerThinkingLevel = (typeof WORKER_THINKING_LEVELS)[number];

/** The `--model` argument: caller arguments win, then the first available "worker" entry of model-roles.json. */
export function workerModelArgument(registry: RoleRegistry, model?: string, thinkingLevel?: WorkerThinkingLevel): string {
  const resolved = resolveRole("worker", registry, { model, thinking: thinkingLevel });
  return `${resolved.model}:${resolved.thinking}`;
}

/** Closed benchmark-only selection; never accepts a general model/thinking override. */
export function benchmarkWorkerModelArgument(registry: RoleRegistry, benchmarkModel: BenchmarkWorkerModel) {
  const resolved = resolveBenchmarkWorkerModel(benchmarkModel, registry);
  return { ...resolved, argument: `${resolved.model}:${resolved.thinking}` };
}

export type CommandError = Error & { stdout?: string; stderr?: string };

export async function command(command: string, args: string[], cwd?: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  try {
    return (await execFile(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, signal })).stdout;
  } catch (error) {
    const failure = error as CommandError;
    const detail = [failure.stderr, failure.stdout, failure.message].filter(Boolean).join("\n").trim();
    const wrapped = new Error(`${command} ${args.join(" ")} failed: ${detail}`) as CommandError;
    wrapped.stdout = failure.stdout;
    wrapped.stderr = failure.stderr;
    throw wrapped;
  }
}

export type NativeProjectIdentity = {
  cwd: string;
  repoRoot: string;
  repoKey: string;
};

export async function nativeProjectIdentity(cwd: string): Promise<NativeProjectIdentity> {
  const absoluteCwd = resolve(cwd);
  try {
    const repoRoot = (await command("git", ["rev-parse", "--show-toplevel"], absoluteCwd)).trim();
    if (!repoRoot) throw new Error("Git returned an empty repository root.");
    const commonDir = (await command("git", ["rev-parse", "--git-common-dir"], absoluteCwd)).trim();
    if (!commonDir) throw new Error("Git returned an empty common directory.");
    const commonPath = resolve(absoluteCwd, commonDir);
    const repoKey = commonPath.endsWith("/.git") ? commonPath : `${commonPath}/.git`;
    return { cwd: absoluteCwd, repoRoot: resolve(repoRoot), repoKey };
  } catch (error) {
    throw new Error(`Pi cwd ${absoluteCwd} is not a native Git checkout. Run the Worker from the repository that owns the task. ${diagnosticText(error)}`);
  }
}

/** Worktrunk owns effective configuration, command forms, and approval identity. */
export async function approvedHookTypes(checkoutPath: string, types: string[], signal?: AbortSignal): Promise<Set<string>> {
  const hooks: unknown = JSON.parse(await command("wt", ["-C", checkoutPath, "hook", "show", "--format", "json"], checkoutPath, DEFAULT_TIMEOUT_MS, signal));
  if (!Array.isArray(hooks) || hooks.some((hook) =>
    !hook || typeof hook.type !== "string" || typeof hook.needs_approval !== "boolean" ||
    !["user", "project"].includes(hook.source) || (hook.name !== null && typeof hook.name !== "string"))) {
    throw new Error(`Worktrunk returned invalid hook discovery for ${checkoutPath}.`);
  }
  const selected = hooks.filter((hook) => types.includes(hook.type));
  const unapproved = selected.filter((hook) => hook.needs_approval);
  if (unapproved.length) {
    throw new Error(
      `Worktrunk hooks need human approval in ${checkoutPath}: ` +
      unapproved.map((hook) => `${hook.type} ${hook.source}:${hook.name ?? "(unnamed)"}`).join(", ") +
      `. Inspect with wt -C ${JSON.stringify(checkoutPath)} hook show and approve through Worktrunk interactively before retrying. No hooks were run by this operation.`,
    );
  }
  return new Set(selected.map((hook) => hook.type));
}

export async function removeNativeWorkerCheckout(project: { cwd: string }, branch: string, checkIn: CheckIn, discard = false): Promise<string> {
  return withCheckIn(checkIn, `Worktrunk removal of ${branch}`, () => command("wt", [
    "-C", project.cwd, "remove", branch,
    ...(discard ? ["--force", "--force-delete"] : []),
    "--foreground", "--format", "json",
  ], undefined, 0));
}

/** Git's own linked-worktree registry: the checkout registered for `branch`, if any. */
export async function nativeWorktreeForBranch(repoCwd: string, branch: string): Promise<string | undefined> {
  const entries = (await command("git", ["worktree", "list", "--porcelain"], repoCwd)).split("\n\n");
  for (const entry of entries) {
    const path = /^worktree (.+)$/m.exec(entry)?.[1];
    if (path && new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(entry)) return path;
  }
  return undefined;
}

/** Observed authoritative presence of a captured checkout: registered with Git, on
 * disk, or (for a discard, which force-deletes) its branch still exists. */
export async function nativeCheckoutPresent(repoCwd: string, checkout: { checkoutPath: string; branch: string }, includeBranch: boolean): Promise<boolean> {
  const registered = (await command("git", ["worktree", "list", "--porcelain"], repoCwd)).split("\n").some((line) => line === `worktree ${checkout.checkoutPath}`);
  if (registered || existsSync(checkout.checkoutPath)) return true;
  if (!includeBranch) return false;
  try { await command("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${checkout.branch}`], repoCwd); return true; }
  catch { return false; }
}

export async function nativeHead(checkoutPath: string, label: string): Promise<string> {
  const head = (await command("git", ["rev-parse", "HEAD"], checkoutPath)).trim();
  if (!/^[0-9a-f]{7,64}$/i.test(head)) throw new Error(`${label} returned an invalid native HEAD ${head || "(empty)"}.`);
  return head;
}

export async function sourceAlreadyIntegrated(integration: { source: { checkoutPath: string }; target: { checkoutPath: string } }): Promise<{ sourceTip: string; targetTip: string } | undefined> {
  const sourceTip = await nativeHead(integration.source.checkoutPath, "Worker source");
  const targetTip = await nativeHead(integration.target.checkoutPath, "Integration target");
  try {
    await command("git", ["merge-base", "--is-ancestor", sourceTip, targetTip], integration.target.checkoutPath);
    return { sourceTip, targetTip };
  } catch {
    return undefined;
  }
}

export function validateNativeRemovalResult(output: string, integration: { source: { checkoutPath: string; branch: string } }): string {
  let parsed: any;
  try { parsed = JSON.parse(output); } catch (error) {
    throw new Error(`Worktrunk removal returned invalid JSON for ${integration.source.branch}: ${diagnosticText(error)}`);
  }
  // `wt remove --format json` reports one entry per removed worktree.
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`Worktrunk removal of ${integration.source.branch} reported ${Array.isArray(parsed) ? parsed.length : "no"} removal entries; expected exactly the captured Worker checkout.`);
  }
  const [removed] = parsed;
  if (removed?.branch !== integration.source.branch) {
    throw new Error(`Worktrunk removal reported branch ${removed?.branch}, not captured Worker branch ${integration.source.branch}; no other branch was accepted.`);
  }
  if (removed.path !== integration.source.checkoutPath) {
    throw new Error(`Worktrunk removal reported checkout ${removed.path}, not captured Worker checkout ${integration.source.checkoutPath}; no other checkout was accepted.`);
  }
  return output.trim().slice(0, 4_000);
}

export async function runTandemCommand(args: string[], cwd: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await command("tandem", args, cwd);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Tandem 0.12.2 returns the whole record under `data`, including body, the
// full accord, children, and `location`. `location` is derived from storage
// (`board` or `logs`) and is the only reliable active-versus-archived signal:
// an archived Task reports `state: null`.
export { tandemShow };

export function tandemCounts(task: any, taskId: string): WorkerTandemCounts {
  const reworkCount = task?.reworkCount;
  const attemptCount = task?.attemptCount;
  if (!Number.isSafeInteger(reworkCount) || reworkCount < 0 || !Number.isSafeInteger(attemptCount) || attemptCount < 0) {
    throw new Error(`Tandem Task ${taskId} did not provide native reworkCount and attemptCount fields.`);
  }
  return { reworkCount, attemptCount };
}

export function tandemTaskMetrics(task: any, taskId: string, completedAt: number): WorkerCompletionMetrics {
  const counts = tandemCounts(task, taskId);
  const createdAt = task?.createdAt;
  if (typeof createdAt !== "string" || !Date.parse(createdAt)) {
    throw new Error(`Tandem Task ${taskId} did not provide a usable createdAt for completion metrics.`);
  }
  const elapsedMs = Math.max(0, completedAt - Date.parse(createdAt));
  return {
    attemptCount: counts.attemptCount,
    reworkCount: counts.reworkCount,
    discardedCount: Number.isSafeInteger(task?.discardedCount) && task.discardedCount >= 0 ? task.discardedCount : 0,
    elapsedMs,
  };
}

export const REWORK_NOTE_LENGTH = 512;

export function reworkNote(message: string): string {
  return message.trim().split(/\r?\n/, 1)[0]!.slice(0, REWORK_NOTE_LENGTH) || "Worker correction requested.";
}

export async function accordStatus(taskId: string, cwd: string): Promise<string> {
  const task = await tandemShow(taskId, cwd);
  return task.accordStatus ?? task?.accord?.status ?? "unknown";
}

export async function ensureDeliveredThenRework(taskId: string, cwd: string, message: string, report?: WorkerReport): Promise<void> {
  const status = await accordStatus(taskId, cwd);
  if (status === "claimed" && report) {
    const deliver = await runTandemCommand([
      "accord", "deliver", taskId,
      "--summary", report.summary,
      ...report.evidence.flatMap(({ criterion, observation }) => ["--evidence", `${criterion}: ${observation}`]),
      ...report.files.flatMap((file) => ["--file-changed", file]),
    ], cwd);
    if (!deliver.ok) throw new Error(`Could not deliver Worker work for ${taskId} before recording rework; feedback was not sent. ${deliver.error}`);
  }
  const result = await runTandemCommand(["accord", "rework", taskId, "--note", reworkNote(message)], cwd);
  if (!result.ok) throw new Error(`Could not record Worker rework for ${taskId}; feedback was not sent. ${result.error}`);
}

export function requireActiveTask(task: any, taskId: string, context: string): void {
  if (task.location === "logs") throw new Error(`${context} requires an active Tandem Task: ${taskId} is archived in Logs.`);
}

export function workerTaskDefinition(task: any): WorkerTaskDefinition {
  return {
    id: task.id,
    title: task.title,
    body: nstarContractBody(task.body || ""),
    state: task.state ?? null,
    priority: task.priority ?? null,
    blockers: Array.isArray(task.blockers) ? task.blockers : [],
    relatedFiles: Array.isArray(task.relatedFiles) ? task.relatedFiles : [],
    references: Array.isArray(task.references) ? task.references : [],
    acceptance: task.accord?.acceptance ?? [],
    constraints: task.accord?.constraints ?? [],
    validations: task.accord?.validations ?? [],
  };
}

export async function captureWorkerAssignment(task: any, cwd: string): Promise<WorkerAssignment> {
  const children = Array.isArray(task.children) ? task.children : [];
  const milestones = [];
  for (const child of children) {
    if (typeof child?.id !== "string") throw new Error(`Tandem Task ${task.id} has a child without an ID; refusing an incomplete Worker assignment.`);
    const definition = await tandemShow(child.id, cwd);
    if (definition.location === "logs") continue;
    if (definition.location !== "board") {
      throw new Error(`Tandem Task ${child.id} has unknown location ${String(definition.location)}; refusing an incomplete Worker assignment.`);
    }
    milestones.push(workerTaskDefinition(definition));
  }
  return { root: workerTaskDefinition(task), milestones };
}

export async function requireNoOpenWorkerSubtasks(task: any, cwd: string, phase: "merge" | "complete"): Promise<void> {
  const children = Array.isArray(task.children) ? task.children : [];
  const open: string[] = [];
  for (const child of children) {
    if (typeof child?.id !== "string") {
      throw new Error(`Tandem root Task ${task.id} has a child without an ID; worker_finish cannot verify its subtasks and will not ${phase}.`);
    }
    const subtask = await tandemShow(child.id, cwd);
    if (subtask.location !== "logs") {
      const title = typeof subtask.title === "string" && subtask.title.trim() ? ` (${subtask.title})` : "";
      open.push(`${subtask.id}${title}`);
    }
  }
  if (open.length === 0) return;
  const operation = phase === "merge" ? "merge this Worker delivery" : "complete the root Task";
  throw new Error(`Worker finish cannot ${operation} while these subtasks are active: ${open.join(", ")}. The orchestrator must complete or cancel the listed subtasks in Tandem, then retry worker_finish.${phase === "merge" ? " No merge was attempted by this call." : ""}`);
}

export async function validateWorkerDispatch(task: any, cwd: string): Promise<void> {
  if (typeof task.parentId === "string" && task.parentId) {
    throw new Error(`Task ${task.id} is a subtask of ${task.parentId}; a Worker owns an entire root Task, never a subtask. Start the Worker for ${task.parentId}; its subtasks are milestones within that assignment.`);
  }
  const effort = task.effort;
  if (typeof effort !== "string" || !effort.trim()) {
    throw new Error(`Task ${task.id} has no effort set; set effort before starting a Worker.`);
  }
  if (WORKER_LIGHT_EFFORTS.has(effort)) return;

  const missing: string[] = [];
  if ((await tandemAssignment(task.id, cwd)).length === 0) {
    missing.push(`Task ${task.id} has no runnable validations; medium or larger effort requires a runnable validation written as \`$ <command>\`.`);
  }
  if (!Array.isArray(task.relatedFiles) || task.relatedFiles.length === 0) {
    missing.push(`Task ${task.id} has no relatedFiles; medium or larger effort requires at least one related file.`);
  }
  if (missing.length > 0) throw new Error(missing.join(" "));
}

export function latestTodoList(ctx: ExtensionContext): WorkerReport["checklist"] {
  let todos: TodoItem[] | undefined = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    todos = applyTodoEntry(todos, entry);
  }
  return todos ?? [];
}

export function diagnosticText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return (text.trim() || "Unknown Worker handoff publication failure.").slice(0, 4_000);
}

export const PROVIDER_ERROR_DIAGNOSTIC_PREFIX = "Worker turn ended on a provider error: ";

export const REJECTED_REPORT_DIAGNOSTIC_PREFIX = "Rejected worker_report";

export const REJECTED_REPORT_SUFFIX = " This report was NOT delivered. Fix the cause and resubmit worker_report in this turn, or use worker_ask; if the turn ends without a successful worker_report the owner is notified of this rejection. Never end with a plain final message claiming the report was submitted.";

/**
 * Diagnostic when the Worker ended its turn after a rejected worker_report. A
 * rejection alone is not reported (the Worker can usually fix it in the same
 * turn); only a settled turn counts: the last message is an assistant message
 * that stopped normally with no pending tool call, and the latest worker_report
 * result since the turn's Parent request is an error with no success after it.
 */
export function rejectedReportDiagnostic(ctx: ExtensionContext): string | undefined {
  const messages = ctx.sessionManager.getBranch().filter((entry: any) => entry?.type === "message").map((entry: any) => entry.message);
  const last = messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "stop" || (Array.isArray(last.content) && last.content.some((part: any) => part?.type === "toolCall"))) return undefined;
  const turnStart = messages.findLastIndex((message: any) => message?.role === "user");
  const results = messages.slice(turnStart + 1).filter((message: any) => message?.role === "toolResult" && message.toolName === "worker_report");
  const rejected = results.at(-1);
  if (!rejected?.isError) return undefined;
  const call = messages.flatMap((message: any) => message?.role === "assistant" && Array.isArray(message.content) ? message.content : [])
    .find((part: any) => part?.type === "toolCall" && part.id === rejected.toolCallId);
  const status = typeof call?.arguments?.status === "string" ? call.arguments.status : "unknown";
  const summary = typeof call?.arguments?.summary === "string" ? call.arguments.summary.replace(/\s+/g, " ").trim().slice(0, 500) : "";
  const text = Array.isArray(rejected.content) ? rejected.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join(" ") : "";
  const reason = text.replace(REJECTED_REPORT_SUFFIX, "").replace(/\s+/g, " ").trim().slice(0, 2_000) || "no error text";
  return `${REJECTED_REPORT_DIAGNOSTIC_PREFIX} (status=${status}) was not delivered: ${reason}${summary ? ` | Attempted summary: ${summary}` : ""}`;
}

/** Diagnostic when the session's last message is an assistant message that ended on a provider error (stopReason "error", after Pi's own retries). */
export function providerErrorDiagnostic(ctx: ExtensionContext): string | undefined {
  const last = ctx.sessionManager.getBranch().filter((entry: any) => entry?.type === "message").at(-1) as any;
  const message = last?.message;
  if (message?.role !== "assistant" || message.stopReason !== "error") return undefined;
  const text = typeof message.errorMessage === "string" ? message.errorMessage.replace(/\s+/g, " ").trim() : "";
  return `${PROVIDER_ERROR_DIAGNOSTIC_PREFIX}${text.slice(0, 500) || "no error message"}`;
}

export async function checkoutBranch(checkoutPath: string, label: string): Promise<string> {
  let branch: string;
  try {
    branch = (await command("git", ["branch", "--show-current"], checkoutPath)).trim();
  } catch (error) {
    throw new Error(`${label} checkout ${checkoutPath} is unavailable. Reopen the original Worktrunk checkout and retry; no merge was attempted. ${diagnosticText(error)}`);
  }
  if (!branch) throw new Error(`${label} checkout ${checkoutPath} is detached; select its captured branch through Worktrunk before integrating.`);
  return branch;
}

export async function checkoutRepoKey(checkoutPath: string, label: string): Promise<string> {
  try {
    const gitDir = (await command("git", ["rev-parse", "--git-common-dir"], checkoutPath)).trim();
    if (!gitDir) throw new Error("Git returned an empty common directory.");
    const absolute = resolve(checkoutPath, gitDir);
    return absolute.endsWith("/.git") ? absolute : `${absolute}/.git`;
  } catch (error) {
    throw new Error(`${label} checkout ${checkoutPath} has no readable native repository identity. ${diagnosticText(error)}`);
  }
}

export async function validateCapturedCheckout(identity: { checkoutPath: string; branch: string }, repoKey: string, label: string): Promise<string> {
  const actualRepoKey = await checkoutRepoKey(identity.checkoutPath, label);
  const capturedRepoKey = repoKey.endsWith("/.git") ? repoKey : `${repoKey}/.git`;
  if (actualRepoKey !== capturedRepoKey) {
    throw new Error(`${label} checkout ${identity.checkoutPath} belongs to ${actualRepoKey}, not captured repository ${repoKey}. Reopen the original Worktrunk checkout; no merge was attempted.`);
  }
  const branch = await checkoutBranch(identity.checkoutPath, label);
  if (branch !== identity.branch) {
    throw new Error(`${label} branch changed to ${branch}; expected captured branch ${identity.branch}. Restore it through Worktrunk; no merge was attempted.`);
  }
  return branch;
}

export async function requireCleanCheckout(checkoutPath: string, label: string): Promise<void> {
  let status: string;
  try {
    status = await command("git", ["status", "--porcelain"], checkoutPath);
  } catch (error) {
    throw new Error(`${label} checkout ${checkoutPath} cannot be inspected. Reopen the original Worktrunk checkout and retry; no merge was attempted. ${diagnosticText(error)}`);
  }
  if (!status.trim()) return;
  const conflicts = status.split("\n").filter((line) => /^(DD|AU|UD|UA|DU|AA|UU)/.test(line));
  const reason = conflicts.length > 0 ? "has unresolved conflicts" : "is dirty";
  throw new Error(`${label} checkout ${checkoutPath} ${reason}. Resolve or preserve those changes, then retry the explicit Worktrunk merge; the Worker checkout has not been removed.`);
}

export const DiscardParameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Exact retained Worker or manus whose attempt should be discarded." }),
  note: Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Reason for discarding the attempt." }),
}, { additionalProperties: false });

export const PauseParameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Exact directly owned Worker to pause." }),
  note: Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Durable reason for pausing the Worker." }),
}, { additionalProperties: false });

export const FeedbackParameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Exact directly owned Worker receiving owner feedback." }),
  message: Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Owner feedback or a scope clarification." }),
  approve: Type.Optional(Type.Boolean({ description: "Set true ONLY to approve the Worker's pending plan for implementation. Valid only while the Worker's current report is a plan; otherwise the call fails before anything is sent. Omitted or false on a plan is a revision request: the plan stays unapproved and the Worker revises and resubmits." })),
}, { additionalProperties: false });

export const WorkerAskParameters = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 4_000, description: "One focused clarification question for the owning orchestrator, not the human." }),
}, { additionalProperties: false });

export const WorkerAnswerParameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Exact directly owned Worker that asked the question." }),
  questionId: Type.String({ minLength: 1, description: "Exact pending question ID from the Worker question notice." }),
  answer: Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Answer to that clarification; resumes the same Worker without recording rework." }),
}, { additionalProperties: false });

export const WorkerReportEvidenceParameters = Type.Object({
  criterion: Type.String({ minLength: 1, description: "Label for the Worker's observation or evidence." }),
  observation: Type.String({ minLength: 1, description: "Concrete observation, evidence, or gap for the orchestrator." }),
}, { additionalProperties: false });

/** Short form (task-568): a trivial/small-effort Task may send only status, summary, files and evidence;
 * worker_report fills the rest. Medium and larger Tasks must send every field. */
const FULL_ONLY = "Required for medium and larger Tasks; a small Task's short report leaves it out.";
export const WorkerReportParameters = Type.Object({
  version: Type.Optional(Type.Literal(1, { description: FULL_ONLY })),
  taskId: Type.Optional(Type.String({ minLength: 1, description: `Current assigned Tandem Task ID. ${FULL_ONLY}` })),
  status: Type.Union([Type.Literal("plan"), Type.Literal("ready"), Type.Literal("needs-input")]),
  summary: Type.String({ minLength: 1 }),
  files: Type.Array(Type.String()),
  validation: Type.Optional(Type.Array(Type.String(), { description: `Human-readable planned checks or actual observations, including command and supplemental browser/manual check outcomes. ${FULL_ONLY}` })),
  blockers: Type.Optional(Type.Array(Type.String(), { description: FULL_ONLY })),
  risks: Type.Optional(Type.Array(Type.String(), { description: FULL_ONLY })),
  evidence: Type.Array(WorkerReportEvidenceParameters),
}, { additionalProperties: false });

export type WorkerReportInput = Static<typeof WorkerReportParameters>;

export const WorkerProgressParameters = Type.Object({
  action: Type.Union([Type.Literal("start"), Type.Literal("report"), Type.Literal("block"), Type.Literal("resume")], { description: "Scoped milestone progress action." }),
  milestoneId: Type.String({ minLength: 1, description: "Existing active milestone in the current Worker's captured assignment." }),
  summary: Type.Optional(Type.String({ minLength: 1, description: "Progress summary for report." })),
  evidence: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Evidence for report." })),
  note: Type.Optional(Type.String({ minLength: 1, description: "Blocking note for block." })),
}, { additionalProperties: false });

export type WorkerProgressInput = Static<typeof WorkerProgressParameters>;

export function assignmentScope(value: WorkerAssignment): unknown {
  const definition = (task: WorkerTaskDefinition) => ({
    id: task.id, title: task.title, body: nstarContractBody(task.body), blockers: task.blockers,
    relatedFiles: task.relatedFiles, references: task.references,
    acceptance: task.acceptance, constraints: task.constraints, validations: task.validations,
  });
  return { root: definition(value.root), milestones: value.milestones.map(definition) };
}

/**
 * A milestone the owner completed or cancelled after the report leaves the
 * active assignment (finish even requires that); that is not a scope change.
 * Root definition changes and new or edited active milestones still are.
 */
export function reportScopeMatchesCurrent(report: WorkerReport, current: WorkerAssignment): boolean {
  const active = new Set(current.milestones.map(({ id }) => id));
  if (!report.assignment) return false;
  const reported = { ...report.assignment, milestones: report.assignment.milestones.filter(({ id }) => active.has(id)) };
  return JSON.stringify(assignmentScope(reported)) === JSON.stringify(assignmentScope(current));
}

export async function runWorkerProgressNative(action: WorkerProgressInput["action"], milestoneId: string, params: WorkerProgressInput, agentName: string, cwd: string): Promise<any> {
  const nativeAction = { start: "claim", report: "deliver", block: "block", resume: "resume" }[action];
  const args = ["accord", nativeAction, milestoneId];
  if (action === "start") args.push("--assignee", agentName);
  if (action === "report") {
    const summary = params.summary?.trim();
    if (!summary) throw new Error("worker_progress report requires summary.");
    args.push("--summary", summary);
    for (const evidence of params.evidence ?? []) args.push("--evidence", evidence);
  }
  if (action === "block") {
    const note = params.note?.trim();
    if (!note) throw new Error("worker_progress block requires note.");
    args.push("--note", note);
  }
  args.push("--json");
  const output = await command("tandem", args, cwd);
  let parsed: any;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Native Tandem ${nativeAction} returned invalid JSON: ${diagnosticText(error)}`);
  }
  if (!parsed?.ok) throw new Error(`Native Tandem ${nativeAction} rejected milestone ${milestoneId}: ${JSON.stringify(parsed?.error ?? parsed)}`);
  return { action: nativeAction, ...parsed };
}
