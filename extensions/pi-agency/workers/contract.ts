import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { runRunnableValidation, tandemProjectRules, type CheckIn } from "./shared.ts";
import type { HcWorkerRecord } from "./hc-record.ts";
import type { WorkerProjectRule } from "./brief.ts";

/** The historical contract: what saved, recovered and finished work is read with. Never grows. */
const CONTRACT_SECTIONS = ["Outcome", "Scope", "Exclusions", "Check", "Done"] as const;
/** What a new Task-free launch must carry first: the ask, where it came from, what was ruled out, the expected return. */
const CONTEXT_SECTIONS = ["Request", "Sources", "Rejected", "Return"] as const;

/** The one authoritative template, copyable as written; a refused launch prints it and the agency skill's example follows it. */
export const BRIEF_SKELETON = [
  "## Request",
  "> <Algorant's exact words, verbatim>",
  "## Sources",
  "<inbox id, Task id, path, URL or commit where the ask and evidence live>",
  "## Rejected",
  "<options Algorant ruled out, in his words; or none when true>",
  "## Return",
  "<output format wanted back, e.g. plan only / one commit + proof>",
  "## Outcome",
  "<what finished work achieves>",
  "## Scope",
  "<repo-relative files; directories end in />",
  "## Exclusions",
  "<what not to touch>",
  "## Check",
  "$ <runnable command>",
  "## Done",
  "<what the owner or Algorant observes when finished>",
].join("\n");

/** Sections in the order the text names them; the one reader behind both the historical and the launch contract. */
function readSections(brief: string, names: readonly string[]): Map<string, string> {
  const sections = new Map<string, string>();
  const heading = new RegExp(`^[ \\t]*(?:(#{1,6})[ \\t]+)?(?:\\*\\*)?(${names.join("|")})(?:\\*\\*)?[ \\t]*(?::[ \\t]*(.*)|$)`, "gim");
  const matches = [...brief.matchAll(heading)].filter((match) => match[1] || match[3] !== undefined);
  for (const [index, match] of matches.entries()) {
    const key = match[2]!.toLowerCase();
    if (sections.has(key)) throw new Error(`brief has duplicate ${match[2]} sections.`);
    const next = matches[index + 1]?.index ?? brief.length;
    sections.set(key, `${match[3] ?? ""}\n${brief.slice(match.index! + match[0].length, next)}`.trim());
  }
  return sections;
}

/** Task-free contracts are the starter's verbatim text, never a synthetic Task. */
export function briefContract(brief: string): { scope: string[]; checks: string[] } {
  if (!brief.trim() || brief.length > 16_000 || /\u0000/.test(brief)) throw new Error("brief must be a nonempty contract of at most 16000 characters.");
  const sections = readSections(brief, CONTRACT_SECTIONS);
  const missing = ["outcome", "scope", "exclusions", "check", "done"].filter((key) => !sections.get(key)?.replace(/[\s*`#-]/g, ""));
  if (missing.length) throw new Error(`brief needs nonempty Outcome / Scope / Exclusions / Check / Done sections; missing: ${missing.join(", ")}. Nothing was started.`);
  const scope = sections.get("scope")!.split(/[\s,]+/).map((entry) => entry.replace(/^[*`-]+|[`;]+$/g, "")).filter(Boolean);
  if (!scope.length || scope.some((path) => isAbsolute(path) || path === "." || path.split("/").some((part) => part === "..") || !/^[\w.@/-]+$/.test(path))) {
    throw new Error("brief Scope must list repo-relative files or directories (directories end in /), not prose or globs. Nothing was started.");
  }
  return { scope: [...new Set(scope)], checks: runnableLines(sections.get("check")!) };
}

export function requireContract(params: { taskId?: string; brief?: string; label?: string }): void {
  if ((params.taskId === undefined) === (params.brief === undefined)) throw new Error("Supply exactly one of taskId or brief. Nothing was started.");
  if (params.brief !== undefined) {
    if (!params.label || !/^[\p{L}\p{N}]+(?:[ '-][\p{L}\p{N}]+)*$/u.test(params.label.trim()) || params.label.trim().split(/\s+/).length < 2 || params.label.trim().split(/\s+/).length > 5) throw new Error("Task-free work requires label: 2-5 plain words. Nothing was started.");
    briefContract(params.brief);
  }
}

const bare = (text: string): string => text.replace(/[\s*`#>-]/g, "");
/** Template placeholders (`<like this>`) are not content. */
const filled = (text: string): boolean => bare(text.replace(/<[^>\n]*>/g, "")).length > 0;
/** An explicit empty answer is no source. */
const NO_SOURCE = /^(none|n\/a|na|nil|unknown|tbd)\.?$/i;
const LAUNCH_ORDER = [...CONTEXT_SECTIONS, ...CONTRACT_SECTIONS].map((name) => name.toLowerCase());

/**
 * A NEW Task-free Worker or manus launch only: all nine headings, in order (the four context
 * sections first, then the historical five, so the historical reader still reads what this one
 * accepts). Saved work, `taskId` and helper `task` are never held to it. The Request has exactly
 * two shapes, told apart by its first line; neither verbatim truth nor Sources text is inferred.
 */
export function requireLaunchBrief(params: { brief?: string }): void {
  if (params.brief === undefined) return;
  const refuse = (problem: string): never => { throw new Error(`brief is missing required context: ${problem}. Nothing was started.\nRequest is either a first line \`> <Algorant's exact words>\` (relayed metadata may follow), or exactly \`No direct quote: <reason>\` with a durable source in Sources. All nine headings, in this order:\n${BRIEF_SKELETON}`); };
  const sections = readSections(params.brief, LAUNCH_ORDER.map((key) => key[0]!.toUpperCase() + key.slice(1)));
  const missing = CONTEXT_SECTIONS.filter((name) => !filled(sections.get(name.toLowerCase()) ?? ""));
  if (missing.length) refuse(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing, empty or only a placeholder`);
  const keys = [...sections.keys()];
  if (keys.length !== LAUNCH_ORDER.length || LAUNCH_ORDER.some((key, index) => keys[index] !== key)) refuse("Request, Sources, Rejected, Return, Outcome, Scope, Exclusions, Check and Done must all be present, in that order");
  const request = sections.get("request")!;
  const first = request.split(/\r?\n/)[0]!;
  if (first.startsWith(">")) {
    if (!filled(first.slice(1))) refuse("Request must begin with a nonempty `> ` quote of Algorant's words");
    return;
  }
  const reason = /^No direct quote:(.*)$/s.exec(request)?.[1];
  if (reason === undefined) refuse("Request must begin with a `> ` quote of Algorant's words, or exactly `No direct quote:` and a reason");
  if (!filled(reason!)) refuse("`No direct quote:` needs a reason");
  if (/^[ \t]*>/m.test(request)) refuse("Request is `No direct quote:` or a quote, not both");
  const sourced = sections.get("sources")!.replace(/<[^>\n]*>/g, "");
  if (!bare(sourced) || NO_SOURCE.test(bare(sourced))) refuse("with `No direct quote:` Sources must cite a durable source (inbox id, Task, path, URL, commit), not none or a placeholder");
}

/** Project rules are optional only when this Git repository has no Tandem board. */
export async function projectRules(repoKey: string, target: string, signal?: AbortSignal): Promise<WorkerProjectRule[]> {
  return existsSync(resolve(dirname(repoKey), ".tandem")) ? tandemProjectRules(target, signal) : [];
}

function runnableLines(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(?:[-*]\s+)?(?:`)?\$\s+(.+?)`?\s*$/.exec(line);
    return match ? [match[1]!] : [];
  });
}

export const workerBase = (record: HcWorkerRecord): string => record.integration.baseHead ?? record.integration.target.branch;
export const hasWorktree = (record: HcWorkerRecord): boolean => record.integration.worktree !== false;
export const workerName = (record: HcWorkerRecord): string => `${record.label ?? record.childAgent}${record.taskId ? ` [${record.taskId}]` : ""}`;

export async function taskFreeChecks(record: HcWorkerRecord, checkIn: CheckIn, signal?: AbortSignal) {
  const { checks } = briefContract(record.brief!);
  const rules = await projectRules(record.integration.repoKey, record.integration.target.checkoutPath, signal);
  const base = workerBase(record);
  if (!/^[a-zA-Z0-9_./@-]+$/.test(base)) throw new Error("Invalid captured diff base.");
  const commands = [...new Set([`git diff --check ${base}...HEAD`, ...checks, ...rules.flatMap(({ rule }) => runnableLines(rule))])];
  const results = [];
  for (const [index, command] of commands.entries()) {
    const result = await runRunnableValidation({ command }, record.integration.source.checkoutPath, checkIn, signal);
    results.push(result);
    if (result.exitCode !== 0) return { results, notRun: commands.slice(index + 1) };
  }
  return { results, notRun: [] };
}
