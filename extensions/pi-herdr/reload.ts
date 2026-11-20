import { newId } from "../pi-agency/state.ts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { livePis, pullBehind, reloadOwner, resourceRevision } from "../../scripts/live-pis.ts";
import { terminalWho } from "../../scripts/whois.ts";
import { ackError, messages, modelControlError, operationError, readEvents, type CutoverOperation, type Envelope, type ModelAck, type ModelControl, type ReloadAck } from "../pi-agency/inbox/envelope.ts";
import { inboxGate } from "../pi-agency/inbox/gate.ts";
import { sendAgentMessage } from "../pi-agency/inbox/send.ts";
import { OPENAI_FAST_STATE_EVENT, type OpenAIFastState } from "../pi-providers/openai/events.ts";
import { hcEndpoint, hcJson, hcMachines } from "./core.ts";
import { sourceFingerprint } from "./fingerprint.ts";
import { cutoverStatus, isSuccess, settleCutover, settleOf, summaryCutover, summarySweep, type Ack, type Row, type Sweep } from "./reload-summary.ts";
import { SELF_RELOAD_EVENT, type SelfReloadState } from "./turn-label.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REQUEST = "pi-reload-request";
const OUTCOME = "pi-reload-outcome";
const SUMMARY = "pi-reload-summary";
const ACK = "pi-reload-ack";
const SWEEP = "pi-reload-sweep";
const SWEEP_DONE = "pi-reload-sweep-done";
const NOTIFIED = "pi-reload-notified";
const PENDING = "pi-reload-pending";
const FAILURE = "pi-reload-failure";
/** The self-reload entry recorded at a trigger point; its text is the prompt the turn must not lose. */
const SELF = "pi-self-reload";
/** Append-only receipt that the entry's prompt was handed back (or deliberately dropped). */
const SELF_DONE = "pi-self-reload-done";
type SelfRequest = {
  id: string;
  at: string;
  from: string;
  expected: string;
  /** The prompt this trigger point consumed; empty at the idle boundary, where no turn was waiting. */
  text: string;
  images?: { type: "image"; data: string; mimeType: string }[];
  /** This attempt's number for its target fingerprint; a fresh fingerprint starts again at 1. */
  attempts?: number;
};
/** Attempts allowed for one target fingerprint before the runtime stops trying and says so once. */
const SELF_ATTEMPTS = 3;
const MODEL_REQUEST = "pi-model-request";
const MODEL_OUTCOME = "pi-model-outcome";
/** One cutover operation's card, per-target acks, and its at-most-one alert and completion. */
const CUTOVER = "pi-model-cutover";
const CUTOVER_ACK = "pi-model-ack";
const CUTOVER_ALERT = "pi-model-cutover-alert";
const CUTOVER_COMPLETE = "pi-model-cutover-complete";
const CUTOVER_REJECTED = "pi-model-cutover-rejected";
const CUTOVER_FAILURE = "pi-model-cutover-failure";
const CUTOVER_DONE = "pi-model-cutover-done";
type Owner = { core: string; terminal: string; label: string };
type Request = { id: string; previous: string | null; expected: string; owner: Owner };
/** A recorded request plus the session entry's time, which bounds how long it may stay unapplied. */
type Recorded = Request & { at: string };
type SweepRequest = { id: string; previous: string | null; expected: string };
type ModelRequest = { id: string; owner: Owner; control: ModelControl };
type Summary = { lines: string[]; detail: string[]; sweep?: Sweep };
const short = (value: string | null) => value?.slice(0, 8) ?? "unknown";
/** Private /pi-reload argument: Pi sends it to itself at the idle boundary. Argument completion never suggests it, so the command list stays one entry. */
const APPLY_ARG = "--internal-apply";
/** The second private argument: the one self-reload mechanism, reached from either trigger point. */
const SELF_ARG = "--internal-self";
/** A recorded request that still cannot apply after this long is answered with a visible outcome instead of staying pending. */
const DEFER_BOUND_MS = 10 * 60_000;
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
/** This process's group and its tty's foreground group, from /proc/self/stat (fields after the command name: state ppid pgrp session tty_nr tpgid). */
const ttyGroups = () => {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { pgid: Number(fields[2]), foreground: Number(fields[5]) };
};

/** Existing inbox interception + documented target-owned command dispatch; never terminal keys. */
export function registerPiReload(pi: ExtensionAPI): {
  /** The inbox transform: typed control envelopes, and the model turns nothing else claims. */
  deliver: (env: Envelope, ctx: ExtensionContext) => Promise<null | undefined>;
  /** Keeps an inbox message queued when its turn would otherwise start on sources this Pi no longer matches. */
  keep: (env: Envelope, ctx: ExtensionContext) => boolean;
} {
  let loaded: string | null = null;
  /** The one fingerprint of the sources this Pi loaded at its last session_start; both triggers compare against it. */
  let sources = "";
  /**
   * The id of the self-reload entry whose `/pi-reload --internal-self` this runtime sent. The dispatch
   * runs synchronously, so an unresolved entry whose id is not this one has no dispatch in flight any
   * more: it will never complete, and leaving it open would latch every trigger (task-757).
   */
  let selfDispatch: string | null = null;
  /** One visible notice per target fingerprint when its attempts are exhausted. */
  let selfExhausted = "";
  let localChanges = false;
  let own: Owner | undefined;
  let supported = false;
  // Request ids the private apply command was already sent for at this idle boundary; the next agent_settled clears it so a lost dispatch is retried, never stranded.
  let dispatched = "";
  // Deferral reasons already recorded per request id, so a waiting request shows once, not on every idle event.
  const deferrals = new Map<string, string>();
  const summarize = (lines: string[], detail: string[] = [], sweep?: Sweep) => pi.appendEntry<Summary>(SUMMARY, { lines, detail, ...(sweep ? { sweep } : {}) });
  // Acknowledgements recorded on this caller, rebuilt from its session entries; the sweep card reads them live.
  const acks = new Map<string, Ack>();
  const sent = new Set<string>();
  const notified = new Set<string>();
  // Cutover cards on this caller, rebuilt from its append-only session entries.
  const cutovers = new Map<string, CutoverOperation>();
  const cutoverAcks = new Map<string, ModelAck>();
  const cutoverAlerts = new Set<string>();
  const cutoverCompletions = new Set<string>();
  let sweeping = false;
  const readAcks = (ctx: ExtensionContext) => {
    acks.clear();
    notified.clear();
    deferrals.clear();
    cutovers.clear();
    cutoverAcks.clear();
    cutoverAlerts.clear();
    cutoverCompletions.clear();
    // A pending state already recorded for a request is not recorded again after a resume.
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      if (e.type !== "custom") continue;
      if (e.customType === NOTIFIED) notified.add(e.data.sweep);
      else if (e.customType === ACK) acks.set(e.data.request, e.data);
      else if (e.customType === CUTOVER) cutovers.set(e.data.operation.id, e.data.operation);
      else if (e.customType === CUTOVER_ACK) cutoverAcks.set(`${e.data.operation.id}\u0000${e.data.target.terminal}`, e.data);
      else if (e.customType === CUTOVER_ALERT) cutoverAlerts.add(e.data.operation);
      else if (e.customType === CUTOVER_COMPLETE) cutoverCompletions.add(e.data.operation);
      else if (e.customType === PENDING) deferrals.set(e.data.id, e.data.why);
    }
  };
  // Entries are append-only: a late acknowledgement is a new hidden entry, and the card's component reads `acks` at render time, so the same card shows it on the repaint that appending triggers.
  const recordAck = (ack: Ack) => { pi.appendEntry(ACK, ack); acks.set(ack.request, ack); };
  /** One outcome per planned target of one operation; a different operation never shares its rows. */
  const ackKey = (ack: ModelAck) => `${ack.operation.id}\u0000${ack.target.terminal}`;
  const ackRows = (operation: CutoverOperation) => new Map([...cutoverAcks.values()].filter((ack) => ack.operation.id === operation.id).map((ack) => [ack.target.terminal, ack]));
  /** Record an operation once: a notice after its acks, or an echoed operation, never forks the group. */
  const recordCutover = (operation: CutoverOperation) => { if (cutovers.has(operation.id)) return; cutovers.set(operation.id, operation); pi.appendEntry(CUTOVER, { operation }); };
  /** Record one target's outcome once; a validated target acknowledgement supersedes a provisional local send-failure row. */
  const recordCutoverAck = (ack: ModelAck) => {
    const existing = cutoverAcks.get(ackKey(ack));
    if (existing && !(existing.request === null && ack.request !== null)) return false;
    recordCutover(ack.operation);
    cutoverAcks.set(ackKey(ack), ack);
    pi.appendEntry(CUTOVER_ACK, ack);
    return true;
  };
  /** One ordinary message: the first failure's alert, or the requested settled completion. */
  const sendCutover = (ctx: ExtensionContext, customType: string, content: string, operation: CutoverOperation, rows: string[]) =>
    pi.sendMessage({ customType, display: true, details: { operation: operation.id, rows }, content }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
  /** The first failure of an operation wakes once; every later acknowledgement only updates its card. */
  const alertCutover = (ctx: ExtensionContext, operation: CutoverOperation) => {
    if (cutoverAlerts.has(operation.id)) return;
    cutoverAlerts.add(operation.id);
    pi.appendEntry(CUTOVER_ALERT, { operation: operation.id });
    const card = summaryCutover(operation, ackRows(operation));
    sendCutover(ctx, CUTOVER_FAILURE, `Model cutover ${operation.id}: ${card.compact.map((part) => part.text).join("; ")}`, operation, card.rows);
  };
  /** One settled message, only when the producer asked for it and every planned target is acknowledged. */
  const completeCutover = (ctx: ExtensionContext, operation: CutoverOperation) => {
    if (operation.completion !== "requested" || cutoverCompletions.has(operation.id) || !settleCutover(operation, ackRows(operation)).settled) return;
    cutoverCompletions.add(operation.id);
    pi.appendEntry(CUTOVER_COMPLETE, { operation: operation.id });
    const card = summaryCutover(operation, ackRows(operation));
    sendCutover(ctx, CUTOVER_DONE, `Model cutover ${operation.id} settled: ${card.compact.map((part) => part.text).join("; ")}`, operation, card.rows);
  };
  /** Bind an acknowledgement to its origin, this caller's own outbound request and the planned values. */
  const cutoverAckError = (ack: ModelAck, env: Envelope): string | undefined => {
    const invalid = ackError(ack);
    if (invalid) return invalid;
    const { target } = ack;
    const known = cutovers.get(ack.operation.id);
    if (known && JSON.stringify(known.targets) !== JSON.stringify(ack.operation.targets)) return `operation ${ack.operation.id} differs from the one already recorded`;
    if (ack.request === null) return env.from.core === own!.core && env.from.terminal === own!.terminal ? undefined : `a target's failed request must come from this caller, not ${env.from.terminal}`;
    if (env.from.core !== target.core || env.from.terminal !== target.terminal) return `acknowledgement origin ${env.from.terminal} is not planned target ${target.terminal}`;
    if (env.reply_to !== ack.request) return `acknowledgement ${env.id} does not reply to request ${ack.request}`;
    const sent = messages(readEvents()).get(ack.request);
    const control = sent?.control;
    if (!sent || sent.to.core !== target.core || sent.to.terminal !== target.terminal) return `no outbound request ${ack.request} to ${target.terminal}`;
    if (sent.from.core !== own!.core || sent.from.terminal !== own!.terminal) return `request ${ack.request} was not sent by this caller (${sent.from.terminal})`;
    if (control?.type !== "pi-model" || JSON.stringify(control.operation) !== JSON.stringify(ack.operation)) return `request ${ack.request} is not this operation`;
    if (control.model !== target.requested.model || control.thinking !== target.requested.thinking || control.fast !== target.requested.fast) return `request ${ack.request} differs from the planned request for ${target.terminal}`;
    return undefined;
  };
  /** The one ordinary message a sweep may send: once, when every request is answered and something failed. Everything else lives in the card. */
  const notifyIfSettled = (ctx: ExtensionContext) => {
    const latest = (ctx.sessionManager.getBranch() as any[]).findLast((e) => e.type === "custom" && e.customType === SUMMARY && e.data?.sweep?.id)?.data.sweep.id;
    for (const e of ctx.sessionManager.getBranch() as any[]) {
      const sweep: Sweep | undefined = e.type === "custom" && e.customType === SUMMARY ? e.data?.sweep : undefined;
      // Only the newest sweep reports: a late answer to an older, superseded sweep settles its card silently.
      if (!sweep?.id || notified.has(sweep.id) || sweep.id !== latest) continue;
      const { pending, failed } = settleOf(sweep, acks);
      if (pending || !failed) continue;
      notified.add(sweep.id);
      pi.appendEntry(NOTIFIED, { sweep: sweep.id });
      // Self-contained, with the card's own numbers: the model cannot see the card.
      const card = summarySweep(sweep, acks);
      pi.sendMessage({
        customType: FAILURE, display: true, details: { sweep: sweep.id, rows: card.rows },
        content: `Pi reload: ${card.compact.map((part) => part.text).join("; ")}`,
      }, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
    }
  };
  let fast: OpenAIFastState | undefined;
  type Applying = { request: ModelRequest; ctx: ExtensionContext; fast: boolean };
  let applying: Applying | undefined;
  pi.events.on(OPENAI_FAST_STATE_EVENT, (state) => {
    fast = state as OpenAIFastState;
    // Only armed after model and thinking are set, so model_select/session_start broadcasts never finish a request.
    if (applying?.fast) void finishModel(applying.ctx, applying.request, true);
  });
  const pending = <T = Recorded>(ctx: ExtensionContext, request = REQUEST, outcome = OUTCOME): T[] => {
    const branch = ctx.sessionManager.getBranch();
    const done = new Set(branch.filter((e) => e.type === "custom" && e.customType === outcome).map((e: any) => e.data?.id));
    return branch.filter((e) => e.type === "custom" && e.customType === request)
      .map((e: any) => ({ ...e.data, at: e.data?.at ?? e.timestamp }) as T & { id: string })
      .filter((r) => !done.has(r.id));
  };
  const route = async (owner: Owner): Promise<string> => {
    if (owner.core === own?.core) return owner.terminal;
    const machine = (await hcMachines()).find((m) => m.id === owner.core && m.state === "connected");
    if (!machine) throw new Error(`No connected native route back to ${owner.label}'s core.`);
    return `${machine.name}/${owner.terminal}`;
  };
  const acknowledge = async (ctx: ExtensionContext, request: Request, outcome: ReloadAck["outcome"]) => {
    // At most one attempt per request; no background retry or duplicate acknowledgement.
    const label = own!.label.slice(0, 80);
    const result = { verified: `reloaded, verified ${short(loaded)}`, current: `already current (${short(loaded)})`, "not-verified": `reload NOT verified (observed ${short(loaded)}, expected ${short(request.expected)})`, "not-reloaded": "not reloaded: repository HEAD changed; rerun explicitly", "not-applied": `not reloaded: still no idle boundary ${Math.round(DEFER_BOUND_MS / 60_000)} minutes after the request; rerun explicitly`, "not-foreground": "not reloaded: this Pi is a background job of its shell and would stop on tty input; restart it" }[outcome];
    pi.appendEntry(OUTCOME, { id: request.id, result, loaded, expected: request.expected });
    const control: ReloadAck = { type: "pi-reload-ack", request: request.id, outcome, previous: request.previous, loaded, expected: request.expected, dirty: localChanges };
    // A request an older caller recorded for its own reload-last is acknowledged in place (this runtime's /pi-reload no longer writes one); everything else is one typed result, which the caller consumes silently on success.
    if (isSuccess(outcome) && request.owner.core === own!.core && request.owner.terminal === own!.terminal) {
      recordAck({ request: request.id, outcome, previous: request.previous, loaded, expected: request.expected, dirty: localChanges, label: own!.label, machine: "" });
      return;
    }
    await sendAgentMessage(ctx, {
      terminal: await route(request.owner), kind: "result", control,
      ...(/^m[0-9a-f]{8}$/.test(request.id) ? { reply_to: request.id } : {}),
      body: `${label}: ${result}`,
    });
  };
  /** One outcome per model request: a typed ack for this protocol, or an ordinary failed reply for a protocol rejection. */
  const finishModel = async (ctx: ExtensionContext, request: ModelRequest, applied: boolean | string, typed = true) => {
    if (applying?.request.id === request.id) applying = undefined;
    const { model, thinking, fast: wantFast, operation } = request.control;
    const problems = typeof applied === "string" ? [applied] : [];
    if (applied === true) {
      if (`${ctx.model?.provider}/${ctx.model?.id}` !== model) problems.push("model differs from request");
      if (pi.getThinkingLevel() !== thinking) problems.push(`thinking clamped to ${pi.getThinkingLevel()}`);
      if (wantFast && !fast?.eligible) problems.push("model not Fast-eligible");
    }
    // Observed after the attempt, failed or clamped too; null only where Pi reported no state.
    const actual: NonNullable<ModelAck["actual"]> = {
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
      thinking: pi.getThinkingLevel(),
      fast: typeof fast?.enabled === "boolean" ? fast.enabled : null,
    };
    const actualText = `${actual.model ?? "no model"} · thinking ${actual.thinking ?? "unknown"} · fast ${actual.fast === null ? "unknown" : actual.fast ? "on" : "off"}`;
    const result = `${problems.length ? `model request FAILED: ${problems.join("; ")}. Actual` : "model applied. Actual"}: ${actualText}`;
    pi.appendEntry(MODEL_OUTCOME, { id: request.id, result });
    const target = operation?.targets.find((planned) => planned.core === own!.core && planned.terminal === own!.terminal);
    const ack: ModelAck | undefined = typed && operation && target ? {
      type: "pi-model-ack", request: /^m[0-9a-f]{8}$/.test(request.id) ? request.id : null, operation, target,
      outcome: problems.length ? "failed" : "applied", actual, problems,
    } : undefined;
    // The first line stays inside the 160-character headline limit; the proof continues below it.
    const body = `${own!.label.slice(0, 80)}: model ${problems.length ? "request FAILED" : "applied"}\n${result}\nRequest ${request.id}. Typed control: no model turn for the request.`;
    try {
      await sendAgentMessage(ctx, { terminal: await route(request.owner), kind: "result", ...(ack ? { control: ack } : {}), ...(/^m[0-9a-f]{8}$/.test(request.id) ? { reply_to: request.id } : {}), body });
    } finally { applyModel(ctx); }
  };
  /** Runs from the inbox transform (idle) or agent_settled: model/thinking through Pi's API, Fast through its existing owner. */
  const applyModel = (ctx: ExtensionContext) => {
    if (!own || !supported || applying || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const request = pending<ModelRequest>(ctx, MODEL_REQUEST, MODEL_OUTCOME)[0];
    if (!request) return;
    // A local record with no operation is a rejection; an accepted remote ungrouped request is applied.
    const invalid = request.control.operation ? operationError(request.control.operation, own) : request.owner.core === own.core ? "a model request that resolves to this core needs a cutover operation" : undefined;
    if (invalid) { void finishModel(ctx, request, invalid, false).catch((error) => ctx.ui.notify(`Model request outcome could not be sent: ${reason(error)}`, "warning")); return; }
    const state: Applying = applying = { request, ctx, fast: false };
    void (async () => {
      try {
        const [provider, id] = request.control.model.split("/") as [string, string];
        const target = ctx.modelRegistry.find(provider, id);
        if (!target) throw new Error(`unknown model ${request.control.model}`);
        if (!pi.getCommands().some((c) => c.name === "fast")) throw new Error("no /fast owner loaded (pi-providers)");
        if (!await pi.setModel(target)) throw new Error(`no authentication for ${request.control.model}`);
        pi.setThinkingLevel(request.control.thinking as ReturnType<typeof pi.getThinkingLevel>);
        state.fast = true; // the next Fast state is that of the /fast command below
        pi.sendUserMessage(`/fast ${request.control.fast ? "on" : "off"}`, { expandPromptTemplates: true });
      } catch (error) { await finishModel(ctx, request, reason(error)); }
    })();
  };
  /** Record, once per reason, that a recorded request is waiting: the session shows a pending state instead of nothing. */
  const defer = (requests: Recorded[], why: string) => {
    const fresh = requests.filter((request) => deferrals.get(request.id) !== why);
    if (!fresh.length) return;
    for (const request of fresh) {
      deferrals.set(request.id, why);
      pi.appendEntry(PENDING, { id: request.id, why, expected: request.expected, at: new Date().toISOString() });
    }
    summarize(
      fresh.map((request) => `Reload request ${request.id} for ${own!.label} pending: ${why}.`),
      [
        "The typed request stays recorded and applies at this Pi's next idle boundary; no model turn and no composer input.",
        `If it still cannot apply ${Math.round(DEFER_BOUND_MS / 60_000)} minutes after it was sent, it is answered with a visible outcome instead of staying pending.`,
      ],
    );
  };
  /**
   * Drive recorded requests to an outcome from the events a Pi already emits; no timer, poll or watcher.
   * A request that cannot apply now is recorded as pending with its reason, and the next idle boundary retries it.
   * Only the private apply command can reload (ctx.reload() needs a command context), so anything that can apply hands over to it.
   */
  const applyNow = async (ctx: ExtensionContext) => {
    if (!own || !supported) return;
    const requests = pending(ctx);
    if (!requests.length) { dispatched = ""; return; }
    const overdue = requests.filter((request) => Date.now() - Date.parse(request.at) >= DEFER_BOUND_MS);
    const waiting = requests.filter((request) => !overdue.includes(request));
    // A request that has waited past its bound is answered here, even while the Pi is busy: it never stays silent.
    for (const request of overdue) await acknowledge(ctx, request, "not-applied");
    if (!ctx.isIdle()) { defer(waiting, "deferred: this Pi is working; applies at its next idle boundary"); return; }
    if (ctx.hasPendingMessages()) { defer(waiting, "deferred: waiting for queued messages to finish; applies at its next idle boundary"); return; }
    if (!waiting.length) { dispatched = ""; return; }
    // One dispatch per idle boundary for the same requests; a dispatch that never ran is retried by the next boundary.
    const ids = waiting.map((request) => request.id).join(",");
    if (dispatched === ids) return;
    dispatched = ids;
    try { pi.sendUserMessage(`/pi-reload ${APPLY_ARG}`, { expandPromptTemplates: true }); }
    catch (error) { dispatched = ""; defer(waiting, `deferred: dispatching the apply command failed: ${reason(error)}`); }
  };

  const fingerprintOf = (ctx: ExtensionContext) => sourceFingerprint(ctx.cwd);
  /** The self-reload entry whose prompt has not been handed back yet; at most one per reload. */
  const pendingSelf = (ctx: ExtensionContext): SelfRequest | undefined => {
    const branch = ctx.sessionManager.getBranch() as any[];
    const done = new Set(branch.filter((e) => e.type === "custom" && e.customType === SELF_DONE).map((e) => e.data?.id));
    return branch.filter((e) => e.type === "custom" && e.customType === SELF && !done.has(e.data?.id)).map((e) => e.data as SelfRequest).at(-1);
  };
  /** Hand a consumed prompt back to Pi; the entry that recorded it is already closed. */
  const handBack = (self: SelfRequest) => {
    if (!self.text) return;
    // A prompt Pi itself cannot start (no model) surfaces as its own send error; the entry keeps the text.
    pi.sendUserMessage(self.images?.length ? [{ type: "text" as const, text: self.text }, ...self.images] : self.text,
      { expandPromptTemplates: true });
  };
  /** Close an attempt and hand its prompt back exactly once; the turn then starts on the code just loaded. */
  const replaySelf = (self: SelfRequest) => {
    pi.appendEntry(SELF_DONE, { id: self.id });
    handBack(self);
  };
  /**
   * Close an attempt left open by a dispatch that is no longer in flight: it will never complete, and an
   * open entry latches every later trigger (task-757). Its recorded prompt is not dropped here; callers
   * carry it into the next attempt, or hand it back with `replaySelf` when there is no next attempt.
   */
  const abandonSelf = (ctx: ExtensionContext): SelfRequest | undefined => {
    const self = pendingSelf(ctx);
    if (!self) return undefined;
    pi.appendEntry(SELF_DONE, { id: self.id });
    return self;
  };
  /** One prompt made of the abandoned attempt's recorded prompt and the one this trigger consumes; each arrives once. */
  const carried = (self: SelfRequest | undefined, text: string, images?: SelfRequest["images"]) => ({
    text: [self?.text ?? "", text].filter(Boolean).join("\n\n"),
    images: [...(self?.images ?? []), ...(images ?? [])],
  });
  /** This attempt's number: an abandoned attempt's count carries over only when it targeted the same fingerprint. */
  const attemptNumber = (abandoned: SelfRequest | undefined, expected: string) => abandoned?.expected === expected ? (abandoned.attempts ?? 0) + 1 : 1;
  /** Record and dispatch one attempt; a dispatch that throws leaves nothing open. */
  const dispatchSelf = (ctx: ExtensionContext, expected: string, text: string, images: SelfRequest["images"], attempts: number): boolean => {
    const self: SelfRequest = { id: newId("self-"), at: new Date().toISOString(), from: sources, expected, text, ...(images.length ? { images } : {}), attempts };
    pi.appendEntry<SelfRequest>(SELF, self);
    selfDispatch = self.id;
    try { pi.sendUserMessage(`/pi-reload ${SELF_ARG}`, { expandPromptTemplates: true }); }
    catch (error) {
      selfDispatch = null;
      pi.appendEntry(SELF_DONE, { id: self.id });
      ctx.ui.notify(`Self-reload could not start: ${reason(error)}`, "warning");
      return false;
    }
    return true;
  };
  /**
   * The attempts for one source change are exhausted: the runtime stops dispatching and says so once, so
   * a failure that will not clear is visible instead of an endless dispatch loop. Turns then run on the
   * code that is loaded, with nothing held.
   */
  const stopSelf = (ctx: ExtensionContext, expected: string, abandoned: SelfRequest | undefined) => {
    // Nothing is held: the abandoned prompt is handed back once now, and runs on the loaded code.
    if (abandoned) handBack(abandoned);
    if (selfExhausted === expected) return;
    selfExhausted = expected;
    summarize([`Self-reload stopped for sources ${short(sources)} → ${short(expected)} after ${SELF_ATTEMPTS} attempts.`],
      ["Each attempt was dispatched and its recorded prompt was handed back once; later turns run on the code that is loaded until the sources change again."]);
  };
  /**
   * Both trigger points end here: one fingerprint, one reload, and the prompt (if a turn was waiting for
   * it) continues after the reload instead of on stale code. Never mid-turn: a reason not to reload is
   * said once as `reload pending`, and that turn runs on what is loaded with nothing dropped.
   */
  const applySelf = async (ctx: ExtensionContext) => {
    selfDispatch = null;
    if (!supported || ctx.mode !== "tui") return;
    const self = pendingSelf(ctx);
    if (!self) return;
    const now = fingerprintOf(ctx);
    // Someone (a /pi-reload request, a person typing /reload) already loaded these exact sources.
    if (now.fingerprint === sources) { replaySelf(self); inboxGate.rescan(); return; }
    const groups = ttyGroups();
    const blocked = !ctx.isIdle() ? "this Pi started working"
      : ctx.hasPendingMessages() ? "queued messages are waiting"
        : groups.pgid !== groups.foreground ? "this Pi is a background job and a reload's tty replies would stop it"
          : "";
    if (blocked) {
      const state: SelfReloadState = { from: short(self.from), to: short(now.fingerprint), pending: blocked };
      pi.events.emit(SELF_RELOAD_EVENT, state);
      replaySelf(self);
      // Nothing more will reload: a message kept for this reload is delivered on the loaded code now.
      inboxGate.rescan();
      return;
    }
    summarize([`Reloading ${own!.label} before the turn: sources ${short(self.from)} → ${short(now.fingerprint)}.`],
      ["One fingerprint covers the agent dir and this project's .pi; the turn runs after this reload, never during it."]);
    await ctx.reload();
  };
  /**
   * The same fingerprint at the second trigger point, between turns: a Pi whose turns arrive as inbox
   * messages (which emit no input event) still notices, and no turn is ever reloaded underneath itself.
   */
  const selfCheck = async (ctx: ExtensionContext) => {
    if (!own || !supported || ctx.mode !== "tui" || selfDispatch !== null || sweeping) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    // A typed inbox request reloads through its own path.
    if (pending(ctx).length) return;
    // No dispatch is in flight at this boundary, so an entry still open was abandoned by a lost dispatch.
    const abandoned = abandonSelf(ctx);
    const now = fingerprintOf(ctx);
    // Nothing to reload: the abandoned prompt still runs, now, on the code that is loaded.
    if (now.fingerprint === sources) { if (abandoned) handBack(abandoned); return; }
    // A new source change starts counting again.
    if (selfExhausted !== now.fingerprint) selfExhausted = "";
    const attempts = attemptNumber(abandoned, now.fingerprint);
    if (attempts > SELF_ATTEMPTS) { stopSelf(ctx, now.fingerprint, abandoned); return; }
    // The abandoned attempt's prompt rides into this one, so the new runtime hands it back exactly once.
    const { text, images } = carried(abandoned, "");
    dispatchSelf(ctx, now.fingerprint, text, images, attempts);
  };

  pi.registerEntryRenderer<Summary>(SUMMARY, (entry, options, theme) => ({
    // Built at render time so a late acknowledgement shows in the same card on the next repaint.
    render: (width: number) => {
      const data = entry.data!;
      // Entry renderers get no outputPad (only message renderers do): the documented Box(1, 1) card.
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      let body: string;
      let detail = data.detail;
      if (data.sweep) {
        const sweep = summarySweep(data.sweep, acks);
        body = sweep.compact.map((part) => part.tone ? theme.fg(part.tone, part.text) : part.text).join(" · ");
        detail = sweep.detail;
      } else body = data.lines.join("\n");
      box.addChild(new Text(`${theme.fg("accent", theme.bold("Pi reload"))}\n${body}`, 0, 0));
      if (options.expanded && detail.length) box.addChild(new Text(theme.fg("muted", detail.join("\n")), 0, 0));
      return box.render(width);
    },
    invalidate() {},
  }));

  pi.registerEntryRenderer<{ operation: CutoverOperation }>(CUTOVER, (entry, options, theme) => ({
    render: (width: number) => {
      const operation = entry.data!.operation;
      const card = summaryCutover(operation, ackRows(operation));
      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
      const body = card.compact.map((part) => part.tone ? theme.fg(part.tone, part.text) : part.text).join(" · ");
      const title = `${theme.fg("accent", theme.bold("Model cutover"))} ${theme.fg("muted", `${operation.id} · ${operation.targets.length} target${operation.targets.length === 1 ? "" : "s"}`)}`;
      box.addChild(new Text(`${title}\n${body}`, 0, 0));
      if (options.expanded && card.detail.length) box.addChild(new Text(theme.fg("muted", card.detail.join("\n")), 0, 0));
      return box.render(width);
    },
    invalidate() {},
  }));

  // The one settled or failure message: one tone line compact, the per-target proof expanded; same box as the card.
  const cutoverMessage = (message: any, options: any, theme: any) => {
    const rows = ((message.details ?? {}) as { rows?: string[] }).rows ?? [];
    const box = new Box(options.outputPad, 1, (text: string) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg(message.customType === CUTOVER_FAILURE ? "error" : "accent", String(message.content)), 0, 0));
    if (options.expanded && rows.length) box.addChild(new Text(theme.fg("muted", rows.join("\n")), 0, 0));
    return box;
  };
  pi.registerMessageRenderer(CUTOVER_FAILURE, cutoverMessage);
  pi.registerMessageRenderer(CUTOVER_DONE, cutoverMessage);

  // The one failure message: one red line compact, the per-Pi rows expanded; same box as the card.
  pi.registerMessageRenderer(FAILURE, (message, options, theme) => {
    const rows = ((message.details ?? {}) as { rows?: string[] }).rows ?? [];
    const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(theme.fg("error", String(message.content)), 0, 0));
    if (options.expanded && rows.length) box.addChild(new Text(theme.fg("muted", rows.join("\n")), 0, 0));
    return box;
  });

  pi.on("session_start", async (event, ctx) => {
    dispatched = "";
    deferrals.clear();
    applying = undefined;
    const endpoint = await hcEndpoint(process.env.HC_TERMINAL_ID!);
    own = { core: endpoint.core, terminal: endpoint.terminal, label: terminalWho(endpoint.record).label };
    supported = ctx.mode === "tui" && reloadOwner(endpoint.record);
    loaded = null;
    readAcks(ctx);
    try {
      const source = await resourceRevision(ROOT);
      loaded = source.targetRevision;
      localChanges = source.resourcesDirty;
      if (localChanges) ctx.ui.notify(`Resources HEAD ${short(loaded)}: local changes present (informational).`, "info");
    } catch (error) { ctx.ui.notify(`Cannot identify loaded resources: ${reason(error)}`, "warning"); }
    // One fingerprint of every source this Pi loads; both self-reload trigger points compare against it.
    sources = supported ? fingerprintOf(ctx).fingerprint : "";
    selfDispatch = null;
    // pi.pgid lets a sweep or sender see from hc's foreground whether this Pi still owns its terminal; pi.session is its restart hint.
    await hcJson(["label", own.terminal, `pi.resources=${loaded ?? "unknown"}`, `pi.fingerprint=${sources}`, `pi.reload=${supported ? "1" : ""}`, `pi.model-control=${supported ? "1" : ""}`, `pi.cutover=${supported ? "1" : ""}`,
      `pi.pgid=${ttyGroups().pgid}`, `pi.session=${ctx.sessionManager.getSessionFile() ?? ""}`]);
    if (event.reason === "reload") {
      for (const request of pending(ctx)) {
        await acknowledge(ctx, request, loaded === request.expected ? "verified" : "not-verified");
      }
    }
    // The self-reload this Pi asked for landed: record the new stamp, say it once, and continue the turn the
    // reload interrupted. A reload that never happened (a restart instead) never replays an old prompt silently.
    const self = pendingSelf(ctx);
    if (self && event.reason === "reload") {
      await hcJson(["label", own.terminal, `pi.reloaded=${short(sources)}`, `pi.say=reloaded to ${short(sources)}`]);
      if (self.text) {
        const state: SelfReloadState = { from: short(self.from), to: short(sources) };
        pi.events.emit(SELF_RELOAD_EVENT, state);
      }
      replaySelf(self);
    } else if (self) {
      pi.appendEntry(SELF_DONE, { id: self.id });
      summarize(["Self-reload did not complete: the prompt recorded for it was NOT replayed."], [self.text.slice(0, 400)]);
    }
    // A request recorded in an earlier session stays recorded, but is not applied from inside session_start
    // (ctx.reload() there would re-enter the session being started): it applies at this Pi's next idle boundary.
    const carried = pending(ctx);
    if (carried.length) defer(carried, "deferred: recorded in an earlier session; applies at this Pi's next idle boundary");
    // The caller reloaded itself first: this NEW runtime, not the one that was asked, starts the sweep, once.
    const branch = ctx.sessionManager.getBranch() as any[];
    const done = new Set(branch.filter((e) => e.type === "custom" && e.customType === SWEEP_DONE).map((e) => e.data.id));
    const waiting = branch.filter((e) => e.type === "custom" && e.customType === SWEEP && !done.has(e.data.id)).map((e) => e.data as SweepRequest);
    for (const request of waiting) pi.appendEntry(SWEEP_DONE, { id: request.id });
    if (waiting.length && event.reason === "reload" && supported) {
      void runSweep(ctx, waiting.at(-1)!.previous).catch((error) => ctx.ui.notify(`Pi reload sweep failed: ${reason(error)}`, "error"));
    }
  });
  pi.on("session_shutdown", async () => {
    await hcJson(["label", process.env.HC_TERMINAL_ID!, "pi.resources=", "pi.fingerprint=", "pi.reloaded=", "pi.reload=", "pi.model-control=", "pi.cutover=", "pi.pgid=", "pi.session="]);
    own = undefined;
  });
  pi.on("agent_settled", (_event, ctx) => {
    dispatched = ""; // a fresh idle boundary: retry anything a lost or bailed dispatch left recorded
    selfDispatch = null; // and no self-reload dispatch is in flight at a settled boundary any more
    applyModel(ctx);
    void applyNow(ctx);
    // The second trigger point for the same fingerprint: between turns, never during one.
    void selfCheck(ctx).catch((error) => ctx.ui.notify(`Self-reload check failed: ${reason(error)}`, "warning"));
  });
  // A turn start: the prompt was typed for code that is no longer on disk. Consume it (so the turn never starts
  // on stale code), reload, and hand it back from the new runtime as the turn that continues.
  pi.on("input", (event, ctx) => {
    if (!own || !supported || ctx.mode !== "tui" || selfDispatch !== null) return;
    // A person's prompt before it is expanded; never a queued steer/follow-up and never a replay.
    if (event.source !== "interactive" || event.streamingBehavior) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    // An entry still open here was abandoned by a lost dispatch; its prompt rides along, never dropped.
    const abandoned = abandonSelf(ctx);
    const now = fingerprintOf(ctx);
    // Nothing to reload: the abandoned prompt runs in this turn, ahead of the one just typed.
    if (now.fingerprint === sources) {
      if (!abandoned) return;
      const { text, images } = carried(abandoned, event.text, event.images);
      return { action: "transform" as const, text, ...(images.length ? { images } : {}) };
    }
    if (selfExhausted !== now.fingerprint) selfExhausted = "";
    const attempts = attemptNumber(abandoned, now.fingerprint);
    const { text, images } = carried(abandoned, event.text, event.images);
    if (attempts > SELF_ATTEMPTS) {
      stopSelf(ctx, now.fingerprint, undefined);
      // Nothing is consumed and nothing is held: this turn runs now on the loaded code.
      return { action: "transform" as const, text, ...(images.length ? { images } : {}) };
    }
    if (!dispatchSelf(ctx, now.fingerprint, text, images, attempts)) return; // the prompt runs now on the loaded code
    return { action: "handled" as const };
  });

  /** Reload this Pi for its recorded typed inbox requests (the private /pi-reload mode). */
  const applyPending = async (ctx: ExtensionContext) => {
    dispatched = "";
    if (!supported || ctx.mode !== "tui") return;
    try {
      // Not applicable now: record why. The next idle boundary retries; never re-dispatch from inside the dispatch.
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        const requests = pending(ctx);
        if (requests.length) defer(requests, ctx.isIdle() ? "deferred: waiting for queued messages to finish; applies at its next idle boundary" : "deferred: this Pi is working; applies at its next idle boundary");
        return;
      }
      const accepted: Request[] = [];
      const seen = new Set<string>();
      // Requests recorded while this runs (a second queued inbox reload, delivered during an acknowledgement) are answered in the same pass.
      for (let requests = pending(ctx); requests.length; requests = pending(ctx).filter((r) => !seen.has(r.id))) {
        const source = await resourceRevision(ROOT);
        localChanges = source.resourcesDirty;
        // A background job of its shell stops (SIGTTIN) on the tty replies a reload provokes (task-632): answer instead.
        const groups = ttyGroups();
        for (const request of requests) {
          seen.add(request.id);
          if (groups.pgid !== groups.foreground) await acknowledge(ctx, request, "not-foreground");
          // Already at HEAD: current, including a stale request for a revision HEAD has since moved past.
          else if (loaded === source.targetRevision) await acknowledge(ctx, request, "current");
          else if (source.targetRevision !== request.expected) await acknowledge(ctx, request, "not-reloaded");
          else accepted.push(request);
        }
      }
      if (!accepted.length) return;
      summarize([`Reloading ${own!.label} for ${accepted.map((request) => request.id).join(", ")}.`], [...(localChanges ? ["local changes present (informational; repository HEAD is not byte attestation)"] : []), "Typed inbox request consumed: no model turn for control dispatch. A success is acknowledged silently; only a failure starts a turn on the caller."]);
      await ctx.reload();
    } catch (error) {
      // Never silent: name what stopped the apply. The request stays recorded and the next idle boundary retries it, bounded by DEFER_BOUND_MS.
      const ids = pending(ctx).map((request) => request.id);
      summarize([`Reload deferred${ids.length ? ` for ${ids.join(", ")}` : ""}: ${reason(error)}.`], ["The recorded request retries at the next idle boundary; it is answered with an outcome if it still cannot apply."]);
    }
    return;
  };

  /** Runs in the caller's runtime that has the newest code: its loaded revision equals HEAD, or the card says it does not. */
  const runSweep = async (ctx: ExtensionContext, reloadedFrom: string | null) => {
    if (sweeping) return;
    sweeping = true;
    try {
      const inventory = await livePis();
      const source = await resourceRevision(ROOT);
      localChanges = source.resourcesDirty;
      const sweep: Sweep = { id: newId("sweep-"), ranFrom: loaded, expected: source.targetRevision, rows: [], down: [], history: [] };
      const detail: string[] = [];
      for (const machine of inventory.machines) {
        if (machine.state !== "connected") sweep.down.push({ name: machine.name, why: "offline" });
        else if (machine.error) detail.push(`${machine.name}: ${machine.error}`);
        if (!machine.history) continue;
        // Only a strictly-behind machine is fast-forwarded, before any reload is requested there; everything else is shown, never forced.
        const pull = await pullBehind(machine);
        if (pull?.ok) {
          for (const peer of inventory.pis) if (peer.core === machine.core) peer.targetRevision = machine.targetRevision;
          sweep.history.push({ machine: machine.name, text: `pulled ${short(pull.from)} → ${short(pull.to)}`, ok: true });
          detail.push(`${machine.name}: ${machine.history}; git pull --ff-only brought its checkout from ${short(pull.from)} to ${short(pull.to)}${pull.to === source.targetRevision ? "" : ` (caller HEAD is ${short(source.targetRevision)})`}.`);
        } else {
          const relation = machine.relation === "unknown" ? "unknown history" : machine.relation;
          sweep.history.push({ machine: machine.name, text: `not pulled (${pull ? `pull failed: ${pull.why}` : relation})` });
          detail.push(`${machine.name}: ${machine.history}; not pulled${pull ? `: ${pull.why}` : ""}. Its Pis reload their own checkout (${short(machine.targetRevision)}).`);
        }
      }
      sent.clear();
      for (const peer of inventory.pis) {
        if (peer.core === own!.core && peer.terminal === own!.terminal) continue;
        const row: Row = { label: peer.label, machine: peer.machine, revision: peer.targetRevision, state: "skipped", note: "" };
        const flags = peer.resourcesDirty ? "local changes present" : "";
        if (peer.shortLived) {
          Object.assign(row, { why: "child/Worker", note: "unsupported short-lived child/Worker; its owner controls its lifecycle" });
        } else if (peer.background) {
          // Stopped, or running as a background job that a reload's tty replies would stop: no request (task-632).
          Object.assign(row, { state: "failed", why: `stopped or a background job (terminal foreground: ${peer.background})`, note: `restart${peer.machine === inventory.localMachine ? "" : ` on ${peer.machine}`}: ${peer.session ? `pi --session ${peer.session}` : "its Pi"}` });
        } else if (peer.error || !peer.targetRevision || !["idle", "done", "working"].includes(peer.status)) {
          Object.assign(row, { why: peer.error ? "unreadable" : peer.status === "unknown" || !peer.targetRevision ? "no revision" : peer.status, note: `skipped ${peer.error ?? peer.status}; rerun when resolved` });
        } else if (peer.loadedRevision === peer.targetRevision) {
          Object.assign(row, { state: "current", note: [`already current (${short(peer.loadedRevision)})`, flags].filter(Boolean).join("; ") });
        } else if (!peer.reloadCapable) {
          Object.assign(row, { why: "needs bootstrap /reload", note: `bootstrap required at ${peer.address} after this version is installed locally: ordinary built-in /reload at its actual idle prompt; no receiver is loaded (reload does not pull code)` });
        } else {
          try {
            const { env } = await sendAgentMessage(ctx, {
              terminal: peer.address, kind: "request", body: `Reload shared Pi resources at your next idle boundary.\nTarget ${peer.targetRevision}; typed control, not model instructions.`,
              control: { type: "pi-reload", core: peer.core, terminal: peer.terminal, revision: peer.targetRevision },
            });
            sent.add(env.id);
            Object.assign(row, { state: "requested", request: env.id, busy: peer.status === "working", note: [`request ${env.id} delivered${peer.status === "working" ? "; deferred: it is working and applies at its own idle boundary" : "; applies at its own idle boundary"}`, flags].filter(Boolean).join("; ") });
          } catch (error) { Object.assign(row, { state: "failed", why: `request failed: ${reason(error)}`, note: "" }); }
        }
        sweep.rows.push(row);
      }
      if (localChanges) detail.push("Caller: local changes present (informational; repository HEAD is not byte attestation).");
      const stale = loaded !== source.targetRevision;
      sweep.rows.push({
        label: own!.label, machine: inventory.localMachine, revision: source.targetRevision, state: stale ? "failed" : "current",
        ...(stale ? { why: `caller runs ${short(loaded)}, HEAD is ${short(source.targetRevision)}; rerun` } : {}),
        note: reloadedFrom && reloadedFrom !== loaded ? `caller, reloaded first (${short(reloadedFrom)} → ${short(loaded)})` : `caller, already current (${short(loaded)})`,
      });
      summarize([], detail, sweep);
      notifyIfSettled(ctx);
    } finally { sweeping = false; }
  };

  pi.registerCommand("pi-reload", {
    description: "Reload this Pi first if it is behind, then ask every other live Pi to reload through its own inbox receiver; never send keys.",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      if (args.trim() === APPLY_ARG) { await applyPending(ctx); return; }
      if (args.trim() === SELF_ARG) { await applySelf(ctx); return; }
      if (args.trim()) { ctx.ui.notify("Usage: /pi-reload (no arguments)", "error"); return; }
      if (!supported || ctx.mode !== "tui" || !ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify("Use /pi-reload in a long-lived owner Pi at its idle ordinary prompt, with no pending messages.", "warning"); return;
      }
      const source = await resourceRevision(ROOT);
      localChanges = source.resourcesDirty;
      if (loaded === source.targetRevision) { await runSweep(ctx, null); return; }
      // The caller is behind HEAD: reload it first. The session entry is consumed once at the next session_start, where the sweep runs from the new code.
      pi.appendEntry<SweepRequest>(SWEEP, { id: newId("sweep-"), previous: loaded, expected: source.targetRevision });
      await ctx.reload();
      return;
    },
  });

  /**
   * A message an idle Pi is about to turn into a turn, while the sources it loaded no longer match:
   * keep it in its folder for the runtime that loads them (task-751). An idle Pi's next turn is the
   * only turn it gets, so the same self-reload it already runs between turns is started here instead,
   * and the new runtime's own inbox scan delivers that message as its turn. Nothing is unlinked,
   * delivered or recorded by this runtime, so the message is never lost, duplicated or consumed first.
   */
  const keepForReload = (env: Envelope, ctx: ExtensionContext): boolean => {
    if (!own || !supported || ctx.mode !== "tui") return false;
    // Typed controls start no model turn, and a steer belongs to the turn already running.
    if (env.control || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
    // A self-reload already in flight delivers this message from its own session_start scan.
    if (selfDispatch !== null) return true;
    // A Pi that cannot reload — a background job of its shell, as the typed request path already says —
    // delivers on the loaded code: keeping the message there would leave no event to rescan it.
    const groups = ttyGroups();
    if (groups.pgid !== groups.foreground) return false;
    const now = fingerprintOf(ctx);
    if (now.fingerprint === sources) return false;
    if (selfExhausted !== now.fingerprint) selfExhausted = "";
    // An entry still open here was abandoned by a lost dispatch: its prompt rides along into this attempt,
    // so it is not held and not dropped. The message kept below is delivered by the new runtime once.
    const abandoned = abandonSelf(ctx);
    const attempts = attemptNumber(abandoned, now.fingerprint);
    if (attempts > SELF_ATTEMPTS) {
      stopSelf(ctx, now.fingerprint, abandoned);
      return false; // the message starts its turn on the loaded code
    }
    const { text, images } = carried(abandoned, "");
    return dispatchSelf(ctx, now.fingerprint, text, images, attempts);
  };

  const deliver = async (env: Envelope, ctx: ExtensionContext): Promise<null | undefined> => {
    const control = env.control;
    if (control?.type === "pi-model-operation") {
      // The producer's own self-notice: it opens this caller's card before any acknowledgement. Only this
      // Pi's own terminal may open it; anything else is rejected passively for inspection, never recorded.
      const invalid = !own ? "this Pi has no terminal identity"
        : env.from.core !== own.core || env.from.terminal !== own.terminal ? `notice ${env.id} was not sent by this Pi (${env.from.terminal})`
          : operationError(control.operation);
      if (invalid) pi.appendEntry(CUTOVER_REJECTED, { at: new Date().toISOString(), notice: env.id, why: invalid });
      else if (control.operation) recordCutover(control.operation);
      return null;
    }
    if (control?.type === "pi-model-ack") {
      if (!own) return null;
      const ack = control;
      const why = cutoverAckError(ack, env);
      if (why) {
        pi.appendEntry(CUTOVER_REJECTED, { at: new Date().toISOString(), request: ack.request, target: ack.target?.terminal, why });
        // A misaddressed success must never become a model message; a real failure with no card is delivered as what it is.
        return ack.outcome === "applied" && ack.problems.length === 0 ? null : undefined;
      }
      if (!recordCutoverAck(ack)) return null;
      const operation = cutovers.get(ack.operation.id)!;
      // Every failure updates the visible card immediately (recordCutoverAck appended it); the operation's first one also wakes once.
      if (cutoverStatus(ack).status === "failed") alertCutover(ctx, operation);
      completeCutover(ctx, operation);
      return null;
    }
    if (control?.type === "pi-model") {
      if (!own || !env.from.core || !env.from.terminal) throw new Error("Malformed typed Pi model request; no change scheduled.");
      const request: ModelRequest = { id: env.id, control, owner: { core: env.from.core, terminal: env.from.terminal, label: env.from.label } };
      if (ctx.sessionManager.getBranch().some((e: any) => e.type === "custom" && e.customType === MODEL_REQUEST && e.data?.id === env.id)) return null;
      pi.appendEntry(MODEL_REQUEST, request);
      // Refused before any model change: unsupported endpoint, invalid operation, or a no-operation request from this core.
      const protocol = !supported ? "unsupported endpoint: only a long-lived Pi owner in tui mode applies model requests"
        : control.operation ? operationError(control.operation, own) : env.from.core === own!.core ? "a model request that resolves to this core needs a cutover operation" : undefined;
      if (protocol) { await finishModel(ctx, request, protocol, false); return null; }
      // Field validation applies to every shape, including the ungrouped remote form.
      const fields = modelControlError(control);
      if (fields) { await finishModel(ctx, request, fields, Boolean(control.operation)); return null; }
      if (control.operation) {
        const planned = control.operation.targets.find((target) => target.core === own!.core && target.terminal === own!.terminal)!;
        const mismatch = control.model !== planned.requested.model || control.thinking !== planned.requested.thinking || control.fast !== planned.requested.fast ? `request differs from the planned request for ${planned.label}` : undefined;
        if (mismatch) { await finishModel(ctx, request, mismatch); return null; }
      }
      summarize([`Model request for ${own.label} recorded${ctx.isIdle() ? " (idle dispatch)" : "; deferred until agent_settled"}: ${control.model} · thinking ${control.thinking} · fast ${control.fast ? "on" : "off"}${control.operation ? ` · cutover ${control.operation.id}` : " · ungrouped remote request"}.`], ["Control consumed by the existing inbox: no model turn and no composer input; a grouped request closes with one typed acknowledgement, an ungrouped one with one ordinary result."]);
      applyModel(ctx);
      return null;
    }
    if (control?.type === "pi-reload-ack") {
      if (acks.has(control.request)) return null; // already recorded
      const branch = ctx.sessionManager.getBranch() as any[];
      const known = sent.has(control.request) || branch.some((e) => e.type === "custom" && e.customType === SUMMARY && e.data?.sweep?.rows?.some((r: Row) => r.request === control.request));
      // A success is always silent, matched or not. A failure is the card's when it matches a sweep; with no card to hold it, it is the ordinary result it is.
      if (!known && !isSuccess(control.outcome)) return undefined;
      recordAck({ request: control.request, outcome: control.outcome, previous: control.previous, loaded: control.loaded, expected: control.expected, dirty: control.dirty, label: env.from.label, machine: env.from.machine });
      if (known) notifyIfSettled(ctx);
      return null;
    }
    if (!control || control.type !== "pi-reload") return undefined;
    if (!own || !supported || control.core !== own.core || control.terminal !== own.terminal || !/^[0-9a-f]{40,64}$/.test(control.revision) || !env.from.core || !env.from.terminal) {
      throw new Error("Misaddressed or malformed typed Pi reload request; no reload scheduled.");
    }
    if (!ctx.sessionManager.getBranch().some((e: any) => e.type === "custom" && e.customType === REQUEST && e.data?.id === env.id)) {
      pi.appendEntry<Request>(REQUEST, { id: env.id, expected: control.revision, previous: loaded, owner: { core: env.from.core, terminal: env.from.terminal, label: env.from.label } });
      summarize([`Reload request ${env.id} for ${own.label} recorded.`], ["Control consumed by the existing inbox: no model turn and no composer input. It applies at this Pi's next idle boundary."]);
    }
    await applyNow(ctx);
    return null;
  };

  return { deliver, keep: keepForReload };
}
