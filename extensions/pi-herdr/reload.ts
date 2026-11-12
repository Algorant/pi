import { newId } from "../pi-agency/state.ts";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { livePis, pullBehind, reloadOwner, resourceRevision } from "../../scripts/live-pis.ts";
import { terminalWho } from "../../scripts/whois.ts";
import { modelControlError, type Envelope, type ModelControl, type ReloadAck } from "../pi-agency/inbox/envelope.ts";
import { sendAgentMessage } from "../pi-agency/inbox/send.ts";
import { OPENAI_FAST_STATE_EVENT, type OpenAIFastState } from "../pi-providers/openai/events.ts";
import { hcEndpoint, hcJson, hcMachines } from "./core.ts";
import { sourceFingerprint } from "./fingerprint.ts";
import { isSuccess, settleOf, summarySweep, type Ack, type Row, type Sweep } from "./reload-summary.ts";
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
};
const MODEL_REQUEST = "pi-model-request";
const MODEL_OUTCOME = "pi-model-outcome";
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
export function registerPiReload(pi: ExtensionAPI): (env: Envelope, ctx: ExtensionContext) => Promise<null | undefined> {
  let loaded: string | null = null;
  /** The one fingerprint of the sources this Pi loaded at its last session_start; both triggers compare against it. */
  let sources = "";
  /** One self-reload at a time: a second trigger inside the same window is dropped, never stacked. */
  let selfReloading = false;
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
  let sweeping = false;
  const readAcks = (ctx: ExtensionContext) => {
    acks.clear();
    notified.clear();
    deferrals.clear();
    for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === NOTIFIED) notified.add(e.data.sweep);
    for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === ACK) acks.set(e.data.request, e.data);
    // A pending state already recorded for a request is not recorded again after a resume.
    for (const e of ctx.sessionManager.getBranch() as any[]) if (e.type === "custom" && e.customType === PENDING) deferrals.set(e.data.id, e.data.why);
  };
  // Entries are append-only: a late acknowledgement is a new hidden entry, and the card's component reads `acks` at render time, so the same card shows it on the repaint that appending triggers.
  const recordAck = (ack: Ack) => { pi.appendEntry(ACK, ack); acks.set(ack.request, ack); };
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
  /** One outcome per model request: record it, then one ordinary inbox result to the requester. */
  const finishModel = async (ctx: ExtensionContext, request: ModelRequest, applied: boolean | string) => {
    if (applying?.request.id === request.id) applying = undefined;
    const { model, thinking, fast: wantFast } = request.control;
    const problems = typeof applied === "string" ? [applied] : [];
    if (applied === true) {
      if (`${ctx.model?.provider}/${ctx.model?.id}` !== model) problems.push("model differs from request");
      if (pi.getThinkingLevel() !== thinking) problems.push(`thinking clamped to ${pi.getThinkingLevel()}`);
      if (wantFast && !fast?.eligible) problems.push("model not Fast-eligible");
    }
    const actual = `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"} · thinking ${pi.getThinkingLevel()} · fast ${fast?.enabled ? "on" : "off"}`;
    const result = `${problems.length ? `model request FAILED: ${problems.join("; ")}. Actual` : "model applied. Actual"}: ${actual}`;
    pi.appendEntry(MODEL_OUTCOME, { id: request.id, result });
    try {
      await sendAgentMessage(ctx, { terminal: await route(request.owner), kind: "result", ...(/^m[0-9a-f]{8}$/.test(request.id) ? { reply_to: request.id } : {}), body: `${own!.label.slice(0, 80)}: ${result}\nRequest ${request.id}. Typed control: no model turn for the request.` });
    } finally { applyModel(ctx); }
  };
  /** Runs from the inbox transform (idle) or agent_settled: model/thinking through Pi's API, Fast through its existing owner. */
  const applyModel = (ctx: ExtensionContext) => {
    if (!own || !supported || applying || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const request = pending<ModelRequest>(ctx, MODEL_REQUEST, MODEL_OUTCOME)[0];
    if (!request) return;
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
  /** Hand a consumed prompt back to Pi exactly once; the turn then starts on the code just loaded. */
  const replaySelf = (self: SelfRequest) => {
    pi.appendEntry(SELF_DONE, { id: self.id });
    if (!self.text) return;
    // A prompt Pi itself cannot start (no model) surfaces as its own send error; the entry keeps the text.
    pi.sendUserMessage(self.images?.length ? [{ type: "text" as const, text: self.text }, ...self.images] : self.text,
      { expandPromptTemplates: true });
  };
  /**
   * Both trigger points end here: one fingerprint, one reload, and the prompt (if a turn was waiting for
   * it) continues after the reload instead of on stale code. Never mid-turn: a reason not to reload is
   * said once as `reload pending`, and that turn runs on what is loaded with nothing dropped.
   */
  const applySelf = async (ctx: ExtensionContext) => {
    selfReloading = false;
    if (!supported || ctx.mode !== "tui") return;
    const self = pendingSelf(ctx);
    if (!self) return;
    const now = fingerprintOf(ctx);
    // Someone (a /pi-reload request, a person typing /reload) already loaded these exact sources.
    if (now.fingerprint === sources) { replaySelf(self); return; }
    const groups = ttyGroups();
    const blocked = !ctx.isIdle() ? "this Pi started working"
      : ctx.hasPendingMessages() ? "queued messages are waiting"
        : groups.pgid !== groups.foreground ? "this Pi is a background job and a reload's tty replies would stop it"
          : "";
    if (blocked) {
      const state: SelfReloadState = { from: short(self.from), to: short(now.fingerprint), pending: blocked };
      pi.events.emit(SELF_RELOAD_EVENT, state);
      replaySelf(self);
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
    if (!own || !supported || ctx.mode !== "tui" || selfReloading || sweeping) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const now = fingerprintOf(ctx);
    // A typed inbox request reloads through its own path, and a waiting prompt is handed back already.
    if (now.fingerprint === sources || pendingSelf(ctx) || pending(ctx).length) return;
    const self: SelfRequest = { id: newId("self-"), at: new Date().toISOString(), from: sources, expected: now.fingerprint, text: "" };
    pi.appendEntry<SelfRequest>(SELF, self);
    selfReloading = true;
    try { pi.sendUserMessage(`/pi-reload ${SELF_ARG}`, { expandPromptTemplates: true }); }
    catch (error) {
      selfReloading = false;
      pi.appendEntry(SELF_DONE, { id: self.id });
      ctx.ui.notify(`Self-reload could not start: ${reason(error)}`, "warning");
    }
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
    selfReloading = false;
    // pi.pgid lets a sweep or sender see from hc's foreground whether this Pi still owns its terminal; pi.session is its restart hint.
    await hcJson(["label", own.terminal, `pi.resources=${loaded ?? "unknown"}`, `pi.fingerprint=${sources}`, `pi.reload=${supported ? "1" : ""}`, `pi.model-control=${supported ? "1" : ""}`,
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
    await hcJson(["label", process.env.HC_TERMINAL_ID!, "pi.resources=", "pi.fingerprint=", "pi.reloaded=", "pi.reload=", "pi.model-control=", "pi.pgid=", "pi.session="]);
    own = undefined;
  });
  pi.on("agent_settled", (_event, ctx) => {
    dispatched = ""; // a fresh idle boundary: retry anything a lost or bailed dispatch left recorded
    applyModel(ctx);
    void applyNow(ctx);
    // The second trigger point for the same fingerprint: between turns, never during one.
    void selfCheck(ctx).catch((error) => ctx.ui.notify(`Self-reload check failed: ${reason(error)}`, "warning"));
  });
  // A turn start: the prompt was typed for code that is no longer on disk. Consume it (so the turn never starts
  // on stale code), reload, and hand it back from the new runtime as the turn that continues.
  pi.on("input", (event, ctx) => {
    if (!own || !supported || ctx.mode !== "tui" || selfReloading) return;
    // A person's prompt before it is expanded; never a queued steer/follow-up and never a replay.
    if (event.source !== "interactive" || event.streamingBehavior) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const now = fingerprintOf(ctx);
    // A stale prompt is consumed below instead; a self-reload already waiting is handed back by its own pass.
    if (now.fingerprint === sources || pendingSelf(ctx)) return;
    const self: SelfRequest = { id: newId("self-"), at: new Date().toISOString(), from: sources, expected: now.fingerprint, text: event.text, images: event.images };
    pi.appendEntry<SelfRequest>(SELF, self);
    selfReloading = true;
    try { pi.sendUserMessage(`/pi-reload ${SELF_ARG}`, { expandPromptTemplates: true }); }
    catch (error) {
      selfReloading = false;
      pi.appendEntry(SELF_DONE, { id: self.id });
      return; // the prompt runs now on the loaded code; the idle check reloads after it
    }
    return { action: "handled" };
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

  return async (env, ctx) => {
    const control = env.control;
    if (control?.type === "pi-model") {
      if (!own || !env.from.core || !env.from.terminal) throw new Error("Malformed typed Pi model request; no change scheduled.");
      const request: ModelRequest = { id: env.id, control, owner: { core: env.from.core, terminal: env.from.terminal, label: env.from.label } };
      const invalid = modelControlError(control) ?? (supported ? undefined : "unsupported endpoint: only a long-lived Pi owner in tui mode applies model requests");
      if (invalid) { pi.appendEntry(MODEL_REQUEST, request); await finishModel(ctx, request, invalid); }
      else if (!ctx.sessionManager.getBranch().some((e: any) => e.type === "custom" && e.customType === MODEL_REQUEST && e.data?.id === env.id)) {
        pi.appendEntry(MODEL_REQUEST, request);
        summarize([`Model request for ${own.label} recorded${ctx.isIdle() ? " (idle dispatch)" : "; deferred until agent_settled"}: ${control.model} · thinking ${control.thinking} · fast ${control.fast ? "on" : "off"}.`], ["Control consumed by the existing inbox: no model turn and no composer input."]);
        applyModel(ctx);
      }
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
}
