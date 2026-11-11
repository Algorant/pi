import { join } from "node:path";
import { stateDir, writeAtomic } from "../state.ts";

export type WorkerReportStatus = "plan" | "ready" | "needs-input";
export type WorkerTaskDefinition = {
  id: string;
  title: string;
  body: string;
  state: string | null;
  priority: string | null;
  blockers: string[];
  relatedFiles: string[];
  references: string[];
  acceptance: string[];
  constraints: string[];
  validations: string[];
};
export type WorkerAssignment = {
  root: WorkerTaskDefinition;
  milestones: WorkerTaskDefinition[];
};
export type WorkerReportEvidence = { criterion: string; observation: string };
export type WorkerRunnableValidationResult = {
  command: string;
  exitCode: number;
  outputTail: string;
};
export type WorkerReportChecklistItem = {
  id: number;
  title: string;
  description: string;
  status: "not-started" | "in-progress" | "waiting" | "completed";
};
export type WorkerReportSource = { checkoutPath: string; branch: string; head: string; statusPorcelain: string };
/** The Task's runnable validations as the runtime ran them for a ready report, against `head`. */
export type WorkerReportChecks = { head: string; results: WorkerRunnableValidationResult[]; notRun: string[] };
export type WorkerReport = {
  version: 1;
  deliveryId: string;
  taskId?: string;
  label?: string;
  needsAlgorant?: boolean;
  brief?: string;
  status: WorkerReportStatus;
  summary: string;
  files: string[];
  validation: string[];
  blockers: string[];
  risks: string[];
  assignment?: WorkerAssignment;
  checklist: WorkerReportChecklistItem[];
  source: WorkerReportSource;
  evidence: WorkerReportEvidence[];
  /** Runtime-recorded, ready reports only. */
  checks?: WorkerReportChecks;
};

const WORKER_REPORT_KEYS = [
  "version", "deliveryId", "taskId", "status", "summary", "files", "validation",
  "blockers", "risks", "assignment", "checklist", "source", "evidence",
] as const;

/** True when every recorded check passed and none was skipped. */
export const checksPassed = (checks: WorkerReportChecks): boolean =>
  checks.notRun.length === 0 && checks.results.every((result) => result.exitCode === 0);

export function formatChecks(checks: WorkerReportChecks | undefined): string {
  if (!checks) return "not recorded";
  if (!checks.results.length) return `none runnable (at ${checks.head.slice(0, 12)})`;
  const runs = checks.results.map((result) => `\`${result.command}\` exit ${result.exitCode}`);
  return `${runs.join("; ")}${checks.notRun.length ? `; not run: ${checks.notRun.join("; ")}` : ""} (at ${checks.head.slice(0, 12)})`;
}

export type WorkerQuestion = { id: string; text: string; askedAt: number };

/** Discrete completion snapshot captured once at Worker finish. */
export type WorkerCompletionMetrics = {
  /** Number of accord.claimed events for the Task at completion. */
  attemptCount: number;
  /** Number of accord.rework events for the Task at completion. */
  reworkCount: number;
  /** Number of discarded dispositions (accord.release disposition=discarded) at completion. */
  discardedCount: number;
  /** Total elapsed milliseconds from Task createdAt to completion. */
  elapsedMs: number;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TASK_ID = /^task-[0-9]+(?:-[0-9]+)?$/;

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid Worker report ${name} keys.`);
  }
}

function reportString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_000 || /\u0000/.test(value)) {
    throw new Error(`Invalid Worker report ${name}.`);
  }
  return value;
}

function reportStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid Worker report ${name}.`);
  return value.map((item, index) => reportString(item, `${name}[${index}]`));
}

function reportTaskDefinition(value: unknown, name: string): WorkerTaskDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Worker report ${name}.`);
  const definition = value as Record<string, unknown>;
  exactKeys(definition, ["id", "title", "body", "state", "priority", "blockers", "relatedFiles", "references", "acceptance", "constraints", "validations"], name);
  if (typeof definition.id !== "string" || !TASK_ID.test(definition.id)) throw new Error(`Invalid Worker report ${name} ID.`);
  if (definition.state !== null && typeof definition.state !== "string") throw new Error(`Invalid Worker report ${name} state.`);
  if (definition.priority !== null && typeof definition.priority !== "string") throw new Error(`Invalid Worker report ${name} priority.`);
  return {
    id: definition.id,
    title: reportString(definition.title, `${name} title`),
    body: typeof definition.body === "string" && definition.body.length <= 16_000 && !/\u0000/.test(definition.body)
      ? definition.body
      : (() => { throw new Error(`Invalid Worker report ${name} body.`); })(),
    state: definition.state,
    priority: definition.priority,
    blockers: reportStringArray(definition.blockers, `${name} blockers`),
    relatedFiles: reportStringArray(definition.relatedFiles, `${name} relatedFiles`),
    references: reportStringArray(definition.references, `${name} references`),
    acceptance: reportStringArray(definition.acceptance, `${name} acceptance`),
    constraints: reportStringArray(definition.constraints, `${name} constraints`),
    validations: reportStringArray(definition.validations, `${name} validations`),
  };
}

export function validateWorkerAssignment(value: unknown): WorkerAssignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Worker report assignment.");
  const assignment = value as Record<string, unknown>;
  exactKeys(assignment, ["root", "milestones"], "assignment");
  if (!Array.isArray(assignment.milestones)) throw new Error("Invalid Worker report assignment milestones.");
  return {
    root: reportTaskDefinition(assignment.root, "assignment root"),
    milestones: assignment.milestones.map((item, index) => reportTaskDefinition(item, `assignment milestone[${index}]`)),
  };
}

function reportSource(value: unknown): WorkerReportSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Worker report source.");
  const source = value as Record<string, unknown>;
  exactKeys(source, ["checkoutPath", "branch", "head", "statusPorcelain"], "source");
  if (typeof source.statusPorcelain !== "string" || /\u0000/.test(source.statusPorcelain)) throw new Error("Invalid Worker report source statusPorcelain.");
  return {
    checkoutPath: requiredAbsolutePath(source.checkoutPath, "report source checkout path"),
    branch: reportString(source.branch, "report source branch"),
    head: reportString(source.head, "source head"),
    statusPorcelain: source.statusPorcelain,
  };
}

function reportChecklist(value: unknown): WorkerReportChecklistItem[] {
  if (!Array.isArray(value)) throw new Error("Invalid Worker report checklist.");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid Worker report checklist[${index}].`);
    const todo = item as Record<string, unknown>;
    exactKeys(todo, ["id", "title", "description", "status"], `checklist[${index}]`);
    if (typeof todo.id !== "number" || !Number.isSafeInteger(todo.id) || todo.id < 1) throw new Error(`Invalid Worker report checklist[${index}] id.`);
    if (todo.status !== "not-started" && todo.status !== "in-progress" && todo.status !== "waiting" && todo.status !== "completed") throw new Error(`Invalid Worker report checklist[${index}] status.`);
    return { id: todo.id, title: reportString(todo.title, `checklist[${index}] title`), description: reportString(todo.description, `checklist[${index}] description`), status: todo.status };
  });
}

function reportChecks(value: unknown): WorkerReportChecks {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Worker report checks.");
  const checks = value as Record<string, unknown>;
  exactKeys(checks, ["head", "results", "notRun"], "checks");
  if (!Array.isArray(checks.results)) throw new Error("Invalid Worker report checks results.");
  return {
    head: reportString(checks.head, "checks head"),
    results: checks.results.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid Worker report checks result[${index}].`);
      const result = item as Record<string, unknown>;
      exactKeys(result, ["command", "exitCode", "outputTail"], `checks result[${index}]`);
      if (!Number.isSafeInteger(result.exitCode) || typeof result.outputTail !== "string") throw new Error(`Invalid Worker report checks result[${index}].`);
      return { command: reportString(result.command, `checks result[${index}] command`), exitCode: result.exitCode as number, outputTail: result.outputTail };
    }),
    notRun: reportStringArray(checks.notRun, "checks notRun"),
  };
}

function reportEvidence(value: unknown): WorkerReportEvidence[] {
  if (!Array.isArray(value)) throw new Error("Invalid Worker report evidence.");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Invalid Worker report evidence[${index}].`);
    const evidence = item as Record<string, unknown>;
    exactKeys(evidence, ["criterion", "observation"], `evidence[${index}]`);
    return { criterion: reportString(evidence.criterion, `evidence[${index}] criterion`), observation: reportString(evidence.observation, `evidence[${index}] observation`) };
  });
}

export function validateWorkerReport(value: unknown): WorkerReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Worker report.");
  const report = value as Record<string, unknown>;
  const optional = ["checks", "label", "needsAlgorant", "brief"].filter((key) => key in report);
  const keys = WORKER_REPORT_KEYS.filter((key) => key !== "taskId" && key !== "assignment" || key in report);
  exactKeys(report, [...keys, ...optional], "object");
  if (report.version !== 1 || typeof report.deliveryId !== "string" || !ID.test(report.deliveryId) || (report.taskId !== undefined && (typeof report.taskId !== "string" || !TASK_ID.test(report.taskId)))) throw new Error("Invalid Worker report identity.");
  if (report.status !== "plan" && report.status !== "ready" && report.status !== "needs-input") throw new Error("Invalid Worker report status.");
  if (report.needsAlgorant !== undefined && typeof report.needsAlgorant !== "boolean") throw new Error("Invalid Worker report needsAlgorant.");
  const assignment = report.taskId === undefined ? undefined : validateWorkerAssignment(report.assignment);
  if (assignment && assignment.root.id !== report.taskId) throw new Error("Worker report assignment does not match task ID.");
  if (!assignment && (report.assignment !== undefined || typeof report.brief !== "string" || !report.brief.trim() || typeof report.label !== "string" || typeof report.needsAlgorant !== "boolean")) throw new Error("Task-free Worker report needs its label, brief and needsAlgorant, not a Task assignment.");
  const source = reportSource(report.source);
  return {
    version: 1,
    deliveryId: report.deliveryId,
    ...(report.taskId === undefined ? {} : { taskId: report.taskId as string }),
    ...(report.label === undefined ? {} : { label: reportString(report.label, "label") }),
    ...(report.brief === undefined ? {} : { brief: reportString(report.brief, "brief") }),
    ...(report.needsAlgorant === undefined ? {} : { needsAlgorant: report.needsAlgorant as boolean }),
    status: report.status,
    summary: reportString(report.summary, "summary"),
    files: reportStringArray(report.files, "files"),
    validation: reportStringArray(report.validation, "validation"),
    blockers: reportStringArray(report.blockers, "blockers"),
    risks: reportStringArray(report.risks, "risks"),
    ...(assignment ? { assignment } : {}),
    checklist: reportChecklist(report.checklist),
    source,
    evidence: reportEvidence(report.evidence),
    ...(report.checks === undefined ? {} : { checks: reportChecks(report.checks) }),
  };
}

export type WorkerTandemCounts = {
  reworkCount: number;
  attemptCount: number;
};

export function formatWorkerReport(report: WorkerReport, counts?: WorkerTandemCounts): string {
  return [
    ...(report.label ? [`WORKER: ${report.label}`] : []),
    ...(report.taskId ? [`TASK: \`${report.taskId}\``] : ["RECORD: git + inbox (Task-free)"]),
    ...(report.needsAlgorant !== undefined ? [`needsAlgorant: ${report.needsAlgorant}`] : []),
    `SUMMARY: ${report.summary}`,
    `FILES: ${report.files.join(", ") || "none"}`,
    `VALIDATION: ${report.validation.join("; ") || "none"}`,
    ...(report.status === "ready" ? [`CHECKS: ${formatChecks(report.checks)}`] : []),
    `COMMIT: ${report.source.head}`,
    `GIT_STATUS: ${report.source.statusPorcelain || "clean"}`,
    `BLOCKERS: ${report.blockers.join("; ") || "none"}`,
    `RISKS: ${report.risks.join("; ") || "none"}`,
    `STATUS: ${report.status}`,
    ...(counts ? [
      `REWORK_COUNT: ${counts.reworkCount}`,
      `ATTEMPT_COUNT: ${counts.attemptCount}`,
      ...(counts.reworkCount >= 2 ? ["REWORK_GUIDANCE: This Task has multiple revisions. Inspect their actual scope and evidence; the aggregate count does not establish repeated failure on one criterion."] : []),
    ] : []),
    "EVIDENCE:",
    ...report.evidence.map((item) => `- ${item.criterion}: ${item.observation}`),
  ].join("\n");
}

export const handoffRecordDirectory = () => stateDir("pi", "worker-handoffs");
export const integrationOutcomeDirectory = () => stateDir("pi", "worker-integration-outcomes");

export function recordPath(directory: string, deliveryId: string): string {
  if (!ID.test(deliveryId)) throw new Error("Invalid Worker handoff delivery ID.");
  return join(directory, `${deliveryId}.json`);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || !ID.test(value)) throw new Error(`Invalid Worker handoff ${name}.`);
  return value;
}

function requiredAbsolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 4_096 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error(`Invalid Worker handoff ${name}.`);
  }
  return value;
}

function finiteOutcomeTime(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid Worker handoff ${name}.`);
  return value;
}

export function validateWorkerQuestion(value: unknown): WorkerQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Worker question.");
  const question = value as Record<string, unknown>;
  exactKeys(question, ["id", "text", "askedAt"], "question");
  const text = reportString(question.text, "question text");
  if (text.length > 4_000) throw new Error("Worker question must be at most 4000 characters.");
  return { id: requiredText(question.id, "question ID"), text, askedAt: finiteOutcomeTime(question.askedAt, "question timestamp") };
}

/** One atomic, private writer for native Worker control records and receipts. */
export async function writeWorkerRecordJson(path: string, value: unknown): Promise<void> {
  writeAtomic(path, `${JSON.stringify(value)}\n`);
}
