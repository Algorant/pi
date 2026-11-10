import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { runRunnableValidation, tandemProjectRules, type CheckIn } from "./shared.ts";
import type { HcWorkerRecord } from "./hc-record.ts";
import type { WorkerProjectRule } from "./brief.ts";

/** Task-free contracts are the starter's verbatim text, never a synthetic Task. */
export function briefContract(brief: string): { scope: string[]; checks: string[] } {
  if (!brief.trim() || brief.length > 16_000 || /\u0000/.test(brief)) throw new Error("brief must be a nonempty contract of at most 16000 characters.");
  const sections = new Map<string, string>();
  const heading = /^[ \t]*(?:(#{1,6})[ \t]+)?(?:\*\*)?(Outcome|Scope|Exclusions|Check|Done)(?:\*\*)?[ \t]*(?::[ \t]*(.*)|$)/gim;
  const matches = [...brief.matchAll(heading)].filter((match) => match[1] || match[3] !== undefined);
  for (const [index, match] of matches.entries()) {
    const key = match[2]!.toLowerCase();
    if (sections.has(key)) throw new Error(`brief has duplicate ${match[2]} sections.`);
    const next = matches[index + 1]?.index ?? brief.length;
    sections.set(key, `${match[3] ?? ""}\n${brief.slice(match.index! + match[0].length, next)}`.trim());
  }
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
