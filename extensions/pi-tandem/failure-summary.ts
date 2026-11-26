import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Automatic failed-call summaries for completed work (task-836): Worker ready, helper final and an
 * explicitly marked manus final. Only structured tool failures count (a tool result with isError, or a
 * failed nested call Pi records on its caller). Nothing from error text, arguments or output ever
 * leaves this module except a fixed template chosen from a closed set of codes; the tool name is
 * kept only when it is a registered tool. Pure functions, so every caller may import them freely.
 * There is no count, size or group cap anywhere (task-852): flood prevention is not this summary's job.
 */
export const FAILURE_SCOPE = "failure-scope";
/** A manus track is one scope for its whole session. */
export const trackScope = (sessionId: string): string => `track-${sessionId}`;
/** pi.events request/answer channel to the one recorder (failed-calls.ts); the bus runs handlers synchronously up to their first await. */
export const FAILURE_MEMORY_EVENT = "pi-tandem:failure-memory";
/** pi.events request/answer channel for a consumer's read-only view of its OWN current session's failure groups (task-852). */
export const FAILURE_GROUPS_EVENT = "pi-tandem:failure-groups";
/** A durable Ceph assignment binding: `{ session, scope }`, scope a delivered request id or null (unbound). Written by the recorder only. */
export const FAILURE_BINDING = "failure-binding";
/** A durable failed call with the scope captured before it ran: `{ session, id, tool, code, scope }`. Written by the recorder only. */
export const FAILURE_CALL = "failure-call";
/** The marker that opens a session's own failure history: copied (forked) entries before it are another session's. */
export const sessionScope = (sessionId: string): string => `session-${sessionId}`;

export const TEMPLATES = {
  "not-found": "tool not found",
  "arguments": "arguments rejected",
  "aborted": "operation aborted",
  "blocked": "blocked before it ran",
  "exit": "command exited non-zero",
  "timeout": "command timed out",
  "script": "script failed",
  "manus-working": "Manus is working; wait for its delivery before finish.",
  "error": "tool reported an error",
} as const;
export type FailureCode = keyof typeof TEMPLATES;

const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const ORIGIN = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNREGISTERED = "unregistered";

/** One assignment's failures: [tool, code, count] triples. `cut`: Pi's own nested-call record was incomplete, so counts are lower bounds. */
export type FailureOrigin = { id: string; calls: [string, FailureCode, number][]; cut?: true };
/** `cut`: a source's own record was incomplete; every count is a lower bound. */
export type Failures = { v: 1; origins: FailureOrigin[]; cut?: true };
/** `scope`: the Ceph request assignment captured before the call ran; absent or null when unattributed. */
export type FailureRecord = { id: string; tool: string; code: FailureCode; scope?: string | null };
type Memory = { records: FailureRecord[] };

/** The one producer text of the manus variant of worker_finish's refusal (pi-herdr/workers.ts); the Worker variant says "handoff" and stays "error". */
const MANUS_WORKING = /^manus [A-Za-z0-9._-]+ is working; wait for its delivery before finish\.$/;

/** The code for what Pi itself writes for a failure; anything else (including any extension's free text) is "error". */
export function classify(text: string, tool?: string): FailureCode {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (tool === "worker_finish" && MANUS_WORKING.test(text)) return "manus-working";
  if (/^Tool \S+ not found$/.test(text)) return "not-found";
  if (text.startsWith('Validation failed for tool "')) return "arguments";
  if (text === "Operation aborted") return "aborted";
  if (text === "Tool execution was blocked") return "blocked";
  if (/Command exited with code -?\d+$/.test(text)) return "exit";
  if (/(^|\n)Command timed out after \d+ seconds/.test(text)) return "timeout";
  if (first === "Script failed") return "script";
  return "error";
}

const textOf = (content: unknown): string => Array.isArray(content)
  ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
export const resultText = (result: unknown): string => textOf((result as { content?: unknown } | null)?.content);

const toolName = (name: unknown, known: ReadonlySet<string>): string => typeof name === "string" && TOOL.test(name) && known.has(name) ? name : UNREGISTERED;

function origin(id: string, records: FailureRecord[], cut: boolean, known: ReadonlySet<string>): FailureOrigin | undefined {
  const counts = new Map<string, [string, FailureCode, number]>();
  for (const record of records) {
    const tool = toolName(record.tool, known);
    const key = `${tool}\u0000${record.code}`;
    const entry = counts.get(key);
    if (entry) entry[2] += 1; else counts.set(key, [tool, record.code, 1]);
  }
  const pairs = [...counts.values()].sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  if (!pairs.length && !cut) return undefined;
  return { id, calls: pairs, ...(cut ? { cut: true as const } : {}) };
}

/**
 * The one ingress check (handoff files, envelopes, received messages): throws on anything outside the closed
 * vocabulary, and returns a summary REBUILT from the validated fields only, so an unknown extra
 * field at any level can never persist or relay. Callers must use the returned value, never the input.
 */
export function validateFailures(value: unknown): Failures {
  const input = value as Failures;
  if (!input || typeof input !== "object" || input.v !== 1 || !Array.isArray(input.origins) || (input.cut !== undefined && input.cut !== true)) throw new Error("Invalid failed-call summary.");
  if (!input.origins.length) throw new Error("Invalid failed-call summary origin count.");
  const seen = new Set<string>();
  const origins: FailureOrigin[] = input.origins.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !ORIGIN.test(entry.id) || seen.has(entry.id) || !Array.isArray(entry.calls) || (entry.cut !== undefined && entry.cut !== true) || (!entry.calls.length && !entry.cut)) throw new Error("Invalid failed-call summary origin.");
    seen.add(entry.id);
    const calls = entry.calls.map((call): [string, FailureCode, number] => {
      if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || !TOOL.test(call[0]) || typeof call[1] !== "string" || !Object.hasOwn(TEMPLATES, call[1]) || !Number.isSafeInteger(call[2]) || call[2] < 1) throw new Error("Invalid failed-call summary call.");
      return [call[0], call[1], call[2]];
    });
    return { id: entry.id, calls, ...(entry.cut ? { cut: true as const } : {}) };
  });
  return { v: 1, origins, ...(input.cut ? { cut: true as const } : {}) };
}

/** Merge summaries by stable origin id: the first one seen wins, so a relayed or retried copy never counts twice. */
export function mergeFailures(parts: Array<Failures | undefined>): Failures | undefined {
  const origins = new Map<string, FailureOrigin>();
  let cut = false;
  for (const part of parts) {
    if (!part) continue;
    if (part.cut) cut = true;
    for (const entry of part.origins) if (!origins.has(entry.id)) origins.set(entry.id, entry);
  }
  if (!origins.size) return undefined;
  return { v: 1, origins: [...origins.values()], ...(cut ? { cut: true as const } : {}) };
}

type Entry = { type?: string; customType?: string; data?: any; details?: any; message?: any };

/** Failed calls of the entries from `start` on: tool results with isError and failed nested calls Pi recorded on their caller. `cut`: Pi's own nested record lost calls. */
function scan(entries: readonly Entry[], start: number): { records: Map<string, FailureRecord>; cut: boolean } {
  const records = new Map<string, FailureRecord>();
  let cut = false;
  for (const entry of entries.slice(start)) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult") continue;
    if (message.isError === true && typeof message.toolCallId === "string") records.set(message.toolCallId, { id: message.toolCallId, tool: message.toolName, code: classify(textOf(message.content), message.toolName) });
    const nested = message.nestedCalls;
    if (nested?.complete === false) cut = true;
    for (const call of nested?.calls ?? []) if (call?.status === "error" && typeof call.id === "string") records.set(call.id, { id: call.id, tool: call.name, code: classify(typeof call.error === "string" ? call.error : "", call.name) });
  }
  return { records, cut };
}

/** This scope's own failures: tool results after its marker in the session branch, plus the recorder's in-process observations (same-batch results are not persisted yet), de-duplicated by tool call id. */
export function ownFailures(entries: readonly Entry[], scopeId: string, memory: Memory, known: ReadonlySet<string>): Failures | undefined {
  const start = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.id === scopeId);
  if (start < 0) throw new Error(`No failed-call scope marker ${scopeId} in this session.`);
  const { records, cut } = scan(entries, start + 1);
  for (const record of memory.records) if (!records.has(record.id)) records.set(record.id, record);
  const mine = origin(scopeId, [...records.values()], cut, known);
  return mine ? { v: 1, origins: [mine], ...(cut ? { cut: true as const } : {}) } : undefined;
}

/** One failure group of a session: its stable signature `<tool>/<code>`, the fixed template text, and a cumulative count. */
export type FailureGroup = { signature: string; tool: string; code: FailureCode; error: string; count: number };
/** The FAILURE_GROUPS_EVENT request: the consumer sets `session`; the recorder answers `groups` and `complete` only for its own current session. */
export type FailureGroupsRequest = { session: string; groups?: FailureGroup[]; complete?: boolean };

/**
 * Every failed call (nested included) of THIS session, grouped by `<tool>/<code>`: the branch entries after the first
 * marker that names this session (copied fork entries precede it and are another session's), plus the recorder's
 * not-yet-persisted calls. `complete` is false when Pi's own nested record lost calls. Undefined when the session has
 * no marker, so a missing provenance is never reported as a clean history.
 */
export function failureGroups(entries: readonly Entry[], sessionId: string, pending: readonly FailureRecord[], known: ReadonlySet<string>): { groups: FailureGroup[]; complete: boolean } | undefined {
  const start = entries.findIndex((entry) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.session === sessionId);
  if (start < 0) return undefined;
  const { records, cut } = scan(entries, start + 1);
  for (const record of pending) if (!records.has(record.id)) records.set(record.id, record);
  const groups = new Map<string, FailureGroup>();
  for (const record of records.values()) {
    const tool = toolName(record.tool, known);
    const signature = `${tool}/${record.code}`;
    const group = groups.get(signature);
    if (group) group.count += 1; else groups.set(signature, { signature, tool, code: record.code, error: TEMPLATES[record.code], count: 1 });
  }
  return { groups: [...groups.values()].sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature)), complete: !cut };
}

const REQUEST_ID = /^m[0-9a-f]{8}$/;

/** The one request predicate for binding and attachment: kind request, no control, no reply_to, addressed to exactly this terminal (core and terminal). */
export function isCephRequest(env: any, own: { core: string; terminal: string }): env is { id: string } {
  return env?.kind === "request" && !env.control && !env.reply_to && REQUEST_ID.test(String(env.id)) && env.to?.core === own.core && env.to?.terminal === own.terminal;
}

/** This session's own branch entries: those after the first marker naming the session id. A fork copies its parent's earlier entries, which precede it and prove nothing. None when the marker is missing. */
function sessionEntries(entries: readonly Entry[], sessionId: string): readonly Entry[] {
  const start = entries.findIndex((entry) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.session === sessionId);
  return start < 0 ? [] : entries.slice(start + 1);
}

/** Whether a request satisfying the shared predicate was delivered into THIS session's own branch (never a copied fork entry). */
export function deliveredRequest(entries: readonly Entry[], sessionId: string, requestId: string, own: { core: string; terminal: string }): boolean {
  return sessionEntries(entries, sessionId).some((entry) => entry.type === "custom_message" && entry.customType === "pi-agent-message" && entry.details?.id === requestId && isCephRequest(entry.details, own));
}

/** A Worker or manus control record's identity fields: what a Ceph's dispatch recorded before the child launched. */
export type DispatchedChild = { from?: string; childSessionId: string; invocationId: string; kind?: string; owner: { core: string; terminal: string } };

/**
 * One request's Ceph failures: the ledger entries of THIS session whose captured scope is the request (nested calls
 * included), plus the recorder's unpersisted calls of that scope, plus the summaries of children it provably started
 * for exactly this request. Only this session's own branch entries count (see sessionEntries); a forked copy proves
 * nothing. A child is proven by its control record (this terminal owns it, `from` is the request) AND the delivering envelope's sender session equalling that record's child session; its origin id must be the
 * record's invocation (Worker) or track (manus). Anything else, terminal equality included, is left out.
 */
export function cephFailures(entries: readonly Entry[], sessionId: string, requestId: string, own: { core: string; terminal: string }, children: readonly DispatchedChild[], memory: Memory, known: ReadonlySet<string>): Failures | undefined {
  const records = new Map<string, FailureRecord>();
  const history = sessionEntries(entries, sessionId);
  for (const entry of history) {
    const data = entry.type === "custom" && entry.customType === FAILURE_CALL ? entry.data : undefined;
    if (data?.session === sessionId && data.scope === requestId && typeof data.id === "string" && typeof data.code === "string" && Object.hasOwn(TEMPLATES, data.code)) records.set(data.id, { id: data.id, tool: data.tool, code: data.code });
  }
  for (const record of memory.records) if (record.scope === requestId && !records.has(record.id)) records.set(record.id, record);
  const mine = origin(`ceph-${requestId}`, [...records.values()], false, known);
  const proven = children.filter((child) => child.from === requestId && child.owner.core === own.core && child.owner.terminal === own.terminal);
  const received: Failures[] = [];
  for (const entry of history) {
    if (entry.type !== "custom_message" || entry.customType !== "pi-agent-message" || !entry.details?.failures) continue;
    if (entry.details.to?.core !== own.core || entry.details.to?.terminal !== own.terminal) continue;
    const sender = entry.details.from?.session;
    const matches = proven.filter((child) => child.childSessionId === sender);
    if (!matches.length) continue;
    const failures = validateFailures(entry.details.failures);
    const origins = failures.origins.filter((item) => matches.some((child) => item.id === (child.kind === "manus" ? trackScope(child.childSessionId) : child.invocationId)));
    if (origins.length) received.push({ v: 1, origins, ...(failures.cut ? { cut: true as const } : {}) });
  }
  return mergeFailures([mine ? { v: 1, origins: [mine], ...(mine.cut ? { cut: true as const } : {}) } : undefined, ...received]);
}

/**
 * Who this manus actually started, from existing native evidence only: `workers` are the invocation ids of the
 * Worker control records this terminal owns (origin id = invocation id); `helperTerminals` are the terminals of
 * the helpers its own dendra_start results in this session named. `core` is this terminal's hc core.
 */
export type ChildEvidence = { core: string; workers: ReadonlySet<string>; helperTerminals: ReadonlySet<string> };

/** Helper terminals this session's own (top-level, successful) dendra_start results started. */
export function startedHelpers(entries: readonly Entry[]): Set<string> {
  const terminals = new Set<string>();
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult" || message.toolName !== "dendra_start" || message.isError === true) continue;
    const details = message.details;
    if (["scout", "researcher", "reviewer"].includes(details?.kind) && typeof details.terminal === "string") terminals.add(details.terminal);
  }
  return terminals;
}

/**
 * Summaries of this track's own finished children: delivered messages after the scope marker whose origin is a
 * Worker invocation this terminal owns, or a helper origin sent from a terminal this session started. Every
 * other origin (another sender, a relay of someone else's track) is left out, never assumed to be a child.
 */
export function receivedFailures(entries: readonly Entry[], scopeId: string, children: ChildEvidence): Failures[] {
  const start = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.id === scopeId);
  const accepted: Failures[] = [];
  for (const entry of entries.slice(start + 1)) {
    if (entry.type !== "custom_message" || entry.customType !== "pi-agent-message" || !entry.details?.failures) continue;
    const from = entry.details.from;
    const helperSender = from?.core === children.core && typeof from.terminal === "string" && children.helperTerminals.has(from.terminal);
    const failures = validateFailures(entry.details.failures);
    const origins = failures.origins.filter((origin) => children.workers.has(origin.id) || (helperSender && origin.id.startsWith("helper-")));
    if (origins.length) accepted.push({ v: 1, origins, ...(failures.cut ? { cut: true as const } : {}) });
  }
  return accepted;
}

/** Write the scope marker and reset the recorder: everything after it belongs to this assignment. */
export function openFailureScope(pi: ExtensionAPI, id: string): void {
  if (!ORIGIN.test(id)) throw new Error("Invalid failed-call scope id.");
  pi.events.emit(FAILURE_MEMORY_EVENT, { op: "reset" });
  pi.appendEntry(FAILURE_SCOPE, { id });
}

/** The recorder's in-process observations; throws when pi-tandem's recorder is not loaded. */
function memory(pi: ExtensionAPI): Memory {
  const request: { op: "read"; records?: FailureRecord[] } = { op: "read" };
  pi.events.emit(FAILURE_MEMORY_EVENT, request);
  if (!request.records) throw new Error("The failed-call recorder (pi-tandem) is not loaded.");
  return { records: request.records };
}

/** The summary for one assignment scope, with the children's summaries merged in when `children` is set; undefined when nothing failed. */
export function collectFailures(pi: ExtensionAPI, ctx: ExtensionContext, scopeId: string, options: { children?: ChildEvidence } = {}): Failures | undefined {
  const entries = ctx.sessionManager.getBranch() as readonly Entry[];
  const known = new Set(pi.getAllTools().map((tool) => tool.name));
  const own = ownFailures(entries, scopeId, memory(pi), known);
  return mergeFailures([own, ...(options.children ? receivedFailures(entries, scopeId, options.children) : [])]);
}

/** A Ceph's summary for the request it answers; undefined when that request's work failed nothing. Callers have already proven the request was delivered to this Ceph. */
export function collectCephFailures(pi: ExtensionAPI, ctx: ExtensionContext, requestId: string, own: { core: string; terminal: string }, children: readonly DispatchedChild[]): Failures | undefined {
  const known = new Set(pi.getAllTools().map((tool) => tool.name));
  return cephFailures(ctx.sessionManager.getBranch() as readonly Entry[], ctx.sessionManager.getSessionId(), requestId, own, children, memory(pi), known);
}

/** Section appended after a delivered message body; the headline stays line 1 of the body. */
export function renderFailures(failures: Failures): string {
  const groups = new Map<string, { tool: string; code: FailureCode; n: number; origins: string[] }>();
  let lower = failures.cut === true;
  for (const entry of failures.origins) {
    if (entry.cut) lower = true;
    for (const [tool, code, n] of entry.calls) {
      const key = `${tool}\u0000${code}`;
      const group = groups.get(key) ?? { tool, code, n: 0, origins: [] };
      group.n += n;
      group.origins.push(entry.id.slice(-8));
      groups.set(key, group);
    }
  }
  const sorted = [...groups.values()].sort((a, b) => b.n - a.n || a.tool.localeCompare(b.tool));
  const lines = sorted.map((group) => `- ${group.tool}: ${TEMPLATES[group.code]} ×${group.n} (${group.origins.length} origin${group.origins.length === 1 ? "" : "s"}: ${group.origins.join(", ")})`);
  return [`Failed tool calls (automatic; ${failures.origins.length} origin${failures.origins.length === 1 ? "" : "s"}${lower ? "; lower bound, some failures are not listed" : ""}):`, ...lines].join("\n");
}
