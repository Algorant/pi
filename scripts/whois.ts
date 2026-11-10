import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { hcEndpoint, hcFind, hcJson, hcText } from "../extensions/pi-hc/core.ts";
import { messages, readEvents } from "../extensions/pi-agency/inbox/envelope.ts";
import { stateDir, tandemShow } from "../extensions/pi-agency/state.ts";
import { handoffRecordDirectory } from "../extensions/pi-agency/workers/handoff-record.ts";

/**
 * whois: the one naming system (task-585, design B of herdra task-81). Whoever starts a primitive
 * writes its label once, on the primitive itself; this module turns any id into that label. No
 * registry: hc labels, Tandem titles, the inbox log, Herdra's open items and the Worker records are
 * the stores. Ids (hc addresses, message ids, oN, delivery ids) stay ids underneath.
 *
 *   label          a terminal's hc `label=`; a Task's title; a message's headline; an open item's `what`
 *   terminal rule  `label=`, else Herdra for the Pi named herdra, else "<Project> Ceph" for the Pi in
 *                  a space's main tab, else its hc name, else its address
 *
 * Used by Pi (import), scripts and Herdr mods (the `whois` CLI beside this file).
 */
export type Who = { label: string; kind: string; project: string | null; id: string };

/** Where a start path writes the label and kind on an hc terminal. */
export const LABEL_KEY = "label";
export const KIND_KEY = "kind";
/** hc's limit for a terminal name: 1-32 of a-z 0-9 - _. */
const NAME_MAX = 32;

const run = promisify(execFile);
const TASK_ID = /^(?:([^:\s/]+):)?(task-\d+(?:-\d+)*)$/;
const MESSAGE_ID = /^m[0-9a-f]{8}$/;
const OPEN_ID = /^o\d+$/;

/** A fallback label: the first non-empty line of a Task title, helper task or reason, without a closing period. */
export function labelFrom(text: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
  return line.replace(/\.+$/, "").trim();
}

/** The label's slug: the hc name and branch of what it labels (`Cleaner alert cards` → `cleaner-alert-cards`). */
export function slugOf(label: string, max = NAME_MAX): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) throw new Error(`Label "${label}" has no letters or digits to name it by.`);
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  return (cut.includes("-") && slug[max] !== "-" ? cut.slice(0, cut.lastIndexOf("-")) : cut).replace(/-+$/, "");
}

/**
 * The hc name (and branch, with `repo`) for a new primitive: the label's slug, else `-2`, `-3`… on a
 * collision with a live hc terminal, any Worker's durable name, or (with `repo`) a branch of that repo.
 */
export async function nameFor(label: string, repo?: string): Promise<string> {
  const workers = new Set(workerRecords().map((record) => record.childAgent));
  for (let n = 1; n < 100; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const name = `${slugOf(label, NAME_MAX - suffix.length)}${suffix}`;
    if (workers.has(name)) continue;
    if ((await hcFind(name))?.state === "live") continue;
    if (repo && await branchExists(repo, name)) continue;
    return name;
  }
  throw new Error(`No free name for label "${label}" up to -99.`);
}

/** The project a `project:task-N` label names. */
const projectOfTask = (task: unknown): string | null => typeof task === "string" && task.includes(":") ? task.slice(0, task.indexOf(":")) : null;

/** A terminal as `hc get` (or `hc ls`) reports it, named by the terminal rule above. */
export function terminalWho(terminal: any): Who {
  const where = String(terminal.labels?.where ?? terminal.where ?? "");
  const [space = "", ...tab] = where.split(" / ");
  const project = space || projectOfTask(terminal.labels?.task);
  const app = terminal.status?.app ?? terminal.agent;
  const id = String(terminal.address);
  const label = terminal.labels?.[LABEL_KEY];
  const kind = terminal.labels?.[KIND_KEY];
  if (label) return { label, kind: kind || (app === "pi" ? "agent" : "terminal"), project, id };
  if (terminal.name === "herdra") return { label: "Herdra", kind: "herdra", project, id };
  if (space && tab.join(" / ") === "main" && app === "pi") return { label: `${space} Ceph`, kind: "ceph", project, id };
  return { label: terminal.name || id, kind: kind || (app === "pi" ? "agent" : "terminal"), project, id };
}

/** `label`, or `label@machine` for a peer on another machine. */
export const named = (label: string, machine: string, local: string): string => machine && machine !== local ? `${label}@${machine}` : label;

/** An inbox address (envelope from/to) as Algorant reads it: its whois label, written at send time; an envelope without one shows its terminal. */
export type Peer = { label?: unknown; machine?: unknown; terminal?: unknown };
const str = (value: unknown): string => typeof value === "string" ? value.trim() : "";
export const peerName = (peer: Peer, local: unknown): string =>
  named(str(peer.label) || str(peer.terminal) || "?", str(peer.machine), str(local));
/** The name with the actual address in parentheses: `.pi Ceph (t1p)`, `Herdra@desktop (t1q)`. */
export const peerText = (peer: Peer, local: unknown): string => {
  const raw = str(peer.terminal);
  return raw && raw !== str(peer.label) ? `${peerName(peer, local)} (${raw})` : peerName(peer, local);
};

/** A Worker's label by its durable name, from its newest control record (undefined for none, or a record from before labels). */
export function workerLabel(name: string): string | undefined {
  return workerRecords().filter((record) => record.childAgent === name).sort((a, b) => b.createdAt - a.createdAt)[0]?.label || undefined;
}

/** A live terminal's address in this core, the core's permanent id, and its whois label (resolved now; names move). */
export type HcAddress = { terminal: string; core: string; label: string };
export async function hcAddress(target: string): Promise<HcAddress> {
  const { terminal, core, record } = await hcEndpoint(target);
  return { terminal, core, label: terminalWho(record).label };
}

type WorkerRecordLike = { childAgent: string; label?: string; taskId?: string; createdAt: number; integration: { repoKey: string; source: { branch: string } } };

/** Native Worker control records, read as stored: hc-record.ts owns and validates them, but loads Pi's runtime, which this CLI does not. */
function workerRecords(): WorkerRecordLike[] {
  const dir = handoffRecordDirectory();
  let names: string[];
  try { names = readdirSync(dir); } catch (error: any) { if (error?.code === "ENOENT") return []; throw error; }
  return names.filter((name) => /^handoff-hc-.+\.json$/.test(name)).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

const workerWho = (record: WorkerRecordLike): Who =>
  ({ label: record.label || record.childAgent, kind: "worker", project: basename(dirname(record.integration.repoKey)), id: record.childAgent });

/** The project of a checkout: its repository folder's name (`.pi`, `herdra`). */
async function projectOf(cwd: string): Promise<string> {
  const common = (await run("git", ["rev-parse", "--git-common-dir"], { cwd })).stdout.trim();
  const path = resolve(cwd, common);
  return basename(path.endsWith("/.git") ? dirname(path) : path);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try { await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }); return true; }
  catch { return false; }
}

/** A Task by id: on `project`'s board (found through that project's live Ceph, here or on a connected machine), else the board of `cwd`. */
async function taskWho(project: string | undefined, id: string, cwd: string): Promise<Who> {
  if (!project) return { label: (await tandemShow(id, cwd)).title, kind: "task", project: await projectOf(cwd), id };
  const listed = await hcJson(["ls", "--json"]);
  const ceph = (listed.terminals ?? []).find((t: any) => t.state === "live" && t.where === `${project} / main` && t.agent === "pi" && t.cwd);
  if (!ceph) throw new Error(`No live Ceph for project ${project} (a pi in its space's main tab) to read ${id} from.`);
  const machine = ceph.address.includes("/") ? ceph.address.slice(0, ceph.address.indexOf("/")) : undefined;
  // hc exec returns what tandem wrote and its exit code; a missing Task is tandem's own JSON error.
  const ran = JSON.parse(await hcText(["exec", "--json", ...(machine ? ["--on", machine] : []), "--cwd", ceph.cwd, "--", "tandem", "show", id, "--json"], undefined, 30_000));
  const shown = JSON.parse(Buffer.from(String(ran.stdout ?? ""), "base64").toString("utf8"));
  if (shown.ok === false || typeof shown.data?.title !== "string") throw new Error(`tandem show ${id}: ${shown.error?.message ?? "no Task"}`);
  return { label: shown.data.title, kind: "task", project, id };
}

function openItemWho(id: string): Who {
  const file = stateDir("herdra", "open.jsonl");
  let item: { what: string; project: string | null } | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.id !== id) continue;
    if (event.op === "open") item = { what: event.what, project: event.project ?? null };
    else if (event.op === "update" && item) item = { what: event.what ?? item.what, project: event.project ?? item.project };
  }
  if (!item) throw new Error(`No open item ${id} in ${file}.`);
  return { label: item.what, kind: "open item", project: item.project, id };
}

async function branchWho(branch: string, cwd: string): Promise<Who | undefined> {
  let project: string;
  try { project = await projectOf(cwd); } catch { return undefined; }
  if (!await branchExists(cwd, branch)) return undefined;
  const record = workerRecords().filter((entry) => entry.integration.source.branch === branch && basename(dirname(entry.integration.repoKey)) === project)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (record) return { ...workerWho(record), kind: "branch", id: branch };
  // A manus or other agent working in that branch's checkout names it.
  const porcelain = (await run("git", ["worktree", "list", "--porcelain"], { cwd })).stdout;
  const path = porcelain.split("\n\n").find((entry) => entry.split("\n").includes(`branch refs/heads/${branch}`))?.match(/^worktree (.+)$/m)?.[1];
  const listed = path ? await hcJson(["ls", "--json"]) : undefined;
  const holder = (listed?.terminals ?? []).find((t: any) => t.state === "live" && t.cwd === path && t.agent === "pi");
  if (holder) return { ...terminalWho(await hcJson(["get", holder.address])), kind: "branch", id: branch };
  return { label: branch, kind: "branch", project, id: branch };
}

/**
 * Any id → {label, kind, project, id}: a terminal (`t17j`, `homelab-server/t3`, an hc name), a Worker by
 * its durable name (live or not), a Task (`task-81`, `herdra:task-81`), a message (`m…`), an open
 * item (`oN`) or a branch of the repository at `cwd`. Throws when nothing has that id.
 */
export async function whois(id: string, options: { cwd?: string } = {}): Promise<Who> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const key = id.trim();
  if (MESSAGE_ID.test(key)) {
    const view = messages(readEvents()).get(key);
    if (!view) throw new Error(`No inbox message ${key} in this machine's log.`);
    return { label: view.headline, kind: "message", project: projectOfTask(view.task), id: key };
  }
  if (OPEN_ID.test(key)) return openItemWho(key);
  const task = TASK_ID.exec(key);
  if (task) return taskWho(task[1], task[2]!, cwd);
  const terminal = await hcFind(key);
  if (terminal && terminal.state === "live") return terminalWho(terminal);
  const matches = workerRecords().filter((record) => record.childAgent === key || record.label === key).sort((a, b) => b.createdAt - a.createdAt);
  if (new Set(matches.map((record) => record.childAgent)).size > 1) throw new Error(`Worker label "${key}" is ambiguous; use its hc name.`);
  if (matches[0]) return workerWho(matches[0]);
  if (terminal) return terminalWho(terminal);
  const branch = await branchWho(key, cwd);
  if (branch) return branch;
  throw new Error(`Nothing named ${key}: no terminal, Worker, Task, message, open item or branch (of ${cwd}).`);
}
