import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { newId } from "../state.ts";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  type WorkerAssignment, type WorkerCompletionMetrics, type WorkerQuestion, type WorkerReport,
  validateWorkerAssignment, validateWorkerQuestion, validateWorkerReport,
  handoffRecordDirectory, integrationOutcomeDirectory, recordPath, writeWorkerRecordJson,
} from "./handoff-record.ts";

/**
 * Native Worker records in the existing handoff store, one writer per file:
 *
 * - `handoff-hc-<uuid>.json`: an owner CONTROL record, written only by the owning Pi
 *   (start, continuation, recovery each create a new one). It references the Worker
 *   invocation it directs by `invocationId` and never holds what the Worker produced.
 * - `invocation-hc-<uuid>.started.json`: the Worker's start acknowledgement, created once.
 * - `invocation-hc-<uuid>.json`: the Worker's typed handoff (question, report or
 *   failure), created once and never rewritten.
 *
 * The invocation id is the native terminal's `pi.worker.invocation` label. Owner
 * recovery creates a successor control record for the SAME invocation, so a
 * late handoff lands where every owner of that invocation reads it.
 */
export type HcWorkerEndpoint = { core: string; terminal: string };
export type HcWorkerCheckout = { checkoutPath: string; branch: string };
export type HcWorkerIntegration = { repoKey: string; source: HcWorkerCheckout; target: HcWorkerCheckout; worktree?: boolean; baseHead?: string };
/** The exact owner direction an invocation carries. `ofDeliveryId` is the control
 * record whose invocation handoff (report/question) it answers. Whether it reached
 * the Worker is the Worker's own start acknowledgement, not a field here. */
export type HcWorkerDirection = { request: string; ofDeliveryId: string; questionId?: string; approve?: true };
export type HcWorkerControlState = "pending" | "failed" | "paused" | "discarding" | "discarded";
export type HcWorkerBenchmarkSelection = {
  requestedModel: "openai-codex/gpt-6-luna" | "anthropic/claude-sonnet-5-5";
  selectedModel: "openai-codex/gpt-6-luna" | "anthropic/claude-sonnet-5-5";
  providerExemption: "approved-benchmark-provider-exception";
  providerExemptionModel: "openai-codex/gpt-6-luna" | "anthropic/claude-sonnet-5-5";
  fast: boolean;
  quota: string;
  quotaCheckedAt: number;
};

/** Owner-only control record. Captured workflow facts, never a mirror of live HC
 * status and never a copy of the Worker's handoff. One record kind covers both a
 * Worker and a manus: same shape and same completeness, without the Worker-only
 * delivery cycle (direction, plan approval, rework stamps). */
export type HcWorkerRecord = {
  version: 8;
  /** "manus" for a manus's own record; absent on every Worker record (never migrated). */
  kind?: "manus";
  deliveryId: string;
  recoveryOfDeliveryId?: string;
  taskId?: string;
  brief?: string;
  needsAlgorant?: boolean;
  from?: string;
  ownerSessionId: string;
  childAgent: string;
  /** The Worker's label (whois): what its start named it; its slug is childAgent and its branch. */
  label?: string;
  createdAt: number;
  updatedAt: number;
  diagnostic?: string;
  /** Set when the orchestrator explicitly approves a plan (worker_feedback approve:true); a new plan report clears it. */
  planAcceptedAt?: number;
  /** Intent precedes native mutation; an interrupted intent must never be replayed blindly. */
  accordReworkRequestedAt?: number;
  /** Post-delivery feedback records exactly one native Accord rework. */
  accordReworkRecordedAt?: number;
  /** Discard receipts retry only the unfinished presentation/removal steps. */
  discardNote?: string;
  discardReleasedAt?: number;
  discardPresentationClosedAt?: number;
  discardRemovalResult?: string;
  discardRemovalCompletedAt?: number;
  discardDiagnostic?: string;
  /** The Worker invocation this record directs; stable across owner recovery. A
   * manus record carries one too (its identity), though no typed invocation uses it. */
  invocationId: string;
  owner: HcWorkerEndpoint;
  /** The owner's own observation of the terminal its launch returned. */
  child?: HcWorkerEndpoint;
  /** Parent-chosen Pi session ID, reused by every invocation of this Worker. A manus
   * record carries the session ID its one Pi was launched with. */
  childSessionId: string;
  /** Captured `provider/model:thinking` for every invocation of this Worker; a manus
   * records MANUS_MODEL because it runs Pi's own default. */
  model: string;
  /** Present only for explicitly selected, approved benchmark Worker launches. */
  benchmark?: HcWorkerBenchmarkSelection;
  integration: HcWorkerIntegration;
  assignment?: WorkerAssignment;
  planRequired: boolean;
  state: HcWorkerControlState;
  direction?: HcWorkerDirection;
  /** Existing inbox handoff thread observed by the owner; retained through recovery. */
  noticeId?: string;
  /** Set when this owner read the invocation\'s ready report through worker_handoff. */
  handoffReadAt?: number;
  /** Discard intent stamps: a retry proves a step from them plus observed Tandem/Worktrunk state. */
  discardReleaseRequestedAt?: number;
  discardedCountBefore?: number;
  discardRemovalRequestedAt?: number;
};

/** Worker-owned, immutable: this invocation actually started a run under its direction. */
export type HcWorkerStart = {
  version: 1; invocationId: string; childAgent: string; childSessionId: string;
  child: HcWorkerEndpoint; sessionPath: string; startedAt: number;
};
/** Worker-owned, immutable: the one outcome this invocation handed back. */
export type HcWorkerHandoff = {
  version: 1; invocationId: string; taskId?: string; childAgent: string; childSessionId: string;
  child: HcWorkerEndpoint; sessionPath: string; publishedAt: number;
  question?: WorkerQuestion; report?: WorkerReport; diagnostic?: string;
};

export type HcWorkerOutcome = {
  version: 2;
  disposition: "integrated";
  deliveryId: string;
  taskId?: string;
  label?: string;
  from?: string;
  mergeRange?: string;
  revert?: string;
  inboxThreadId?: string;
  ownerSessionId: string;
  childAgent: string;
  owner: HcWorkerEndpoint;
  integration: HcWorkerIntegration;
  mergedAt: number;
  sourceTip?: string;
  targetTip?: string;
  worktrunkResult?: string;
  /** Set only after the owner records the accepted Tandem outcome. */
  acceptedAt?: number;
  taskCompletedAt?: number;
  /** Discrete completion snapshot: attempt/rework/discard counts and total time. */
  completionMetrics?: WorkerCompletionMetrics;
  finalSummary?: string;
  finalEvidence?: string[];
  finalFilesChanged?: string[];
  /** Finish receipts make later calls retry only presentation/removal steps. */
  presentationClosedAt?: number;
  removalResult?: string;
  removalCompletedAt?: number;
  finishDiagnostic?: string;
  /** Finish intent stamps: a retry proves a step from them plus observed Tandem/Worktrunk state. */
  taskCompletionRequestedAt?: number;
  removalRequestedAt?: number;
};

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid native Worker ${label}.`);
}
function time(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid native Worker ${label}.`);
}
function endpoint(value: HcWorkerEndpoint, label: string): void {
  if (!value || typeof value !== "object") throw new Error(`Missing native Worker ${label}.`);
  text(value.core, `${label} core`); text(value.terminal, `${label} terminal`);
}
function invocation(value: unknown): void {
  text(value, "invocation ID");
  if (!/^invocation-hc-[0-9a-f-]{36}$/.test(value)) throw new Error("Native Worker invocation must use its protocol-owned ID.");
}
function integration(value: HcWorkerIntegration): void {
  if (!value || typeof value !== "object") throw new Error("Missing native Worker integration capture.");
  text(value.repoKey, "repository");
  if (value.worktree !== undefined && typeof value.worktree !== "boolean") throw new Error("Invalid native Worker isolation mode.");
  if (value.baseHead !== undefined && !/^[0-9a-f]{7,64}$/i.test(value.baseHead)) throw new Error("Invalid native Worker captured base HEAD.");
  if (value.worktree === false && (!value.baseHead || value.source.checkoutPath !== value.target.checkoutPath || value.source.branch !== value.target.branch)) throw new Error("Shared Worker source and target must be the same captured checkout and branch, with a base HEAD.");
  for (const key of ["source", "target"] as const) {
    const checkout = value[key];
    if (!checkout || !isAbsolute(checkout.checkoutPath)) throw new Error(`Missing native Worker ${key} checkout.`);
    text(checkout.checkoutPath, `${key} path`); text(checkout.branch, `${key} branch`);
  }
}
function identity(value: HcWorkerRecord | HcWorkerOutcome): void {
  text(value.deliveryId, "delivery ID"); text(value.ownerSessionId, "owner session"); text(value.childAgent, "agent");
  if (!value.deliveryId.startsWith("handoff-hc-")) throw new Error("Native Worker delivery must use its actual protocol-owned ID.");
  if (value.taskId !== undefined && !/^task-[0-9]+(?:-[0-9]+)?$/.test(value.taskId)) throw new Error("Invalid native Worker Task ID.");
  endpoint(value.owner, "owner"); integration(value.integration);
}
/** What the Worker produced lives only in its invocation files. */
const PRODUCER_FIELDS = ["report", "question", "handoff", "childSessionPath"];

/** True for a manus's own record; a Worker record never carries a kind. */
export const isManusRecord = (record: Pick<HcWorkerRecord, "kind">): boolean => record.kind === "manus";

export function validateHcWorkerRecord(value: unknown): HcWorkerRecord {
  if (!value || typeof value !== "object" || (value as HcWorkerRecord).version !== 8) throw new Error("Expected native Worker control record version8.");
  const record = value as HcWorkerRecord;
  identity(record);
  invocation(record.invocationId);
  if (PRODUCER_FIELDS.some((key) => key in record)) throw new Error(`Native Worker control ${record.deliveryId} cannot hold Worker-produced handoff data.`);
  if (record.kind !== undefined && !isManusRecord(record)) throw new Error(`Native control ${record.deliveryId} has an unknown kind; only "manus" is written (a Worker record has none).`);
  if (record.child) endpoint(record.child, "child");
  if (record.label !== undefined) text(record.label, "label");
  if (!["pending", "failed", "paused", "discarding", "discarded"].includes(record.state)) throw new Error("Invalid native Worker control state.");
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt) || record.updatedAt < record.createdAt) throw new Error("Invalid native Worker timestamps.");
  // Every record, either kind, is complete: a half-written one is refused at write time
  // instead of being unreadable to every reader later.
  text(record.childSessionId, "session ID");
  text(record.model, "model");
  if (record.benchmark !== undefined) {
    const benchmark = record.benchmark;
    const contenders = ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5-5"];
    if (isManusRecord(record) || !benchmark || !contenders.includes(benchmark.requestedModel) ||
        benchmark.selectedModel !== benchmark.requestedModel || benchmark.providerExemption !== "approved-benchmark-provider-exception" || benchmark.providerExemptionModel !== benchmark.selectedModel ||
        typeof benchmark.quotaCheckedAt !== "number" || !Number.isFinite(benchmark.quotaCheckedAt) || benchmark.quotaCheckedAt < 0 ||
        record.model !== `${benchmark.selectedModel}:high` || benchmark.fast !== (benchmark.selectedModel === "openai-codex/gpt-6-luna") ||
        typeof benchmark.quota !== "string" || !benchmark.quota.trim()) {
      throw new Error("Invalid native Worker benchmark selection or provider exemption.");
    }
  }
  if (typeof record.planRequired !== "boolean") throw new Error("Invalid native plan policy.");
  if (record.taskId) {
    record.assignment = validateWorkerAssignment(record.assignment);
    if (record.assignment.root.id !== record.taskId || record.brief !== undefined) throw new Error("Native assignment differs from captured Task.");
  } else if (record.assignment !== undefined || typeof record.brief !== "string" || !record.brief.trim() || !record.label || typeof record.needsAlgorant !== "boolean") {
    throw new Error("Task-free work requires a label, brief and needsAlgorant, not a fabricated Task assignment.");
  }
  if (isManusRecord(record)) {
    // A manus has no Worker delivery cycle: no direction, plan approval or rework receipts.
    const workerOnly = ["direction", "planAcceptedAt", "accordReworkRequestedAt", "accordReworkRecordedAt"] as const;
    const present = workerOnly.filter((key) => record[key] !== undefined);
    if (present.length) throw new Error(`Manus record ${record.deliveryId} cannot hold Worker-only ${present.join(", ")}.`);
    if (!record.label) throw new Error("A manus record requires its label.");
  }
  if (record.needsAlgorant !== undefined && typeof record.needsAlgorant !== "boolean") throw new Error("Invalid native Worker needsAlgorant.");
  if (record.handoffReadAt !== undefined) time(record.handoffReadAt, "handoff read time");
  if (record.direction !== undefined) {
    const direction = record.direction;
    if (!direction || typeof direction.request !== "string" || !direction.request.trim() || typeof direction.ofDeliveryId !== "string" || !direction.ofDeliveryId.startsWith("handoff-hc-") ||
        (direction.questionId !== undefined && typeof direction.questionId !== "string") || (direction.approve !== undefined && direction.approve !== true) ||
        "deliveredAt" in direction) throw new Error("Invalid native Worker direction.");
  }
  return record;
}
function invocationIdentity(value: HcWorkerStart | HcWorkerHandoff): void {
  if (!value || typeof value !== "object" || value.version !== 1) throw new Error("Expected native Worker invocation file version1.");
  invocation(value.invocationId); text(value.childAgent, "agent"); text(value.childSessionId, "session ID");
  endpoint(value.child, "child");
  if (!isAbsolute(value.sessionPath)) throw new Error("Native Worker session must be an absolute path.");
}
export function validateHcWorkerStart(value: unknown): HcWorkerStart {
  const start = value as HcWorkerStart;
  invocationIdentity(start);
  time(start.startedAt, "start time");
  return start;
}
export function validateHcWorkerHandoff(value: unknown): HcWorkerHandoff {
  const handoff = value as HcWorkerHandoff;
  invocationIdentity(handoff);
  time(handoff.publishedAt, "handoff time");
  if (handoff.taskId !== undefined && !/^task-[0-9]+(?:-[0-9]+)?$/.test(handoff.taskId)) throw new Error("Invalid native Worker Task ID.");
  if ([handoff.question, handoff.report, handoff.diagnostic].filter((part) => part !== undefined).length !== 1) throw new Error("A native Worker handoff holds exactly one question, report or failure.");
  if (handoff.question) handoff.question = validateWorkerQuestion(handoff.question);
  if (handoff.report) {
    handoff.report = validateWorkerReport(handoff.report);
    if (handoff.report.taskId !== handoff.taskId || handoff.report.deliveryId !== handoff.invocationId) throw new Error("Native Worker report identity differs from its invocation.");
  }
  if (handoff.diagnostic !== undefined && (typeof handoff.diagnostic !== "string" || !handoff.diagnostic.trim())) throw new Error("Invalid native Worker failure diagnostic.");
  return handoff;
}
export function validateHcWorkerOutcome(value: unknown): HcWorkerOutcome {
  if (!value || typeof value !== "object" || (value as HcWorkerOutcome).version !== 2) throw new Error("Expected native Worker outcome version2.");
  const outcome = value as HcWorkerOutcome;
  identity(outcome);
  if (outcome.disposition !== "integrated" || !Number.isFinite(outcome.mergedAt)) throw new Error("Invalid native Worker integration receipt.");
  return outcome;
}

export const createHcDeliveryId = () => newId("handoff-hc-");
export const createHcInvocationId = () => newId("invocation-hc-");
export const hcRecordPath = (id: string) => recordPath(handoffRecordDirectory(), id);
export const hcOutcomePath = (id: string) => recordPath(integrationOutcomeDirectory(), id);
const hcStartPath = (invocationId: string) => recordPath(handoffRecordDirectory(), `${invocationId}.started`);
const hcHandoffPath = (invocationId: string) => recordPath(handoffRecordDirectory(), invocationId);

async function readOptional<T>(path: string, validate: (value: unknown) => T): Promise<T | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error: any) { if (error?.code === "ENOENT") return undefined; throw error; }
  return validate(JSON.parse(raw));
}

/** Atomic, exclusive creation: the first writer wins and nothing is ever replaced. */
async function createOnce(path: string, value: unknown): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${newId("", 12)}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await link(temporary, path);
    return true;
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readHcWorkerRecord(id: string): Promise<HcWorkerRecord> {
  return validateHcWorkerRecord(JSON.parse(await readFile(hcRecordPath(id), "utf8")));
}
/** A manus takes Pi's own default model (manus_start passes no --model), so its record
 * states that instead of a captured model role. Nothing reads it as a model choice. */
export const MANUS_MODEL = "pi-default";

/** A new control record; its id is fresh, so an existing file is a protocol error. */
export async function createHcWorkerRecord(record: HcWorkerRecord): Promise<void> {
  let valid: HcWorkerRecord;
  try { valid = validateHcWorkerRecord(record); }
  catch (error) {
    throw new Error(`Refusing to write incomplete native record ${record?.deliveryId ?? "(no delivery id)"}; nothing was written. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!await createOnce(hcRecordPath(record.deliveryId), valid)) throw new Error(`Native Worker control ${record.deliveryId} already exists.`);
}

/** What manus_start knows at start: its label, contract, starter, session and captured checkout. */
export type HcManusRecordParams = {
  label: string;
  taskId?: string;
  brief?: string;
  assignment?: WorkerAssignment;
  needsAlgorant: boolean;
  from?: string;
  ownerSessionId: string;
  owner: HcWorkerEndpoint;
  childAgent: string;
  childSessionId: string;
  integration: HcWorkerIntegration;
};

/** A manus's own control record: written once at start, in the same store, by the
 * same atomic exclusive create as a Worker's, and complete enough that every reader -
 * including a Pi running the previous release - validates it instead of failing the list. */
export async function createHcManusRecord(params: HcManusRecordParams): Promise<HcWorkerRecord> {
  const now = Date.now();
  const record: HcWorkerRecord = {
    version: 8, kind: "manus", deliveryId: createHcDeliveryId(), invocationId: createHcInvocationId(),
    childAgent: params.childAgent, label: params.label, needsAlgorant: params.needsAlgorant,
    childSessionId: params.childSessionId, model: MANUS_MODEL, planRequired: false,
    ...(params.taskId ? { taskId: params.taskId, assignment: params.assignment } : { brief: params.brief }),
    ...(params.from ? { from: params.from } : {}),
    ownerSessionId: params.ownerSessionId, owner: params.owner, createdAt: now, updatedAt: now, state: "pending", integration: params.integration,
  };
  await createHcWorkerRecord(record);
  return record;
}
/** The owning Pi's read-modify-write of its own control record (its only writer);
 * the queue serializes that Pi's parallel tool calls. `change` returns the next
 * record, or the current one unchanged. */
export async function updateHcWorkerRecord(id: string, change: (current: HcWorkerRecord) => HcWorkerRecord | Promise<HcWorkerRecord>): Promise<HcWorkerRecord> {
  const path = hcRecordPath(id);
  return withFileMutationQueue(path, async () => {
    const current = await readHcWorkerRecord(id);
    const next = await change(current);
    if (next === current) return current;
    const valid = validateHcWorkerRecord({ ...next, updatedAt: Math.max(Date.now(), current.updatedAt) });
    await writeWorkerRecordJson(path, valid);
    return valid;
  });
}

export const readHcWorkerStart = (invocationId: string) => readOptional(hcStartPath(invocationId), validateHcWorkerStart);
export const readHcWorkerHandoff = (invocationId: string) => readOptional(hcHandoffPath(invocationId), validateHcWorkerHandoff);
/** The Worker's start acknowledgement; an existing one stays (monotonic). */
export async function acknowledgeHcWorkerStart(start: HcWorkerStart): Promise<HcWorkerStart> {
  await createOnce(hcStartPath(start.invocationId), validateHcWorkerStart(start));
  return (await readHcWorkerStart(start.invocationId))!;
}
/** Publishes the invocation's one handoff. Returns false, writing nothing, when it already has one. */
export async function publishHcWorkerHandoff(handoff: HcWorkerHandoff): Promise<boolean> {
  return createOnce(hcHandoffPath(handoff.invocationId), validateHcWorkerHandoff(handoff));
}

/** Serializes this owner's lifecycle mutations of one Worker (finish, discard,
 * continuation, pause, recovery) so parallel tool calls cannot interleave steps. */
export function withHcWorkerLifecycle<T>(agent: string, run: () => Promise<T>): Promise<T> {
  return withFileMutationQueue(join(handoffRecordDirectory(), `.lifecycle-${agent}`), run);
}
export async function readHcWorkerOutcome(id: string): Promise<HcWorkerOutcome> {
  return validateHcWorkerOutcome(JSON.parse(await readFile(hcOutcomePath(id), "utf8")));
}
export async function writeHcWorkerOutcome(outcome: HcWorkerOutcome): Promise<void> {
  const path = hcOutcomePath(outcome.deliveryId);
  await withFileMutationQueue(path, () => writeWorkerRecordJson(path, validateHcWorkerOutcome(outcome)));
}
async function nativeIds(directory: string): Promise<string[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter(name => /^handoff-hc-.+\.json$/.test(name)).map(name => name.slice(0, -5));
}

/** One bad file must never take the store down: every reader of the list keeps working
 * with the healthy records, and the skipped file is named (task-680: a record written by
 * a newer release made every other session's Worker tools fail as a whole). */
async function listNative<T>(directory: string, validate: (value: unknown) => T): Promise<T[]> {
  const records: T[] = [];
  for (const id of await nativeIds(directory)) {
    try { records.push(validate(JSON.parse(await readFile(recordPath(directory, id), "utf8")))); }
    catch (error) { console.error(`[pi-agency] skipping unreadable native Worker record ${id}.json: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return records;
}
export async function listHcWorkerRecords(): Promise<HcWorkerRecord[]> {
  // Actual protocol-owned control records in the handoff store; an unreadable file is
  // skipped by name, and files from the retired legacy Herdr Worker runtime are ignored.
  return listNative(handoffRecordDirectory(), validateHcWorkerRecord);
}
export async function listHcWorkerOutcomes(): Promise<HcWorkerOutcome[]> {
  return listNative(integrationOutcomeDirectory(), validateHcWorkerOutcome);
}
