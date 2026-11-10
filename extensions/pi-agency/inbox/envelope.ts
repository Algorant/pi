import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { localAgencySettings, localSettingsPath } from "../local-settings.ts";
import { hcEndpoint, isHc } from "../../pi-hc/core.ts";
import { THINKING_LEVELS, validateModelIdentifier } from "../subagents/profile.ts";
import { newId as uniqueId, stateDir } from "../state.ts";

/**
 * Agent-inbox envelope and local log, shared by the pi-agency inbox and the
 * `inbox` CLI. No Pi imports, so the CLI can load it.
 *
 * The log (`log.jsonl`) is local, untracked, semi-ephemeral state: each machine
 * appends what it sees (send, deliver, close). Session transcripts stay the
 * permanent record, because each delivered message carries the full envelope.
 */
export const KINDS = ["request", "result", "blocked"] as const;
export type Kind = (typeof KINDS)[number];

export const INBOX_ROOT = stateDir("pi-agency", "inbox");
export const LOG_PATH = join(INBOX_ROOT, "log.jsonl");

export type Endpoint = { terminal: string; core: string };
export type Address = { machine: string; label: string } & Endpoint;

/** Messages address native HC terminals; core ids disambiguate them. */
export const inboxKey = (address: Endpoint): string => `hc:${address.core}:${address.terminal}`;
export const addressText = (address: Endpoint): string => `terminal ${address.terminal}`;
export type Envelope = {
  v: 1;
  id: string;
  at: string;
  kind: Kind;
  reply_to: string | null;
  /** `context` is the sender's context-window usage in percent when it sent, if Pi reported one. */
  from: Address & { session?: string; context?: number };
  to: Address;
  headline: string;
  body: string;
  /** `<project>:<task-N>`: the sender's hc `task=` label (a manus's track), its request's linked Task. */
  task?: string;
  /** Typed Pi control request; ordinary message text never dispatches commands. */
  control?: { type: "pi-reload"; core: string; terminal: string; revision: string } | ReloadAck | ModelControl;
};

/** A target's acknowledgement of a typed reload request: recorded and consumed silently by the caller when it succeeded. */
export type ReloadAck = { type: "pi-reload-ack"; request: string; outcome: "verified" | "current" | "not-verified" | "not-reloaded" | "not-foreground"; previous: string | null; loaded: string | null; expected: string; dirty: boolean };

/** Typed model cutover request: canonical `provider/id` as in model-roles.json, a thinking level, and Fast on/off. */
export type ModelControl = { type: "pi-model"; model: string; thinking: string; fast: boolean };
/** The reason a model control is invalid, or undefined. Shared by sender and receiver. */
export function modelControlError(control: ModelControl): string | undefined {
  try { validateModelIdentifier(control.model, "model"); } catch (error) { return error instanceof Error ? error.message : String(error); }
  if (control.model !== control.model.trim()) return "model must be an exact provider/model identifier";
  if (!(THINKING_LEVELS as Set<string>).has(control.thinking)) return `thinking must be one of ${[...THINKING_LEVELS].join(", ")}`;
  if (typeof control.fast !== "boolean") return "fast must be a boolean";
  return undefined;
}

/** Who wrote a close or reopen: this machine and, in an hc terminal, that terminal. */
export type Actor = { machine: string; terminal?: string; core?: string };

export type LogEvent =
  | { op: "send"; env: Envelope }
  | { op: "deliver"; env: Envelope; at: string; session: string }
  | { op: "close"; id: string; at: string; by: Actor; note: string }
  | { op: "reopen"; id: string; at: string; by: Actor; note: string }
  | { op: "fail"; env: Envelope; at: string; error: string };

export const inboxDir = (key: string) => join(INBOX_ROOT, encodeURIComponent(key));

export const ID_PATTERN = /^m[0-9a-f]{8}$/;
export const newId = () => uniqueId("m", 8);
export const headlineOf = (body: string) => body.trim().split("\n")[0]?.trim() ?? "";

/** An agent's own message or report opens with a one-line headline of at most this many characters (task-557). */
export const HEADLINE_MAX = 160;
/** Reject an overlong first line before anything is sent; nothing is queued or logged. Length is the only rule. */
export function checkHeadline(text: string): void {
  const length = headlineOf(text).length;
  if (length > HEADLINE_MAX) {
    throw new Error(`Nothing sent: the first line is ${length} characters, ${length - HEADLINE_MAX} over the ${HEADLINE_MAX}-character headline limit. Shorten line 1 (any punctuation is fine) or move the extra text to the lines below it, then resend.`);
  }
}

let machineName: string | undefined;
/**
 * This machine's name, the `machine` in every address. The machine-local global
 * `settings.json` entry `"pi-agency": { "machine": "<name>" }` wins when set
 * (for machines without Tailscale); otherwise the Tailscale short name. Fails
 * clearly when neither exists; never guesses from the hostname.
 */
export function localMachine(): string {
  if (machineName) return machineName;
  const configured = localAgencySettings().machine;
  if (configured) return (machineName = configured);
  let dnsName: unknown;
  try {
    dnsName = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 })).Self?.DNSName;
  } catch (error) {
    throw new Error(`Cannot determine this machine's name: "pi-agency": { "machine" } is not set in ${localSettingsPath()} and Tailscale is unavailable (tailscale status --json: ${error instanceof Error ? error.message : error}).`);
  }
  if (typeof dnsName !== "string" || !dnsName) throw new Error("tailscale status --json reported no Self.DNSName.");
  machineName = dnsName.split(".")[0];
  return machineName;
}

export function appendEvent(event: LogEvent): void {
  mkdirSync(INBOX_ROOT, { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify(event)}\n`);
}

let cache: { mtimeMs: number; size: number; events: LogEvent[] } | undefined;
/** All log events, re-read only when the file changes. A missing log is an empty history. */
export function readEvents(): LogEvent[] {
  let stat;
  try { stat = statSync(LOG_PATH); } catch { return []; }
  if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.events;
  const events: LogEvent[] = [];
  for (const line of readFileSync(LOG_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      console.error(`[pi-agent-inbox] Skipping an unreadable line in ${LOG_PATH}`);
    }
  }
  cache = { mtimeMs: stat.mtimeMs, size: stat.size, events };
  return events;
}

/** One close or reopen of a message, in log order; the note names the event. */
export type Lifecycle = { event: "closed" | "reopened"; at: string; note: string };
export type MessageView = Envelope & { delivered?: string; failed?: string; replies: string[]; closed?: { at: string; note: string }; lifecycle: Lifecycle[] };

/**
 * One view per message id: send and deliver events merged, with its replies and lifecycle. In log
 * order, a reply (`reply_to`) or a close event closes it and a reopen opens it again; the last one wins.
 */
export function messages(events: LogEvent[]): Map<string, MessageView> {
  const byId = new Map<string, MessageView>();
  for (const event of events) {
    if (event.op === "close" || event.op === "reopen") continue;
    const view = byId.get(event.env.id) ?? { ...event.env, replies: [], lifecycle: [] };
    if (event.op === "deliver") view.delivered = event.at;
    if (event.op === "fail") view.failed = event.error;
    byId.set(event.env.id, view);
  }
  for (const view of byId.values()) {
    if (view.reply_to) byId.get(view.reply_to)?.replies.push(view.id);
  }
  const seen = new Set<string>();
  for (const event of events) {
    let target: MessageView | undefined;
    let entry: Lifecycle;
    if (event.op === "close" || event.op === "reopen") {
      target = byId.get(event.id);
      entry = { event: event.op === "close" ? "closed" : "reopened", at: event.at, note: event.note };
    } else {
      // A reply closes its request once, at the first event that shows it here (send or deliver).
      if (!event.env.reply_to || seen.has(event.env.id)) continue;
      seen.add(event.env.id);
      target = byId.get(event.env.reply_to);
      entry = { event: "closed", at: event.env.at, note: `answered by ${event.env.id}` };
    }
    if (!target) continue;
    target.lifecycle.push(entry);
    target.closed = entry.event === "closed" ? { at: entry.at, note: entry.note } : undefined;
  }
  return byId;
}

/** Open = a request or blocked message that was sent and is not closed (by a reply, a close event, or not reopened since). */
export const isOpen = (view: MessageView) =>
  (view.kind === "request" || view.kind === "blocked") && !view.failed && !view.closed;

/**
 * Where a message is now, as this machine knows it: `failed: <reason>`, `delivered <age> ago`, or
 * `queued`: waiting in its recipient's inbox folder here, or for another core `queued on <machine>`
 * (that machine records its delivery). A local message neither delivered nor waiting says so.
 */
export function deliveryState(view: MessageView, ownCore: string): string {
  if (view.failed) return `failed: ${view.failed}`;
  if (view.delivered) return `delivered ${ageText(view.delivered)} ago`;
  if (view.to.core !== ownCore) return `queued on ${view.to.machine} (its delivery is recorded there)`;
  return existsSync(join(inboxDir(inboxKey(view.to)), `${view.id}.json`)) ? "queued" : "sent, but neither delivered nor waiting in its inbox";
}

/** Record one close; the note names the event (answered, dispatched to <name>, <task> completed, or a person's reason). */
export function closeMessage(id: string, note: string, by: Actor): void {
  appendEvent({ op: "close", id, at: new Date().toISOString(), by, note });
}

/** This machine and, in an hc terminal, its live address: the `by` of a close or reopen. */
export async function localActor(): Promise<Actor> {
  if (!isHc()) return { machine: localMachine() };
  const { terminal, core } = await hcEndpoint(process.env.HC_TERMINAL_ID!);
  return { machine: localMachine(), terminal, core };
}

/** Undo a close: the message is open again until the next reply or close. */
export function reopenMessage(id: string, note: string, by: Actor): void {
  appendEvent({ op: "reopen", id, at: new Date().toISOString(), by, note });
}

const TASK_MENTION = /(?:([A-Za-z0-9._-]+):)?\b(task-\d+(?:-\d+)*)\b/;

/**
 * The Task a request is linked to: the sender's hc `task=` label (`project:task-N`), else the first
 * Task id its text names (`task-N`, or `project:task-N` to name the board). A bare id matches that id
 * on whichever board completes it.
 */
export function linkedTask(view: Pick<Envelope, "task" | "body">): { project?: string; id: string } | undefined {
  const match = TASK_MENTION.exec(view.task ?? "") ?? TASK_MENTION.exec(view.body);
  return match ? { ...(match[1] ? { project: match[1] } : {}), id: match[2]! } : undefined;
}

/**
 * A Task completed or cancelled through Pi (tandem_close, worker_finish): close every open request
 * or blocker in this machine's log linked to it, with the note "<project> <task> completed|cancelled".
 * Returns one line for the caller's result, or undefined when none was linked. The Tandem outcome
 * stands either way: a failed close is reported in that line, not retried.
 */
export async function closeTaskRequests(task: { project?: string; id: string }, outcome: "completed" | "cancelled"): Promise<string | undefined> {
  const note = `${task.project ? `${task.project} ` : ""}${task.id} ${outcome}`;
  try {
    const linked = openMessages(readEvents()).filter((view) => {
      const link = linkedTask(view);
      return link && link.id === task.id && (!link.project || link.project === task.project);
    });
    if (linked.length === 0) return undefined;
    const by = await localActor();
    for (const view of linked) closeMessage(view.id, note, by);
    return `Closed linked inbox request${linked.length === 1 ? "" : "s"} ${linked.map((view) => view.id).join(", ")} (${note}); inbox reopen <id> undoes it.`;
  } catch (error) {
    return `Inbox requests linked to ${task.id} were not closed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function openMessages(events: LogEvent[]): MessageView[] {
  return [...messages(events).values()].filter(isOpen).sort((a, b) => a.at.localeCompare(b.at));
}

/** The whole conversation an id belongs to: its root and every reply below it, oldest first. */
export function thread(events: LogEvent[], id: string): MessageView[] {
  const byId = messages(events);
  let root = byId.get(id);
  if (!root) return [];
  while (root.reply_to && byId.get(root.reply_to)) root = byId.get(root.reply_to)!;
  const out: MessageView[] = [];
  const walk = (view: MessageView) => {
    out.push(view);
    for (const reply of view.replies) {
      const child = byId.get(reply);
      if (child) walk(child);
    }
  };
  walk(root);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function ageText(fromIso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
