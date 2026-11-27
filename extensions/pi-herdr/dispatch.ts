import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createDispatchRenderer, type DispatchTool } from "../pi-ui/tool-ui/custom-tools/dispatch.ts";
import { closeMessage, ID_PATTERN, isOpen, localMachine, messages, readEvents } from "../pi-agency/inbox/envelope.ts";
import { localSettingsPath, temporaryAgencySettings } from "../pi-agency/local-settings.ts";
import { hcProfileRequested } from "../pi-agency/subagents/profile.ts";
import { describeSelection, explicitFlagArgs, explicitLaunchArgs, selectLaunchModel, type LaunchOverride, type LaunchSelection } from "../pi-agency/launch-model.ts";
import { THINKING_LEVELS } from "../pi-agency/subagents/profile.ts";
import { WORKER_CONTEXT_FLAG } from "../pi-agency/workers/context.ts";
import { command, diagnosticText, MAX_PROMPT_LENGTH, captureWorkerAssignment, nativeHead, nativeProjectIdentity, nativeWorktreeForBranch, checkoutBranch, requireActiveTask, tandemShow } from "../pi-agency/workers/shared.ts";
import { createHcManusRecord, updateHcWorkerRecord, type HcWorkerIntegration } from "../pi-agency/workers/hc-record.ts";
import { newId } from "../pi-agency/state.ts";
import { nstarNote } from "../pi-agency/nstar-note.ts";
import { requireContract, requireLaunchBrief } from "../pi-agency/workers/contract.ts";
import { KIND_KEY, LABEL_KEY, labelFrom, nameFor, terminalWho } from "../../scripts/whois.ts";
import { CHILD_EXIT, coreId as appCoreId, hcJson, hcMachines, KICKOFF_FLAG } from "./core.ts";
import { appCommand, localAppHost, resolveAppSpace, type AppHost } from "./app-host.ts";
import { ownerExtensionArgs, type StartWorker } from "./workers.ts";
import { withHook, workStart, type HookCaller } from "./herdra-work.ts";

/**
 * One call to start any child, manus or Ceph (task-65 contract, task-559). Each tool checks its
 * preconditions before any side effect, launches once, checks the launch, and returns. None selects
 * or focuses anything (except the approved new-project space of ceph_start), waits, polls, retries,
 * or falls back: hc, the Herdr app, Tandem, Worktrunk and the inbox stay the authorities. Every one that
 * starts a Pi takes the same optional exact `model` and `thinking` (task-851, pi-agency/launch-model.ts):
 * omitted, the role/set default; given, exact, preflighted and never replaced.
 */
const NAME = "^[a-z0-9_-]{1,32}$";
const NAME_PATTERN = new RegExp(NAME);
const HELPER_KINDS = ["scout", "researcher", "reviewer"] as const;
/** The Worker start requires a direction; with none given, the Task contract and managed brief are the direction. */
const DEFAULT_WORKER_DIRECTION = "Start your assigned work under the authoritative managed contract. Report the actual outcome to your owner.";

/** The one per-launch model pair every Pi-starting tool takes (task-851); omitted fields inherit the role's choice and level. */
const ModelOverride = {
  model: Type.Optional(Type.String({ minLength: 3, description: "Exact provider/id to run this child on (e.g. anthropic/claude-fable-5-1). Omitted: the role/set default. Checked before anything starts (catalog, configured auth, provider policy, quota); refuses instead of substituting, never cut over or switched on a 429." })),
  thinking: Type.Optional(Type.Union([...THINKING_LEVELS].map((level) => Type.Literal(level)), { description: "Thinking level for this child. Omitted: the role's level (or, with model, the role's level for that model if supported). Refused when the model does not support it; with no model, the role default's model is resolved first and then locked." })),
};

/** A label is 2-5 plain words; its slug is the hc name (and branch). */
const LABEL_MAX = 80;
const Label = (fallback: string) => Type.Optional(Type.String({ minLength: 1, maxLength: LABEL_MAX, description: `2-5 plain words naming it for Algorant (e.g. "Cleaner alert cards"), stored as hc label label=; its slug is the hc name${fallback.includes("branch") ? " and branch" : ""} (-2 on a collision). Default: ${fallback}.` }));

const From = Type.Optional(Type.String({ pattern: ID_PATTERN.source, description: "Inbox request id (m1234abcd) this dispatches; it is closed with \"dispatched to <name>\" after a confirmed launch." }));

const DendraParameters = Type.Object({
  kind: Type.Union([...HELPER_KINDS, "worker"].map((kind) => Type.Literal(kind)), { description: "scout | researcher | reviewer (read-only helpers) or worker (a Task or Task-free brief, worktree by default)." }),
  label: Label("the Task title (Worker); required without a Task; or the task first line (helper)"),
  task: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Helpers: the self-contained bounded assignment (required)." })),
  taskId: Type.Optional(Type.String({ minLength: 1, description: "Worker: existing root Task; exactly one taskId or brief." })),
  brief: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Worker: small-work contract with nonempty Request / Sources / Rejected / Return, then Outcome / Scope / Exclusions / Check / Done sections, all nine required in that order (a refusal prints the skeleton). Request's first line is `> ` Algorant's exact words (relayed metadata may follow), or exactly `No direct quote: <reason>` with a durable source in Sources; Rejected says `none` only when true. Scope lists repo-relative files/dirs (dirs end in /); Check uses runnable `$ ` lines. Cold-read the draft with a scout first (agency skill). Exactly one taskId or brief; label required without a Task." })),
  worktree: Type.Optional(Type.Boolean({ description: "Worker: default true, false explicitly skips isolation and uses this checkout." })),
  needsAlgorant: Type.Optional(Type.Boolean({ description: "Default false; true delivers for Algorant judgement and forbids auto-finish." })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Worker: optional temporary direction; durable scope stays in the Task." })),
  ...ModelOverride,
  from: From,
}, { additionalProperties: false });

const ManusParameters = Type.Object({
  taskId: Type.Optional(Type.String({ minLength: 1, description: "Existing project Task; exactly one taskId or brief." })),
  brief: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Track contract with nonempty Request / Sources / Rejected / Return, then Outcome / Scope / Exclusions / Check / Done sections, all nine required in that order (a refusal prints the skeleton). Request's first line is `> ` Algorant's exact words (relayed metadata may follow), or exactly `No direct quote: <reason>` with a durable source in Sources; Rejected says `none` only when true. Scope lists repo-relative files/dirs. Cold-read the draft with a scout first (agency skill). Exactly one taskId or brief; label required without a Task." })),
  needsAlgorant: Type.Optional(Type.Boolean({ description: "Default false; true requires Algorant judgement before integration." })),
  label: Label("the Task title; the label is also its tab name and its slug its branch"),
  worktree: Type.Optional(Type.Boolean({ description: "Default true: own Worktrunk checkout; false explicitly skips it (research/shared checkout)." })),
  direction: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Optional extra direction appended to the brief." })),
  ...ModelOverride,
  from: From,
}, { additionalProperties: false });

const CephParameters = Type.Object({
  project: Type.String({ pattern: NAME, description: "Project name: the Ceph's hc name and its space name." }),
  folder: Type.String({ minLength: 1, description: "Existing project directory: its own Git checkout root with a prepared Tandem workspace (projectify makes them first)." }),
  kickoff: Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Agreed context for the new Ceph; the caller's return route and \"report back when ready\" are appended." }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: LABEL_MAX, description: "Its name for Algorant, stored as hc label label=. Default: \"<project> Ceph\". The hc name stays the project (its route)." })),
  ...ModelOverride,
  from: From,
}, { additionalProperties: false });

type Caller = { address: string; route: string; label: string; core: string; space?: string; tab?: string; labels: Record<string, string>; hc: HookCaller["record"] };
type Result = AgentToolResult<Record<string, unknown>>;

const result = (text: string, details: Record<string, unknown>): Result => ({ content: [{ type: "text", text }], details });

/** The caller's native facts. Its return route is its hc name, or its live address when unnamed (no invented name). */
async function caller(): Promise<Caller> {
  const id = process.env.HC_TERMINAL_ID;
  if (!id) throw new Error("Dispatch tools require a native hc terminal (HC_TERMINAL_ID is unset).");
  const [self, server] = await Promise.all([hcJson(["get", id]), hcJson(["server", "status"])]);
  if (typeof self.address !== "string" || typeof server.core?.id !== "string") throw new Error("hc did not return this terminal's address and core id.");
  return { address: self.address, route: self.name || self.address, label: terminalWho(self).label, core: server.core.id, space: self.labels?.["herdr.space"] || undefined, tab: self.labels?.["herdr.tab"] || undefined, labels: self.labels ?? {}, hc: self };
}

/** `from` must be an open request or blocker addressed to this terminal; checked before anything starts. */
function requireOpenRequest(from: string | undefined, self: Caller): void {
  if (from === undefined) return;
  const view = messages(readEvents()).get(from);
  if (!view) throw new Error(`No inbox message ${from} in this machine's log. Nothing was started.`);
  if (!isOpen(view)) throw new Error(`Inbox message ${from} is not open (${view.kind}${view.failed ? ", failed" : view.closed ? `, closed: ${view.closed.note}` : ""}). Nothing was started.`);
  if (view.to.terminal !== self.address || view.to.core !== self.core) throw new Error(`Inbox request ${from} is addressed to ${view.to.label || view.to.terminal}, not this terminal. Nothing was started.`);
}

/** Closes the dispatched request with the existing inbox close event, only after a confirmed launch. */
function closeRequest(from: string | undefined, name: string, self: Caller): Record<string, unknown> {
  if (from === undefined) return {};
  try {
    closeMessage(from, `dispatched to ${name}`, { machine: localMachine(), terminal: self.address, core: self.core });
    return { requestClosed: from };
  } catch (error) {
    return { requestCloseError: `${from} stays open: ${diagnosticText(error)}` };
  }
}

/** The label given, else its fallback; one line either way (a given label must be one line). */
function labelOf(given: string | undefined, fallback: string): string {
  if (given !== undefined && /[\r\n]/.test(given.trim())) throw new Error("label must be one line of 2-5 plain words. Nothing was started.");
  const label = labelFrom(given ?? fallback);
  if (!label) throw new Error("No label: pass label (2-5 plain words). Nothing was started.");
  return label;
}

async function appLs(): Promise<any> {
  if (!(process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, "herdr-app")))) {
    throw new Error(`The Herdr app (herdr-app) is not installed on this machine (${localMachine()}); nothing was started.`);
  }
  try { return JSON.parse(await command("herdr-app", ["ls"], undefined, 15_000)); }
  catch (error) { throw new Error(`herdr-app ls failed; is the Herdr app window open? ${diagnosticText(error)}`); }
}

/** One app ls after launch: rename an adopted tab (no selection), or report adoption pending. */
async function nameTab(host: AppHost, spaceId: string, terminal: string, tabName: string): Promise<Record<string, unknown>> {
  let tab: any;
  try {
    const app = JSON.parse(await appCommand(host, ["ls"]));
    const space = app.spaces?.find((entry: any) => appCoreId(entry.machine, entry.id) === spaceId);
    tab = space?.tabs?.find((entry: any) => entry.terminals?.some((item: any) => appCoreId(space.machine, item.terminal) === terminal));
  } catch (error) { return { tab: "pending", tabError: diagnosticText(error) }; }
  if (!tab) return { tab: "pending" };
  if (tab.name === tabName) return { tab: tab.id, tabName };
  try {
    const out = JSON.parse(await appCommand(host, ["do", "tab.rename", "--id", tab.id, "--name", tabName]));
    if (out?.ok !== true) throw new Error(JSON.stringify(out).slice(0, 300));
    return { tab: tab.id, tabName };
  } catch (error) {
    return { tab: tab.id, tabName: tab.name, tabError: `tab.rename to ${tabName} failed; the brief tells it to rename its own tab. ${diagnosticText(error)}` };
  }
}

/** A raw `pi <brief>` launch has no first message to check: proof is the live terminal with the
 * requested name, then its own inbox report. A failed request is reported, never retried. */
/**
 * `hc run` takes only hc's own options before `--`; a Pi flag placed there makes the launcher read it
 * as the program to run ("cannot start --session-id"). Name the offender instead of retrying.
 */
const HC_RUN_OPTIONS = new Set(["--json", "--name", "--cwd", "--on", "--label", "--parent", "--no-parent", "--no-notify", "--outlive-parent", "--rm", "--keep", "--bg", "--timeout"]);

function assertLauncherArgs(args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") return;
    if (!arg.startsWith("-")) continue;
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!HC_RUN_OPTIONS.has(flag)) throw new Error(`Nothing was started: "${flag}" is not an hc run option, so it would be run as the program. hc run takes only hc flags before "--"; the program's own flags go after it.`);
  }
}

async function launchRaw(args: string[], name: string): Promise<any> {
  assertLauncherArgs(args);
  let started: any;
  try { started = await hcJson(["run", ...args], 30_000); }
  catch (error) { throw new Error(`hc run did not confirm ${name}: ${diagnosticText(error)} Inspect hc get ${name} before anything else; nothing was retried.`); }
  if (started?.name !== name || typeof started.address !== "string" || started.state !== "live") {
    throw new Error(`hc run returned no live terminal named ${name}: ${JSON.stringify(started).slice(0, 400)}. Nothing was retried.`);
  }
  return started;
}

/** The one cold-read definition, the same file the audit skill's Cold read check applies (task-755). */
const COLD_READ = fileURLToPath(new URL("../../skills/audit/cold-read.md", import.meta.url));

/**
 * The one read-only helper launch: `dendra_start` scout/researcher/reviewer, and the cold read after a
 * Ceph kickoff. Preconditions are settled by the caller; this names the terminal, resolves the
 * child's model (a role default cuts over only when quota alone blocks it; an explicit one never)
 * and runs one hc child. It never selects, waits, polls or retries.
 */
async function launchHelper(kind: "scout" | "researcher" | "reviewer", label: string, task: string, ctx: ExtensionContext, override: LaunchOverride = {}): Promise<{ name: string; address: string; switched?: Record<string, unknown>; helperSwitch: string; selection: LaunchSelection }> {
  const name = await nameFor(label);
  // The child's model is settled here, after every read-only precondition and before any terminal:
  // a blocked or unavailable launch refuses first, cutting a role default over only when quota alone
  // blocks it. A role default launches without a model argument (the child resolves the same role
  // itself); an explicit model or thinking is exact, passed to the child, and kept there. A
  // reviewer's author model is this Pi's own current model (the fact it publishes as pi.model, which
  // a default child reads), so a default reviewer without one fails here; an explicit reviewer model
  // replaces that routing.
  const callerModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  if (kind === "reviewer" && callerModel === undefined && override.model === undefined) throw new Error(`A reviewer needs this Pi's current model (published as pi.model) to choose the opposite-company reviewer; nothing was started.`);
  const resolved = await selectLaunchModel(kind === "reviewer" ? "review" : "subagent", override, ctx.modelRegistry, { callerModel });
  if ("refusal" in resolved) throw new Error(`${resolved.refusal} Nothing was started.`);
  const helperSwitch = resolved.switched
    ? ` Set ${resolved.switched.from} → ${resolved.switched.to} for ${kind} (cutover ${resolved.switched.operation ?? "none"}${resolved.switched.partial ? "; some typed requests failed or a Pi was skipped" : ""}).`
    : "";
  // The caller is the native parent: the report comes to its inbox, a default reviewer reads its pi.model.
  // The task is Pi's first message on its command line; child-exit tells the parent if it ends unreported.
  let started: any;
  try {
    started = await launchRaw(["--bg", "--rm", "--no-notify", "--json", "--name", name, "--cwd", ctx.cwd, "--label", `${LABEL_KEY}=${label}`, "--label", `${KIND_KEY}=${kind}`,
      "--", CHILD_EXIT, "pi", `--${KICKOFF_FLAG}`, ...ownerExtensionArgs(), ...explicitLaunchArgs(resolved.selection), "--agency-profile", kind, "--", `${task.trim()}\n\nUse the automatic failed-call summary in your final report for this invocation; do not infer failures or repeat the summary.`], name);
  } catch (error) {
    throw new Error(`${diagnosticText(error)}${helperSwitch ? `${helperSwitch} That cutover stays applied.` : ""}`);
  }
  return { name, address: started.address, ...(resolved.switched ? { switched: resolved.switched } : {}), helperSwitch, selection: resolved.selection };
}

/**
 * One advisory cold read after a confirmed Ceph kickoff (a Task-free brief is cold-read by its caller before launch, never here). The definition is inline
 * in the helper's task with the text and the repository root, so the helper never depends on which
 * agent directory it loaded. It never delays, blocks or retries the launch: a refusal or launch error
 * leaves the launch standing and returns one reported line for the card.
 */
async function coldRead(what: "kickoff", label: string, text: string, root: string, ctx: ExtensionContext): Promise<Record<string, unknown>> {
  let definition: string;
  try { definition = readFileSync(COLD_READ, "utf8").trim(); }
  catch (error) { return { status: "not started", error: `${COLD_READ} is unreadable: ${diagnosticText(error)}` }; }
  const helperLabel = `Cold read ${label.trim().split(/\s+/).slice(0, 3).join(" ")}`;
  const task = [
    "You are a cold reader, not an editor. Apply exactly the checks in this definition:",
    definition,
    `The ${what} under review is "${label}", verbatim:`,
    text.trim(),
    `Repository root for every path and command you check: ${root}`,
    "Report only the three gaps the definition names, in its format. Never rewrite the text, and do not judge its description, triggers or ambition.",
  ].join("\n\n");
  try {
    const helper = await launchHelper("scout", helperLabel, task, ctx);
    return { status: "started", label: helperLabel, name: helper.name, terminal: helper.address };
  } catch (error) {
    return { status: "not started", label: helperLabel, error: diagnosticText(error) };
  }
}

/** What the launch says about its cold read, or nothing when it had none to start. */
function coldReadNote(facts: Record<string, unknown> | undefined): string {
  if (!facts) return "";
  return facts.status === "started"
    ? ` Advisory cold read ${facts.label} (${facts.name}) started; its findings arrive in your inbox.`
    : ` No cold read: ${facts.error}`;
}

const appRoute = (host: AppHost) => host.machine ? `hc exec --on ${host.machine} -- herdr-app` : "herdr-app";
const rules = (route: string, name: string, tabName: string, host: AppHost) => [
  `Check in to your actual starter/owner ${route} one level up with ordinary agent_send kind=result (never reply_to), one headline under 160 characters: “doing X; next Y”. Follow the global AGENTS.md check-in cadence; cite the assignment in the body.`,
  `Report results, questions and blockers only to ${route} with agent_send terminal=${route}: line 1 is the answer (one line, at most 160 characters), detail below or in an artifact.`,
  "Never select or focus any space, tab or terminal. Never sleep, poll or wait on a timer: start work, end the turn, act when the inbox delivers.",
  `Your app tab should be named "${tabName}". If the tab in \`${appRoute(host)} ls\` whose terminals include $HC_TERMINAL_ID has another name, rename it: ${appRoute(host)} do tab.rename --id <that tab> --name "${tabName}". Your hc name is ${name}.`,
];

export function registerDispatch(pi: ExtensionAPI, startWorker: StartWorker): void {
  // The resolver API erases tool argument types (ToolRenderers); each card only ever draws its own tool.
  const cards = new Map<string, ToolRenderers>((["dendra_start", "manus_start", "ceph_start"] as DispatchTool[]).map((tool) => [tool, createDispatchRenderer(tool) as ToolRenderers]));
  // Rows rebuilt by /reload or resume before session_start registers the tools keep their cards.
  pi.registerToolRenderer((toolName, next) => next() ?? cards.get(toolName));

  async function dendraStart(params: { kind: string; label?: string; task?: string; taskId?: string; brief?: string; prompt?: string; worktree?: boolean; needsAlgorant?: boolean; model?: string; thinking?: string; from?: string }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
    const self = await caller();
    if (params.kind === "worker") {
      requireContract(params);
      requireLaunchBrief(params);
      if (params.label !== undefined) labelOf(params.label, "");
      if (params.task !== undefined) throw new Error("dendra_start worker takes taskId or brief, not task. Nothing was started.");
      requireOpenRequest(params.from, self);
      const started = await startWorker({ taskId: params.taskId, brief: params.brief, label: params.label?.trim(), worktree: params.worktree ?? true, needsAlgorant: params.needsAlgorant ?? false, model: params.model, thinking: params.thinking, from: params.from, prompt: params.prompt ?? DEFAULT_WORKER_DIRECTION }, signal, ctx);
      const d = started.details as Record<string, any>;
      const closed = closeRequest(params.from, `${d.label} (${d.agent})`, self);
      return result(`${(started.content[0] as { text: string }).text}${closed.requestClosed ? ` Closed request ${params.from}.` : closed.requestCloseError ? ` ${closed.requestCloseError}` : ""}`,
        { ...d, kind: "worker", name: d.agent, cwd: d.worktreePath, route: self.route, ...closed });
    }
    if ([params.taskId, params.brief, params.prompt, params.worktree, params.needsAlgorant].some((value) => value !== undefined)) throw new Error(`dendra_start ${params.kind} takes task and an optional label; Worker fields are for kind worker. Nothing was started.`);
    if (!params.task?.trim()) throw new Error(`dendra_start ${params.kind} requires task, the self-contained bounded assignment. Nothing was started.`);
    // The temporary machine policy pauses reviews before any launch side effect; the
    // reviewer child would also refuse inside resolveReviewEntry, but nothing starts.
    if (params.kind === "reviewer" && temporaryAgencySettings().review === "paused") {
      throw new Error(`Reviews are paused by "pi-agency-temporary".review in ${localSettingsPath()}; remove that key to restore reviewer launches. Nothing was started.`);
    }
    const label = labelOf(params.label, params.task);
    requireOpenRequest(params.from, self);
    const helper = await launchHelper(params.kind as "scout" | "researcher" | "reviewer", label, params.task, ctx, { model: params.model, thinking: params.thinking });
    const closed = closeRequest(params.from, `${label} (${helper.name})`, self);
    return result(`Started ${params.kind} ${label} (${helper.name}, ${helper.address}) in ${ctx.cwd}.Model ${describeSelection(helper.selection)}. Its report arrives in your inbox; do not wait or poll.${helper.helperSwitch}`,
      { kind: params.kind, label, name: helper.name, terminal: helper.address, cwd: ctx.cwd, route: self.route, ...(helper.switched ? { modelSwitched: helper.switched } : {}), selection: helper.selection, ...closed });
  }

  async function manusStart(params: { taskId?: string; brief?: string; label?: string; worktree?: boolean; needsAlgorant?: boolean; direction?: string; model?: string; thinking?: string; from?: string }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
    // Preconditions, all before any side effect.
    requireContract(params);
    requireLaunchBrief(params);
    const worktree = params.worktree ?? true;
    const needsAlgorant = params.needsAlgorant ?? false;
    const self = await caller();
    if (params.label !== undefined) labelOf(params.label, "");
    requireOpenRequest(params.from, self);
    // The manus role (its own entry, never the orchestrator or worker one) or an explicit model is
    // resolved before any worktree, record or terminal. A missing role or cell fails closed here.
    const repo = await nativeProjectIdentity(ctx.cwd);
    const project = basename(dirname(repo.repoKey));
    const task = params.taskId ? await tandemShow(params.taskId, repo.repoRoot) : undefined;
    if (task) {
      requireActiveTask(task, task.id, "manus_start");
      if (!String(task.body ?? "").trim()) throw new Error(`Task ${task.id} has an empty body; write its scope first. Nothing was started.`);
    }
    const assignment = task ? await captureWorkerAssignment(task, repo.repoRoot) : undefined;
    if (!self.space) throw new Error(`This terminal (${self.address}) has no herdr.space label: a manus opens in its starter's own app space. Nothing was started.`);
    const membership = await resolveAppSpace(self.space, self.tab, self.core, self.address);
    const { space, host } = membership;
    const spaceId = appCoreId(space.machine, space.id) as string;
    const label = labelOf(params.label, task?.title ?? "");
    // The label's slug names the hc terminal and, for a worktree, its branch (-2 when either is taken).
    const name = await nameFor(label, worktree ? repo.repoRoot : undefined);
    const branch = name;
    const baseHead = await nativeHead(repo.repoRoot, "Manus project");
    const targetBranch = await checkoutBranch(repo.repoRoot, "Manus project");
    // Every read-only precondition has passed: resolve the manus model now, before any checkout,
    // record or terminal exists. A role default cuts over only when quota alone blocks its set; an
    // explicit model or thinking is preflighted exactly and refuses instead.
    const manus = await selectLaunchModel("manus", { model: params.model, thinking: params.thinking }, ctx.modelRegistry, { signal });
    if ("refusal" in manus) throw new Error(`${manus.refusal} Nothing was started.`);
    const manusModel = manus.selection;
    const manusSwitch = manus.switched
      ? ` Set ${manus.switched.from} → ${manus.switched.to} for manus (cutover ${manus.switched.operation ?? "none"}${manus.switched.partial ? "; some typed requests failed or a Pi was skipped" : ""}).`
      : "";
    try {

    let cwd = repo.repoRoot;
    const childSessionId = newId();
    if (worktree) {
      // Worktrunk's own creation lifecycle under its normal hook approval, based on the
      // starter's HEAD exactly as a Worker's is.
      let created: any;
      try {
        created = JSON.parse(await command("wt", ["-C", repo.repoRoot, "switch", "--create", branch, "--base", "@", "--no-cd", "--format", "json"], repo.repoRoot, 0, signal));
      } catch (error) {
        const left = await nativeWorktreeForBranch(repo.repoRoot, branch);
        throw new Error(left
          ? `Worktrunk created ${left} but its creation lifecycle did not complete; it is preserved and no manus was started. ${diagnosticText(error)}`
          : `Worktrunk did not create ${branch}; nothing was created or started. ${diagnosticText(error)}`);
      }
      if (created?.action !== "created" || created.branch !== branch || typeof created.path !== "string" || !isAbsolute(created.path)) {
        throw new Error(`Worktrunk did not report a new checkout for ${branch}: ${JSON.stringify(created).slice(0, 400)}. No manus was started; inspect wt list.`);
      }
      cwd = created.path;
    }
    // One record at start, in the Worker record's own store and atomic write: the starter
    // finishes or discards the manus by it, so a created checkout is never ownerless.
    const integration: HcWorkerIntegration = worktree
      ? { repoKey: repo.repoKey, worktree: true, baseHead, source: { checkoutPath: cwd, branch }, target: { checkoutPath: repo.repoRoot, branch: targetBranch } }
      : { repoKey: repo.repoKey, worktree: false, baseHead, source: { checkoutPath: repo.repoRoot, branch: targetBranch }, target: { checkoutPath: repo.repoRoot, branch: targetBranch } };
    const record = await createHcManusRecord({ label, ...(task ? { taskId: task.id, assignment } : { brief: params.brief! }), needsAlgorant, ...(params.from ? { from: params.from } : {}),
      model: manusModel.argument,
      ownerSessionId: ctx.sessionManager.getSessionId(), owner: { core: self.core, terminal: self.address }, childAgent: name, childSessionId, integration });
    // The existing starter brief/label bind the one local note before the child starts.
    if (!task) await nstarNote({ cwd, label }, { initialize: true, brief: params.brief });
    const brief = [
      `You are manus "${label}" (hc name ${name}), started by ${self.label} (${self.route}) for ${project}${task ? ` Task ${task.id}: ${task.title}` : " (Task-free)"}.`,
      task ? `Your contract is \`tandem show ${task.id}\` (board in ${repo.repoRoot}); Algorant\'s words in it are acceptance, verbatim.` : `Your contract (verbatim):\n${params.brief}`,
      `needsAlgorant: ${needsAlgorant}. ${needsAlgorant ? "Deliver for Algorant judgement through your starter before integration." : "Deliver ready, verified work to your starter for integration."}`,
      params.from ? `Originating inbox thread: ${params.from}.` : undefined,
      task ? "Validation: run the Task's validations and applicable project checks; report actual observations." : `Validation: git diff --check ${baseHead}...HEAD plus the brief Check and applicable project checks; report actual observations.`,
      params.direction?.trim() ? `Direction from your starter: ${params.direction.trim()}` : undefined,
      worktree ? `You work in your own Worktrunk checkout ${cwd} on branch ${branch}; edit only there.` : `You run in the captured shared project checkout ${cwd}. Stay inside the contract; do not merge, remove this checkout or delete its branch.`,
      "",
      "Standing rules:",
      task ? `- Claim the Task now with yourself as assignee: tandem accord claim ${task.id} --assignee pi:${name}.` : "- This work is Task-free: git and the originating inbox thread are the record. Do not fabricate a Task or write Tandem for it.",
      ...rules(self.route, name, label, host).map((rule) => `- ${rule}`),
      `- Deliver to ${self.route} with agent_send terminal=${self.route} kind=result when your work is committed, verified and ready (line 1 the answer, at most 160 characters), then end your turn and wait. ${self.label} (${self.route}) finishes or discards your delivery with worker_finish/worker_discard, which merges through Worktrunk after Algorant's yes when needed. Do not merge, close this terminal, remove this checkout or delete its branch yourself.`,
      "- When you finish this track, mark the handoff to your starter as complete. Use the automatic failed-call summary for this track, including your completed Workers and helpers, without repeating their counts.",
    ].filter((entry) => entry !== undefined).join("\n");
    const labels = { "herdr.space": spaceId, ...(task ? { task: `${project}:${task.id}` } : {}), starter: self.route, needsAlgorant: String(needsAlgorant), [LABEL_KEY]: label, [KIND_KEY]: "manus" };
    const failedAfter = worktree ? ` Checkout ${cwd} (branch ${branch}) is preserved; no automatic removal.` : "";
    let started: any;
    try {
      started = await launchRaw(["--bg", "--rm", "--no-parent", "--json", "--name", name, "--cwd", cwd,
        ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), "--", CHILD_EXIT, "pi", `--${KICKOFF_FLAG}`, ...ownerExtensionArgs(), "--session-id", childSessionId, "--model", manusModel.argument, ...explicitFlagArgs(manusModel), "--", brief], name);
    } catch (error) { throw new Error(`${diagnosticText(error)}${failedAfter} Record ${record.deliveryId} is preserved: finish or discard ${name} with worker_finish/worker_discard.`); }
    // The record's own observation of the terminal the launch returned; finish closes it by this.
    try {
      await updateHcWorkerRecord(record.deliveryId, (current) => current.child ? current : { ...current, child: { core: self.core, terminal: started.address } });
    } catch (error) {
      throw new Error(`Manus ${label} (${name}, ${started.address}) is running, but its record ${record.deliveryId} could not record that terminal. Finish or discard it by name. ${diagnosticText(error)}`);
    }
    // The launch is confirmed and recorded: the row hook never throws, and runs before the tab step can fail.
    const rowHook = await workStart(record, started.address, { core: self.core, terminal: self.address, record: self.hc });
    const tab = await nameTab(host, spaceId, started.address, label);
    const closed = closeRequest(params.from, `${label} (${name})`, self);
    return withHook(result(`Started manus ${label} (${name}, ${started.address}) ${task ? `for ${task.id} ` : "(Task-free) "}in ${cwd}, space ${space.name}; tab ${tab.tab === "pending" ? "adoption pending (it names its own tab)" : `${tab.tabName}`}. Model ${describeSelection(manusModel)}${manusSwitch}. Its reports arrive in your inbox; do not wait or poll. Finish it with worker_finish {agent: "${name}"} once it delivers, or dispose it with worker_discard.`,
      { label, name, terminal: started.address, taskId: task?.id, title: task?.title, worktree, needsAlgorant, cwd, ...(worktree ? { branch } : {}), model: record.model, selection: manusModel, modelSet: manusModel.set, modelQuota: manusModel.quota, ...(manus.switched ? { modelSwitched: manus.switched } : {}), space: spaceId, spaceName: space.name, appHost: host.machine ?? "local", labels, route: self.route, brief, deliveryId: record.deliveryId, ...tab, ...closed }), rowHook);
    } catch (error) {
      // A switch that already happened stays applied; a later failure never hides it.
      throw new Error(`${diagnosticText(error)}${manusSwitch ? `${manusSwitch} That cutover stays applied.` : ""}`);
    }
  }

  async function cephStart(params: { project: string; folder: string; kickoff: string; label?: string; model?: string; thinking?: string; from?: string }, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
    const self = await caller();
    // A Ceph's hc name is its project (its route and the duplicate check); its label names it for Algorant.
    const name = params.project;
    if (!NAME_PATTERN.test(name)) throw new Error(`Project "${name}" is not a valid hc name (1-32 of a-z 0-9 - _).`);
    const label = labelOf(params.label, `${name} Ceph`);
    requireOpenRequest(params.from, self);
    const folder = resolve(params.folder);
    try { if (!statSync(folder).isDirectory()) throw new Error("not a directory"); }
    catch (error) { throw new Error(`Folder ${folder} is not an existing directory (${diagnosticText(error)}). Projectify creates it first. Nothing was started.`); }
    const repo = await nativeProjectIdentity(folder);
    if (repo.repoRoot !== folder) throw new Error(`Folder ${folder} is inside checkout ${repo.repoRoot}, not a project checkout root. Nothing was started.`);
    try { await command("tandem", ["sync", "status", "--json"], folder, 30_000); }
    catch (error) { throw new Error(`Folder ${folder} has no prepared Tandem workspace; projectify initializes it before ceph_start. ${diagnosticText(error)} Nothing was started.`); }
    // Duplicate check on this machine and every connected one; hc ls lists their live terminals.
    const [listed, machines] = await Promise.all([hcJson(["ls", "--json"]), hcMachines()]);
    const terminals: any[] = Array.isArray(listed) ? listed : listed.terminals ?? [];
    const duplicate = terminals.find((terminal) => terminal.state === "live" && (terminal.name === name || terminal.where === `${name} / main`));
    if (duplicate) throw new Error(`A Ceph for ${name} already runs: ${duplicate.address} (${duplicate.name ? `name ${duplicate.name}` : `where ${duplicate.where}`}). Nothing was started.`);
    const notChecked = machines.filter((machine) => machine.state !== "connected").map((machine) => `${machine.name} (${machine.state})`);
    const app = await appLs();
    const candidates = (app.spaces ?? []).filter((space: any) => !space.machine && (space.name === name || space.folder === folder));
    if (candidates.length > 1) throw new Error(`More than one local app space matches ${name} or ${folder} (${candidates.map((s: any) => `${s.id} ${s.name}`).join(", ")}); clarify which. Nothing was started.`);
    const existing = candidates[0];
    if (existing && existing.folder !== folder) throw new Error(`App space ${existing.id} is named ${name} but its folder is ${existing.folder}, not ${folder}; clarify. Nothing was started.`);
    if (existing?.tabs?.some((tab: any) => tab.name === "main")) throw new Error(`App space ${existing.name} (${existing.id}) already has a main tab without a live Ceph named ${name}: a repair to clarify, not a second Ceph. Nothing was started.`);

    // Only now — every read-only precondition has passed — is the Ceph's model resolved: its
    // orchestrator role, cut over by Herdra's same selector when this machine's set is blocked by
    // quota alone, or an explicit model or thinking, preflighted exactly with no cutover. The child
    // then starts on this exact model, so its startup role hook skips and it can never refuse to
    // consume the kickoff already on its command line.
    const orchestrator = await selectLaunchModel("orchestrator", { model: params.model, thinking: params.thinking }, ctx.modelRegistry, { signal });
    if ("refusal" in orchestrator) throw new Error(`${orchestrator.refusal} Nothing was started.`);
    const cephChoice = orchestrator.selection;
    const cephModel = cephChoice.argument;
    const cephSwitch = orchestrator.switched
      ? ` Set ${orchestrator.switched.from} → ${orchestrator.switched.to} for orchestrator (cutover ${orchestrator.switched.operation ?? "none"}${orchestrator.switched.partial ? "; some typed requests failed or a Pi was skipped" : ""}).`
      : "";
    try {

    let spaceId: string;
    let tandemTab: string;
    if (existing) {
      spaceId = existing.id;
      const tandem = existing.tabs?.find((tab: any) => tab.name === "tandem");
      if (tandem) tandemTab = `${tandem.id} (existing)`;
      else {
        // Adoption adds the missing tab without selecting it.
        let board: any;
        try { board = await hcJson(["run", "--bg", "--rm", "--no-parent", "--json", "--cwd", folder, "--label", `herdr.space=${spaceId}`, "--", "tandem", "tui"], 30_000); }
        catch (error) { throw new Error(`Could not add the tandem tab to reused space ${existing.name}: ${diagnosticText(error)} No Ceph was started.`); }
        const named = await nameTab(await localAppHost(), spaceId, board.address, "tandem");
        tandemTab = named.tab === "pending" ? `${board.address} (adoption pending)` : `${named.tab} (added)`;
      }
    } else {
      // A new project's space is created without switching (the app keeps the shown space and tab).
      let out: any;
      try { out = JSON.parse(await command("herdr-app", ["do", "space.new", "--name", name, "--folder", folder, "--tab", "tandem", "--argv", JSON.stringify(["tandem", "tui"]), "--focus", "false"], undefined, 30_000)); }
      catch (error) { throw new Error(`herdr-app space.new failed for ${name}: ${diagnosticText(error)} Nothing was started.`); }
      if (typeof out?.space !== "string") throw new Error(`herdr-app space.new returned no space id: ${JSON.stringify(out).slice(0, 300)}. Inspect herdr-app ls; nothing else was started.`);
      spaceId = out.space;
      tandemTab = `${out.tab ?? "?"} (created)`;
    }
    const kickoff = [
      params.kickoff.trim(),
      "",
      `You are the Ceph of ${name} ("${label}"): hc name ${name}, in the main tab of its app space, cwd ${folder}.`,
      `- ${rules(self.route, name, "main", { core: self.core, machines: [] })[1]}`,
      `- ${rules(self.route, name, "main", { core: self.core, machines: [] })[2]}`,
      `Your return route is ${self.route}: report back when ready with agent_send terminal=${self.route} kind=result, body "[${name}] <outcome>" (line 1 at most 160 characters).`,
    ].join("\n");
    let started: any;
    try {
      started = await launchRaw(["--bg", "--rm", "--no-parent", "--json", "--name", name, "--cwd", folder, "--label", `herdr.space=${spaceId}`,
        "--label", `${LABEL_KEY}=${label}`, "--label", `${KIND_KEY}=ceph`, "--label", `starter=${self.route}`, "--", CHILD_EXIT, "pi", `--${KICKOFF_FLAG}`, ...ownerExtensionArgs(), "--model", cephModel, ...explicitFlagArgs(cephChoice), kickoff], name);
    } catch (error) { throw new Error(`${diagnosticText(error)} Space ${spaceId} is kept as it is; no automatic removal.`); }
    const tab = await nameTab(await localAppHost(), spaceId, started.address, "main");
    const closed = closeRequest(params.from, `${label} (${name})`, self);
    const cold = await coldRead("kickoff", label, params.kickoff, folder, ctx);
    return result(`Started Ceph ${label} (${name}, ${started.address}) in ${folder}, space ${name} ${existing ? "(reused, not switched)" : "(new, not shown)"}; tab ${tab.tab === "pending" ? "adoption pending (it names its own tab main)" : tab.tabName}. Model ${describeSelection(cephChoice)}.${cephSwitch}${notChecked.length ? ` Duplicate check skipped unreachable ${notChecked.join(", ")}.` : ""} It reports back to ${self.route}; do not wait or poll.${coldReadNote(cold)}`,
      { label, name, terminal: started.address, cwd: folder, space: spaceId, spaceName: name, createdSpace: !existing, tandemTab, notChecked, route: self.route, model: cephModel, selection: cephChoice, modelSet: cephChoice.set, modelQuota: cephChoice.quota, ...(orchestrator.switched ? { modelSwitched: orchestrator.switched } : {}), brief: kickoff, coldRead: cold, ...tab, ...closed });
    } catch (error) {
      // A switch that already happened is a committed machine change: never hide it behind a
      // later failure of the space, tab or launch.
      throw new Error(`${diagnosticText(error)}${cephSwitch ? `${cephSwitch} That cutover stays applied.` : " Nothing else was changed."}`);
    }
  }

  const tools = [
    {
      name: "dendra_start", label: "Dendra Start", executionMode: "sequential" as const,
      description: "Start one child of this Pi: a read-only helper (scout, researcher or reviewer; task required, its report arrives in your inbox) or a Worker (exactly taskId OR brief; required label without a Task; worktree default true, explicit false skips it; needsAlgorant forbids auto-finish; handoffs through worker_handoff). model (exact provider/id) and thinking are optional for every kind: omitted, the role default; given, exact and preflighted (catalog, auth, provider policy, quota) before anything is created, refused rather than substituted, and kept by the child through startup, continuation and a provider 429. The result shows the resolved model, thinking and default/override. label (2-5 plain words) names it for Algorant; its slug is the hc name (and a Worker's branch), returned. A temporary machine policy can pause reviewer launches; nothing is started then. A role default is resolved after the read-only checks and, when quota alone blocks that set, cut over first; an explicit model is never cut over. Never selects/focuses, waits or polls. from closes the inbox request it dispatches.",
      promptSnippet: "Delegate a bounded helper or Worker (exactly taskId OR brief; label required Task-free); optional model/thinking choose any child's exact model; outcomes arrive in your inbox.",
      parameters: DendraParameters,
      execute: (_id: string, params: any, signal: AbortSignal | undefined, _u: unknown, ctx: ExtensionContext) => dendraStart(params, signal, ctx),
    },
    {
      name: "manus_start", label: "Manus Start",
      description: "Start a manus: a full Pi in its own tab of your app space for exactly one taskId OR brief. Task-free label required. Worktree defaults true (created through Worktrunk from your HEAD); false explicitly skips it for research/shared checkout. needsAlgorant delivers for human judgement. It resolves the model before any worktree, record or terminal: the native manus role (or the selected model set's manus cell), cut over first when quota alone blocks its set, or the optional exact model/thinking you pass (preflighted, never cut over, kept by the child); it passes that exact model and shows it, with default/override, in the result. There is no orchestrator or worker fallback. label (2-5 plain words, default the Task title) names it and its tab; its slug is the hc name and branch. Writes the manus record you later finish or discard; it reports through your inbox and never merges or closes itself. Labels task= and starter=, never changes Algorant's view, never waits. from closes the inbox request it dispatches.",
      promptSnippet: "Delegate a track in your own space with exactly taskId OR brief, label required Task-free; worktree default true, needsAlgorant for human judgement, optional model/thinking; reports through your inbox.",
      parameters: ManusParameters,
      execute: (_id: string, params: any, signal: AbortSignal | undefined, _u: unknown, ctx: ExtensionContext) => manusStart(params, signal, ctx),
    },
    {
      name: "ceph_start", label: "Ceph Start",
      description: "Start a project's Ceph: a Pi named after the project in the main tab of its app space (a new project's space is created without switching, as is an existing one), with a tandem tab. Requires the project's git checkout and Tandem workspace (projectify first); refuses when a Ceph already runs on this or a connected machine. After those read-only checks it resolves the model, the orchestrator role (cut over first when quota alone blocks the set) or the optional exact model/thinking you pass (preflighted, never cut over, kept by the child), and launches the Pi with that exact model so its kickoff is consumed; the result shows it with default/override. The kickoff ends with your return route.",
      promptSnippet: "Start a named Ceph for a prepared project (projectify first), optional model/thinking; it reports back to you when ready.",
      parameters: CephParameters,
      execute: (_id: string, params: any, signal: AbortSignal | undefined, _u: unknown, ctx: ExtensionContext) => cephStart(params, signal, ctx),
    },
  ];

  pi.on("session_start", async () => {
    // Only owner Pis dispatch: never a Worker invocation or a read-only profile child.
    if (pi.getFlag(WORKER_CONTEXT_FLAG) === true || hcProfileRequested()) return;
    for (const tool of tools) pi.registerTool({ ...tool, ...cards.get(tool.name)! } as any);
  });
}
