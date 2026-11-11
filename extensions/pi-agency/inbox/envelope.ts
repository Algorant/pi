import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { localAgencySettings, localSettingsPath } from "../local-settings.ts";
import { hcEndpoint, isHc } from "../../pi-herdr/core.ts";
import { THINKING_LEVELS, validateModelIdentifier } from "../subagents/profile.ts";
import { newId as uniqueId, stateDir, writeAtomic } from "../state.ts";

/**
 * Agent-inbox envelope, journal and open index, shared by the pi-agency inbox and the
 * `inbox` CLI. No Pi imports, so the CLI can load it.
 *
 * The log (`log.jsonl`) is local, untracked, semi-ephemeral state with one JSON event per
 * line: each machine appends what it sees. A body is stored once per machine — in the
 * `send` of a message this machine sent, or in the `deliver` of one it received from
 * another machine; every other event is a reference. Session transcripts stay the
 * permanent record, because each delivered message carries its full envelope.
 *
 * `open.json` beside it is the open index the append path rewrites: an optimisation over
 * the journal, never the truth (a stale stamp, a missing file or unreadable JSON rebuilds it).
 */
export const KINDS = ["request", "result", "blocked"] as const;
export type Kind = (typeof KINDS)[number];

export const INBOX_ROOT = stateDir("pi-agency", "inbox");
export const LOG_PATH = join(INBOX_ROOT, "log.jsonl");
export const OPEN_PATH = join(INBOX_ROOT, "open.json");

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
  /** The whole message; its first line is the headline readers derive (`headlineOf`), never stored twice. */
  body: string;
  /** `<project>:<task-N>`: the sender's hc `task=` label (a manus's track), its request's linked Task. */
  task?: string;
  /**
   * The sender marks it a correction to work in flight: a Pi that is working steers it into the running
   * turn. Absent (the default) a request or result is held until that turn ends (see steersWhileWorking).
   */
  interrupt?: boolean;
  /** Typed Pi control request; ordinary message text never dispatches commands. */
  control?: { type: "pi-reload"; core: string; terminal: string; revision: string } | ReloadAck | ModelControl;
};

/** A target's acknowledgement of a typed reload request: recorded and consumed silently by the caller when it succeeded. `not-applied` = it stayed recorded but never reached an idle boundary before its bound. */
export type ReloadAck = { type: "pi-reload-ack"; request: string; outcome: "verified" | "current" | "not-verified" | "not-reloaded" | "not-applied" | "not-foreground"; previous: string | null; loaded: string | null; expected: string; dirty: boolean };

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

/**
 * One journal line. Only a `send` carries the body of a message this machine sent, and only a
 * `deliver` of a message received from another machine carries it here (the only local copy);
 * every other event refers to the message by id.
 */
export type LogEvent =
  | { op: "send"; env: Envelope }
  | { op: "deliver"; id: string; at: string; session?: string; env?: Envelope }
  | { op: "close"; id: string; at: string; by: Actor; note: string }
  | { op: "reopen"; id: string; at: string; by: Actor; note: string }
  | { op: "fail"; id: string; at: string; note: string };

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

/**
 * Append one event, then rewrite the open index from it. The journal is the truth: the index is
 * only kept current, and anything that makes the incremental step unsafe (another writer, a stale
 * or missing index, a reopen, whose envelope the index does not hold) rebuilds it from the journal.
 */
export function appendEvent(event: LogEvent): void {
  mkdirSync(INBOX_ROOT, { recursive: true });
  repairJournalTail();
  const before = journalStat();
  const index = readOpenIndex();
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(LOG_PATH, line);
  const after = journalStat();
  if (index && index.stamp === stampOf(before) && after.size === before.size + Buffer.byteLength(line) && event.op !== "reopen") {
    writeOpenIndex(applyOpenEvent(index.open, event), stampOf(after));
    return;
  }
  rebuildOpenIndex();
}

/**
 * Record one delivery as a reference: the body already sits in the message's `send` on the machine
 * that sent it. A message whose send event is on another machine keeps its envelope here instead,
 * because this is the only local copy of its text.
 */
export function recordDelivery(env: Envelope, session: string): void {
  const event: Extract<LogEvent, { op: "deliver" }> = { op: "deliver", id: env.id, at: new Date().toISOString(), session };
  if (env.from.core !== env.to.core) event.env = env;
  appendEvent(event);
}

/**
 * A writer killed mid-append leaves a partial last line: the next writer cuts it, so its own event
 * stays a line and readers never have to skip more than one partial tail.
 */
function repairJournalTail(): void {
  let fd: number;
  try { fd = openSync(LOG_PATH, "r+"); } catch { return; }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return;
    for (let end = size; end > 0;) {
      const start = Math.max(0, end - 65_536);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        if (start + newline + 1 !== size) truncateSync(fd, start + newline + 1);
        return;
      }
      end = start;
    }
    truncateSync(fd, 0);
  } finally {
    closeSync(fd);
  }
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

/** The open index: `{ v, stamp, open }`. The stamp names the journal state it reflects. */
type OpenIndex = { v: 1; stamp: string; open: MessageView[] };
const journalStat = () => { try { return statSync(LOG_PATH); } catch { return { size: 0, mtimeMs: 0 }; } };
/** Size and modification time identify a journal state: any append, truncation or replacement changes one. */
const stampOf = (stat: { size: number; mtimeMs: number }) => `${stat.size}:${stat.mtimeMs}`;

function readOpenIndex(): OpenIndex | undefined {
  let index: any;
  try { index = JSON.parse(readFileSync(OPEN_PATH, "utf8")); } catch { return undefined; }
  if (index?.v !== 1 || typeof index.stamp !== "string" || !Array.isArray(index.open)) return undefined;
  const entries: any[] = index.open;
  if (!entries.every((view) => view && typeof view.id === "string" && typeof view.at === "string" && typeof view.body === "string" && typeof view.from?.terminal === "string" && typeof view.to?.terminal === "string")) return undefined;
  return { v: 1, stamp: index.stamp, open: entries.map((view) => ({ ...view, headline: headlineOf(view.body) })) };
}

/** No headline is stored anywhere: it is body line 1, derived on every read. */
function writeOpenIndex(open: MessageView[], stamp: string): void {
  writeAtomic(OPEN_PATH, JSON.stringify({ v: 1, stamp, open: open.map(({ headline, ...view }) => view) }), 0o644);
}

/**
 * Rebuild from the journal and stamp the state that was read. The stamp is taken before the read, so a
 * concurrent append can only make it too old (the next reader rebuilds), never claim content it lacks.
 */
function rebuildOpenIndex(): MessageView[] {
  const state = journalStat();
  const open = openFromEvents(readEvents());
  writeOpenIndex(open, stampOf(state));
  return open;
}

/** The messages that are open now: from the open index, rebuilt from the journal when it is stale or unusable. */
export function openMessages(): MessageView[] {
  const index = readOpenIndex();
  if (index && index.stamp === stampOf(journalStat())) return [...index.open].sort((a, b) => a.at.localeCompare(b.at));
  return rebuildOpenIndex();
}

/** One message, whether or not it is still open: the open index first, else the journal. */
export function messageView(id: string): MessageView | undefined {
  return openMessages().find((view) => view.id === id) ?? messages(readEvents()).get(id);
}

/** The message view of one envelope: its headline is body line 1, derived here and never stored. */
const viewOf = (env: Envelope): MessageView => ({ ...env, headline: headlineOf(env.body), replies: [], lifecycle: [] });

/** One event applied to an open set, in journal order; the reply, close and fail rules are `isOpen`'s. */
function applyOpenEvent(open: MessageView[], event: LogEvent): MessageView[] {
  const byId = new Map(open.map((view) => [view.id, view]));
  switch (event.op) {
    case "send": {
      // A reply answers its request, so the parent leaves the open set with it.
      if (event.env.reply_to) byId.delete(event.env.reply_to);
      const view = viewOf(event.env);
      if (isOpen(view)) byId.set(view.id, view);
      break;
    }
    case "deliver": {
      const id = event.env?.id ?? event.id;
      const view = byId.get(id) ?? (event.env ? viewOf(event.env) : undefined);
      if (!view) break; // a message this journal never saw sent or received, e.g. a result from afar
      view.delivered = event.at;
      if (isOpen(view)) byId.set(id, view);
      break;
    }
    case "close":
    case "fail": byId.delete(event.id); break;
    case "reopen": break; // never applied: appendEvent rebuilds for a reopen
  }
  return [...byId.values()];
}

/** The open messages of one journal read, by the same rules as the incremental update. */
function openFromEvents(events: LogEvent[]): MessageView[] {
  return [...messages(events).values()].filter(isOpen).sort((a, b) => a.at.localeCompare(b.at));
}

/** One close or reopen of a message, in log order; the note names the event. */
export type Lifecycle = { event: "closed" | "reopened"; at: string; note: string };
export type MessageView = Envelope & { headline: string; delivered?: string; failed?: string; replies: string[]; closed?: { at: string; note: string }; lifecycle: Lifecycle[] };

/**
 * One view per message id: send and deliver events merged, with its replies and lifecycle. In log
 * order, a reply (`reply_to`) or a close event closes it and a reopen opens it again; the last one wins.
 */
export function messages(events: LogEvent[]): Map<string, MessageView> {
  const byId = new Map<string, MessageView>();
  for (const event of events) {
    if (event.op === "close" || event.op === "reopen") continue;
    if (event.op === "deliver") {
      const id = event.env?.id ?? event.id;
      const known = byId.get(id);
      if (known) known.delivered = event.at;
      // A message received from another machine keeps this machine's only copy of its text here.
      else if (event.env) byId.set(id, { ...viewOf(event.env), delivered: event.at });
      continue;
    }
    if (event.op === "fail") {
      const failed = byId.get(event.id);
      if (failed) failed.failed = event.note;
      continue;
    }
    const known = byId.get(event.env.id);
    // A resend of a known id keeps the first envelope; only its replies and lifecycle accumulate.
    if (!known) byId.set(event.env.id, viewOf(event.env));
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
      if (event.op === "fail") continue;
      // A reply closes its request once, at the first event that shows it here (send or deliver).
      const reply = event.env?.reply_to;
      if (!reply || seen.has(event.env!.id)) continue;
      seen.add(event.env!.id);
      target = byId.get(reply);
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
 * Delivered into a running turn only when it cannot wait: a `blocked` message, an answer to a question
 * this Pi asked (`reply_to`), or a sender's explicit correction (`interrupt`). Every other request or
 * result is new work: a working Pi holds it until the turn ends, and it then starts the next turn, so
 * arriving work never displaces the work in hand (the dropped-request fix).
 */
export const steersWhileWorking = (env: Pick<Envelope, "kind" | "reply_to" | "interrupt">) =>
  env.kind === "blocked" || !!env.reply_to || env.interrupt === true;

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
    const linked = openMessages().filter((view) => {
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
