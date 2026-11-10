const BOUNDARY = "Worker assignment boundary: you own the entire root Task, never a subtask. Its subtasks are internal milestones or discrete pieces, not separate Worker assignments. You and the orchestrator jointly choose natural pauses and stopping points as work unfolds; a bounded read-only Subagent investigation is a useful natural pause. Do not split a Task artificially just to create more Workers.";
const TANDEM = "Tandem 0.15 syncs its board itself; `pending` means saved locally. Linked worktrees have no `.tandem/` and Tandem commands there use the main worktree's board. Surface conflicts and held edits to Algorant; resolve only with `tandem sync resolve` when authorized. Never stage, commit, push, edit, delete, or rename `.tandem/` or the `tandem` branch.";

/** Short report for trivial/small-effort Tasks (task-568): four fields; the runtime fills the rest. */
function shortReportGuidance(): string {
  const example = {
    status: "ready",
    summary: "REPLACE with one sentence: what changed.",
    files: ["REPLACE with a changed repo-relative path"],
    evidence: [{ criterion: "REPLACE with an acceptance criterion", observation: "REPLACE with one line: what you checked and saw" }],
  };
  return [
    BOUNDARY,
    TANDEM,
    "Worker report, short form (this is a small Task): call worker_report alone with {status, summary, files, evidence}, the JSON object itself, then stop after success. summary is one sentence; files are the changed repo-relative paths; evidence is one {criterion, observation} per acceptance criterion, each observation one line naming what you checked and saw. Leave out version, taskId, validation, blockers and risks: the runtime fills them. For status=needs-input add blockers (string[]); for status=plan (a plan-first Task) put the plan in summary and wait for approval (worker_feedback approve:true) before editing.",
    "Commit all changes in the captured Worker checkout before a ready report; the ready worker_report runs the Task's `$ <command>` validations itself and records their results, so do not rerun them by hand just before reporting. A worker_report that returns an error was NOT delivered: fix the cause and resubmit in the same turn. Use worker_ask({question}) alone for a clarification. A revised ready report covers the complete outcome, not only the correction.",
    "Short ready input SHAPE EXAMPLE ONLY:",
    "```json\n" + JSON.stringify(example) + "\n```",
  ].join("\n");
}

/** Worker-facing input template, not a report or fabricated validation evidence. */
export function workerReportGuidance(taskId: string, shortReport = false): string {
  if (shortReport) return shortReportGuidance();
  const example = {
    version: 1,
    taskId,
    status: "ready",
    summary: "REPLACE with the delivered outcome and remaining gaps.",
    files: ["REPLACE with a changed repo-relative path"],
    validation: ["REPLACE with actual command/manual observations and outcomes."],
    blockers: [],
    risks: [],
    evidence: [{ criterion: "REPLACE with an acceptance criterion", observation: "REPLACE with the exact observed outcome" }],
  };
  return [
    BOUNDARY,
    TANDEM,
    "Worker report input contract (permanent template):",
    "Call worker_report with the JSON object itself, not a Markdown report, JSON string, or {report: ...} wrapper. Use it alone in the tool batch, then stop after success. The runtime supplies deliveryId, assignment, checklist, and a source snapshot; do not send those fields.",
    "Required fields for every status: version (1), taskId, status, summary, files (string[]), validation (string[]), blockers (string[]), risks (string[]), evidence ({criterion, observation}[]). Keep required strings nonempty; use [] for genuinely absent list items. The runtime captures source HEAD and raw git status from the captured Worker checkout for every report status.",
    "Before submitting a ready report, commit all changes in the captured Worker checkout; plan and needs-input reports may remain dirty.",
    "A ready worker_report runs the Task's runnable (`$ <command>`) validations itself against your committed HEAD and records their exit codes for the owner; do not rerun them by hand just before reporting. Describe supplemental browser/manual checks and other observations in validation/evidence. Finish reuses checks that passed at that HEAD and reruns them only after a new commit.",
    "For status=plan, be concise: state the outcome/boundary, approach, owned files, validation, and unresolved assumptions or decisions. Do not restate the captured assignment. Evidence records inspected facts and unverified assumptions. Stop for explicit approval (worker_feedback with approve:true) before editing when a plan is required; feedback without approval asks you to revise and resubmit the plan, and read-only or inspection-only direction never authorizes edits. You may submit a new plan at any time (new requirements, scope correction); it clears any earlier approval and needs explicit approval again.",
    "A revised ready report (after feedback or a correction) must summarize the COMPLETE verified Task outcome: all changed files and all acceptance evidence, with the later correction added to it, not replacing it. The record keeps only your latest report.",
    "A worker_report that returns an error was NOT delivered. Fix the cause and resubmit in the same turn (for example commit your changes and resubmit), or use worker_ask. The owner is notified of the rejection only if your turn ends without a successful worker_report. Never end with a plain final message claiming a report was submitted unless worker_report succeeded.",
    "For status=needs-input, report current progress, concrete blocker(s), observed failures, and gaps; do not claim completion. For a clarification question, use worker_ask({question: ...}) alone instead of a report, then wait for worker_answer.",
    "Ready input SHAPE EXAMPLE ONLY: replace every placeholder with actual observations.",
    "```json\n" + JSON.stringify(example, null, 2) + "\n```",
  ].join("\n");
}
