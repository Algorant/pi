import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, truncateSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { localAgencySettings, localSettingsPath } from "../local-settings.ts";
import { hcEndpoint, isHc } from "../../pi-herdr/core.ts";
import { THINKING_LEVELS, validateModelIdentifier } from "../subagents/profile.ts";
import { newId as uniqueId, stateDir, writeAtomic } from "../state.ts";
import type { Failures } from "../../pi-tandem/failure-summary.ts";

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
  /** Automatic failed-call summary of the completed work this message hands over (bounded, closed vocabulary); the receiver renders it after the body. */
  failures?: Failures;
  /** The sender stopped the recipient's current turn before queueing this message; retained for history. */
  interrupt?: boolean;
  /** Typed Pi control request; ordinary message text never dispatches commands. */
  control?: { type: "pi-reload"; core: string; terminal: string; revision: string } | ReloadAck | ModelControl | ModelAck | CutoverNotice;
};

/** A target's acknowledgement of a typed reload request: recorded and consumed silently by the caller when it succeeded. `not-applied` = it stayed recorded but never reached an idle boundary before its bound. */
export type ReloadAck = { type: "pi-reload-ack"; request: string; outcome: "verified" | "current" | "not-verified" | "not-reloaded" | "not-applied" | "not-foreground"; previous: string | null; loaded: string | null; expected: string; dirty: boolean };

/** The model, thinking level and Fast state a cutover asks for: canonical `provider/id` as in model-roles.json. */
export type ModelChoice = { model: string; thinking: string; fast: boolean };
/** A planned cutover target: its native address and label, and the exact choice requested of it. */
export type CutoverTarget = { core: string; terminal: string; label: string; requested: ModelChoice };
/** One cutover operation: explicit identity and the full planned target list, never guessed from timing. `requested` adds one ordinary settled message; `silent` keeps every routine outcome passive. */
export type CutoverOperation = { id: string; targets: CutoverTarget[]; completion: "silent" | "requested" };
/** Typed model cutover request: the exact choice plus the operation it belongs to. */
export type ModelControl = { type: "pi-model"; model: string; thinking: string; fast: boolean; operation?: CutoverOperation };
/** One target's typed outcome: the request it answers (null when never queued) and the state it really runs afterwards (null only when unobserved), never the requested choice copied over. */
export type ModelAck = {
  type: "pi-model-ack";
  request: string | null;
  operation: CutoverOperation;
  target: CutoverTarget;
  outcome: "applied" | "failed";
  actual: { model: string | null; thinking: string | null; fast: boolean | null } | null;
  problems: string[];
};
/** The producer's notice of one operation: it opens the caller's card before any acknowledgement. */
export type CutoverNotice = { type: "pi-model-operation"; operation: CutoverOperation };
/** The reason a model control is invalid, or undefined. Shared by sender and receiver. */
export function modelControlError(control: ModelControl): string | undefined {
  try { validateModelIdentifier(control.model, "model"); } catch (error) { return error instanceof Error ? error.message : String(error); }
  if (control.model !== control.model.trim()) return "model must be an exact provider/model identifier";
  if (!(THINKING_LEVELS as Set<string>).has(control.thinking)) return `thinking must be one of ${[...THINKING_LEVELS].join(", ")}`;
  if (typeof control.fast !== "boolean") return "fast must be a boolean";
  return undefined;
}

/** A cutover operation id: the producer's explicit identity, `cut-` plus 8 hex digits. */
export const CUTOVER_ID = /^cut-[0-9a-f]{8}$/;
/** The address fields of a terminal, as used for membership checks. */
export type EndpointRef = { core: string; terminal: string };
/** Why a cutover operation is invalid, or undefined; `self` requires it to be a planned target. Shared by producer, receiver and caller. */
export function operationError(operation: CutoverOperation | undefined, self?: EndpointRef): string | undefined {
  if (!operation) return "a cutover request needs its operation (explicit id and planned targets)";
  if (typeof operation.id !== "string" || !CUTOVER_ID.test(operation.id)) return "operation id must be cut-<8 hex digits>";
  if (operation.completion !== "silent" && operation.completion !== "requested") return 'operation completion must be "silent" or "requested"';
  if (!Array.isArray(operation.targets) || operation.targets.length === 0) return "operation needs at least one planned target";
  if (operation.targets.length > 64) return "operation plans more than 64 targets";
  const seen = new Set<string>();
  for (const target of operation.targets) {
    if (typeof target?.core !== "string" || !target.core || typeof target.terminal !== "string" || !target.terminal || typeof target.label !== "string" || !target.label) return "every planned target needs a core, terminal and label";
    const key = `${target.core}\u0000${target.terminal}`;
    if (seen.has(key)) return `target ${target.terminal} is planned twice`;
    seen.add(key);
    const invalid = modelControlError({ type: "pi-model", ...target.requested });
    if (invalid) return `planned target ${target.label}: ${invalid}`;
  }
  if (self && !operation.targets.some((target) => target.core === self.core && target.terminal === self.terminal)) return `operation ${operation.id} does not plan this terminal (${self.terminal})`;
  return undefined;
}
/** Why a typed acknowledgement is malformed, or undefined. It never decides origin or outbound request: the caller binds it to its journal and plan. */
export function ackError(ack: ModelAck): string | undefined {
  if (ack?.type !== "pi-model-ack") return "not a cutover acknowledgement";
  if (ack.request !== null && !ID_PATTERN.test(String(ack.request))) return "ack request must be a message id or null";
  if (ack.outcome !== "applied" && ack.outcome !== "failed") return "ack outcome must be applied or failed";
  if (!Array.isArray(ack.problems) || ack.problems.some((problem) => typeof problem !== "string")) return "ack problems must be strings";
  const invalid = operationError(ack.operation) ?? operationError({ ...ack.operation, targets: [ack.target] });
  if (invalid) return invalid;
  const planned = ack.operation.targets.find((target) => target.core === ack.target.core && target.terminal === ack.target.terminal);
  if (!planned || JSON.stringify(planned) !== JSON.stringify(ack.target)) return `ack target ${ack.target.terminal} is not the planned target`;
  if (ack.actual === undefined) return "ack actual must be null or observed values";
  if (ack.actual !== null) {
    const fields = ack.actual as Record<string, unknown>;
    if (["model", "thinking"].some((key) => fields[key] !== null && typeof fields[key] !== "string") || (fields.fast !== null && typeof fields.fast !== "boolean")) return "ack actual must hold observed model, thinking and Fast values, or null";
  }
  if (ack.request === null && ack.outcome !== "failed") return "an acknowledgement without a request must be a failure";
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
/**
 * Normalize a message's headline (task-737): a headline longer than HEADLINE_MAX is split at its last
 * word boundary within the limit, and the rest becomes the first detail line, before any existing ones.
 * The headline is the one `headlineOf` reads (the first non-blank line, trimmed), wherever leading blank
 * lines put it; only the split boundary changes, so the prefix, the remaining detail lines and any
 * trailing blank lines stay byte-for-byte. Nothing is dropped — an unbroken first token is cut at the
 * limit — and a body whose headline already fits is returned unchanged. Pure; shared by agent_send and report.
 */
export function splitHeadline(text: string): string {
  if (headlineOf(text).length <= HEADLINE_MAX) return text;
  const start = text.length - text.trimStart().length;
  const newline = text.indexOf("\n", start);
  const line = text.slice(start, newline < 0 ? text.length : newline);
  const end = start + line.trimEnd().length;
  let split = -1;
  for (let at = Math.min(start + HEADLINE_MAX, end - 1); at > start; at--) {
    if (/\s/.test(text[at]!)) { split = at; break; }
  }
  const cut = split < 0 ? start + HEADLINE_MAX : split;
  const next = split < 0 ? cut : cut + 1;
  return `${text.slice(0, cut)}\n${text.slice(next)}`;
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

const LINKED_TASK = /^([A-Za-z0-9._-]+):(task-\d+(?:-\d+)*)$/;

/** The explicitly linked Task from the sender's project-qualified hc `task=` label. */
export function linkedTask(view: Pick<Envelope, "task">): { project: string; id: string } | undefined {
  const match = LINKED_TASK.exec(view.task ?? "");
  return match ? { project: match[1]!, id: match[2]! } : undefined;
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
      return link && link.id === task.id && link.project === task.project;
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
