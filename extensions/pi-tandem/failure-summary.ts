import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Automatic failed-call summaries for completed work (task-836): Worker ready, helper final and an
 * explicitly marked manus final. Only structured tool failures count (a tool result with isError, or a
 * failed nested call Pi records on its caller). Nothing from error text, arguments or output ever
 * leaves this module except a fixed template chosen from a closed set of codes; the tool name is
 * kept only when it is a registered tool. Pure functions, so every caller may import them freely.
 */
export const FAILURE_SCOPE = "failure-scope";
/** A manus track is one scope for its whole session. */
export const trackScope = (sessionId: string): string => `track-${sessionId}`;
/** pi.events request/answer channel to the one recorder (failed-calls.ts); the bus runs handlers synchronously up to their first await. */
export const FAILURE_MEMORY_EVENT = "pi-tandem:failure-memory";

export const TEMPLATES = {
  "not-found": "tool not found",
  "arguments": "arguments rejected",
  "aborted": "operation aborted",
  "blocked": "blocked before it ran",
  "exit": "command exited non-zero",
  "timeout": "command timed out",
  "script": "script failed",
  "error": "tool reported an error",
} as const;
export type FailureCode = keyof typeof TEMPLATES;

export const MAX_GROUPS = 5;
export const MAX_ORIGINS = 32;
export const MAX_BYTES = 4096;
const MAX_PAIRS = 5;
export const MEMORY_LIMIT = 64;
const TOOL = /^[A-Za-z0-9_.-]{1,64}$/;
const ORIGIN = /^[A-Za-z0-9_.:-]{1,64}$/;
const UNREGISTERED = "unregistered";

/** One assignment's failures: [tool, code, count] triples. `cut`: more pairs existed than are listed, or Pi's own record was incomplete, so counts are lower bounds. */
export type FailureOrigin = { id: string; calls: [string, FailureCode, number][]; cut?: true };
/** `cut`: whole origins were dropped to stay within the caps; every count is a lower bound. */
export type Failures = { v: 1; origins: FailureOrigin[]; cut?: true };
export type FailureRecord = { id: string; tool: string; code: FailureCode };
type Memory = { records: FailureRecord[]; lost: boolean };

/** The code for what Pi itself writes for a failure; anything else (including any extension's free text) is "error". */
export function classify(text: string): FailureCode {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
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
  return { id, calls: pairs.slice(0, MAX_PAIRS), ...(cut || pairs.length > MAX_PAIRS ? { cut: true as const } : {}) };
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/**
 * The one ingress check (handoff files, envelopes, received messages): throws on anything outside the closed
 * vocabulary or the caps, and returns a summary REBUILT from the validated fields only, so an unknown extra
 * field at any level can never persist or relay. Callers must use the returned value, never the input.
 */
export function validateFailures(value: unknown): Failures {
  const input = value as Failures;
  if (!input || typeof input !== "object" || input.v !== 1 || !Array.isArray(input.origins) || (input.cut !== undefined && input.cut !== true)) throw new Error("Invalid failed-call summary.");
  if (!input.origins.length || input.origins.length > MAX_ORIGINS) throw new Error("Invalid failed-call summary origin count.");
  const seen = new Set<string>();
  const origins: FailureOrigin[] = input.origins.map((entry) => {
    if (!entry || typeof entry.id !== "string" || !ORIGIN.test(entry.id) || seen.has(entry.id) || !Array.isArray(entry.calls) || entry.calls.length > MAX_PAIRS || (entry.cut !== undefined && entry.cut !== true) || (!entry.calls.length && !entry.cut)) throw new Error("Invalid failed-call summary origin.");
    seen.add(entry.id);
    const calls = entry.calls.map((call): [string, FailureCode, number] => {
      if (!Array.isArray(call) || call.length !== 3 || typeof call[0] !== "string" || !TOOL.test(call[0]) || typeof call[1] !== "string" || !Object.hasOwn(TEMPLATES, call[1]) || !Number.isInteger(call[2]) || call[2] < 1 || call[2] > 1_000_000) throw new Error("Invalid failed-call summary call.");
      return [call[0], call[1], call[2]];
    });
    return { id: entry.id, calls, ...(entry.cut ? { cut: true as const } : {}) };
  });
  const canonical: Failures = { v: 1, origins, ...(input.cut ? { cut: true as const } : {}) };
  if (bytes(canonical) > MAX_BYTES) throw new Error(`Failed-call summary exceeds ${MAX_BYTES} bytes.`);
  return canonical;
}

/** Merge summaries by stable origin id: the first one seen wins, so a relayed or retried copy never counts twice. Caps drop trailing origins and mark every count a lower bound. */
export function mergeFailures(parts: Array<Failures | undefined>): Failures | undefined {
  const origins = new Map<string, FailureOrigin>();
  let cut = false;
  for (const part of parts) {
    if (!part) continue;
    if (part.cut) cut = true;
    for (const entry of part.origins) if (!origins.has(entry.id)) origins.set(entry.id, entry);
  }
  if (!origins.size) return undefined;
  let list = [...origins.values()];
  if (list.length > MAX_ORIGINS) { list = list.slice(0, MAX_ORIGINS); cut = true; }
  let merged: Failures = { v: 1, origins: list, ...(cut ? { cut: true as const } : {}) };
  while (list.length > 1 && bytes(merged) > MAX_BYTES) {
    list = list.slice(0, -1);
    merged = { v: 1, origins: list, cut: true };
  }
  return merged;
}

type Entry = { type?: string; customType?: string; data?: any; details?: any; message?: any };

/** This scope's own failures: tool results after its marker in the session branch, plus the recorder's in-process observations (same-batch results are not persisted yet), de-duplicated by tool call id. */
export function ownFailures(entries: readonly Entry[], scopeId: string, memory: Memory, known: ReadonlySet<string>): Failures | undefined {
  const start = entries.findLastIndex((entry) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.id === scopeId);
  if (start < 0) throw new Error(`No failed-call scope marker ${scopeId} in this session.`);
  const records = new Map<string, FailureRecord>();
  let cut = memory.lost;
  for (const entry of entries.slice(start + 1)) {
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role !== "toolResult") continue;
    if (message.isError === true && typeof message.toolCallId === "string") records.set(message.toolCallId, { id: message.toolCallId, tool: message.toolName, code: classify(textOf(message.content)) });
    const nested = message.nestedCalls;
    if (nested?.complete === false) cut = true;
    for (const call of nested?.calls ?? []) if (call?.status === "error" && typeof call.id === "string") records.set(call.id, { id: call.id, tool: call.name, code: classify(typeof call.error === "string" ? call.error : "") });
  }
  for (const record of memory.records) if (!records.has(record.id)) records.set(record.id, record);
  const mine = origin(scopeId, [...records.values()], cut, known);
  return mine ? { v: 1, origins: [mine], ...(cut ? { cut: true as const } : {}) } : undefined;
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
  const request: { op: "read"; records?: FailureRecord[]; lost?: boolean } = { op: "read" };
  pi.events.emit(FAILURE_MEMORY_EVENT, request);
  if (!request.records) throw new Error("The failed-call recorder (pi-tandem) is not loaded.");
  return { records: request.records, lost: request.lost === true };
}

/** The summary for one assignment scope, with the children's summaries merged in when `children` is set; undefined when nothing failed. */
export function collectFailures(pi: ExtensionAPI, ctx: ExtensionContext, scopeId: string, options: { children?: ChildEvidence } = {}): Failures | undefined {
  const entries = ctx.sessionManager.getBranch() as readonly Entry[];
  const known = new Set(pi.getAllTools().map((tool) => tool.name));
  const own = ownFailures(entries, scopeId, memory(pi), known);
  return mergeFailures([own, ...(options.children ? receivedFailures(entries, scopeId, options.children) : [])]);
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
  if (sorted.length > MAX_GROUPS) lower = true;
  const lines = sorted.slice(0, MAX_GROUPS).map((group) => {
    const shown = group.origins.slice(0, 3).join(", ");
    return `- ${group.tool}: ${TEMPLATES[group.code]} ×${group.n} (${group.origins.length} origin${group.origins.length === 1 ? "" : "s"}: ${shown}${group.origins.length > 3 ? `, +${group.origins.length - 3} more` : ""})`;
  });
  return [`Failed tool calls (automatic; ${failures.origins.length} origin${failures.origins.length === 1 ? "" : "s"}${lower ? "; lower bound, some failures are not listed" : ""}):`, ...lines].join("\n");
}
