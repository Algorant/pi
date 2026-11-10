import type { WorkerAssignment, WorkerTaskDefinition } from "./handoff-record.ts";
import { workerReportGuidance } from "./report-guidance.ts";

export const WORKER_ASSIGNMENT_CONTEXT_LIMIT = 12_000;

export type WorkerProjectRule = { category: string; id: string; rule: string };

function formatCharacterCount(count: number): string {
  return count.toLocaleString("en-US");
}

function serializeAssignmentContext(root: unknown, milestones: unknown[]): string {
  return JSON.stringify({ task: root, milestones }, null, 2)!;
}

function recordFieldSizes(record: WorkerTaskDefinition): string {
  const serializedRecord = JSON.stringify(record, null, 2)!;
  return Object.keys(record)
    .map((field) => {
      const withoutField: Record<string, unknown> = { ...record };
      delete withoutField[field];
      return { field, chars: serializedRecord.length - JSON.stringify(withoutField, null, 2)!.length };
    })
    .filter(({ chars }) => chars > 0)
    .sort((left, right) => right.chars - left.chars)
    .map(({ field, chars }) => `${field}=${formatCharacterCount(chars)}`)
    .join(", ");
}

function assignmentSizeDiagnostic(taskId: string, assignment: WorkerAssignment, actualSize: number): string {
  const rootSize = serializeAssignmentContext(assignment.root, []).length;
  const records = [`- root ${assignment.root.id}: ${formatCharacterCount(rootSize)} chars (root baseline; includes assignment envelope)`];
  for (const [index, milestone] of assignment.milestones.entries()) {
    const formattedRecord = JSON.stringify(milestone, null, 2)!.split("\n").map((line) => `    ${line}`).join("\n");
    const contribution = formattedRecord.length + (index === 0 ? 4 : 2);
    records.push(`- subtask ${milestone.id}: +${formatCharacterCount(contribution)} chars`);
  }
  const fields = [`Field sizes are individual marginal reductions in standalone record JSON when a property is omitted; they are not additive.`];
  for (const record of [assignment.root, ...assignment.milestones]) {
    fields.push(`  ${record.id}: ${recordFieldSizes(record) || "no measurable fields"}`);
  }
  return [
    `Worker Task ${taskId} definition-of-done context is ${formatCharacterCount(actualSize)} characters; limit is ${formatCharacterCount(WORKER_ASSIGNMENT_CONTEXT_LIMIT)} (${formatCharacterCount(actualSize - WORKER_ASSIGNMENT_CONTEXT_LIMIT)} over).`,
    "Per-record contribution (JSON characters; root is the baseline and subtasks are incremental):",
    ...records,
    ...fields,
    "No assignment fields were truncated. Keep all acceptance, constraints, and validations complete; trim redundant body/context prose or remove information only when it is genuinely unnecessary.",
  ].join("\n");
}

// Validation belongs to the assigned project, not this extension's repository.
export const WORKER_TEST_RUNNER_GUIDANCE =
  "\nValidation: follow the assigned project's current rules. Report exact observations and remaining gaps; test or checklist counts are not acceptance evidence.";

// Keep directions as ordinary chat, not slash commands/skill invocations.
export function workerDirection(request: string): string {
  if (!request.trim()) throw new Error("Worker direction must not be empty.");
  return `Parent request:\n${request.trim()}`;
}

function formatActiveProjectRules(rules: readonly WorkerProjectRule[]): string {
  const newline = String.fromCharCode(10);
  const renderedRules = rules.map(({ category, id, rule }) =>
    `- ${id} (${category}): ${rule.trimEnd().split(newline).join(newline + "  ")}`,
  );
  return [
    "Active project rules (authoritative):",
    ...(renderedRules.length > 0 ? renderedRules : ["(No active project rules.)"]),
  ].join(newline);
}

export function taskFreeBrief(label: string, brief: string, needsAlgorant: boolean, rules: readonly WorkerProjectRule[]): string {
  return [
    `Current Worker brief: ${label}. Task-free small, self-contained work; git and the originating inbox thread are the record.`,
    `needsAlgorant: ${needsAlgorant}. ${needsAlgorant ? "Deliver for Algorant's judgement through your owner; never auto-finish." : "Passing in-scope work may auto-finish."}`,
    "The starter's contract follows verbatim. Stay inside Scope and Exclusions. If it grows, report needs-input; do not silently widen scope or fabricate a Task. Do not write Tandem. Follow applicable project rules.",
    "Do not merge, push, delete branches or remove checkouts. The owner decides integration and cleanup. Commit all changes before reporting ready; uncommitted work cannot be ready. If you cannot commit, preserve the changes and report needs-input with the blocker.",
    "Use worker_ask alone for a blocking question, then stop. Otherwise worker_report alone with {status, summary, files, evidence} (plus blockers for needs-input); runtime attaches the contract, HEAD and check evidence. Every report/question ends this invocation. Plain final text is not a report.",
    "Ready checks: runtime runs git diff --check from the captured base, the Check section's runnable `$ ` commands and applicable project rule commands once, recording the exact HEAD. Do not rerun those checks yourself; report supplemental real observations as evidence.",
    formatActiveProjectRules(rules),
    "Starter contract (verbatim):\n" + brief,
  ].join("\n\n");
}

export function workerBrief(
  taskId: string,
  assignment: WorkerAssignment,
  planRequired: boolean,
  planAccepted = false,
  activeProjectRules: readonly WorkerProjectRule[] = [],
  shortReport = false,
): string {
  const assignedContext = serializeAssignmentContext(assignment.root, assignment.milestones);
  if (assignedContext.length > WORKER_ASSIGNMENT_CONTEXT_LIMIT) {
    throw new Error(assignmentSizeDiagnostic(taskId, assignment, assignedContext.length));
  }
  return [
    "Current Worker brief — authoritative captured assignment. Earlier Task briefs in conversation history are historical, not the current contract.",
    "You are a Worker Pi process working in your own Worktrunk Git checkout.",
    "You have normal project permissions. Follow project rules and the assigned Tandem Task.",
    "Do not deliver, accept, complete, or otherwise mutate Tandem workflow for this Task except through worker_progress: you may start, report, block, or resume only an active milestone already captured in this assignment. worker_progress derives your Worker/session/delivery identity and applies the milestone update in the Task's Tandem workspace for you; never access that workspace directly. Never target the root Task, acceptance, completion, scope, ownership, dependencies, unrelated Tasks, or archived records; report implementation evidence to the parent instead.",
    "Do not merge, push, delete branches, or remove the worktree. The parent decides integration and cleanup.",
    `Track local steps with manage_todo_list only when it adds value: a tiny single-step Task may omit a checklist, while multistep work benefits from one linked to this Task (${taskId}). The runtime attaches the captured assignment and your latest checklist to worker_report, so do not retype either one; assigned native milestones remain authoritative.`,
    "Before editing, check whether a consequential instruction is ambiguous. Research locally verifiable facts and state what you verified; use worker_ask for a blocking ambiguity or a decision only the parent can make, then stop for worker_answer; worker_ask must be the only tool call in that turn, and do not ask the human or use worker_report as a question transport. If this Task requires plan-first review, submit a concise plan (outcome/boundary, approach, owned files, validation, unresolved assumptions or decisions) and wait for explicit approval before editing. Otherwise proceed under the Task contract. Report only material milestone changes or blockers; no routine progress pings.",
    ...(planRequired && !planAccepted ? ["Plan-first review is required for this Task; wait for explicit approval (worker_feedback with approve:true) before editing. Feedback without that approval, including read-only or inspection-only direction, asks you to revise and resubmit the plan; it never authorizes edits."] : []),
    ...(planAccepted ? ["The orchestrator explicitly approved your plan (worker_feedback approve:true). Proceed with the requested implementation. If new requirements or a scope correction make the approved plan wrong, submit a new plan with worker_report(status=plan): it clears the approval, and you must stop and wait for explicit approval again."] : []),
    "When ready or blocked for a reason other than a clarification question, call worker_report with status=ready or status=needs-input, then stop. The parent decides acceptance and integration.",
    WORKER_TEST_RUNNER_GUIDANCE,
    workerReportGuidance(taskId, shortReport),
    // Project rules are separate authoritative context, not part of the bounded Task definition.
    formatActiveProjectRules(activeProjectRules),
    "\nAssigned Tandem context:\n" + assignedContext,
  ].join("\n");
}
