import { newId } from "../pi-agency/state.ts";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { createWorkerToolRenderer } from "../pi-ui/tool-ui/custom-tools/workers.ts";
import { closeTaskRequests, headlineOf } from "../pi-agency/inbox/envelope.ts";
import { NSTAR_WORKER } from "../pi-agency/nstar-note.ts";
import { sendAgentMessage } from "../pi-agency/inbox/send.ts";
import { taskFreeBrief, workerBrief, workerDirection } from "../pi-agency/workers/brief.ts";
import { registerWorkerContext, workerContextCapability, WORKER_CONTEXT_FLAG } from "../pi-agency/workers/context.ts";
import { checksPassed, formatChecks, formatWorkerReport, validateWorkerReport, type WorkerReport } from "../pi-agency/workers/handoff-record.ts";
import {
  acknowledgeHcWorkerStart, createHcDeliveryId, createHcInvocationId, createHcWorkerRecord, hcRecordPath, isManusRecord, listHcWorkerOutcomes,
  listHcWorkerRecords, publishHcWorkerHandoff, readHcWorkerHandoff, readHcWorkerRecord, readHcWorkerStart, updateHcWorkerRecord,
  withHcWorkerLifecycle, writeHcWorkerOutcome, type HcWorkerDirection, type HcWorkerHandoff, type HcWorkerOutcome, type HcWorkerRecord,
  type HcWorkerStart, type HcWorkerBenchmarkSelection,
} from "../pi-agency/workers/hc-record.ts";
import {
  DiscardParameters, FeedbackParameters, MAX_PROMPT_LENGTH, PauseParameters, REJECTED_REPORT_SUFFIX,
  WorkerAnswerParameters, WorkerAskParameters, WorkerProgressParameters, WorkerReportParameters,
  approvedHookTypes, captureWorkerAssignment, checkInNotifier, checkoutBranch, command, diagnosticText, formatWorkerDiff, workerDiff,
  ensureDeliveredThenRework, latestTodoList, nativeCheckoutPresent, nativeHead, nativeProjectIdentity, nativeWorktreeForBranch,
  providerErrorDiagnostic, rejectedReportDiagnostic, removeNativeWorkerCheckout, reportScopeMatchesCurrent,
  requireActiveTask, requireCleanCheckout, requireNoOpenWorkerSubtasks, runRunnableValidations, runTandemCommand,
  runWorkerProgressNative, sourceAlreadyIntegrated, tandemCounts, tandemShow,
  tandemTaskMetrics, taskPlanRequired, validateCapturedCheckout, WORKER_LIGHT_EFFORTS, validateNativeRemovalResult, validateWorkerDispatch,
  withCheckIn, workerModelArgument, benchmarkWorkerModelArgument, type WorkerProgressInput, type WorkerReportInput,
} from "../pi-agency/workers/shared.ts";
import { hcProfileRequested } from "../pi-agency/subagents/profile.ts";
import { CHILD_EXIT, hcFind, hcJson, hcText, isHc } from "./core.ts";
import { KIND_KEY, LABEL_KEY, labelFrom, nameFor, workerLabel } from "../../scripts/whois.ts";
import { briefContract, hasWorktree, projectRules, requireContract, taskFreeChecks, workerBase, workerName } from "../pi-agency/workers/contract.ts";
import type { Envelope } from "../pi-agency/inbox/envelope.ts";

/**
 * Native HC Workers. Tandem, Worktrunk and the existing handoff/receipt store
 * stay authoritative; HC owns terminal identity, parent, lifetime and status.
 * Each invocation is one `--outlive-parent --rm` child that hands back exactly
 * one plan/question/ready/error outcome and closes unless natively kept.
 * Continuation reuses the SAME Task, Worktrunk checkout and Pi session ID.
 *
 * One writer per datum: the owner writes only its control records and receipts;
 * the Worker writes only its invocation's start acknowledgement and handoff, each
 * created once. The invocation label is the stable reference both read.
 */
const INVOCATION_LABEL = "pi.worker.invocation";
const CONTEXT_LABEL = "pi.worker.context";

const AgentParameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Stable native Worker name or unambiguous label, including after owner restart." }),
}, { additionalProperties: false });
const RecoverParameters = Type.Object({
  taskId: Type.Optional(Type.String({ minLength: 1, description: "Optional linked Task, checked against the captured Worker; omit for Task-free recovery." })),
  agent: Type.String({ minLength: 1, description: "Stable native Worker name or unambiguous label." }),
}, { additionalProperties: false });
const FinishParameters = Type.Object({
  agent: Type.String({ minLength: 1, description: "Exact native Worker or manus whose verified delivery should be finished." }),
  crashSummary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PROMPT_LENGTH, description: "Only when no Worker invocation is running and it ended without a ready report: your own verified summary of the surviving checkout, which replaces that report. A manus never takes this." })),
}, { additionalProperties: false });

type Owner = { core: string; terminal: string; sessionId: string };
/** A control record with what its invocation produced. A read-only view: never persisted. */
type WorkerView = { record: HcWorkerRecord; started?: HcWorkerStart; handoff?: HcWorkerHandoff };
/** The invocation one Worker run serves, captured once from its own label when the run starts. */
type WorkerRun = { invocationId: string; self: any; record: HcWorkerRecord; published: boolean };
type Result = AgentToolResult<any>;

const text = (value: string, details: unknown): Result => ({ content: [{ type: "text", text: value }], details });

async function coreId(): Promise<string> {
  const server = await hcJson(["server", "status"]);
  if (typeof server.core?.id !== "string") throw new Error("hc did not return its permanent core id.");
  return server.core.id;
}

/** A Worker runs the owner's explicitly selected Pi extensions, so both speak one protocol version. */
export function ownerExtensionArgs(): string[] {
  const argv = process.argv.slice(2);
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg === "--no-extensions" || arg === "-ne") out.push(arg);
    else if ((arg === "-e" || arg === "--extension") && argv[index + 1]) {
      const value = argv[++index]!;
      out.push(arg, value.startsWith("builtin:") ? value : resolve(value));
    }
  }
  return out;
}

/** Records replaced by a continuation/recovery stay as receipts but are not current. */
function leaves(records: HcWorkerRecord[]): HcWorkerRecord[] {
  const superseded = new Set(records.map((record) => record.recoveryOfDeliveryId).filter(Boolean));
  return records.filter((record) => !superseded.has(record.deliveryId));
}

function ownedBy(record: HcWorkerRecord, owner: Owner): boolean {
  // A manus belongs to the starter terminal that ran manus_start, not to one Pi session:
  // its starter is a long-lived Pi that may resume a new session, and the manus must stay
  // finishable after that. A Worker stays session-bound.
  if (isManusRecord(record)) return record.owner.core === owner.core && record.owner.terminal === owner.terminal;
  return record.owner.core === owner.core && record.owner.terminal === owner.terminal && record.ownerSessionId === owner.sessionId;
}

async function workerChain(agent: string, core: string): Promise<HcWorkerRecord[]> {
  return (await listHcWorkerRecords()).filter((record) => (record.childAgent === agent || record.label === agent) && record.owner.core === core);
}

async function currentRecord(agent: string, core: string): Promise<HcWorkerRecord> {
  const current = leaves(await workerChain(agent, core));
  if (current.length !== 1) throw new Error(`Native Worker ${agent} has ${current.length} current deliveries on this core; refusing to guess.`);
  return current[0]!;
}

async function view(record: HcWorkerRecord): Promise<WorkerView> {
  const [started, handoff] = await Promise.all([readHcWorkerStart(record.invocationId), readHcWorkerHandoff(record.invocationId)]);
  return { record, started, handoff };
}

/** Effective delivery state: the Worker's typed handoff first, then the owner's control. */
function deliveryState({ record, handoff }: WorkerView): string {
  if (record.state === "discarding" || record.state === "discarded") return record.state;
  if (handoff?.question) return "question";
  if (handoff?.report) return record.handoffReadAt === undefined ? "ready" : "delivered";
  if (record.state !== "pending") return record.state;
  return handoff ? "failed" : "pending";
}
const diagnosticOf = (worker: WorkerView): string | undefined =>
  deliveryState(worker) === "paused" ? worker.record.diagnostic : worker.handoff?.diagnostic ?? worker.record.diagnostic;
const sessionPathOf = ({ started, handoff }: WorkerView): string | undefined => handoff?.sessionPath ?? started?.sessionPath;

/** Context proof for a kept continuation. Its new invocation has no start ack until
 * the send succeeds: use the answered invocation's real receipt for that SAME
 * session, never as proof that the new direction arrived. */
async function keptSessionStart({ record, started }: WorkerView): Promise<HcWorkerStart | undefined> {
  if (started) return started;
  if (!record.direction || record.direction.ofDeliveryId === record.deliveryId) return undefined;
  const prior = await readHcWorkerRecord(record.direction.ofDeliveryId);
  if (prior.childAgent !== record.childAgent || prior.childSessionId !== record.childSessionId || prior.owner.core !== record.owner.core) {
    throw new Error(`Kept continuation ${record.deliveryId} does not answer this Worker's session.`);
  }
  return readHcWorkerStart(prior.invocationId);
}

/** The captured Worker terminal, or nothing. An undelivered kept continuation
 * can still have an earlier invocation on that terminal: accept only its own
 * chain plus the actual managed-session receipt. Never another Worker/terminal. */
async function liveInvocation(worker: WorkerView, inspect = false): Promise<any | undefined> {
  const { record, started } = worker;
  const address = started?.child.terminal ?? record.child?.terminal;
  if (!address) {
    // An unconfirmed launch: its only proof is a live terminal carrying this invocation's atomic label.
    const named = await hcFind(record.childAgent);
    if (!named || named.state !== "live") return undefined;
    if (named.labels?.[INVOCATION_LABEL] !== record.invocationId) {
      if (inspect) return undefined;
      throw new Error(`Live terminal ${named.address} named ${record.childAgent} carries invocation ${named.labels?.[INVOCATION_LABEL] ?? "none"}, not ${record.invocationId}; refusing to act on or beside it.`);
    }
    return named;
  }
  const terminal = await hcFind(address);
  if (!terminal || terminal.state !== "live") return undefined;
  if (terminal.name === record.childAgent && terminal.labels?.[INVOCATION_LABEL] !== record.invocationId && !started && record.direction && terminal.keep && ["idle", "done"].includes(runtimeState(terminal))) {
    // A crash/refusal between control creation and relabel left this exact kept
    // carrier on a previous cycle. The requested direction remains undelivered.
    const proof = await keptSessionStart(worker);
    const chain = await workerChain(record.childAgent, record.owner.core);
    if (proof?.child.terminal === address && proof.child.core === record.owner.core && proof.childSessionId === record.childSessionId &&
        terminal.labels?.[CONTEXT_LABEL] === workerContextCapability(proof.sessionPath) &&
        chain.some((entry) => entry.invocationId === terminal.labels?.[INVOCATION_LABEL] && entry.childSessionId === record.childSessionId)) return terminal;
  }
  if (terminal.name !== record.childAgent || terminal.labels?.[INVOCATION_LABEL] !== record.invocationId) {
    if (inspect) return undefined;
    throw new Error(`Terminal ${address} no longer carries Worker ${record.childAgent} invocation ${record.invocationId}; refusing to act on another terminal.`);
  }
  return terminal;
}

const runtimeState = (terminal: any | undefined): string => terminal ? terminal.status?.state ?? "live" : "closed";

/** A manus has no `pi.worker.invocation` label: its record names the terminal it started in. */
async function liveManus(record: HcWorkerRecord): Promise<any | undefined> {
  const found = record.child?.terminal ? await hcFind(record.child.terminal) : await hcFind(record.childAgent);
  if (!found || found.state !== "live") return undefined;
  if (found.name !== record.childAgent) throw new Error(`Terminal ${found.address} is named ${found.name}, not manus ${record.childAgent}; refusing to act on another terminal.`);
  return found;
}

/** The live child of either kind: a Worker by its invocation label, a manus by its recorded terminal. */
async function liveChild(worker: WorkerView): Promise<any | undefined> {
  return isManusRecord(worker.record) ? liveManus(worker.record) : liveInvocation(worker);
}

/** Delivery state plus what was actually handed back, e.g. "plan · delivered". */
function handoffState(worker: WorkerView): string {
  const state = deliveryState(worker);
  if (worker.handoff?.question) return `question ${state === "question" ? "pending" : state}`;
  if (worker.handoff?.report) return `${worker.handoff.report.status} · ${state}`;
  if (undeliveredDirection(worker)) return `${state} · direction undelivered`;
  return state;
}

/** A direction reached the Worker only if its invocation acknowledged starting a run. */
const undeliveredDirection = ({ record, started }: WorkerView): HcWorkerDirection | undefined =>
  record.direction && !started ? record.direction : undefined;

/** hc refusals that prove nothing was delivered; anything else leaves delivery unconfirmed. */
const DEFINITE_REFUSALS = new Set(["status_mismatch", "blocked", "not_found", "finished", "needs_target"]);

/** Ends only the captured invocation; --rm removes it, a finished leftover is removed explicitly. */
async function stopInvocation(terminal: any): Promise<void> {
  try { await hcText(["kill", terminal.address]); }
  catch (error) { if ((error as { kind?: string }).kind !== "not_found") throw error; }
  const after = await hcFind(terminal.address);
  if (after?.state === "live") throw new Error(`Child terminal ${terminal.address} is still live after kill.`);
  if (after) await hcText(["rm", terminal.address]);
}

async function waitSettled(address: string): Promise<any | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await hcJson(["wait", address, "--timeout", "30"], 40_000);
    if (result.reason !== "message") break; // a message to this owner ends a wait; wait again
  }
  return hcFind(address);
}

async function recordReworkOnce({ record, handoff }: WorkerView, cwd: string, message: string): Promise<void> {
  if (!record.taskId || handoff?.report?.status !== "ready" || record.accordReworkRecordedAt !== undefined) return;
  if (record.accordReworkRequestedAt !== undefined) throw new Error(`Worker ${record.childAgent} has an interrupted native rework request. Inspect delivery ${record.deliveryId} and the Tandem outcome; feedback will not replay the transition.`);
  await updateHcWorkerRecord(record.deliveryId, (current) => ({ ...current, accordReworkRequestedAt: Date.now() }));
  await ensureDeliveredThenRework(record.taskId, cwd, message, handoff.report);
  await updateHcWorkerRecord(record.deliveryId, (current) => ({ ...current, accordReworkRecordedAt: Date.now() }));
}

class LaunchError extends Error { constructor(message: string, readonly uncertain: boolean) { super(message); } }

async function refreshBenchmarkQuota(record: HcWorkerRecord, registry: ExtensionContext["modelRegistry"]): Promise<HcWorkerRecord> {
  if (!record.benchmark) return record;
  const resolved = benchmarkWorkerModelArgument(registry, record.benchmark.requestedModel);
  if (resolved.model !== record.benchmark.selectedModel || resolved.argument !== record.model || resolved.fast !== record.benchmark.fast ||
      resolved.providerExemption !== record.benchmark.providerExemption || resolved.providerExemptionModel !== record.benchmark.providerExemptionModel) {
    throw new Error(`Saved benchmark Worker ${record.childAgent} no longer resolves to its captured contender, high-thinking model and Fast policy; no launch or continuation was started.`);
  }
  const benchmark = { ...record.benchmark, quota: resolved.quota, quotaCheckedAt: resolved.quotaCheckedAt };
  if (benchmark.quota === record.benchmark.quota && benchmark.quotaCheckedAt === record.benchmark.quotaCheckedAt) return record;
  return updateHcWorkerRecord(record.deliveryId, (current) => {
    if (current.model !== record.model || current.benchmark?.selectedModel !== record.benchmark!.selectedModel) {
      throw new Error(`Saved benchmark Worker ${record.childAgent} changed during quota refresh; no launch or continuation was started.`);
    }
    return { ...current, benchmark };
  });
}

/**
 * One native invocation for this delivery. A failed request is resolved by its atomic label, never retried.
 * `--no-notify`: the typed handoff/failure notice owns the outcome; hc exit notes would type into the owner's composer.
 * child-exit tells the owner through its inbox when the invocation ends without sending any message.
 */
async function launchInvocation(record: HcWorkerRecord, prompt: string, registry: ExtensionContext["modelRegistry"]): Promise<any> {
  record = await refreshBenchmarkQuota(record, registry);
  // The label and kind name it (whois); task= carries its Task (the label never depends on it).
  const labels = { [INVOCATION_LABEL]: record.invocationId, [KIND_KEY]: "worker", ...(record.taskId ? { task: `${basename(dirname(record.integration.repoKey))}:${record.taskId}` } : {}), needsAlgorant: String(record.needsAlgorant ?? false), ...(record.label ? { [LABEL_KEY]: record.label } : {}) };
  const args = ["run", "--bg", "--rm", "--no-notify", "--outlive-parent", "--json", "--name", record.childAgent,
    "--cwd", record.integration.source.checkoutPath, ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]), "--",
    CHILD_EXIT, "pi", ...ownerExtensionArgs(), "--session-id", record.childSessionId, "--model", record.model, `--${WORKER_CONTEXT_FLAG}`, "--", prompt];
  let started: any;
  try {
    started = await hcJson(args, 30_000);
  } catch (error) {
    let found: any;
    try { found = await hcFind(record.childAgent); }
    catch (lookup) { throw new LaunchError(`hc run failed and its outcome could not be read back: ${diagnosticText(error)} / ${diagnosticText(lookup)}`, true); }
    if (found?.state === "live" && found.labels?.[INVOCATION_LABEL] === record.invocationId) started = found;
    else if (!found) throw new LaunchError(`hc run did not start Worker ${record.childAgent}: ${diagnosticText(error)}`, false);
    // hc refused the name itself: this launch never started, whoever holds the name.
    else if ((error as { kind?: string }).kind === "name_taken") throw new LaunchError(`hc run did not start Worker ${record.childAgent}: terminal ${found.address} holds that name without this invocation. ${diagnosticText(error)}`, false);
    else throw new LaunchError(`hc run failed and ${record.childAgent} names terminal ${found.address} without this invocation: ${diagnosticText(error)}`, true);
  }
  if (started?.name !== record.childAgent || typeof started.address !== "string") throw new LaunchError(`hc run returned an unexpected Worker terminal: ${JSON.stringify(started).slice(0, 400)}`, true);
  await updateHcWorkerRecord(record.deliveryId, (current) => ({ ...current, child: { core: record.owner.core, terminal: started.address } }));
  return started;
}

/** The one Tandem delivery of a ready report: summary, evidence and changed files. */
async function deliverReport(taskId: string, cwd: string, report: Pick<WorkerReport, "summary" | "evidence" | "files">): Promise<void> {
  await command("tandem", ["accord", "deliver", taskId, "--summary", report.summary,
    ...report.evidence.flatMap(({ criterion, observation }) => ["--evidence", `${criterion}: ${observation}`]),
    ...report.files.flatMap((file) => ["--file-changed", file]), "--json"], cwd);
}

/** A manus hands back through the inbox, not a typed report: the accepted outcome of
 * its finish is the Worktrunk integration plus the files it changed. */
async function manusAcceptance(record: HcWorkerRecord, outcome: HcWorkerOutcome): Promise<Pick<WorkerReport, "summary" | "evidence" | "files">> {
  const route = `${record.integration.source.branch} → ${record.integration.target.branch}`;
  const tip = outcome.sourceTip ?? outcome.targetTip ?? "";
  const files = (await command("git", ["diff", "--name-only", `${workerBase(record)}..${tip}`], record.integration.target.checkoutPath))
    .split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    summary: `Manus ${workerName(record)} finished by its starter: ${route} integrated at ${tip.slice(0, 12)}.`,
    evidence: [{ criterion: "Worktree lifecycle", observation: `${route} merged through Worktrunk at ${tip}; the captured terminal and checkout were closed and removed.` }],
    files,
  };
}

/** A ready notice carries the report and a bounded diff, so the owner can finish without reading either again. */
async function readyReview(record: HcWorkerRecord, report: WorkerReport): Promise<string> {
  const diff = await workerDiff(record.integration.source.checkoutPath, workerBase(record), report.source.head);
  return `${formatWorkerReport(report)}\n${formatWorkerDiff(diff)}`;
}

function noticeBody({ record, handoff }: WorkerView, review?: string): string {
  const agent = record.childAgent;
  const question = handoff?.question;
  const status = handoff?.report?.status;
  const lines = question
    ? [`Worker needs an answer: ${workerName(record).slice(0, 65)} (${agent})`, `Question ID: ${question.id}`, `Question: ${question.text}`,
      `Answer with worker_answer using agent ${agent} and questionId ${question.id}; it continues the same session and checkout without recording rework.`]
    : status
      ? [status === "plan" ? `Worker plan ready for direction: ${workerName(record).slice(0, 65)} (${agent})` : status === "needs-input" ? `Worker needs input: ${workerName(record).slice(0, 65)} (${agent})` : `Worker handoff ready for review: ${workerName(record).slice(0, 65)} (${agent})`,
        ...(review ? [review, "Review the report and diff above, then worker_finish (or worker_feedback for corrections); worker_handoff shows the same report."]
          : [`Call worker_handoff with agent ${agent} to read the full report.`,
            status === "plan" ? "Approve with worker_feedback approve:true; feedback without approve:true asks for a revised plan. Or worker_discard."
              : status === "needs-input" ? "Resolve the blocker, then reply with worker_feedback; this does not record rework."
                : "Verify its evidence, then worker_finish (or worker_feedback for corrections)."])]
      : [`Worker ended without a handoff: ${workerName(record).slice(0, 65)} (${agent})`, `Diagnostic: ${handoff?.diagnostic ?? "unknown"}`,
        "Its work stays in the checkout and saved session. Continue it with worker_resume or worker_feedback, or dispose it with worker_discard."];
  return [...lines, `needsAlgorant: ${record.needsAlgorant ?? false}.${record.from ? ` Originating inbox thread: ${record.from}.` : ""}`, `This invocation closes unless kept; continuing reuses the saved contract, checkout and session. Delivery ${record.deliveryId}, invocation ${record.invocationId}.`].join("\n");
}

/** Tool name to card kind for every maintained native Worker tool, owner and Worker side. */
const NATIVE_TOOL_CARDS = {
  worker_handoff: "handoff", worker_feedback: "feedback", worker_answer: "answer", worker_recover: "recover",
  worker_resume: "resume", worker_status: "status", worker_pause: "pause", worker_finish: "finish", worker_discard: "discard",
  worker_ask: "ask", worker_report: "report", worker_progress: "progress",
} as const;

export type StartWorker = (params: { taskId?: string; brief?: string; label?: string; worktree?: boolean; needsAlgorant?: boolean; benchmarkModel?: HcWorkerBenchmarkSelection["requestedModel"]; from?: string; prompt: string }, signal: AbortSignal | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<any>>;
export type ReadyNotice = (env: Envelope, ctx: ExtensionContext) => Promise<Envelope | undefined>;

const READY_HEADLINE = /^Worker handoff ready for review: .+ \(([a-z0-9_-]+)\)$/;

export function registerHcWorkers(pi: ExtensionAPI): { startWorker: StartWorker; readyNotice: ReadyNotice } {
  // Tools register at session_start (owner or Worker role), but /reload and resume rebuild
  // transcript rows before that: a load-time resolver keeps those rows on the same cards.
  const cards = new Map(Object.entries(NATIVE_TOOL_CARDS).map(([name, kind]) => [name, createWorkerToolRenderer(kind) as ToolRenderers]));
  pi.registerToolRenderer((toolName, next) => next() ?? cards.get(toolName));
  let workerMode = false;
  let contextFailure: string | undefined;
  let questionAsked = false;
  /** Captured at the first agent_start after settlement and used until the next settlement:
   * a later owner relabel or recovery never re-binds a run that already started. */
  let run: WorkerRun | undefined;

  /** The current owner control of one invocation: recovery successors share its id. Read only. */
  async function invocationControl(invocationId: string): Promise<HcWorkerRecord> {
    const mine = (await listHcWorkerRecords()).filter((record) => record.invocationId === invocationId);
    const superseded = new Set(mine.map((record) => record.recoveryOfDeliveryId).filter(Boolean));
    const current = mine.filter((record) => !superseded.has(record.deliveryId));
    if (current.length !== 1) throw new Error(`Native Worker invocation ${invocationId} has ${current.length} current owner control records; the owner must inspect it with worker_status.`);
    return current[0]!;
  }

  async function captureRun(ctx: ExtensionContext): Promise<WorkerRun> {
    const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
    const invocationId = self.labels?.[INVOCATION_LABEL];
    if (typeof invocationId !== "string") throw new Error("This Pi has no native Worker invocation label; it is not a launched Worker invocation.");
    const record = await invocationControl(invocationId);
    const started = await readHcWorkerStart(invocationId);
    if (record.childAgent !== self.name || record.childSessionId !== ctx.sessionManager.getSessionId() || record.owner.core !== await coreId() ||
        (record.child && record.child.terminal !== self.address) || (started && started.child.terminal !== self.address) ||
        resolve(ctx.cwd) !== record.integration.source.checkoutPath) {
      throw new Error(`Native Worker binding for invocation ${invocationId} does not match this terminal, session or checkout; the owner must inspect it with worker_status.`);
    }
    return { invocationId, self, record, published: false };
  }

  function currentRun(): WorkerRun {
    if (!run) throw new Error(contextFailure ?? "This Worker run has no captured invocation; stop and let the owner inspect it with worker_status.");
    return run;
  }

  /** Creates the invocation's one immutable handoff; false when it already has one (left intact). */
  async function publish(current: WorkerRun, ctx: ExtensionContext, outcome: Pick<HcWorkerHandoff, "question" | "report" | "diagnostic">): Promise<boolean> {
    const created = await publishHcWorkerHandoff({ version: 1, invocationId: current.invocationId, taskId: current.record.taskId, childAgent: current.self.name,
      childSessionId: current.record.childSessionId, child: { core: current.record.owner.core, terminal: current.self.address },
      sessionPath: ctx.sessionManager.getSessionFile()!, publishedAt: Date.now(), ...outcome });
    if (created) current.published = true;
    return created;
  }

  async function closeUnlessKept(ctx: ExtensionContext): Promise<void> {
    const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
    if (!self.keep) ctx.shutdown();
  }

  async function currentOwner(ctx: ExtensionContext): Promise<Owner> {
    const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
    if (workerMode || self.labels?.[INVOCATION_LABEL]) throw new Error("Workers may not own Workers; return a handoff to your owner instead.");
    return { core: await coreId(), terminal: self.address, sessionId: ctx.sessionManager.getSessionId() };
  }

  async function ownedWorker(agent: string, ctx: ExtensionContext): Promise<{ owner: Owner; worker: WorkerView }> {
    const owner = await currentOwner(ctx);
    const record = await currentRecord(agent, owner.core);
    if (!ownedBy(record, owner)) throw new Error(isManusRecord(record)
      ? `Manus ${agent} belongs to its starter terminal ${record.owner.terminal} (core ${record.owner.core}); only that starter finishes or discards it. Nothing changed.`
      : `Worker ${agent} belongs to owner ${record.owner.terminal} session ${record.ownerSessionId}. Use worker_recover to adopt it explicitly.`);
    return { owner, worker: await view(record) };
  }

  // ---------------- Worker side ----------------

  registerWorkerContext(pi, {
    hosted: isHc,
    discoverWorker: async () => Boolean((await hcJson(["get", process.env.HC_TERMINAL_ID!])).labels?.[INVOCATION_LABEL]),
    advertise: async (capability) => { await hcText(["label", process.env.HC_TERMINAL_ID!, `${CONTEXT_LABEL}=${capability}`]); },
    loadBrief: async (ctx) => {
      contextFailure = undefined;
      try {
        if (!run) {
          run = await captureRun(ctx);
          questionAsked = false;
        }
        const { record, self, invocationId } = run;
        if (["failed", "paused", "discarding", "discarded"].includes(record.state)) throw new Error(`Delivery ${record.deliveryId} is ${record.state}; the owner must continue or dispose it first.`);
        // This invocation actually starting a run is the only proof its direction arrived: the Worker's own, once.
        const started = await acknowledgeHcWorkerStart({ version: 1, invocationId, childAgent: self.name, childSessionId: record.childSessionId,
          child: { core: record.owner.core, terminal: self.address }, sessionPath: ctx.sessionManager.getSessionFile()!, startedAt: Date.now() });
        if (started.child.terminal !== self.address) throw new Error(`Invocation ${invocationId} already started in terminal ${started.child.terminal}, not ${self.address}.`);
        const existing = await readHcWorkerHandoff(invocationId);
        const target = record.integration.target.checkoutPath;
        if (existing?.question) questionAsked = true;
        const [rules, task] = await Promise.all([projectRules(record.integration.repoKey, target, ctx.signal), record.taskId ? tandemShow(record.taskId, target) : undefined]);
        const contract = record.taskId
          ? workerBrief(record.taskId, record.assignment!, record.planRequired, record.planAcceptedAt !== undefined, rules, WORKER_LIGHT_EFFORTS.has(task.effort))
          : taskFreeBrief(record.label!, record.brief!, record.needsAlgorant!, rules);
        const brief = `${contract}\n\nLabel: ${record.label ?? record.childAgent}. Owner/return route: ${record.owner.terminal}. Project: ${dirname(record.integration.repoKey)}. Checkout: ${record.integration.source.checkoutPath}. needsAlgorant: ${record.needsAlgorant ?? false}.${record.from ? ` Originating inbox thread: ${record.from}.` : ""}\nYou run as a native HC Worker invocation. Work only in this captured checkout.${hasWorktree(record) ? ` The owner target checkout ${target} is off-limits. Use relative paths.` : " worktree:false explicitly uses this shared checkout; never merge or remove it."} You are the last delegation level: do not start Subagents, Reviewers, Workers, hc terminals or any other agent; if you need help, a decision or a user-run Scriptify step (give the reviewed script path), use worker_ask. Each worker_report or worker_ask ends this invocation and hands the outcome to your owner; plain final text without one is an error outcome. Continuations reopen this same session.`;
        pi.events.emit(NSTAR_WORKER, { ctx, taskId: record.taskId, label: record.label ?? record.childAgent, brief: record.brief, cwd: target, starter: record.owner });
        return {
          brief: existing ? `${brief}\n\nThis invocation already handed back ${existing.question ? "a clarification question" : existing.report ? `a ${existing.report.status} report` : "its outcome"}. Await the owner's continuation; do not edit or submit another report.` : brief,
          targetCheckoutPath: target, sharedCheckout: !hasWorktree(record),
        };
      } catch (error) {
        contextFailure = `Worker context unavailable: ${diagnosticText(error)}`;
        throw error;
      }
    },
  });

  async function runForSubmission(): Promise<WorkerRun> {
    const current = currentRun();
    if (await readHcWorkerHandoff(current.invocationId)) throw new Error("This invocation already handed back its outcome. Stop and wait for the owner.");
    await validateCapturedCheckout(current.record.integration.source, current.record.integration.repoKey, "Worker source");
    return current;
  }

  const askTool = {
    name: "worker_ask", label: "Ask Orchestrator", exposure: "model-only" as const,
    description: "Ask your owning orchestrator one focused clarification question. Use worker_ask alone in its tool batch; it ends this invocation and hands the question to the owner, whose answer continues this same session and checkout. It does not deliver work or record rework.",
    promptSnippet: "Ask the orchestrator a clarification; it ends this invocation until the answer arrives. Do not ask the human instead.",
    parameters: WorkerAskParameters,
    ...createWorkerToolRenderer("ask"),
    async execute(_id: string, params: { question: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
      const current = await runForSubmission();
      const { self, record } = current;
      if (record.taskId) {
        const task = await tandemShow(record.taskId, record.integration.target.checkoutPath);
        requireActiveTask(task, record.taskId, "Worker question");
        if (task.assignee !== self.name) throw new Error(`Worker ${self.name} does not own native Task ${record.taskId}.`);
      }
      const question = { id: newId("question-"), text: params.question.trim(), askedAt: Date.now() };
      if (!await publish(current, ctx, { question })) throw new Error(`Invocation ${current.invocationId} already handed back its outcome; the question was not recorded. Stop and wait.`);
      questionAsked = true;
      return { ...text(`Question recorded for the orchestrator: ${question.text}\nThis invocation now hands it over and closes. Do not continue work.`,
        { agent: self.name, terminal: self.address, taskId: record.taskId, deliveryId: record.deliveryId, invocationId: current.invocationId, questionId: question.id, question: question.text, state: "waiting-for-answer" }), terminate: true };
    },
  };

  const reportTool = {
    name: "worker_report", label: "Worker Report", exposure: "model-only" as const,
    description: "Submit a typed Worker plan, ready, or needs-input report; it ends this invocation and hands the report to your owner. The runtime captures source HEAD and raw git status from the captured checkout and attaches assignment/checklist context. Use worker_ask for a clarification question.",
    promptSnippet: "Report a plan, ready work, or a blocker; it ends this invocation. Use worker_ask for clarification questions.",
    parameters: WorkerReportParameters,
    ...createWorkerToolRenderer("report"),
    async execute(_id: string, params: WorkerReportInput, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext): Promise<AgentToolResult<WorkerReport> & { terminate: true }> {
      let report: WorkerReport;
      let current: WorkerRun;
      try {
        if (params.status === "ready" && params.evidence.length === 0) throw new Error("A ready report needs at least one evidence item (criterion and observation).");
        current = await runForSubmission();
        const { record } = current;
        if (params.taskId !== undefined && record.taskId !== params.taskId) throw new Error(`worker_report identity is not the assigned Worker for ${params.taskId}.`);
        // Short form for trivial/small Tasks (task-568); medium and larger keep the full report.
        const shown = record.taskId ? await tandemShow(record.taskId, record.integration.target.checkoutPath) : undefined;
        const effort = shown?.effort;
        const missing = !shown || WORKER_LIGHT_EFFORTS.has(effort) ? [] : (["version", "taskId", "validation", "blockers", "risks"] as const).filter((key) => params[key] === undefined);
        if (missing.length) throw new Error(`worker_report for a ${effort ?? "no-effort"} Task needs the full report; missing ${missing.join(", ")}.`);
        const source = record.integration.source.checkoutPath;
        const head = (await command("git", ["rev-parse", "HEAD"], source)).trim();
        const statusPorcelain = await command("git", ["status", "--porcelain"], source);
        // The report belongs to this invocation: every owner of it (recovery included) reads the same one.
        report = validateWorkerReport({ ...params, version: 1, ...(record.taskId ? { taskId: record.taskId, assignment: record.assignment } : { brief: record.brief }), label: record.label ?? record.childAgent, needsAlgorant: record.needsAlgorant ?? false, validation: params.validation ?? [], blockers: params.blockers ?? [], risks: params.risks ?? [], deliveryId: current.invocationId, checklist: latestTodoList(ctx),
          source: { checkoutPath: source, branch: record.integration.source.branch, head, statusPorcelain } });
        if (report.status === "ready" && statusPorcelain.trim()) report = { ...report, status: "needs-input", blockers: [...report.blockers, "Uncommitted work cannot be ready. Changes preserved; commit before ready, or ask the owner if committing is blocked."] };
        if (report.status === "ready" && record.planRequired && record.planAcceptedAt === undefined) throw new Error(`Worker report for ${record.taskId} is missing the accepted plan required by its delivery.`);
        if (report.status === "ready") {
          // The Task's runnable validations run once, here, against the reported HEAD; finish reuses
          // passing results at that same HEAD. A failure is recorded for the owner, not hidden.
          const target = record.integration.target.checkoutPath;
          const checks = record.taskId ? await runRunnableValidations(record.taskId, target, source, checkInNotifier(ctx), signal) : await taskFreeChecks(record, checkInNotifier(ctx), signal);
          report = { ...report, checks: { head, ...checks } };
          // Delivery belongs to the ready handoff: finish then makes the one accepting write.
          if (record.taskId && shown.accord?.status !== "delivered") await deliverReport(record.taskId, target, report);
        }
      } catch (error) {
        throw new Error(`${diagnosticText(error)}${REJECTED_REPORT_SUFFIX}`);
      }
      if (!await publish(current, ctx, { report })) throw new Error(`Invocation ${current.invocationId} already handed back its outcome; this report was NOT recorded. Stop and wait for the owner.`);
      const checks = report.checks ? ` Checks: ${formatChecks(report.checks)}${checksPassed(report.checks) ? "" : "; a failed check goes to the owner with this report"}.` : "";
      return { content: [{ type: "text", text: `Worker report recorded for ${report.label ?? report.taskId} (needsAlgorant:${report.needsAlgorant ?? false}) with status ${report.status}; this invocation hands it to the owner and closes.${checks}` }], details: report, terminate: true };
    },
  };

  const progressTool = {
    name: "worker_progress", label: "Worker Progress", exposure: "model-only" as const,
    description: "Publish progress for one existing active milestone in your captured assignment: start, report, block, or resume. Native Tandem runs in the captured target checkout. Root Task acceptance, completion, scope and cleanup remain owner-owned.",
    promptSnippet: "Use only for an assigned active milestone: start, report with summary/evidence, block with note, or resume.",
    parameters: WorkerProgressParameters,
    ...createWorkerToolRenderer("progress"),
    async execute(_id: string, params: WorkerProgressInput, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
      const { self, record } = currentRun();
      if (!record.taskId || !record.assignment) throw new Error("Task-free Workers have no Tandem milestones; report through worker_report or worker_ask.");
      const cwd = record.integration.target.checkoutPath;
      await validateCapturedCheckout(record.integration.target, record.integration.repoKey, "Captured Worker target");
      const rootTask = await tandemShow(record.assignment.root.id, cwd);
      requireActiveTask(rootTask, rootTask.id, "Worker progress");
      if (!record.assignment.milestones.some(({ id }) => id === params.milestoneId)) throw new Error(`Milestone ${params.milestoneId} is not in the assigned Worker milestone set.`);
      if (!rootTask.children.some((child: { id: string }) => child.id === params.milestoneId)) throw new Error(`Milestone ${params.milestoneId} is not an active native subtask under root ${rootTask.id}.`);
      const milestone = await tandemShow(params.milestoneId, cwd);
      requireActiveTask(milestone, params.milestoneId, "Worker progress");
      if (milestone.parentId !== rootTask.id) throw new Error(`Milestone ${params.milestoneId} belongs to native parent ${milestone.parentId}, not root ${rootTask.id}.`);
      if (rootTask.assignee !== self.name) throw new Error(`Tandem ownership mismatch for root ${rootTask.id}: expected Worker ${self.name}, found ${rootTask.assignee ?? "none"}.`);
      const assignee = milestone.assignee;
      if (params.action === "start" ? assignee && assignee !== self.name : assignee !== self.name) throw new Error(`Milestone ${params.milestoneId} is assigned to ${assignee ?? "none"}, not Worker ${self.name}.`);
      if (params.action === "report" && params.note !== undefined) throw new Error("worker_progress report accepts summary and evidence only.");
      if (params.action === "block" && (params.summary !== undefined || params.evidence !== undefined)) throw new Error("worker_progress block accepts note only.");
      if ((params.action === "start" || params.action === "resume") && [params.summary, params.evidence, params.note].some((value) => value !== undefined)) throw new Error(`worker_progress ${params.action} accepts milestoneId and action only.`);
      const native = await runWorkerProgressNative(params.action, params.milestoneId, params, self.name, cwd);
      const resulting = await tandemShow(params.milestoneId, cwd);
      const details = { action: params.action, nativeAction: native.action, rootTaskId: rootTask.id, milestoneId: params.milestoneId, assignee: self.name,
        terminal: self.address, deliveryId: record.deliveryId, sessionPath: ctx.sessionManager.getSessionFile(), authoritativeCheckout: cwd, native, milestone: resulting };
      return text(JSON.stringify(details, null, 2), details);
    },
  };

  pi.on("tool_call", async () => {
    if (!workerMode || !questionAsked) return;
    return { block: true, terminate: true, reason: "This invocation's question is with the owner. Stop; its answer continues this session." };
  });

  /** One job ending = one handed-back outcome, then close unless natively kept. */
  pi.on("agent_settled", async (_event, ctx) => {
    if (!workerMode) return;
    // Settle the invocation this run captured, never a label read now.
    const settled = run;
    run = undefined;
    try {
      if (!settled) throw new Error(contextFailure ?? "This run captured no Worker invocation.");
      // An invocation without a typed handoff hands back its failure. One that already has a
      // handoff (published in this run, or before it by a kept Worker) keeps it unchanged.
      if (!settled.published) await publish(settled, ctx, {
        diagnostic: contextFailure ?? providerErrorDiagnostic(ctx) ?? rejectedReportDiagnostic(ctx) ?? "Worker turn ended without worker_report or worker_ask." });
      if (settled.published) {
        // Notice routing only: whichever owner control currently holds this invocation.
        const worker = await view(await invocationControl(settled.invocationId));
        const state = deliveryState(worker);
        if (!["paused", "discarding", "discarded"].includes(state)) {
          try {
            const report = worker.handoff?.report;
            // The handoff is the authority: a diff that cannot be read is named, and the notice still goes.
            const review = report?.status === "ready" ? await readyReview(worker.record, report).catch((error) => `${formatWorkerReport(report)}\nDIFF: unavailable (${diagnosticText(error)})`) : undefined;
            await sendAgentMessage(ctx, { terminal: worker.record.owner.terminal, kind: "result", body: noticeBody(worker, review) });
          } catch (error) {
            // The handoff file is the authority; the owner (or a recovering owner) reads it.
            pi.appendEntry("pi-herdr-worker-notice-error", { deliveryId: worker.record.deliveryId, invocationId: settled.invocationId, error: diagnosticText(error) });
            console.error(`[pi-herdr] Worker owner notice failed: ${diagnosticText(error)}`);
          }
        }
        if (ctx.hasUI) ctx.ui.notify(`Worker ${state} handoff recorded for ${workerName(worker.record)}`, state === "failed" ? "error" : "info");
      }
    } catch (error) {
      console.error(`[pi-herdr] Worker handoff failed: ${diagnosticText(error)}`);
      if (ctx.hasUI) ctx.ui.notify(`Worker handoff failed: ${diagnosticText(error)}`, "error");
    }
    await closeUnlessKept(ctx);
  });

  // ---------------- Owner side ----------------

  async function continueWorker(params: { agent: string; message: string; approve?: boolean; questionId?: string; requireStopped?: boolean; resumeBlocked?: boolean; redeliver?: boolean }, ctx: ExtensionContext) {
    if (!params.message.trim()) throw new Error("Worker continuation requires a non-empty answer or feedback message.");
    const { owner, worker } = await ownedWorker(params.agent, ctx);
    const previous = worker.record;
    if (isManusRecord(previous)) throw new Error(`Manus ${params.agent} has no Worker continuation; its starter finishes or discards its delivery with worker_finish/worker_discard. No input was sent.`);
    if (["discarding", "discarded"].includes(previous.state)) throw new Error(`Worker ${params.agent} is ${previous.state}; continuation is refused.`);
    const { integration } = previous;
    const { question, report } = worker.handoff ?? {};
    await validateCapturedCheckout(integration.source, integration.repoKey, "Worker source");
    await validateCapturedCheckout(integration.target, integration.repoKey, "Captured Worker target");
    const target = integration.target.checkoutPath;
    const task = previous.taskId ? await tandemShow(previous.taskId, target) : undefined;
    if (task) {
      requireActiveTask(task, task.id, "Worker continuation");
      if (task.assignee !== previous.childAgent) throw new Error(`Tandem ownership mismatch for ${task.id}; expected ${previous.childAgent}, found ${task.assignee ?? "none"}.`);
    }
    // A direction that never reached the Worker is delivered exactly, by worker_resume, before anything new.
    const undelivered = undeliveredDirection(worker);
    if (undelivered && !params.redeliver) {
      const diagnostic = diagnosticOf(worker);
      throw new Error(`Worker ${params.agent} delivery ${previous.deliveryId} holds a direction that has not reached the Worker${diagnostic ? ` (${diagnostic})` : ""}. worker_resume delivers exactly that direction; worker_handoff shows it with the prior handoff. No input was sent.`);
    }
    const answering = params.questionId !== undefined;
    if (answering && (deliveryState(worker) !== "question" || question?.id !== params.questionId)) throw new Error(`Worker ${params.agent} has no published pending question matching ${params.questionId}. No answer was sent.`);
    if (!answering && question) throw new Error(`Worker ${params.agent} is waiting for question ${question.id}. Use worker_answer with that exact question ID.`);
    const planPending = report?.status === "plan";
    if (params.approve && (answering || !planPending)) throw new Error(`approve:true applies only to a pending plan, and Worker ${params.agent} has ${report ? `a ${report.status} report` : "no pending plan"}. No feedback was sent.`);
    const live = await liveInvocation(worker);
    if (live && runtimeState(live) === "working") {
      if (worker.handoff) throw new Error(`Worker ${params.agent} handed back ${report ? `a ${report.status} report` : "its outcome"} but is still settling. No feedback was sent; retry after it hands off.`);
      if (answering || params.requireStopped) throw new Error(`Worker ${params.agent} is working; this continuation requires a settled Worker. No input was sent.`);
      const receipt = await hcJson(["send", "--if", "working", "--json", live.address, workerDirection(params.message)]);
      return text(`Sent in-flight feedback to working Worker ${params.agent} (${live.address}); its current delivery cycle was preserved.`,
        { host: "hc", agent: params.agent, terminal: live.address, taskId: previous.taskId, state: "working", routed: "in-flight", receipt });
    }
    // Only an explicitly kept invocation receives a new cycle in place; any other
    // live one is still starting or closing after its handoff.
    if (live && !live.keep) throw new Error(`Worker invocation ${live.address} is ${runtimeState(live)} and not kept: it is still starting or closing. No input was sent; retry after it works or hands off.`);
    const sessionPath = live ? (await keptSessionStart(worker))?.sessionPath : sessionPathOf(worker);
    if (live && (!sessionPath || live.labels?.[CONTEXT_LABEL] !== workerContextCapability(sessionPath))) {
      throw new Error(`Kept Worker ${params.agent} (${live.address}) has not loaded managed context for its session; no input was sent.`);
    }
    const benchmark = previous.benchmark
      ? benchmarkWorkerModelArgument(ctx.modelRegistry, previous.benchmark.requestedModel)
      : undefined;
    if (benchmark && (benchmark.model !== previous.benchmark!.selectedModel || benchmark.argument !== previous.model ||
        benchmark.fast !== previous.benchmark!.fast || benchmark.providerExemption !== previous.benchmark!.providerExemption ||
        benchmark.providerExemptionModel !== previous.benchmark!.providerExemptionModel)) {
      throw new Error(`Saved benchmark Worker ${params.agent} no longer resolves to its captured contender, high-thinking model and Fast policy; no retarget or continuation was started.`);
    }
    const benchmarkRecord: HcWorkerBenchmarkSelection | undefined = benchmark
      ? { ...previous.benchmark!, quota: benchmark.quota, quotaCheckedAt: benchmark.quotaCheckedAt }
      : undefined;
    const assignment = task ? await captureWorkerAssignment(task, target) : undefined;
    // A plan handoff supersedes any earlier approval: only approve:true approves it again.
    const planAcceptedAt = params.approve ? Date.now() : planPending ? undefined : previous.planAcceptedAt;
    const planNote = params.approve ? "Plan approved; proceed.\n" : planPending ? "NOT plan approval: do not edit; revise and resubmit worker_report(status=plan).\n" : "";
    const request = undelivered ? undelivered.request
      : answering ? `Answer to question ${question!.id}:\n${question!.text}\n\nOrchestrator answer:\n${params.message.trim()}` : `${planNote}${params.message.trim()}`;
    const direction: HcWorkerDirection = undelivered
      ? { request, ofDeliveryId: undelivered.ofDeliveryId, ...(undelivered.questionId ? { questionId: undelivered.questionId } : {}), ...(undelivered.approve ? { approve: true as const } : {}) }
      : { request, ofDeliveryId: previous.deliveryId, ...(answering ? { questionId: params.questionId } : {}), ...(params.approve ? { approve: true as const } : {}) };
    const planRequired = task ? taskPlanRequired(task) : planPending || previous.planRequired;
    if (task) workerBrief(task.id, assignment!, planRequired, planAcceptedAt !== undefined);
    const prompt = workerDirection(request);
    if (params.resumeBlocked && task?.accordStatus === "blocked") {
      const resumed = await runTandemCommand(["accord", "resume", task.id], target);
      if (!resumed.ok) throw new Error(`Could not resume durable Tandem state for Worker ${params.agent}; no continuation was sent. ${resumed.error}`);
    }
    if (!answering && !undelivered) await recordReworkOnce(worker, target, params.message);
    const now = Date.now();
    // Each continuation is a NEW invocation; a kept terminal is relabelled to it only once settled.
    const next: HcWorkerRecord = {
      version: 8, deliveryId: createHcDeliveryId(), recoveryOfDeliveryId: previous.deliveryId, invocationId: createHcInvocationId(), taskId: previous.taskId,
      ownerSessionId: owner.sessionId, owner: { core: owner.core, terminal: owner.terminal }, childAgent: previous.childAgent,
      ...(previous.label ? { label: previous.label } : {}), brief: previous.brief, needsAlgorant: previous.needsAlgorant, from: previous.from, childSessionId: previous.childSessionId, model: previous.model, ...(benchmarkRecord ? { benchmark: benchmarkRecord } : {}), integration, assignment, planRequired,
      ...(live ? { child: { core: owner.core, terminal: live.address } } : {}),
      ...(planAcceptedAt !== undefined ? { planAcceptedAt } : {}),
      direction, createdAt: now, updatedAt: now, state: "pending",
    };
    await createHcWorkerRecord(next);
    let terminal: string;
    try {
      if (live) {
        // Recheck the strict quota gate immediately before sending a new invocation to a kept child.
        await refreshBenchmarkQuota(next, ctx.modelRegistry);
        // Refuse before changing the label. Settled is idle or done; `--if` only
        // distinguishes idle from working.
        if (!["idle", "done"].includes(runtimeState(live))) throw new LaunchError(`Kept Worker ${live.address} is ${runtimeState(live)}, not settled.`, false);
        try { await hcText(["label", live.address, `${INVOCATION_LABEL}=${next.invocationId}`]); }
        catch (error) { throw new LaunchError(`Kept Worker ${live.address} relabel was not confirmed; no input was sent. ${diagnosticText(error)}`, true); }
        let receipt: any;
        try { receipt = await hcJson(["send", "--json", live.address, prompt]); }
        catch (error) { throw new LaunchError(diagnosticText(error), !DEFINITE_REFUSALS.has((error as { kind?: string }).kind ?? "")); }
        if (receipt?.started === false) throw new LaunchError(`hc send did not confirm the kept Worker's turn started: ${JSON.stringify(receipt).slice(0, 300)}`, true);
        terminal = live.address;
      } else {
        terminal = (await launchInvocation(next, prompt, ctx.modelRegistry)).address;
      }
    } catch (error) {
      // Never retried here. A refusal proves nothing arrived: the delivery fails and keeps its exact
      // direction for worker_resume. An unconfirmed one stays pending: if its invocation runs, it
      // confirms receipt and hands off normally; if not, worker_resume delivers the same direction.
      const uncertain = !(error instanceof LaunchError) || error.uncertain;
      const diagnostic = `${uncertain ? "Continuation delivery unconfirmed" : "Continuation did not reach the Worker"}: ${diagnosticText(error)}`;
      await updateHcWorkerRecord(next.deliveryId, (current) => uncertain || current.state !== "pending"
        ? { ...current, diagnostic } : { ...current, state: "failed", diagnostic });
      throw new Error(`${diagnostic}. Delivery ${next.deliveryId} keeps the exact direction and the prior handoff (worker_handoff shows both); nothing was retried. ${uncertain
        ? "Inspect worker_status: a live invocation of this delivery continues as is; once none is running, worker_resume delivers the same direction."
        : "worker_resume delivers exactly this direction when you choose; do not resend it as new feedback."}`);
    }
    return text(`${undelivered ? "Delivered the preserved direction to" : answering ? "Answered clarification for" : params.redeliver ? "Sent the generic continuation to" : "Sent feedback to"} Worker ${params.agent} in the same session and checkout (${terminal}); opened delivery ${next.deliveryId}.`,
      // The invocation now carrying this delivery: a kept one got a new turn, otherwise a new one is starting.
      { host: "hc", agent: params.agent, terminal, taskId: previous.taskId, deliveryId: next.deliveryId, invocationId: next.invocationId, state: live ? "kept · turn sent" : "new invocation · starting", routed: "new-cycle",
        direction: undelivered ? "redelivered" : "new", ...(live ? { kept: true } : {}), ...(benchmarkRecord ? { benchmark: benchmarkRecord } : {}),
        ...(planPending && !answering ? { plan: params.approve ? "approved" : "revise" } : {}), ...(answering ? { questionId: params.questionId, answer: params.message.trim() } : {}) });
  }

  async function recoverWorker(params: { taskId?: string; agent: string }, ctx: ExtensionContext) {
    const owner = await currentOwner(ctx);
    const current = leaves(await workerChain(params.agent, owner.core));
    if (params.taskId !== undefined && current.some((record) => record.taskId !== params.taskId)) throw new Error("Recovery taskId differs from the captured Worker contract; nothing changed.");
    if (current.length !== 1) throw new Error(`Native Worker ${params.agent} has ${current.length} current deliveries for ${params.taskId}; recovery made no changes.`);
    const previous = current[0]!;
    if (ownedBy(previous, owner)) return { record: previous, adopted: false };
    if (isManusRecord(previous)) throw new Error(`Manus ${params.agent} belongs to its starter terminal ${previous.owner.terminal} (core ${previous.owner.core}); only that starter finishes or discards it. Recovery made no changes.`);
    if (["discarding", "discarded"].includes(previous.state)) throw new Error(`Worker ${params.agent} is ${previous.state}; recovery made no changes.`);
    await validateCapturedCheckout(previous.integration.source, previous.integration.repoKey, "Worker source");
    await validateCapturedCheckout(previous.integration.target, previous.integration.repoKey, "Captured Worker target");
    if (previous.taskId) {
      const task = await tandemShow(previous.taskId, previous.integration.target.checkoutPath);
      requireActiveTask(task, previous.taskId, "Worker recovery");
      if (task.assignee !== previous.childAgent) throw new Error(`Tandem ownership mismatch for ${previous.taskId}: expected ${previous.childAgent}, found ${task.assignee ?? "none"}. Recovery never claims.`);
    }
    // Refuses a terminal holding the Worker's name without its invocation; reads only.
    await liveInvocation(await view(previous));
    const now = Date.now();
    // A successor control for the SAME invocation: owner data only, nothing the Worker produced,
    // and no relabel. A late handoff of that invocation is read here through its id.
    const { handoffReadAt: _read, ...control } = previous;
    const record: HcWorkerRecord = {
      ...control, deliveryId: createHcDeliveryId(), recoveryOfDeliveryId: previous.deliveryId, ownerSessionId: owner.sessionId,
      owner: { core: owner.core, terminal: owner.terminal }, createdAt: now, updatedAt: now,
    };
    await createHcWorkerRecord(record);
    return { record, adopted: true };
  }

  /** The one native Worker start path, reached through dispatch.ts `dendra_start {kind: "worker"}`. */
  async function startWorker(params: Parameters<StartWorker>[0], signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<Result> {
    const owner = await currentOwner(ctx);
    requireContract(params);
    const worktree = params.worktree ?? true;
    const needsAlgorant = params.needsAlgorant ?? false;
    const benchmark = params.benchmarkModel ? benchmarkWorkerModelArgument(ctx.modelRegistry, params.benchmarkModel) : undefined;
    const model = benchmark?.argument ?? workerModelArgument(ctx.modelRegistry);
    const benchmarkRecord: HcWorkerBenchmarkSelection | undefined = benchmark ? {
      requestedModel: params.benchmarkModel!, selectedModel: benchmark.model, providerExemption: benchmark.providerExemption,
      providerExemptionModel: benchmark.providerExemptionModel, fast: benchmark.fast, quota: benchmark.quota, quotaCheckedAt: benchmark.quotaCheckedAt,
    } : undefined;
    const project = await nativeProjectIdentity(ctx.cwd);
    const task = params.taskId ? await tandemShow(params.taskId, ctx.cwd) : undefined;
    if (task) {
      requireActiveTask(task, task.id, "Starting a Worker");
      await validateWorkerDispatch(task, ctx.cwd);
    }
    const assignment = task ? await captureWorkerAssignment(task, ctx.cwd) : undefined;
    const planRequired = task ? taskPlanRequired(task) : false;
    if (task) workerBrief(task.id, assignment!, planRequired);
    const prompt = workerDirection(params.prompt);
    const outcomes = await listHcWorkerOutcomes();
    const active = leaves(await listHcWorkerRecords()).filter((record) => record.integration.repoKey === project.repoKey &&
      record.state !== "discarded" && !outcomes.some((outcome) => outcome.childAgent === record.childAgent && outcome.integration.repoKey === project.repoKey && outcome.removalCompletedAt));
    if (task && active.some((record) => record.taskId === task.id)) {
      const holder = active.find((record) => record.taskId === task.id)!;
      throw new Error(`Task ${task.id} already has a native ${isManusRecord(holder) ? "manus" : "Worker"} (${workerName(holder)}); continue, finish or discard it first.`);
    }
    const shared = !worktree && active.find((record) => !hasWorktree(record) && record.integration.source.checkoutPath === project.repoRoot);
    if (shared) throw new Error(`Checkout ${project.repoRoot} already has an active worktree-less ${isManusRecord(shared) ? "manus" : "Worker"} (${workerName(shared)}). Use a worktree or finish that attempt; nothing started.`);
    const targetBranch = await checkoutBranch(project.repoRoot, "Integration target");
    // The label (default: the Task title) names it; its slug is its durable hc name and its branch (-2 when taken).
    const baseHead = await nativeHead(project.repoRoot, "Integration target");
    const label = labelFrom(params.label ?? task?.title ?? "");
    if (!label) throw new Error("Worker requires label (2-5 plain words).");
    const agent = await nameFor(label, worktree ? project.repoRoot : undefined);
    const branch = worktree ? agent : targetBranch;
    const deliveryId = createHcDeliveryId();
    let checkoutPath: string | undefined;
    let provisioningFailed = false;
    let written = false;
    let claimed = false;
    let launchAttempted = false;
    let launchUncertain = false;
    try {
      if (worktree) {
        // Worktrunk's own creation lifecycle: it refuses unapproved hooks before creating anything,
        // blocks on pre-switch/pre-start, and dispatches post-start/post-switch in the background.
        // Hooks run exactly once here; continuation and recovery never create or provision again.
        let created: any;
        try {
          created = JSON.parse(await command("wt", ["-C", project.repoRoot, "switch", "--create", branch, "--base", "@", "--no-cd", "--format", "json"], project.repoRoot, 0, signal));
        } catch (error) {
          const left = await nativeWorktreeForBranch(project.repoRoot, branch);
          if (!left) throw new Error(`Worktrunk did not create Worker checkout ${branch}; nothing was created, claimed or started. ${diagnosticText(error)}`);
          checkoutPath = left;
          provisioningFailed = true;
          throw new Error(`Worktrunk created ${left} but its creation lifecycle did not complete; Pi was not started. ${diagnosticText(error)}`);
        }
        if (created?.action !== "created" || created.branch !== branch || typeof created.path !== "string" || !isAbsolute(created.path)) {
          throw new Error(`Worktrunk did not create a new Worker checkout for ${branch}: ${JSON.stringify(created).slice(0, 400)}`);
        }
        checkoutPath = created.path as string;
      } else {
        await requireCleanCheckout(project.repoRoot, "Shared Worker source");
        checkoutPath = project.repoRoot;
      }
      const source = await nativeProjectIdentity(checkoutPath);
      if (source.repoKey !== project.repoKey || source.repoRoot !== checkoutPath) throw new Error(`Worker checkout ${checkoutPath} is not a linked checkout of ${project.repoKey}.`);
      if (await checkoutBranch(checkoutPath, "Worker source") !== branch) throw new Error(`Worker checkout ${checkoutPath} is not on ${branch}.`);
      const now = Date.now();
      const record: HcWorkerRecord = {
        version: 8, deliveryId, invocationId: createHcInvocationId(), ...(task ? { taskId: task.id, assignment } : { brief: params.brief! }), needsAlgorant, from: params.from, ownerSessionId: owner.sessionId, owner: { core: owner.core, terminal: owner.terminal },
        childAgent: agent, label, childSessionId: newId(), model, ...(benchmarkRecord ? { benchmark: benchmarkRecord } : {}), createdAt: now, updatedAt: now, state: "pending", planRequired,
        direction: { request: params.prompt.trim(), ofDeliveryId: deliveryId },
        integration: { repoKey: project.repoKey, worktree, baseHead, source: { checkoutPath, branch }, target: { checkoutPath: project.repoRoot, branch: targetBranch } },
      };
      await createHcWorkerRecord(record);
      written = true;
      // `accord claim --assignee` is the single ownership write, before the first context-bearing run.
      if (task) {
        const claim = await runTandemCommand(["accord", "claim", task.id, "--assignee", agent], ctx.cwd);
        if (!claim.ok && (await tandemShow(task.id, ctx.cwd)).assignee !== agent) throw new Error(claim.error || `Tandem could not claim ${task.id}.`);
        claimed = true;
      }
      launchAttempted = true;
      let started: any;
      try { started = await launchInvocation(record, prompt, ctx.modelRegistry); }
      catch (error) { launchUncertain = error instanceof LaunchError ? error.uncertain : true; throw error; }
      return text(`Started native Worker ${label} (${agent}, ${started.address}) ${task ? `for ${task.id}` : "(Task-free)"} under ${owner.terminal}. Checkout: ${checkoutPath} (${worktree ? "created through Worktrunk" : "shared; no merge or removal"}). needsAlgorant:${needsAlgorant}.${benchmarkRecord ? ` Benchmark contender ${benchmarkRecord.selectedModel} at high thinking; provider exemption ${benchmarkRecord.providerExemption}; ${benchmarkRecord.quota}; Fast ${benchmarkRecord.fast ? "on" : "off"}.` : ""}`,
        { host: "hc", state: "starting", taskId: task?.id, title: task?.title, label, worktree, needsAlgorant, from: params.from, agent, terminal: started.address, core: owner.core, worktreePath: checkoutPath, branch, deliveryId, invocationId: record.invocationId,
          integrationTarget: record.integration.target, sessionId: record.childSessionId, model, ...(benchmarkRecord ? { benchmark: benchmarkRecord } : {}), outlivesParent: true });
    } catch (error) {
      const identity = `${task ? `Task ${task.id}, ` : ""}Worker ${agent}, checkout ${checkoutPath ?? "(none)"}, branch ${branch}, delivery ${deliveryId}`;
      if (provisioningFailed) throw new Error(`${diagnosticText(error)} Preserve ${identity} for inspection (wt -C ${JSON.stringify(checkoutPath)} config state logs). Resolve provisioning or dispose this checkout through Worktrunk before retrying; do not blindly rerun creation hooks.`);
      if (claimed || written && launchAttempted) {
        throw new Error(`${diagnosticText(error)} Captured Worker ${agent} is preserved. ${launchUncertain ? "The native launch outcome is unconfirmed: inspect hc ls and worker_status before anything else." : "No Worker invocation started."} The pending record remains the identity of ${identity}: continue it with worker_resume (same checkout and session) or dispose it with worker_discard. Do not rerun dendra_start or claim again.`);
      }
      if (checkoutPath && worktree) {
        try {
          await approvedHookTypes(checkoutPath, ["pre-remove", "post-remove"]);
          await removeNativeWorkerCheckout({ cwd: project.repoRoot }, branch, checkInNotifier(ctx));
          if (written) await rm(hcRecordPath(deliveryId), { force: true });
        } catch (cleanup) {
          throw new Error(`${diagnosticText(error)} Automatic cleanup of the new unclaimed checkout failed; preserve ${identity} and dispose it through Worktrunk. ${diagnosticText(cleanup)}`);
        }
      }
      throw error;
    }
  }

  const ownerTools: any[] = [
    {
      name: "worker_handoff", label: "Worker Handoff",
      description: "Read the current structured handoff (report or question) of one native Worker you own, without changing Tandem workflow. Call it after the inbox notice arrives. Never sleep or poll for it.",
      parameters: AgentParameters,
      ...createWorkerToolRenderer("handoff"),
      async execute(_id: string, params: { agent: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        const { worker } = await ownedWorker(params.agent, ctx);
        const { record, handoff: published } = worker;
        if (isManusRecord(record)) throw new Error(`Manus ${params.agent} reports through the inbox, not a typed handoff; finish or discard it with worker_finish/worker_discard.`);
        const live = await liveInvocation(worker, true);
        const state = deliveryState(worker);
        const diagnostic = diagnosticOf(worker);
        const base = { host: "hc", agent: params.agent, terminal: live?.address, state: runtimeState(live), sessionPath: sessionPathOf(worker), deliveryId: record.deliveryId, invocationId: record.invocationId, taskId: record.taskId, deliveryState: state };
        if (published?.question) {
          return text(`Worker ${workerName(record)} needs an answer.\nQuestion ID: ${published.question.id}\nQuestion: ${published.question.text}\nUse worker_answer with this exact agent and question ID. This is not a ready report.`,
            { ...base, questionId: published.question.id, question: published.question.text });
        }
        if (!published?.report) {
          if (!record.direction) throw new Error(`Worker ${params.agent} has no current typed report (delivery ${state}${diagnostic ? `: ${diagnostic}` : ""}).`);
          // No typed handoff of its own: show the exact direction it carries and the prior typed handoff it answers.
          const delivered = Boolean(worker.started);
          const prior = record.direction.ofDeliveryId === record.deliveryId ? undefined : await view(await readHcWorkerRecord(record.direction.ofDeliveryId));
          const priorDiagnostic = prior && diagnosticOf(prior);
          const priorText = !prior ? "(none: this is the Worker's first delivery)"
            : prior.handoff?.question ? `Question ${prior.handoff.question.id}: ${prior.handoff.question.text}`
              : prior.handoff?.report ? formatWorkerReport(prior.handoff.report, record.taskId ? tandemCounts(await tandemShow(record.taskId, record.integration.target.checkoutPath), record.taskId) : undefined)
                : `(no typed handoff; that delivery was ${deliveryState(prior)}${priorDiagnostic ? `: ${priorDiagnostic}` : ""})`;
          return text([
            `Worker ${params.agent} delivery ${record.deliveryId} is ${state} without a typed handoff of its own${diagnostic ? `: ${diagnostic}` : "."}`,
            delivered ? "Its direction reached the Worker:" : "Its direction has NOT reached the Worker (exact, preserved):",
            record.direction.request,
            "",
            prior ? `Prior handoff, delivery ${prior.record.deliveryId} (superseded by this direction; it is not finishable as is):` : "Prior handoff:",
            priorText,
            "",
            delivered ? "Continue with worker_resume or worker_feedback, or dispose with worker_discard."
              : "worker_resume delivers exactly this direction; worker_feedback and worker_answer refuse until it has been delivered.",
          ].join("\n"), { ...base, direction: record.direction.request, directionDelivered: delivered, priorDeliveryId: prior?.record.deliveryId,
            priorHandoff: prior?.handoff?.question ? "question" : prior?.handoff?.report?.status ?? "none" });
        }
        const counts = record.taskId ? tandemCounts(await tandemShow(record.taskId, record.integration.target.checkoutPath), record.taskId) : undefined;
        const handoff = formatWorkerReport(published.report, counts);
        // This owner has now read the report: its own control fact, never a copy of the report.
        const current = await updateHcWorkerRecord(record.deliveryId, (latest) => latest.handoffReadAt === undefined && !["discarding", "discarded"].includes(latest.state) ? { ...latest, handoffReadAt: Date.now() } : latest);
        return text(handoff, { ...base, deliveryState: deliveryState({ ...worker, record: current }), report: published.report });
      },
    },
    {
      name: "worker_feedback", label: "Worker Feedback",
      description: "Send owner direction to a native Worker you own. A working invocation receives in-flight feedback; otherwise a new delivery cycle continues the same session and checkout. On a pending plan, approve:true approves implementation; without it the Worker revises and resubmits the plan. Only feedback after ready work records rework. Pending questions require worker_answer.",
      promptSnippet: "Send feedback to a Worker. On a pending plan pass approve:true to approve it; answer worker_ask questions through worker_answer.",
      parameters: FeedbackParameters,
      ...createWorkerToolRenderer("feedback"),
      async execute(_id: string, params: { agent: string; message: string; approve?: boolean }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, () => continueWorker(params, ctx));
      },
    },
    {
      name: "worker_answer", label: "Answer Worker",
      description: "Answer one published pending clarification from a native Worker you own, by its exact question ID. Continues the same session and checkout; never records delivery or rework.",
      promptSnippet: "Answer a pending Worker clarification using the exact agent and question ID from its notice.",
      parameters: WorkerAnswerParameters,
      ...createWorkerToolRenderer("answer"),
      async execute(_id: string, params: { agent: string; questionId: string; answer: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, () => continueWorker({ agent: params.agent, questionId: params.questionId, message: params.answer }, ctx));
      },
    },
    {
      name: "worker_recover", label: "Recover Worker",
      description: "Adopt one exact native Worker into this owner session after an owner restart or move, without continuing its work, claiming, or changing its checkout/session/receipts. A running invocation keeps running and hands its outcome to this session.",
      parameters: RecoverParameters,
      ...createWorkerToolRenderer("recover"),
      async execute(_id: string, params: { taskId?: string; agent: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, async () => {
          const { record, adopted } = await recoverWorker(params, ctx);
          const worker = await view(record);
          const live = await liveInvocation(worker);
          return text(adopted ? `Adopted Worker ${workerName(record)} into this owner session as delivery ${record.deliveryId} of invocation ${record.invocationId} (${handoffState(worker)}; invocation ${runtimeState(live)}); nothing was continued.` : `Worker ${params.agent} is already owned by this session; no changes.`,
            { host: "hc", agent: params.agent, taskId: record.taskId, deliveryId: record.deliveryId, recoveryOfDeliveryId: record.recoveryOfDeliveryId, invocationId: record.invocationId, adopted,
              handoffState: handoffState(worker), sessionPath: sessionPathOf(worker), terminal: live?.address, state: runtimeState(live) });
        });
      },
    },
    {
      name: "worker_resume", label: "Resume Worker",
      description: "Continue one paused or failed native Worker: adopt it if another owner session holds it, clear a linked Tandem block if present (Task-free never writes Tandem), and continue the same session and checkout. Ready or plan reports belong to worker_handoff/worker_feedback/worker_finish.",
      parameters: RecoverParameters,
      ...createWorkerToolRenderer("resume"),
      async execute(_id: string, params: { taskId?: string; agent: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, async () => {
          const { handoff } = await view((await recoverWorker(params, ctx)).record);
          if (handoff?.question) throw new Error(`Worker ${params.agent} is waiting for question ${handoff.question.id}; use worker_answer.`);
          if (handoff?.report?.status === "plan") throw new Error("Use worker_feedback (approve:true to approve, otherwise it asks for a revision); worker_resume does not approve plans.");
          if (handoff?.report?.status === "ready") throw new Error(`Worker ${params.agent} is ready. Use worker_handoff/worker_finish; resume did not restart it.`);
          // An undelivered direction is delivered exactly; only a Worker that already received its
          // direction gets the generic continuation.
          const continued = await continueWorker({ agent: params.agent, requireStopped: true, resumeBlocked: true, redeliver: true,
            message: "Continue your assigned task from where you paused. Preserve existing work and completed steps; do not start over. Report ready or needs-input when appropriate." }, ctx);
          return { ...continued, details: { ...continued.details, resumed: true, runtime: continued.details.direction === "redelivered" ? "preserved direction delivered" : "continuation sent" } };
        });
      },
    },
    {
      name: "worker_status", label: "Worker Status",
      description: "Inspect one native Worker: its native terminal and status, current delivery state, owner, checkout and session.",
      parameters: AgentParameters,
      ...createWorkerToolRenderer("status"),
      async execute(_id: string, params: { agent: string }) {
        const record = await currentRecord(params.agent, await coreId());
        const worker = await view(record);
        const live = await liveChild(worker);
        const details = { host: "hc", agent: params.agent, kind: record.kind ?? "worker", taskId: record.taskId, deliveryId: record.deliveryId, invocationId: record.invocationId,
          carryingInvocationId: live?.labels?.[INVOCATION_LABEL], terminal: live?.address ?? worker.started?.child.terminal ?? record.child?.terminal, state: runtimeState(live),
          ...(record.direction ? { directionDelivered: Boolean(worker.started) } : {}),
          kept: live?.keep ?? false, handoffState: handoffState(worker), diagnostic: diagnosticOf(worker), owner: record.owner, ownerSessionId: record.ownerSessionId,
          worktreePath: record.integration.source.checkoutPath, branch: record.integration.source.branch, sessionId: record.childSessionId, sessionPath: sessionPathOf(worker) };
        return text(JSON.stringify(details, null, 2), details);
      },
    },
    {
      name: "worker_pause", label: "Pause Worker",
      description: "Pause one working native Worker you own: record the durable Worker block (and linked Task when present), interrupt its invocation, and confirm it stopped working. The checkout and work are preserved; worker_resume continues the same session.",
      promptSnippet: "Pause after recording the block in the existing Worker record (and linked Task if any), then interrupt and confirm stopped.",
      parameters: PauseParameters,
      ...createWorkerToolRenderer("pause"),
      async execute(_id: string, params: { agent: string; note: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, async () => {
          const { worker } = await ownedWorker(params.agent, ctx);
          const { record } = worker;
          if (isManusRecord(record)) throw new Error(`Manus ${params.agent} has no Worker pause; its starter waits for its delivery and then finishes or discards it. Nothing changed.`);
          const state = deliveryState(worker);
          if (!["pending", "failed"].includes(state)) throw new Error(`Worker ${params.agent} delivery is ${state}; nothing is running to pause.`);
          const note = params.note.trim();
          // Resolve the invocation first: a refusal must come before any durable write.
          const live = await liveInvocation(worker);
          const blocked = record.taskId ? await runTandemCommand(["accord", "block", record.taskId, "--note", note], record.integration.target.checkoutPath) : { ok: true };
          if (!blocked.ok) throw new Error(`Could not record durable pause for Worker ${params.agent}; it was not interrupted. ${blocked.error}`);
          // Owner control only; a handoff the Worker publishes meanwhile is its own file and stays authoritative.
          const control = await updateHcWorkerRecord(record.deliveryId, (current) => ["pending", "failed"].includes(current.state)
            ? { ...current, state: "paused", diagnostic: `paused: ${note}` } : current);
          let runtime = "closed";
          if (live) {
            await hcText(["interrupt", live.address]);
            const after = await waitSettled(live.address);
            if (after?.state === "live" && runtimeState(after) === "working") throw new Error(`Worker ${params.agent} is durably blocked but still working after the interrupt; do not claim it is paused.`);
            runtime = runtimeState(after);
          }
          const paused = await view(control);
          const handedOff = deliveryState(paused) !== "paused";
          return text(handedOff
            ? `Worker ${params.agent} handed off (${handoffState(paused)}) before pause: ${record.taskId ? "Tandem and Worker control recorded the block" : "Worker control recorded the block (no Tandem write)"}, the delivery keeps its handoff; invocation ${runtime}. worker_handoff reads it.`
            : `Paused Worker ${params.agent}: ${record.taskId ? "Tandem and Worker control recorded a durable block" : "Worker control recorded a durable block (no Tandem write)"}; invocation ${runtime}. Checkout and work preserved.`,
            { host: "hc", agent: params.agent, taskId: record.taskId, runtime, durable: "blocked", note, handoffState: handoffState(paused), terminal: live?.address });
        });
      },
    },
    {
      name: "worker_finish", label: "Finish Worker",
      description: "Finish verified delivered work once for either child with a captured Worktrunk checkout: a Worker (its typed ready report is the gate) or a manus (its inbox delivery is the gate; its starter runs this). Reuses passing checks only at identical HEAD (reruns otherwise; a Task-backed manus runs the Task's runnable validations at its HEAD, and a failure blocks the merge); integrates through Worktrunk --no-remove; accepts any linked Task (a Task-free manus writes no Tandem); closes the captured child and removes only its captured checkout. worktree:false retains shared checkout/branch without merging/removing. Receipt retains git range/revert and retries only unfinished steps. needsAlgorant:true requires Algorant acceptance via owner first.",
      promptSnippet: "After verifying the current ready handoff, finish it once; the receipt handles later failures.",
      parameters: FinishParameters,
      ...createWorkerToolRenderer("finish"),
      async execute(_id: string, params: { agent: string; crashSummary?: string }, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, () => finishWorker(params, signal, ctx));
      },
    },
    {
      name: "worker_discard", label: "Discard Worker",
      description: "Discard an unintegrated owned attempt (Worker or manus) with resumable receipt: close captured child, release any linked Task this attempt holds, remove only captured worktree/branch. Task-free never writes Tandem; worktree:false preserves shared checkout/branch and changes. Integrated work is refused.",
      promptSnippet: "Discard only a disposable Worker attempt; the receipt retries only unfinished steps.",
      parameters: DiscardParameters,
      ...createWorkerToolRenderer("discard"),
      async execute(_id: string, params: { agent: string; note: string }, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
        return withHcWorkerLifecycle(params.agent, () => discardWorker(params, ctx));
      },
    },
  ];

  async function finishWorker(params: { agent: string; crashSummary?: string }, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    const { owner, worker } = await ownedWorker(params.agent, ctx);
    const { record } = worker;
    // A manus record has no typed handoff, assignment or invocation label: finish and discard
    // act on its captured checkout and terminal, and skip the Worker-only gates.
    const manus = isManusRecord(record);
    const kindName = manus ? "manus" : "Worker";
    const crashSummary = params.crashSummary?.trim();
    if (params.crashSummary !== undefined && !crashSummary) throw new Error("crashSummary must not be blank.");
    if (manus && crashSummary) throw new Error(`Manus ${params.agent} delivers through the inbox, not a typed report; crashSummary applies only to a Worker invocation without a ready report. Finish made no changes.`);
    if (["discarding", "discarded"].includes(record.state)) throw new Error(`${kindName} ${params.agent} is being discarded; finish is refused.`);
    const chainIds = new Set((await workerChain(params.agent, owner.core)).map((entry) => entry.deliveryId));
    const outcomes = (await listHcWorkerOutcomes()).filter((outcome) => outcome.childAgent === params.agent && chainIds.has(outcome.deliveryId));
    if (outcomes.length > 1) throw new Error(`Multiple integration receipts exist for Worker ${params.agent}; finish refuses an ambiguous state.`);
    let outcome: HcWorkerOutcome | undefined = outcomes[0];
    // A receipt that already records every finish step makes this call an idempotent no-op.
    const finishedEarlier = Boolean(outcome?.acceptedAt && (!record.taskId || outcome.taskCompletedAt) && outcome.presentationClosedAt && outcome.removalCompletedAt);
    const { integration } = record;
    const target = integration.target.checkoutPath;
    await validateCapturedCheckout(integration.target, integration.repoKey, "Integration target");
    const live = await liveChild(worker);
    if (live && runtimeState(live) === "working") throw new Error(`${kindName} ${params.agent} is working; wait for its ${manus ? "delivery" : "handoff"} before finish.`);
    if (crashSummary && live) throw new Error(`Worker ${params.agent} has a live invocation (${live.address}); crashSummary applies only when none is running.`);
    // The current invocation's own immutable report, whichever owner control references it.
    const report = worker.handoff?.report;
    if (crashSummary && report?.status === "ready") throw new Error(`Worker ${params.agent} has a ready report; finish it without crashSummary.`);
    if (!outcome?.acceptedAt) {
      if (manus) {
        // Its inbox delivery is the handoff: no typed report, no invocation id, no Worker scope/assignee gate.
        if (record.taskId) {
          const task = await tandemShow(record.taskId, target);
          requireActiveTask(task, record.taskId, "manus finish");
          await requireNoOpenWorkerSubtasks(task, target, outcome ? "complete" : "merge");
        }
      } else {
        if (!crashSummary && (report?.status !== "ready" || report.deliveryId !== record.invocationId || report.taskId !== record.taskId)) {
          if (record.direction && !report) throw new Error(`Worker ${params.agent} delivery ${record.deliveryId} carries ${worker.started ? "a" : "an undelivered"} direction and no ready report of its own; worker_handoff shows it with the prior handoff. Finish made no changes.`);
          throw new Error(`Worker ${params.agent} has no current typed ready report; verify and finish a ready handoff (or pass crashSummary when it ended without one).`);
        }
        if (record.taskId) {
          const task = await tandemShow(record.taskId, target);
          requireActiveTask(task, record.taskId, "Worker finish");
          await requireNoOpenWorkerSubtasks(task, target, outcome ? "complete" : "merge");
          if (!crashSummary && !reportScopeMatchesCurrent(report!, await captureWorkerAssignment(task, target))) throw new Error(`Worker ${params.agent} ready report is stale for the current Task scope; finish made no changes.`);
          if (task.assignee !== params.agent) throw new Error(`Tandem ownership mismatch for ${record.taskId}: expected ${params.agent}, found ${task.assignee ?? "none"}. Finish made no changes.`);
        } else if (!crashSummary && report?.brief !== record.brief) throw new Error("Task-free report differs from the captured brief; finish made no changes.");
      }
    }
    const write = async (next: HcWorkerOutcome) => { await writeHcWorkerOutcome(next); outcome = next; };
    let inboxNote: string | undefined;
    let alreadyMerged = false;
    let checks: "reused" | "rerun" | undefined;
    // A saved receipt covers only the source tip it merged; a later Worker commit is never reported as integrated.
    if (outcome && hasWorktree(record) && await nativeCheckoutPresent(target, integration.source, false)) {
      const liveTip = await nativeHead(integration.source.checkoutPath, "Worker source");
      if (liveTip !== outcome.sourceTip) throw new Error(`Worker ${params.agent} saved receipt integrated source ${outcome.sourceTip}, but its checkout is now at ${liveTip}; finish refuses to report the later commit as integrated. Review it and integrate it separately.`);
    }
    if (!outcome) {
      await validateCapturedCheckout(integration.source, integration.repoKey, "Worker source");
      await requireCleanCheckout(integration.source.checkoutPath, "Worker source");
      const reportedHead = report?.source?.head;
      if (!crashSummary && reportedHead) {
        const liveHead = await nativeHead(integration.source.checkoutPath, "Worker source");
        if (liveHead !== reportedHead) throw new Error(`Worker ${params.agent} ready report was made at ${reportedHead}, but its checkout is now at ${liveHead}; finish refuses to merge a commit made after the report. Have the Worker report again. Finish made no changes.`);
      }
      // Checks that passed at worker_report on this exact HEAD (the scope check above proved the
      // same validations) are not run again; any other HEAD, or a recorded failure, reruns them.
      const recorded = report?.checks;
      if (!crashSummary && recorded && checksPassed(recorded) && recorded.head === await nativeHead(integration.source.checkoutPath, "Worker source")) checks = "reused";
      else {
        checks = "rerun";
        const runnable = record.taskId ? await runRunnableValidations(record.taskId, target, integration.source.checkoutPath, checkInNotifier(ctx), signal) : await taskFreeChecks(record, checkInNotifier(ctx), signal);
        const failed = runnable.results.find((result) => result.exitCode !== 0);
        if (failed) throw new Error(`Runnable validation failed before Worker finish merge: ${failed.command} (exit code ${failed.exitCode}). Not run: ${runnable.notRun.join("; ") || "none"}.\nOutput tail:\n${failed.outputTail || "(no output)"}`);
      }
      const before = hasWorktree(record) ? await nativeHead(target, "Integration target") : integration.baseHead!;
      let result: string;
      let tips = await sourceAlreadyIntegrated(integration);
      if (!hasWorktree(record)) {
        alreadyMerged = true;
        tips = { sourceTip: await nativeHead(target, "Shared checkout"), targetTip: await nativeHead(target, "Shared checkout") };
        result = "worktree:false: commit already on target; no merge";
      } else if (tips) { alreadyMerged = true; result = JSON.stringify({ alreadyMerged: true, ...tips }); }
      else {
        try {
          result = await withCheckIn(checkInNotifier(ctx), `Worktrunk merge of ${integration.source.branch} into ${integration.target.branch}`, () =>
            command("wt", ["-C", integration.source.checkoutPath, "merge", integration.target.branch, "--no-remove", "--format", "json"], undefined, 0));
        } catch (error) {
          throw new Error(`Worktrunk refused the finish merge from ${integration.source.branch} to ${integration.target.branch}. ${diagnosticText(error)} Both checkouts are preserved.`);
        }
        tips = { sourceTip: await nativeHead(integration.source.checkoutPath, "Worker source"), targetTip: await nativeHead(target, "Integration target") };
      }
      try {
        await write({ version: 2, disposition: "integrated", deliveryId: record.deliveryId, taskId: record.taskId, ownerSessionId: record.ownerSessionId,
          owner: record.owner, childAgent: record.childAgent, label: record.label, from: record.from, inboxThreadId: record.from ?? record.noticeId, mergeRange: `${before}..${tips.targetTip}`, revert: `git -C ${JSON.stringify(target)} revert --no-edit ${before}..${tips.targetTip}`, integration, mergedAt: Date.now(), ...tips, ...(result.trim() ? { worktrunkResult: result.trim().slice(0, 4_000) } : {}) });
      } catch (error) {
        throw new Error(`Worktrunk merged ${integration.source.branch} into ${integration.target.branch}, but finish could not save its receipt. Do not retry the merge. ${diagnosticText(error)}`);
      }
    }
    // A manus has no typed report: its accepted outcome is the integration plus the files it changed.
    const manusAccepted = manus ? await manusAcceptance(record, outcome!) : undefined;
    const step = async (failure: string, run: () => Promise<void>) => {
      try { await run(); }
      catch (error) {
        await writeHcWorkerOutcome({ ...outcome!, finishDiagnostic: diagnosticText(error) }).catch(() => {});
        throw new Error(`${failure} Do not retry the merge; retry worker_finish to resume only unfinished steps. ${diagnosticText(error)}`);
      }
    };
    if (!record.taskId && !outcome!.acceptedAt) {
      if (manus && manusAccepted) await write({ ...outcome!, acceptedAt: Date.now(), finalSummary: manusAccepted.summary,
        finalEvidence: manusAccepted.evidence.map(({ criterion, observation }) => `${criterion}: ${observation}`), finalFilesChanged: manusAccepted.files });
      else await write({ ...outcome!, acceptedAt: Date.now(), finalSummary: crashSummary ?? report!.summary, finalEvidence: report?.evidence.map(({ criterion, observation }) => `${criterion}: ${observation}`), finalFilesChanged: report?.files });
    }
    const taskId = record.taskId;
    if (taskId) await step(`${kindName} ${taskId} integrated, but the accepted Tandem outcome is incomplete.`, async () => {
      // A ready report was delivered to Tandem when it was handed back, so accepting it is one
      // write (`tandem complete`); only a crashSummary or a reworked Task still delivers here.
      let shown: any;
      if (!outcome!.acceptedAt) {
        shown = await tandemShow(taskId, target);
        if (shown.accord?.status !== "delivered") {
          await deliverReport(taskId, target, manusAccepted ?? (crashSummary
            ? { summary: crashSummary, evidence: [{ criterion: "Owner verification", observation: `the ${kindName} invocation ended without a typed ready report; the owner verified the surviving checkout and finished it.` }], files: [] }
            : report!));
          shown = await tandemShow(taskId, target);
        }
        if (shown.accord?.status !== "delivered") throw new Error(`Tandem Task ${taskId} has no current delivered outcome to accept.`);
        await write({ ...outcome!, acceptedAt: Date.now(), finalSummary: shown.accord.summary, finalEvidence: shown.accord.evidence, finalFilesChanged: shown.accord.filesChanged, finishDiagnostic: undefined });
      }
      if (!outcome!.taskCompletedAt) {
        const task = shown ?? await tandemShow(taskId, target);
        if (task.location === "logs") {
          // Archived: proven only as this finish's own completion (intent stamped first) that Tandem
          // records as a completed outcome for this Worker. Never inferred from absence on the board.
          if (outcome!.taskCompletionRequestedAt === undefined || task.resolution?.outcome !== "completed" || (!manus && task.assignee !== params.agent)) {
            throw new Error(`Task ${taskId} is archived (outcome ${task.resolution?.outcome ?? "unknown"}, assignee ${task.assignee ?? "none"}) without a completion this finish requested; it records no completion.`);
          }
        } else {
          await requireNoOpenWorkerSubtasks(task, target, "complete");
          await write({ ...outcome!, taskCompletionRequestedAt: Date.now() });
          await command("tandem", ["complete", taskId, "--note", `Merged by worker_finish: ${integration.source.branch} → ${integration.target.branch} at ${outcome!.targetTip}.`, "--json"], target);
          inboxNote = await closeTaskRequests({ project: basename(dirname(integration.repoKey)), id: taskId }, "completed");
        }
        // Completion changes no count: the record read before it gives the same metrics.
        await write({ ...outcome!, taskCompletedAt: Date.now(), completionMetrics: tandemTaskMetrics(task, taskId, Date.now()), finishDiagnostic: undefined });
      }
    });
    await step(`${kindName} ${workerName(record)} has an accepted outcome, but its captured terminal could not be closed.`, async () => {
      if (outcome!.presentationClosedAt) return;
      const open = await liveChild(worker);
      if (open) await stopInvocation(open);
      await write({ ...outcome!, presentationClosedAt: Date.now(), finishDiagnostic: undefined });
    });
    await step(`${kindName} ${workerName(record)} has an accepted outcome, but Worktrunk removal of ${integration.source.branch} is incomplete.`, async () => {
      if (outcome!.removalCompletedAt) return;
      if (!hasWorktree(record)) {
        await write({ ...outcome!, removalResult: "worktree:false: shared checkout and branch retained; no removal", removalCompletedAt: Date.now(), finishDiagnostic: undefined });
        return;
      }
      if (!await nativeCheckoutPresent(target, integration.source, false)) {
        // Observed gone from Git and disk: proven as this finish's own removal only when it stamped the request first.
        if (outcome!.removalRequestedAt === undefined) throw new Error(`Captured checkout ${integration.source.checkoutPath} is already gone, but this finish never requested its removal; it records no removal.`);
        await write({ ...outcome!, removalResult: "Requested Worktrunk removal observed complete: the captured checkout is no longer registered with Git or present on disk.", removalCompletedAt: Date.now(), finishDiagnostic: undefined });
        return;
      }
      await write({ ...outcome!, removalRequestedAt: outcome!.removalRequestedAt ?? Date.now() });
      const removal = validateNativeRemovalResult(await removeNativeWorkerCheckout({ cwd: target }, integration.source.branch, checkInNotifier(ctx)), integration);
      await write({ ...outcome!, removalResult: removal || undefined, removalCompletedAt: Date.now(), finishDiagnostic: undefined });
    });
    const metrics = outcome!.completionMetrics;
    const route = `${integration.source.branch} → ${integration.target.branch}`;
    const summary = manus
      ? !hasWorktree(record)
        ? `Finished manus ${workerName(record)}: accepted its committed work on the shared checkout; closed only its captured terminal. No merge or removal.`
        : finishedEarlier
          ? `Manus ${workerName(record)} was already finished: its saved receipt records the integration of ${route}, the closed terminal and the removed checkout. This call made no new change.`
          : outcomes.length > 0
            ? `Finished manus ${workerName(record)}: resumed its saved receipt (${route} was already integrated; no new merge) and completed only the unfinished steps.`
            : `Finished manus ${workerName(record)}: integrated ${route}, recorded the accepted outcome, closed its terminal and removed its captured checkout.`
      : !hasWorktree(record)
      ? `Finished Worker ${workerName(record)}: accepted committed work; closed only its captured child. Shared checkout retained; no merge or removal.`
      : !record.taskId
      ? `Finished Worker ${workerName(record)}: ${finishedEarlier ? "already finished; saved receipt reused, no new changes" : "integrated, accepted in git/inbox, closed child and removed captured worktree"}; no Tandem writes.`
      : finishedEarlier
      ? `Worker ${record.taskId} was already finished: its saved receipt records the integration of ${route}, the accepted Tandem outcome, the closed terminal and the removed checkout. This call made no new merge, Tandem, terminal or checkout change.`
      : outcomes.length > 0
        ? `Finished Worker ${record.taskId}: resumed its saved receipt (${route} was already integrated; no new merge) and completed only the unfinished steps; the accepted Tandem outcome, closed terminal and removed checkout are now recorded.`
        : alreadyMerged
          ? `Finished Worker ${record.taskId}: ${route} was already merged in Git (no new merge); recorded its receipt and the accepted Tandem outcome, closed its terminal, and removed its captured checkout.`
          : `Finished Worker ${record.taskId}: integrated ${route}, recorded the accepted Tandem outcome, closed its terminal, and removed its captured checkout.`;
    const checked = manus ? "" : checks === "reused" ? " Checks passed at worker_report on this HEAD; not rerun." : checks === "rerun" ? " Checks rerun and passed." : "";
    return text(`${summary}${checked}${metrics ? ` ${metrics.attemptCount} attempt(s), ${metrics.reworkCount} rework(s), ${metrics.elapsedMs} ms.` : ""}${inboxNote ? ` ${inboxNote}` : ""}`,
      { agent: params.agent, kind: record.kind ?? "worker", taskId: record.taskId, deliveryId: record.deliveryId, source: integration.source, target: integration.target, accepted: true, merged: true, ...(checks && !manus ? { checks } : {}),
        alreadyIntegrated: outcomes.length > 0 || alreadyMerged, presentationClosed: true, removed: hasWorktree(record), checkoutRetained: !hasWorktree(record), worktree: hasWorktree(record), needsAlgorant: record.needsAlgorant ?? false, ...(crashSummary ? { deadRuntime: true } : {}), integrationOutcome: outcome, host: "hc", state: "closed" });
  }

  async function discardWorker(params: { agent: string; note: string }, ctx: ExtensionContext) {
    const { owner, worker } = await ownedWorker(params.agent, ctx);
    const current = worker.record;
    const manus = isManusRecord(current);
    const kindName = manus ? "manus" : "Worker";
    const note = params.note.trim();
    const chainIds = new Set((await workerChain(params.agent, owner.core)).map((entry) => entry.deliveryId));
    if ((await listHcWorkerOutcomes()).some((outcome) => chainIds.has(outcome.deliveryId))) throw new Error(`${kindName} ${params.agent} has an integrated outcome; finish it instead of discarding integrated work.`);
    const integration = current.integration;
    const base = { host: "hc", agent: params.agent, kind: current.kind ?? "worker", taskId: current.taskId, deliveryId: current.deliveryId, disposition: "discarded", branch: integration.source.branch, worktreePath: integration.source.checkoutPath };
    if (current.state === "discarded") return text(`${kindName} ${params.agent} was already discarded; receipt ${current.deliveryId} made no changes.`, { ...base, state: "closed", removed: hasWorktree(current), branchDeleted: hasWorktree(current), checkoutRetained: !hasWorktree(current), alreadyDiscarded: true });
    await validateCapturedCheckout(integration.target, integration.repoKey, "Captured Worker target");
    if (!current.discardRemovalRequestedAt) await validateCapturedCheckout(integration.source, integration.repoKey, "Worker source");
    const deliveryId = current.deliveryId;
    // Every step re-reads this owner's control record: its stamps are the receipt.
    let record = await updateHcWorkerRecord(deliveryId, (latest) => ({ ...latest, state: "discarding", discardNote: latest.discardNote ?? `discarded: ${note}`, discardDiagnostic: undefined }));
    const save = async (patch: Partial<HcWorkerRecord>) => { record = await updateHcWorkerRecord(deliveryId, (latest) => ({ ...latest, ...patch })); };
    const cwd = integration.target.checkoutPath;
    // A resumed receipt reports steps an earlier attempt finished as such.
    let tandemOutcome = record.discardReleasedAt ? "the Tandem discarded disposition was already recorded" : "recorded native Tandem discarded disposition";
    const closedEarlier = Boolean(record.discardPresentationClosedAt);
    let closedTerminal: string | undefined;
    try {
      if (!record.discardPresentationClosedAt) {
        const live = manus ? await liveManus(record) : await liveInvocation({ ...worker, record });
        if (live) {
          if (runtimeState(live) === "working") { await hcText(["interrupt", live.address]); await waitSettled(live.address); }
          await stopInvocation(live);
          closedTerminal = live.address;
        }
        await save({ discardPresentationClosedAt: Date.now() });
      }
      if (!record.taskId) tandemOutcome = "recorded disposition in the existing receipt; no Tandem writes";
      if (!record.discardReleasedAt && record.taskId) {
        const task = await tandemShow(record.taskId, cwd);
        const discardedCount = Number.isSafeInteger(task.discardedCount) ? task.discardedCount : 0;
        // A manus claims as pi:<name>; it may also have left the Task with its starter.
        const ours = task.assignee === params.agent || (manus && task.assignee === `pi:${params.agent}`);
        if (task.location === "logs") tandemOutcome = `left Tandem unchanged because ${record.taskId} is already archived`;
        else if (ours) {
          await save({ discardReleaseRequestedAt: record.discardReleaseRequestedAt ?? Date.now(), discardedCountBefore: record.discardedCountBefore ?? discardedCount });
          await command("tandem", ["accord", "release", record.taskId, "--note", record.discardNote!, "--disposition", "discarded", "--json"], cwd);
        } else if (manus) tandemOutcome = `left Tandem unchanged because ${record.taskId} is assigned to ${task.assignee ?? "none"}, not this manus`;
        else if (record.discardReleaseRequestedAt === undefined || record.discardedCountBefore === undefined || discardedCount <= record.discardedCountBefore) {
          // Unassigned without a discard this receipt requested and Tandem counted: not proven ours.
          throw new Error(`Task ${record.taskId} is no longer assigned to ${params.agent} (now ${task.assignee ?? "none"}, discardedCount ${discardedCount}), and this discard did not record that release; it records no disposition.`);
        } else tandemOutcome = "observed the native Tandem discarded disposition this discard requested";
        await save({ discardReleasedAt: Date.now() });
      }
      if (!record.discardRemovalCompletedAt && !hasWorktree(record)) await save({ discardRemovalResult: "Shared checkout retained; no merge, branch deletion or removal", discardRemovalCompletedAt: Date.now() });
      if (!record.discardRemovalCompletedAt) {
        if (!await nativeCheckoutPresent(cwd, integration.source, true)) {
          if (record.discardRemovalRequestedAt === undefined) throw new Error(`Captured checkout ${integration.source.checkoutPath} and branch ${integration.source.branch} are already gone, but this discard never requested their removal; it records no removal.`);
          await save({ discardRemovalResult: "Requested Worktrunk removal observed complete: the captured checkout and branch no longer exist.", discardRemovalCompletedAt: Date.now() });
        } else {
          await save({ discardRemovalRequestedAt: record.discardRemovalRequestedAt ?? Date.now() });
          const removal = validateNativeRemovalResult(await removeNativeWorkerCheckout({ cwd }, integration.source.branch, checkInNotifier(ctx), true), integration);
          await save({ discardRemovalResult: removal || undefined, discardRemovalCompletedAt: Date.now() });
        }
      }
      await save({ state: "discarded" });
    } catch (error) {
      await updateHcWorkerRecord(deliveryId, (latest) => ({ ...latest, discardDiagnostic: diagnosticText(error) })).catch(() => {});
      throw new Error(`${kindName} ${record.taskId} discard receipt ${deliveryId} was preserved; retry resumes only unfinished steps. ${diagnosticText(error)}`);
    }
    return text(`Discarded ${kindName} ${workerName(record)}: ${tandemOutcome}, ${closedTerminal ? `closed its terminal ${closedTerminal}` : closedEarlier ? "its invocation was already closed" : "no invocation was running"}, and ${hasWorktree(record) ? `removed captured checkout ${integration.source.branch} through Worktrunk` : "retained shared checkout/branch and changes (no removal)"}.`,
      { ...base, state: "closed", terminal: closedTerminal, removed: hasWorktree(record), branchDeleted: hasWorktree(record), checkoutRetained: !hasWorktree(record), worktree: hasWorktree(record), presentationClosed: true, integration });
  }

  /**
   * Auto-finish (Algorant, herdra task-68): when this owner's inbox receives its own Worker's
   * ready notice for a small Task not tagged `review` (task-581) whose diff stays inside relatedFiles
   * and whose recorded checks passed at the current HEAD, the owner Pi finishes it here, without a model call, and delivers
   * a result notice naming the merge and how to revert it. Anything else keeps the normal review
   * notice with the reason added; nothing is merged.
   */
  async function readyNotice(env: Envelope, ctx: ExtensionContext): Promise<Envelope | undefined> {
    const match = env.kind === "result" && !workerMode ? READY_HEADLINE.exec(headlineOf(env.body)) : null;
    if (!match) return undefined;
    const agent = match[1]!;
    let outcome: { reason: string } | { finished: Result; before: string; review: string; target: string; branch: string };
    try {
      outcome = await withHcWorkerLifecycle(agent, async () => {
        const { worker } = await ownedWorker(agent, ctx);
        const { record, handoff } = worker;
        const report = handoff?.report;
        if (report?.status !== "ready" || report.deliveryId !== record.invocationId) return { reason: "the notice is not this Worker's current ready report" };
        if (env.from.core !== record.owner.core || env.from.terminal !== (worker.started?.child.terminal ?? record.child?.terminal)) return { reason: "the notice did not come from this Worker's own terminal" };
        // The owner observes the existing inbox thread; no new result store or Worker-side control write.
        await updateHcWorkerRecord(record.deliveryId, (current) => current.noticeId ? current : { ...current, noticeId: env.id });
        const { source, target } = record.integration;
        if (record.needsAlgorant) return { reason: "needsAlgorant:true: Algorant must see or judge the result" };
        const task = record.taskId ? await tandemShow(record.taskId, target.checkoutPath) : undefined;
        if (task && !WORKER_LIGHT_EFFORTS.has(task.effort)) return { reason: `effort is ${task.effort ?? "unset"}, not small` };
        if (task && taskPlanRequired(task)) return { reason: "the Task requires plan review" };
        if (Array.isArray(task?.tags) && task.tags.includes("review")) return { reason: "the Task is tagged `review`: Algorant must see or judge the result" };
        if (report.blockers.length) return { reason: "the report lists blockers" };
        const checks = report.checks;
        if (!checks?.results.length) return { reason: "no runnable checks were recorded" };
        const failed = checks.results.find((result) => result.exitCode !== 0);
        if (failed || !checksPassed(checks)) return { reason: failed ? `check failed: \`${failed.command}\` exit ${failed.exitCode}` : `checks not run: ${checks.notRun.join("; ")}` };
        const head = await nativeHead(source.checkoutPath, "Worker source");
        if (checks.head !== head) return { reason: `the Worker checkout moved from the checked ${checks.head.slice(0, 12)} to ${head.slice(0, 12)}` };
        const diff = await workerDiff(source.checkoutPath, workerBase(record), head);
        const related: string[] = task ? (Array.isArray(task.relatedFiles) ? task.relatedFiles : []) : briefContract(record.brief!).scope;
        const outside = diff.files.filter((file) => !related.some((entry) => entry === file || (entry.endsWith("/") && file.startsWith(entry))));
        if (!diff.files.length) return { reason: "the diff is empty" };
        if (outside.length) return { reason: `files outside ${task ? "relatedFiles" : "brief Scope"}: ${outside.join(", ")}` };
        if ((await command("git", ["status", "--porcelain"], target.checkoutPath)).trim()) return { reason: `the target checkout ${target.checkoutPath} has uncommitted changes` };
        const before = await nativeHead(target.checkoutPath, "Integration target");
        const review = `${formatWorkerReport(report)}\n${formatWorkerDiff(diff)}`;
        try {
          return { finished: await finishWorker({ agent }, undefined, ctx), before, review, target: target.checkoutPath, branch: target.branch };
        } catch (error) {
          return { reason: `worker_finish stopped: ${diagnosticText(error)}` };
        }
      });
    } catch (error) {
      outcome = { reason: diagnosticText(error) };
    }
    if ("reason" in outcome) {
      return { ...env, body: `${env.body}\nAuto-finish not applied: ${outcome.reason}. Review it as usual.` };
    }
    const after: string = outcome.finished.details.integrationOutcome.targetTip;
    const receipt = outcome.finished.details.integrationOutcome as HcWorkerOutcome;
    const headline = `Worker auto-finished: ${(receipt.label ?? agent).slice(0, 50)}${receipt.taskId ? ` [${receipt.taskId}]` : ""} (${agent}) at ${after.slice(0, 12)}`;
    return { ...env, body: [headline,
      (outcome.finished.content[0] as { text: string }).text,
      `${receipt.integration.worktree === false ? "Accepted on shared checkout (no merge)" : "Merged"} into ${outcome.branch} in ${outcome.target}: ${receipt.mergeRange ?? `${outcome.before}..${after}`}.`,
      `Revert: ${receipt.revert ?? `git -C ${outcome.target} revert --no-edit ${outcome.before}..${after}`}`,
      "Auto-finished: small work, needsAlgorant:false, diff inside declared scope and checks passed at this HEAD; no owner call needed.",
      outcome.review].join("\n") };
  }

  /** Each result names its Worker by its whois label (from the Worker's record) for the card. */
  const labelled = (tool: any) => ({
    ...tool,
    async execute(id: string, params: any, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionContext) {
      if (!workerMode && typeof params?.agent === "string") {
        const record = await currentRecord(params.agent, await coreId());
        params = { ...params, agent: record.childAgent };
      }
      const result = await tool.execute(id, params, signal, update, ctx);
      const agent = result?.details?.agent ?? params?.agent ?? (workerMode ? run?.record.childAgent : undefined);
      const label = typeof agent === "string" ? workerLabel(agent) : undefined;
      const record = typeof agent === "string" ? await currentRecord(agent, await coreId()) : undefined;
      return result?.details && typeof result.details === "object" ? { ...result, details: { ...result.details, ...(label ? { label } : {}), ...(record ? { needsAlgorant: record.needsAlgorant ?? false, worktree: hasWorktree(record) } : {}) } } : result;
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    workerMode = pi.getFlag(WORKER_CONTEXT_FLAG) === true;
    contextFailure = undefined;
    questionAsked = false;
    run = undefined;
    // Read-only profile children never own Workers.
    if (!workerMode && hcProfileRequested()) return;
    for (const tool of workerMode ? [askTool, reportTool, progressTool] : ownerTools) pi.registerTool(labelled(tool) as any);
  });
  return { startWorker, readyNotice };
}
