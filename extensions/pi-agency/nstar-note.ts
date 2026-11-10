import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { tandemShow, writeAtomic } from "./state.ts";

export const NSTAR_WORKER = "pi-agency:nstar-worker";
export const NSTAR_INBOX = "pi-agency:nstar-inbox";
const START = "<!-- nstar -->\n";
const END = "\n<!-- /nstar -->\n\n";
const ENTRY = "\n\n<!-- nstar-entry -->\n";
const HEADINGS = ["Goal", "Limits", "Algorant approvals / inputs", "Next step", "Recent hand-offs", "Notes"] as const;
const exec = promisify(execFile);
export type NstarBinding = { cwd: string; taskId: string } | { cwd: string; label: string };
/** What nstar records itself. A Task-backed job keeps it in its Pi session; a Task-free job in its note file. */
export type NstarCaptures = { approvals: string[]; next: string; handoffs: string[]; notes: string };
export type NstarNote = NstarCaptures & { goal: string; limits: string; rest: string };
/** The session side of a Task-backed job: its latest saved captures, and how to save new ones. */
export type NstarSession = { load(): NstarCaptures | undefined; save(captures: NstarCaptures): void };
const quote = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");
const unquote = (text: string) => text.split("\n").map((line) => line.startsWith("> ") ? line.slice(2) : line).join("\n");

/**
 * Task bodies written before task-597 may still lead with a northstar block. It is
 * bookkeeping, not contract: Worker scope/plan comparison and briefs skip it.
 */
export function nstarContractBody(body: string): string {
  if (!body.startsWith(START)) return body;
  const end = body.indexOf(END, START.length);
  if (end < 0) throw new Error("Malformed northstar block at the top of the Task body.");
  return body.slice(end + END.length);
}

function section(body: string, name: string, next?: string): string {
  const from = `### ${name}\n`;
  const begin = body.indexOf(from);
  const end = next ? body.indexOf(`\n\n### ${next}\n`, begin + from.length) : body.length;
  if (begin < 0 || end < begin) throw new Error(`Malformed northstar ${name} section.`);
  return body.slice(begin + from.length, end);
}
const entries = (body: string) => body ? body.split(ENTRY).filter(Boolean) : [];

function parse(body: string): NstarNote | undefined {
  if (!body.startsWith(START)) return undefined;
  const rest = nstarContractBody(body);
  const block = body.slice(START.length, body.indexOf(END, START.length));
  const values = HEADINGS.map((heading, index) => section(block, heading, HEADINGS[index + 1]));
  return { goal: unquote(values[0]!), limits: unquote(values[1]!), approvals: entries(values[2]!), next: unquote(values[3]!), handoffs: entries(values[4]!), notes: values[5]!, rest };
}

function format(note: NstarNote): string {
  const values = [quote(note.goal), quote(note.limits), note.approvals.join(ENTRY), note.next ? quote(note.next) : "", note.handoffs.join(ENTRY), note.notes];
  return START + "## northstar\n\n" + HEADINGS.map((heading, index) => `### ${heading}\n${values[index]}`).join("\n\n") + END + note.rest;
}

function briefSection(brief: string, name: string): string {
  const match = new RegExp(`(?:^|\\n)[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*\\*)?${name}(?:\\*\\*)?[ \\t]*(?::[ \\t]*|\\n)([\\s\\S]*?)(?=\\n[ \\t]*(?:#{1,6}[ \\t]+)?(?:\\*\\*)?(?:Outcome|Scope|Exclusions|Check|Done)(?:\\*\\*)?[ \\t]*(?::|\\n)|$)`, "i").exec(brief);
  return match?.[1]?.trim() || "Read the starter contract below.";
}

const NO_CAPTURES: NstarCaptures = { approvals: [], next: "", handoffs: [], notes: "" };

export const nstarLocation = (binding: NstarBinding) => "taskId" in binding ? `${binding.taskId} (${binding.cwd})` : join(binding.cwd, ".pi", "notes", `${binding.label}.md`);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8", timeout: 10_000 })).stdout.trim();
}

/** Ignore locally, in Git's own exclude file; never modify a project's versioned ignore policy. */
async function ignoreNote(binding: NstarBinding): Promise<void> {
  const location = nstarLocation(binding);
  const tracked = await git(binding.cwd, ["ls-files", "--", location]);
  if (tracked) throw new Error(`Northstar notes must be untracked: ${location} is tracked.`);
  const exclude = resolve(binding.cwd, await git(binding.cwd, ["rev-parse", "--git-path", "info/exclude"]));
  await withFileMutationQueue(exclude, async () => {
    let text = "";
    try { text = await readFile(exclude, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!text.split("\n").includes("/.pi/notes/")) {
      await mkdir(dirname(exclude), { recursive: true });
      await writeFile(exclude, `${text}${text && !text.endsWith("\n") ? "\n" : ""}/.pi/notes/\n`);
    }
  });
}

/** A single rolling list across both kinds: the newest ~20 entries, no archive or store. */
function trim(note: NstarCaptures): void {
  const recent = [...note.approvals.map((entry) => ({ entry, kind: "approval" })), ...note.handoffs.map((entry) => ({ entry, kind: "handoff" }))]
    .sort((a, b) => a.entry.slice(0, 24).localeCompare(b.entry.slice(0, 24))).slice(-20);
  note.approvals = recent.filter(({ kind }) => kind === "approval").map(({ entry }) => entry);
  note.handoffs = recent.filter(({ kind }) => kind === "handoff").map(({ entry }) => entry);
}

/**
 * One serialized read/modify/write. A Task is read, never written: its title and
 * scope frame the block, and the captures live in the Pi session. A Task-free job
 * keeps its whole note in the ignored note file.
 */
export async function nstarNote(binding: NstarBinding, options: { initialize?: boolean; brief?: string; session?: NstarSession; change?: (note: NstarNote) => void } = {}): Promise<{ text: string; block: string; archived: boolean }> {
  const location = nstarLocation(binding);
  return withFileMutationQueue(location, async () => {
    if ("taskId" in binding) {
      if (!options.session) throw new Error("A Task-backed northstar needs its Pi session.");
      const task = await tandemShow(binding.taskId, binding.cwd);
      const archived = task.location === "logs";
      if (task.location !== "board" && !archived) throw new Error("Unknown Tandem location; northstar will not continue.");
      if (archived && options.change) throw new Error(`Archived Task ${binding.taskId} is read-only; no northstar write attempted.`);
      const limits = [`The Task contract remains authoritative: tandem show ${binding.taskId}.`, ...(task.relatedFiles?.length ? [`Scope: ${task.relatedFiles.join(", ")}`] : []), ...(task.accord?.constraints ?? [])].join("\n");
      const saved = options.session.load();
      const note: NstarNote = { ...structuredClone(saved ?? NO_CAPTURES), goal: task.title, limits, rest: "" };
      options.change?.(note);
      trim(note);
      const captures: NstarCaptures = { approvals: note.approvals, next: note.next, handoffs: note.handoffs, notes: note.notes };
      if (JSON.stringify(captures) !== JSON.stringify(saved ?? NO_CAPTURES)) options.session.save(captures);
      const text = format(note).trimEnd();
      return { text, block: text, archived };
    }
    let body = "";
    try { body = await readFile(location, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.initialize) throw error; }
    let note = parse(body);
    if (!note && !options.initialize) throw new Error(`No initialized northstar note at ${location}.`);
    note ??= {
      ...structuredClone(NO_CAPTURES),
      goal: options.brief ? briefSection(options.brief, "Outcome") : binding.label,
      limits: options.brief ? `Scope: ${briefSection(options.brief, "Scope")}\nExclusions: ${briefSection(options.brief, "Exclusions")}` : "",
      rest: body || (options.brief ? `## Starter contract (verbatim; agent, not Algorant)\n\n${options.brief}` : ""),
    };
    options.change?.(note);
    trim(note);
    const text = format(note);
    if (text !== body) {
      await ignoreNote(binding);
      writeAtomic(location, text, 0o644);
    }
    return { text, block: text.slice(0, text.indexOf(END) + END.length).trimEnd(), archived: false };
  });
}

export function nstarCapture(note: NstarCaptures, kind: "approval" | "handoff", attribution: string, text: string, id: string, at = new Date().toISOString()): void {
  const list = kind === "approval" ? note.approvals : note.handoffs;
  if (id && [...note.approvals, ...note.handoffs].some((entry) => entry.includes(`**${attribution} · ${id}**\n`))) return;
  list.push(`${at}\n**${attribution}${id ? ` · ${id}` : ""}**\n${quote(text)}`);
}

export function nstarAppend(note: NstarCaptures, author: string, text: string): void {
  note.notes += `${note.notes ? "\n\n" : ""}**${author} (agent, not Algorant)**\n${quote(text)}`;
}
