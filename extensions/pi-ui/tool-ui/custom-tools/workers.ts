import { createBoxedToolRenderer } from "../core/card";
import { durationLabel, fieldLine, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRenderInput, ToolUiBoxModel, ToolUiSectionModel, ToolUiTone } from "../core/types";

type WorkerToolKind = "ask" | "answer" | "start" | "recover" | "resume" | "status" | "handoff" | "feedback" | "discard" | "pause" | "finish" | "report" | "progress";
type Args = { agent?: unknown; taskId?: unknown; disposition?: unknown; action?: unknown; prompt?: unknown; message?: unknown; note?: unknown; question?: unknown; questionId?: unknown; answer?: unknown; status?: unknown; milestoneId?: unknown; approve?: unknown };
type Details = {
  taskId?: unknown;
  title?: unknown;
  needsAlgorant?: boolean;
  worktree?: boolean;
  checkoutRetained?: boolean;
  accepted?: boolean;
  integrationOutcome?: { mergeRange?: string; revert?: string };
  agent?: unknown;
  label?: unknown;
  state?: unknown;
  sessionPath?: unknown;
  disposition?: unknown;
  /** Native HC terminal address of the Worker invocation, absent when none runs. */
  terminal?: unknown;
  deliveryState?: unknown;
  direction?: unknown;
  directionDelivered?: unknown;
  priorHandoff?: unknown;
  priorDeliveryId?: unknown;
  adopted?: unknown;
  handoffState?: unknown;
  kept?: unknown;
  worktreePath?: unknown;
  branch?: unknown;
  branchDeleted?: unknown;
  runtime?: unknown;
  durable?: unknown;
  removed?: unknown;
  action?: unknown;
  merged?: unknown;
  alreadyIntegrated?: unknown;
  durableOutcomeRecovered?: unknown;
  deliveryId?: unknown;
  routed?: unknown;
  plan?: unknown;
  questionId?: unknown;
  question?: unknown;
  answer?: unknown;
  report?: { status?: unknown };
  source?: { branch?: unknown; checkoutPath?: unknown; head?: unknown; statusPorcelain?: unknown };
  target?: { branch?: unknown; checkoutPath?: unknown };
  status?: unknown;
  summary?: unknown;
  files?: unknown;
  validation?: unknown;
  blockers?: unknown;
  risks?: unknown;
  evidence?: unknown;
  nativeAction?: unknown;
  rootTaskId?: unknown;
  milestoneId?: unknown;
  assignee?: unknown;
  authoritativeCheckout?: unknown;
  milestone?: { id?: unknown; title?: unknown; state?: unknown; accordStatus?: unknown; accord?: { status?: unknown } };
};

const LABEL: Record<WorkerToolKind, string> = {
  ask: "Ask Orchestrator",
  answer: "Answer Worker",
  start: "Start Worker",
  recover: "Recover Worker",
  resume: "Resume Worker",
  status: "Worker Status",
  handoff: "Worker Handoff",
  feedback: "Worker Feedback",
  discard: "Discard Worker",
  pause: "Pause Worker",
  finish: "Finish Worker",
  report: "Worker Report",
  progress: "Worker Progress",
};

export function createWorkerToolRenderer(kind: WorkerToolKind) {
  return createBoxedToolRenderer<Args, Details>((input) => buildBox(kind, input));
}

function buildBox(kind: WorkerToolKind, { args, result, options, theme, pending, error, context, text: output }: BoxedToolRenderInput<Args, Details>): ToolUiBoxModel {
  const details = asDetails(result?.details);
  const succeeded = !pending && !error && Boolean(result);
  const tone: ToolUiTone = pending ? "pending" : error ? "error" : succeeded ? resultTone(kind, details) : "warning";
  // Its whois label, with the durable name underneath in parentheses.
  const name = text(details.agent) || text(args.agent);
  const agent = text(details.label) ? `${text(details.label)}${name ? ` (${name})` : ""}` : name || "Worker";
  const status = pending ? (context.executionStarted ? "running" : "queued") : error ? "failed" : resultStatus(kind, details);
  const body = [theme.fg("muted", `${callSummary(kind, agent, args, details)}${details.needsAlgorant !== undefined ? ` · needsAlgorant:${details.needsAlgorant}` : ""}${details.taskId ? ` · ${text(details.taskId)}` : succeeded ? " · Task-free" : ""}`)];
  // A refusal's own text is the actionable outcome; show it instead of empty result fields.
  const sections = error ? [section("Error", [theme.fg("error", truncatePlain(output, options.expanded ? 4000 : 400))])]
    : !pending && result ? asSections(sectionFor(kind, args, details, theme, Boolean(options.expanded))) : [];
  return {
    title: `${statusIcon(theme, tone)} ${toolName(theme, LABEL[kind])}`,
    status: joinTitleParts([status, durationLabel(context.state)]),
    tone,
    body,
    sections,
  };
}

function resultStatus(kind: WorkerToolKind, details: Details): string {
  if (kind === "start") return "launched";
  if (kind === "recover") return details.adopted === false ? "already owned" : "reattached";
  if (kind === "resume") return text(details.runtime) || "continuation sent";
  if (kind === "handoff" && details.directionDelivered === false) return "direction undelivered";
  if (kind === "handoff" && details.directionDelivered === true) return "no handoff yet";
  if (kind === "ask") return "waiting for answer";
  if (kind === "answer") return "answer sent";
  if (kind === "handoff") return text(details.report?.status) || (details.questionId ? "needs answer" : "reported");
  if (kind === "feedback" && details.plan === "approved") return "plan approved";
  if (kind === "feedback" && details.plan === "revise") return "revision requested";
  if (kind === "feedback") return "sent";
  if (kind === "discard") return details.removed === true || details.checkoutRetained === true ? "discarded" : "partial";
  if (kind === "pause") return "paused";
  if (kind === "finish") return details.accepted === true && (details.removed === true || details.checkoutRetained === true) ? "finished" : "partial";
  if (kind === "report") return details.status === "ready" ? "ready" : details.status === "plan" ? "plan" : details.status === "needs-input" ? "needs input" : "reported";
  if (kind === "progress") return progressState(details);
  return text(details.state) || "inspected";
}

function resultTone(kind: WorkerToolKind, details: Details): ToolUiTone {
  if (kind === "report") return details.status === "needs-input" ? "warning" : details.status === "plan" ? "pending" : "success";
  if (kind === "progress" && progressState(details) === "blocked") return "warning";
  return "success";
}

function progressState(details: Details): string {
  const action = text(details.action) || text(details.nativeAction);
  if (action === "start" || action === "claim") return "claimed";
  if (action === "block") return "blocked";
  if (action === "resume") return "resumed";
  if (action === "report" || action === "deliver") return "delivered";
  return "inspected";
}

function callSummary(kind: WorkerToolKind, agent: string, args: Args, details?: Details): string {
  if (kind === "ask") return truncatePlain(text(args.question), 140);
  if (kind === "answer") return `answer ${truncatePlain(agent, 90)}`;
  if (kind === "start") return `launch ${text(args.taskId) || "Task"} in an owned worktree`;
  if (kind === "recover") return `reattach ${truncatePlain(agent, 90)}`;
  if (kind === "resume") return `continue ${truncatePlain(agent, 90)}`;
  if (kind === "handoff") return `retrieve ${truncatePlain(agent, 90)}`;
  if (kind === "feedback") return args.approve === true ? `approve plan · ${truncatePlain(agent, 90)}` : `message ${truncatePlain(agent, 90)} · no plan approval`;
  if (kind === "discard") return `discard ${truncatePlain(agent, 90)}`;
  if (kind === "status") return `inspect ${truncatePlain(agent, 90)}`;
  if (kind === "report") return `report ${truncatePlain(text(args.taskId) || agent, 70)} · ${reportSummary(args.status)}`;
  if (kind === "progress") return `report milestone ${truncatePlain(text(args.milestoneId) || "—", 70)} · ${agent} ${text(details?.nativeAction) || text(args.action) || "progress"}`;
  if (kind === "pause") return `interrupt ${truncatePlain(agent, 90)}`;
  if (kind === "finish") return `finish ${truncatePlain(agent, 90)}`;
  return `inspect ${truncatePlain(agent, 90)}`;
}

function sectionFor(kind: WorkerToolKind, args: Args, details: Details, theme: any, expanded: boolean): ToolUiSectionModel | ToolUiSectionModel[] {
  if (kind === "ask" || kind === "answer") return section("Clarification", [
    fieldLine(theme, "agent", text(details.agent) || text(args.agent) || "—", "accent"),
    fieldLine(theme, "task", text(details.taskId) || "Task-free · git + inbox", "accent"),
    fieldLine(theme, "question ID", text(details.questionId) || text(args.questionId) || "—", "muted"),
    fieldLine(theme, kind === "ask" ? "question" : "answer", truncatePlain(text(kind === "ask" ? details.question : details.answer), expanded ? 1000 : 180), "toolOutput"),
    fieldLine(theme, "lifecycle", "no native delivery or rework recorded", "muted"),
  ]);
  if (kind === "start") return startSection(details, theme, expanded);
  if (kind === "recover" || kind === "resume") return section(kind === "resume" ? "Continuation" : "Recovery", [
    fieldLine(theme, "agent", text(details.agent) || "—", "accent"),
    fieldLine(theme, "task", text(details.taskId) || "Task-free · git + inbox", "accent"),
    fieldLine(theme, "result", kind === "resume"
      ? details.direction === "redelivered" ? "preserved direction delivered exactly" : "generic continuation sent"
      : details.adopted === false ? "already owned; no change" : "reattached only; nothing continued", "toolOutput"),
    text(details.handoffState) ? fieldLine(theme, "handoff", text(details.handoffState), "muted") : undefined,
    text(details.deliveryId) ? fieldLine(theme, "delivery", text(details.deliveryId), "muted") : undefined,
    location(theme, details),
    expanded && text(details.sessionPath) ? fieldLine(theme, "session", truncatePlain(text(details.sessionPath), 260), "muted") : undefined,
  ]);
  if (kind === "status") return statusSection(args, details, theme, expanded);
  if (kind === "handoff") return handoffSection(details, theme, expanded);
  if (kind === "feedback") return messageSection(args, details, theme);
  if (kind === "discard") return cleanupSection(details, theme, expanded);
  if (kind === "finish") return integrationSection(details, theme, expanded);
  if (kind === "report") return reportSections(args, details, theme, expanded);
  if (kind === "progress") return progressSections(args, details, theme, expanded);
  return section("Pause", [
    fieldLine(theme, "agent", text(details.agent) || text(args.agent) || "—", "accent"),
    fieldLine(theme, "durable", text(details.durable) || "—", "warning"),
    fieldLine(theme, "runtime after", text(details.runtime) || "—", "muted"),
    text(details.handoffState) ? fieldLine(theme, "handoff", text(details.handoffState), text(details.handoffState) === "paused" ? "muted" : "warning") : undefined,
    text(args.note) ? fieldLine(theme, "note", truncatePlain(text(args.note), expanded ? 1000 : 180), "toolOutput") : undefined,
  ]);
}

function startSection(details: Details, theme: any, expanded: boolean) {
  return section("Worker", [
    fieldLine(theme, "task", text(details.taskId) || "Task-free · git + inbox", "accent"),
    text(details.title) ? fieldLine(theme, "title", truncatePlain(text(details.title), expanded ? 220 : 120), "toolOutput") : undefined,
    fieldLine(theme, "agent", text(details.agent) || "—", "accent"),
    location(theme, details),
    text(details.branch) ? fieldLine(theme, "branch", truncatePlain(text(details.branch), 120), "muted") : undefined,
    fieldLine(theme, "provisioning", details.worktree === false ? "shared checkout · no merge/removal" : "Worktrunk lifecycle · pre-start done · post-start dispatched", "muted"),
    expanded && text(details.worktreePath) ? fieldLine(theme, "worktree", truncatePlain(text(details.worktreePath), 260), "muted") : undefined,
  ]);
}

function statusSection(args: Args, details: Details, theme: any, expanded: boolean) {
  const runtime = text(details.state) || "unknown";
  const handoff = text(details.handoffState) || "unknown";
  return section("Runtime", [
    fieldLine(theme, "agent", text(args.agent) || text(details.agent) || "—", "accent"),
    fieldLine(theme, "runtime", details.kept === true ? `${runtime} · kept` : runtime, runtime === "done" ? "success" : runtime === "blocked" ? "warning" : "muted"),
    fieldLine(theme, "handoff", handoff, /^ready\b|reported/.test(handoff) ? "success" : /failed|needs-input|question/.test(handoff) ? "warning" : "muted"),
    location(theme, details),
    expanded && text(details.worktreePath) ? fieldLine(theme, "worktree", truncatePlain(text(details.worktreePath), 260), "muted") : undefined,
  ]);
}

/** The Worker's actual native terminal and its runtime, or that no invocation runs. */
function location(theme: any, details: Details): string {
  const runtime = text(details.state) || "closed";
  return fieldLine(theme, "terminal", text(details.terminal) ? `${text(details.terminal)} · ${runtime}` : `no invocation · ${runtime}`, runtime === "working" ? "accent" : "muted");
}

function messageSection(args: Args, details: Details, theme: any) {
  const approving = args.approve === true;
  return section("Feedback", [
    fieldLine(theme, "agent", text(details.agent) || "—", "accent"),
    approving || details.plan === "revise"
      ? fieldLine(theme, "plan", approving ? "approved — implementation authorized" : "not approved — Worker told to revise and resubmit", approving ? "success" : "warning")
      : undefined,
    location(theme, details),
    fieldLine(theme, "delivery", details.routed === "new-cycle" ? `new delivery cycle opened${text(details.deliveryId) ? ` · ${text(details.deliveryId)}` : ""}` : "current delivery cycle preserved", "toolOutput"),
  ]);
}

function handoffSection(details: Details, theme: any, expanded: boolean) {
  if (typeof details.directionDelivered === "boolean") return section("Review", [
    fieldLine(theme, "agent", text(details.agent) || "—", "accent"),
    location(theme, details),
    fieldLine(theme, "delivery", `${text(details.deliveryState) || "—"} · no typed handoff of its own`, "warning"),
    fieldLine(theme, "direction", details.directionDelivered ? "reached the Worker" : "NOT delivered · preserved for worker_resume", details.directionDelivered ? "muted" : "warning"),
    fieldLine(theme, "prior handoff", `${text(details.priorHandoff) || "none"}${text(details.priorDeliveryId) ? ` · ${text(details.priorDeliveryId)}` : ""}`, "toolOutput"),
    text(details.direction) ? fieldLine(theme, "text", truncatePlain(text(details.direction), expanded ? 1000 : 160), "muted") : undefined,
  ]);
  return section("Review", [
    fieldLine(theme, "agent", text(details.agent) || "—", "accent"),
    location(theme, details),
    text(details.deliveryState) ? fieldLine(theme, "delivery", text(details.deliveryState), "muted") : undefined,
    fieldLine(theme, "handoff", details.questionId ? "waiting for an orchestrator answer" : text(details.report?.status) === "needs-input" ? "input required; not ready work" : text(details.report?.status) === "plan" ? "plan awaiting direction" : "ready report for orchestrator review", "toolOutput"),
    expanded && text(details.sessionPath) ? fieldLine(theme, "session", truncatePlain(text(details.sessionPath), 260), "muted") : undefined,
  ]);
}

function integrationSection(details: Details, theme: any, expanded: boolean) {
  const source = text(details.source?.branch) || "—";
  const target = text(details.target?.branch) || "—";
  return section("Worktrunk integration", [
    fieldLine(theme, "source", source, "accent"),
    fieldLine(theme, "target", target, "toolOutput"),
    fieldLine(theme, "receipt", [details.alreadyIntegrated === true ? "already integrated, no new merge" : "merged once", "accepted", "terminal closed", details.checkoutRetained ? "shared checkout retained · no merge/removal" : details.removed === true ? "checkout removed" : "removal pending"].join(" · "), "success"),
    text(details.integrationOutcome?.mergeRange) ? fieldLine(theme, "range", text(details.integrationOutcome?.mergeRange), "muted") : undefined,
    expanded && text(details.integrationOutcome?.revert) ? fieldLine(theme, "revert", text(details.integrationOutcome?.revert), "toolOutput") : undefined,
    expanded && text(details.source?.checkoutPath) ? fieldLine(theme, "source checkout", truncatePlain(text(details.source?.checkoutPath), 260), "muted") : undefined,
    expanded && text(details.target?.checkoutPath) ? fieldLine(theme, "target checkout", truncatePlain(text(details.target?.checkoutPath), 260), "muted") : undefined,
  ]);
}

function cleanupSection(details: Details, theme: any, expanded: boolean) {
  const branch = text(details.branch);
  const branchOutcome = details.branchDeleted === true ? "deleted safely" : branch ? "preserved (not force-deleted)" : "none";
  return section("Cleanup", [
    fieldLine(theme, "agent", text(details.agent) || "—", "accent"),
    fieldLine(theme, "disposition", text(details.disposition) || "—", "toolOutput"),
    location(theme, details),
    details.durableOutcomeRecovered === true && text(details.deliveryId) ? fieldLine(theme, "durable record", text(details.deliveryId), "success") : undefined,
    fieldLine(theme, "branch", branch ? `${truncatePlain(branch, 120)} · ${branchOutcome}` : branchOutcome, details.branchDeleted === true ? "success" : "muted"),
    expanded && text(details.worktreePath) ? fieldLine(theme, "worktree", truncatePlain(text(details.worktreePath), 260), "muted") : undefined,
  ]);
}

function reportSummary(status: unknown): string {
  if (status === "plan") return "plan awaiting direction";
  if (status === "needs-input") return "input required; not ready work";
  return "ready work for orchestrator review";
}

function asSections(value: ToolUiSectionModel | ToolUiSectionModel[]): ToolUiSectionModel[] {
  return Array.isArray(value) ? value : [value];
}

function reportSections(args: Args, details: Details, theme: any, expanded: boolean): ToolUiSectionModel[] {
  const status = text(details.status) || text(args.status) || "reported";
  const files = asList(details.files);
  const validations = asList(details.validation);
  const blockers = asList(details.blockers);
  const evidence = asList(details.evidence);
  const hasSnapshot = typeof details.source?.head === "string" && typeof details.source?.statusPorcelain === "string";
  const summary = text(details.summary);
  const gitStatus = hasSnapshot ? text(details.source?.statusPorcelain) : "";
  const commit = hasSnapshot ? text(details.source?.head) : "";
  const compactStatus = hasSnapshot ? (gitStatus.trim() ? `${gitStatus.trim().split("\n").length} changed` : "clean tree") : "";
  const reportLines = [
    fieldLine(theme, "task", text(details.taskId) || text(args.taskId) || "Task-free · git + inbox", "accent"),
    fieldLine(theme, "status", status, status === "ready" ? "success" : status === "needs-input" ? "warning" : "muted"),
    hasSnapshot ? fieldLine(theme, "commit", joinTitleParts([commit.slice(0, 7), compactStatus]) || "—", "muted") : undefined,
    expanded && gitStatus ? fieldLine(theme, "git status", truncatePlain(gitStatus, 260), "muted") : undefined,
    status === "plan"
      ? fieldLine(theme, "files to change", files.length, "muted")
      : fieldLine(theme, "files", `${files.length} changed`, "muted"),
    status === "plan" ? fieldLine(theme, "planned validations", validations.length, "muted") : undefined,
    status === "needs-input" ? fieldLine(theme, "blockers", blockers.length, blockers.length > 0 ? "warning" : "muted") : undefined,
    status === "ready"
      ? fieldLine(theme, "evidence", `${evidence.length} ${evidence.length === 1 ? "observation" : "observations"}`, "muted")
      : undefined,
  ];
  const sections = [section("Report", reportLines)];
  if (status === "needs-input") {
    if (blockers.length > 0) sections.push(section("Blocker", blockers.map((blocker) => theme.fg("warning", truncatePlain(blocker, expanded ? 1000 : 180)))));
  } else if (summary) {
    sections.push(section(status === "plan" ? "Approach" : "Summary", [theme.fg("toolOutput", truncatePlain(summary, expanded ? 1000 : 180))]));
  }
  return sections;
}

function progressSections(args: Args, details: Details, theme: any, expanded: boolean): ToolUiSectionModel[] {
  const milestone = asRecord(details.milestone);
  const sections = [section("Milestone", [
    fieldLine(theme, "root", text(details.rootTaskId) || "—", "accent"),
    fieldLine(theme, "milestone", text(details.milestoneId) || text(args.milestoneId) || "—", "accent"),
    fieldLine(theme, "action", text(details.action) || text(args.action) || "progress", "toolOutput"),
    fieldLine(theme, "assignee", text(details.assignee) || "—", "accent"),
    fieldLine(theme, "accord", text(milestone.accord?.status) || text(milestone.accordStatus) || "—", "toolOutput"),
    expanded && text(milestone.title) ? fieldLine(theme, "title", truncatePlain(text(milestone.title), 220), "muted") : undefined,
    expanded && text(details.sessionPath) ? fieldLine(theme, "session", truncatePlain(text(details.sessionPath), 260), "muted") : undefined,
    expanded && text(details.authoritativeCheckout) ? fieldLine(theme, "checkout", truncatePlain(text(details.authoritativeCheckout), 260), "muted") : undefined,
  ])];
  const note = text(args.note);
  if (note) sections.push(section("Note", [theme.fg("warning", truncatePlain(note, expanded ? 1000 : 180))]));
  return sections;
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function asDetails(value: unknown): Details { return value && typeof value === "object" && !Array.isArray(value) ? value as Details : {}; }
