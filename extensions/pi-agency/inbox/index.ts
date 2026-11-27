import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createAgentSendRenderer, renderAgentMessage } from "../../pi-ui/tool-ui/custom-tools/agent-inbox";
import { NSTAR_INBOX } from "../nstar-note.ts";
import { inboxGate } from "./gate.ts";
import { deliveryHint, dropLocalEnvelope, readTarget, sendAgentMessage, statusText, type SendParams } from "./send.ts";
import { ASK_MARK, askRefusal, checkAskTarget, isCephTerminal, requestStart, trackAsk, withHook, type AskPlan } from "../../pi-herdr/herdra-work.ts";
import { InboxOverlay, type InboxRow } from "../../pi-ui/tool-ui/custom-tools/inbox-overlay";
import { addressText, ageText, closeMessage, HEADLINE_MAX, ID_PATTERN, inboxDir, inboxKey, KINDS, localMachine, messages, openMessages, readEvents, recordDelivery, thread, type Endpoint, type Envelope, type MessageView } from "./envelope.ts";
import { hcEndpoint, hcJson, hcMachines, type HcMachine } from "../../pi-herdr/core.ts";
import { collectCephFailures, collectFailures, deliveredRequest, renderFailures, startedHelpers, trackScope, validateFailures } from "../../pi-tandem/failure-summary.ts";
import { listHcWorkerRecords } from "../workers/hc-record.ts";
import { hcAddress, KIND_KEY, peerName, peerText } from "../../../scripts/whois.ts";

/**
 * Agent inbox: one folder per native HC terminal. Senders drop a small JSON file via
 * temp file + rename; the Pi session in that terminal watches its folder, delivers
 * each file with pi.sendMessage as a labelled agent message (never through the
 * composer), then deletes it. Leftovers are delivered on session_start.
 */
const MESSAGE_TYPE = "pi-agent-message";

/** Preserve malformed/misaddressed files for inspection rather than delivering them. */
function readEnvelope(path: string, key: string): Envelope {
  const env = JSON.parse(readFileSync(path, "utf8"));
  if (env.v !== 1 || inboxKey(env.to) !== key) throw new Error("Unsupported or misaddressed inbox envelope.");
  return env;
}

/** A sender in another hc core, and this core's native route back to it (by permanent core id). */
const foreignCore = (env: Envelope) => env.from.core !== env.to.core;
type Routes = HcMachine[] | Error;

/** The model-facing header: id, reply, kind, sender (label@machine when remote), its address and context. */
function header(env: Envelope, routes?: Routes): string {
  const sender = peerName(env.from, env.to.machine);
  const context = env.from.context === undefined ? "" : `, context ${env.from.context}%`;
  const reply = env.reply_to ? ` ↩ ${env.reply_to}` : "";
  const machine = env.from.machine === env.to.machine ? "" : ` on ${env.from.machine}`;
  // Only requests and blocked messages invite an answer; a hint on results would invite ping-pong.
  let answer = "";
  if (env.kind !== "result" && foreignCore(env)) {
    const route = routes instanceof Error ? undefined : routes?.find((m) => m.id === env.from.core);
    answer = route ? `; answer with agent_send terminal=${route.name}/${env.from.terminal} reply_to=${env.id}`
      : `; it cannot be answered from here: ${routes instanceof Error ? `hc machine ls failed (${routes.message})` : `no machine in hc machine ls has its core ${env.from.core}`}`;
  } else if (env.kind !== "result") {
    answer = `; answer with agent_send terminal=${env.from.terminal} reply_to=${env.id}`;
  }
  return `[Agent message ${env.id}${reply} · ${env.kind} from ${sender} (${addressText(env.from)}${machine}${context}); not from Algorant${answer}]`;
}

/** Replace an envelope (Worker notices), leave it unchanged (undefined), or explicitly consume it (null, no model turn). */
export type InboxTransform = (env: Envelope, ctx: ExtensionContext) => Promise<Envelope | undefined | null>;

/**
 * Decide, before an envelope is claimed from its folder, that this runtime must not deliver it yet
 * (a reload has to land first): `true` leaves the file exactly where it is — never unlinked,
 * delivered or recorded — and a later scan delivers it on the code that is loaded then.
 */
export type InboxKeep = (env: Envelope, ctx: ExtensionContext) => boolean;

export default function piAgentInbox(pi: ExtensionAPI, transform?: InboxTransform, keep?: InboxKeep): void {
  let ctx: ExtensionContext | undefined;
  let endpoint: Endpoint | undefined;
  let watcher: FSWatcher | undefined;
  let lifecycle = 0;
  let live = false;
  let detachCompactionAbort: (() => void) | undefined;

  function releaseCompaction(): void {
    detachCompactionAbort?.();
    detachCompactionAbort = undefined;
    inboxGate.release();
  }

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => renderAgentMessage(message as any, options, theme));

  async function deliverPending(): Promise<void> {
    // Held during any compaction (see gate.ts); files stay until the release rescan.
    const scanCtx = ctx;
    const scanLifecycle = lifecycle;
    const current = () => live && lifecycle === scanLifecycle && ctx === scanCtx;
    if (!scanCtx || !endpoint || inboxGate.held || !live) return;
    const touchContext = (): boolean => {
      if (!current()) return false;
      try {
        scanCtx.isIdle();
        return true;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("This extension ctx is stale after session replacement or reload.")) throw error;
        if (lifecycle === scanLifecycle && ctx === scanCtx) {
          live = false;
          watcher?.close(); watcher = undefined;
        }
        return false;
      }
    };
    const key = inboxKey(endpoint);
    const dir = inboxDir(key);
    const pending: Array<{ path: string; env: Envelope }> = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const path = join(dir, name);
      try {
        pending.push({ path, env: readEnvelope(path, key) });
      } catch (error) {
        // Already consumed by an overlapping scan, or malformed. Malformed files
        // are never deleted: they stay for inspection and are reported each scan.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[pi-agent-inbox] Unreadable message ${path}: ${error}`);
      }
    }
    // File names are message ids, so delivery follows the send time instead.
    pending.sort((a, b) => a.env.at.localeCompare(b.env.at));
    let routes: Routes | undefined;
    if (pending.some(({ env }) => foreignCore(env))) {
      routes = await hcMachines().catch((error) => error instanceof Error ? error : new Error(String(error)));
      if (!current() || inboxGate.held) return; // reloaded or compacting meanwhile: the files wait
    }
    for (const { path, env } of pending) {
      // New work waits its turn: while this Pi is working, a message that is not blocked or an answer
      // to a question it asked stays in its inbox folder. The scan after the turn ends (agent_settled)
      // delivers it as a follow-up that starts the next turn.
      // A typed control is different: its receiver consumes it without a model turn, so it is delivered
      // while the Pi is working too. The target records it as pending and applies it at its own idle boundary.
      if (!touchContext()) return;
      if (env.kind !== "blocked" && !env.reply_to && !env.control && !scanCtx.isIdle()) continue;
      // A delivery path that cannot deliver on the loaded code keeps the message queued instead:
      // claiming it now would consume it for a turn that code no longer matches.
      if (keep?.(env, scanCtx)) continue;
      // Validate again after keep and immediately before claiming, including steers and typed controls.
      if (!touchContext()) return;
      const session = scanCtx.sessionManager.getSessionId();
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // an overlapping scan delivered it
        throw error;
      }
      const transformed = transform ? await transform(env, scanCtx) : undefined;
      if (transformed === null) {
        recordDelivery(env, session);
        continue;
      }
      let delivered = transformed ?? env;
      let failureSection = "";
      if (delivered.failures) {
        try {
          // Rebuilt from the validated fields: nothing outside the closed contract is delivered, persisted or relayed.
          const failures = validateFailures(delivered.failures);
          delivered = { ...delivered, failures };
          failureSection = `\n\n${renderFailures(failures)}`;
        }
        catch (error) {
          // A malformed summary is dropped with a note, so it can never poison a later merge; the message itself still arrives.
          console.error(`[pi-agent-inbox] Dropped invalid failed-call summary on ${delivered.id}: ${error}`);
          const { failures: _dropped, ...rest } = delivered;
          delivered = rest;
        }
      }
      // A returned envelope is prepared for delivery; if this runtime ended while awaiting the
      // transform, restore that exact envelope for the next runtime. Exceptions are never replayed.
      if (!current()) { dropLocalEnvelope(delivered); return; }
      // Only delivered messages: consumed reload controls never enter note capture.
      pi.events.emit(NSTAR_INBOX, { env: delivered, ctx: scanCtx });
      const idle = scanCtx.isIdle();
      if (idle) inboxGate.turnPending = true;
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: `${header(delivered, routes)}\n${delivered.body}${failureSection}`,
        display: true,
        details: delivered,
      }, idle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" });
      recordDelivery(delivered, session);
    }
  }

  function scan(): void {
    deliverPending().catch((error) => console.error(`[pi-agent-inbox] Inbox scan failed: ${error}`));
  }

  pi.on("session_start", async (_event, context) => {
    const starting = ++lifecycle;
    live = false;
    watcher?.close(); watcher = undefined;
    ctx = undefined; endpoint = undefined;
    const address = await hcAddress(process.env.HC_TERMINAL_ID!);
    if (lifecycle !== starting) return;
    endpoint = address;
    ctx = context;
    live = true;
    // Reload/session replacement must not inherit a hold from the previous runtime.
    detachCompactionAbort?.();
    detachCompactionAbort = undefined;
    inboxGate.held = false;
    inboxGate.turnPending = false;
    const dir = inboxDir(inboxKey(endpoint));
    mkdirSync(dir, { recursive: true });
    // Scan on any event: a rename is reported under the temp name only.
    watcher = watch(dir, () => scan());
    scan();
  });
  pi.on("agent_settled", () => scan());
  // session_compact fires before Pi has finished the compaction (it is not idle
  // yet, so a delivery would steer into nothing); the gate rescans once idle.
  inboxGate.register("inbox", { context: () => ctx, scan });
  pi.on("agent_start", () => { inboxGate.turnPending = false; });
  pi.on("session_before_compact", (event) => {
    detachCompactionAbort?.();
    inboxGate.hold();
    // Aborting a manual compaction must release delivery even before a terminal
    // compaction event arrives. Its rescan still waits for Pi to become idle.
    event.signal.addEventListener("abort", releaseCompaction, { once: true });
    detachCompactionAbort = () => event.signal.removeEventListener("abort", releaseCompaction);
    if (event.signal.aborted) releaseCompaction();
  });
  pi.on("session_compact", releaseCompaction);
  pi.on("session_compact_failed", releaseCompaction);
  pi.on("session_shutdown", () => {
    lifecycle++;
    live = false;
    watcher?.close(); watcher = undefined; ctx = undefined; endpoint = undefined;
    detachCompactionAbort?.(); detachCompactionAbort = undefined;
    inboxGate.held = false;
    inboxGate.turnPending = false;
  });

  pi.registerCommand("inbox", {
    description: "Browse agent-inbox history: open requests, recent messages and threads (c closes with a note).",
    handler: async (_args, context) => {
      const local = localMachine();
      const row = (view: MessageView): InboxRow => ({
        id: view.id, kind: view.kind, at: view.at, from: peerText(view.from, local), to: peerText(view.to, local),
        headline: view.headline, body: view.body, replyTo: view.reply_to, replies: view.replies, closed: view.closed, failed: view.failed,
      });
      const source = {
        open: () => openMessages().map(row),
        recent: () => [...messages(readEvents()).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100).map(row),
        thread: (id: string) => thread(readEvents(), id).map(row),
        close: (id: string, note: string) => closeMessage(id, note, { machine: local, ...endpoint }),
        age: (iso: string) => ageText(iso),
      };
      await context.ui.custom<void>(
        (tui, theme, _keybindings, done) => new InboxOverlay(theme, source, () => (tui as any).terminal?.rows ?? 40, () => tui.requestRender(), () => done()),
        { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } },
      );
    },
  });

  pi.registerTool({
    name: "agent_send",
    label: "Agent Send",
    description: "Queue a durable labelled message to another Pi. The recipient is terminal: an HC terminal id/name, or machine/terminal for another machine in hc machine ls, resolved at send time by its own core. Use hc ls for HC discovery; do not reuse a saved Herdra terminal id after relaunch. Delivery uses Pi's conversation API, never its composer; queued messages survive reload. A recipient that is working holds a request or result until that turn ends, then starts the next turn with it; only a blocked message or a reply (reply_to) is steered into the running turn. interrupt: true stops the recipient's current turn first, then queues this message for its next turn. Line 1 of body is the answer: one headline line of at most 160 characters, details below; a longer first line is split at its last word boundary within 160, and the rest becomes the first body line before any existing details (nothing is dropped). Kinds: request, result, blocked. A reply_to message id closes that request; so does a dispatch naming it (from:) or its explicitly linked Task (the sender's project-qualified task= label) completing or being cancelled. The result says what the recipient is doing now. Results, questions and blockers go up one level: a manus to its starter, a Ceph to Herdra (local terminal herdra, or its supplied machine-qualified route), which relays choices Algorant must make. History: ~/.pi/agent/scripts/inbox (open, recent, thread, close, reopen). On a manus’s final result use complete: ‘track’; omit it on plans, questions, check-ins and ordinary results. A Ceph’s result with reply_to to a request it was sent carries that request’s summary. The summary is attached automatically; never write it yourself.",
    promptSnippet: "Message another Pi by native HC terminal/name using its durable inbox.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        terminal: { type: "string", minLength: 1, description: "HC terminal: id/name in the local core (e.g. herdra), or machine/terminal on a machine from hc machine ls (e.g. laptop/t3); resolved by its own core at send time." },
        kind: { type: "string", enum: [...KINDS], description: "request, result, or blocked." },
        body: { type: "string", minLength: 1, description: `Message text: line 1 is the answer, a one-line headline of at most ${HEADLINE_MAX} characters; details below. A longer first line is split at its last word boundary within ${HEADLINE_MAX} and the overflow becomes the first body line, before any existing details; nothing is dropped.` },
        reply_to: { type: "string", pattern: ID_PATTERN.source, description: "Id of the agent message this answers, e.g. m4f1a2c9." },
        complete: { type: "string", enum: ["track"], description: "A manus’s final result only: marks the track complete and attaches the automatic failed-call summary. Omit it everywhere else." },
        ask: { type: "string", minLength: 1, description: "Herdra main only, kind request to a project Ceph, no reply_to: Algorant's exact words. They are appended to the queued body after \"Algorant's words, verbatim:\" and, after the queue is confirmed, tracked as one ask row (request-start, then ask adoption: two separate writes). Nothing is trimmed or changed. Refused before anything is queued if the words are empty, contain NUL, or are over about 65000 plain bytes (the CLI carries them twice, JSON-escaped, in one 131071-byte argument), or if the headline is blank, has a control character, starts with --, or is over 160 bytes." },
        interrupt: { type: "boolean", description: "Set true to stop the recipient's current turn first, then queue this message for its next turn. The result reports whether hc confirmed a stop or observed the terminal idle; if the stop is unconfirmed, the message is still queued. Default false preserves ordinary durable delivery. Blocked messages and replies (reply_to) still steer." },
      },
      required: ["terminal", "kind", "body"],
    },
    ...createAgentSendRenderer(),
    async execute(_id: string, params: SendParams & { complete?: "track"; ask?: string }, _signal: unknown, _update: unknown, context: ExtensionContext) {
      const { complete, ask, ...send } = params;
      let askPlan: AskPlan | undefined;
      if (ask !== undefined) {
        if (send.kind !== "request" || send.reply_to || complete !== undefined || send.control) throw new Error("ask applies only to a new request (no reply_to, no complete); nothing was queued.");
        const refusal = askRefusal(ask, send.body);
        if (refusal) throw new Error(`ask refused: ${refusal}; nothing was queued.`);
        send.body = `${send.body}${ASK_MARK}${ask}`;
        send.beforeQueue = async ({ target, self, caller }) => { askPlan = await checkAskTarget(target, caller, self); };
      }
      let failures: Envelope["failures"];
      if (complete !== undefined) {
        if (complete !== "track") throw new Error('complete must be "track".');
        if (send.kind !== "result") throw new Error('complete: "track" applies only to kind "result".');
        if (!process.env.HC_TERMINAL_ID || (await hcJson(["get", process.env.HC_TERMINAL_ID])).labels?.[KIND_KEY] !== "manus") throw new Error('complete: "track" is only for a manus’s final result; this terminal is not a manus. Nothing was sent.');
        // This track's own failures plus the summaries of the Workers and helpers it started, merged by origin.
        // A child is proven by existing native evidence only: Worker records this terminal owns, and the helper
        // terminals its own dendra_start results named; any other sender's summary is not this track's.
        const own = await hcAddress(process.env.HC_TERMINAL_ID);
        const workers = new Set((await listHcWorkerRecords()).filter((record) => record.owner.core === own.core && record.owner.terminal === own.terminal).map((record) => record.invocationId));
        failures = collectFailures(pi, context, trackScope(context.sessionManager.getSessionId()), { children: { core: own.core, workers, helperTerminals: startedHelpers(context.sessionManager.getBranch() as any) } });
      } else if (send.kind === "result" && send.reply_to && process.env.HC_TERMINAL_ID) {
        // A Ceph's answer to a request it was delivered carries that request's own failures and nothing else's; any other
        // reply (and any send that is not exactly kind result with reply_to) carries none.
        const { terminal, core, record } = await hcEndpoint(process.env.HC_TERMINAL_ID);
        if (isCephTerminal({ core, terminal, record }) && deliveredRequest(context.sessionManager.getBranch() as any, context.sessionManager.getSessionId(), send.reply_to, { core, terminal })) {
          const children = (await listHcWorkerRecords()).filter((child) => child.owner.core === core && child.owner.terminal === terminal);
          failures = collectCephFailures(pi, context, send.reply_to, { core, terminal }, children);
        }
      }
      const { env, file, interruptOutcome, self } = await sendAgentMessage(context, { ...send, ...(failures ? { failures } : {}) });
      const to = peerName(env.to, localMachine());
      // Delivery itself is asynchronous; the recipient's status now says when it lands (task-555).
      const read = await readTarget(env.to, env.from.core!);
      const target = read?.status;
      // Herdra main's request to a Ceph opens its widget row; the same recipient read decides, and a failure never touches the queued send.
      const hook = ask !== undefined ? await trackAsk(env, self, read, ask, askPlan!) : await requestStart(env, self, read);
      const now = target ? ` ${to} is ${statusText(target)} now: ${deliveryHint(target, interruptOutcome)}.` : interruptOutcome ? ` ${deliveryHint({ state: "unknown", route: params.terminal }, interruptOutcome)}.` : "";
      return withHook({
        content: [{ type: "text" as const, text: `Queued ${env.kind} ${env.id}${env.reply_to ? ` (reply to ${env.reply_to})` : ""} for ${to} (${addressText(env.to)}); it is delivered into that Pi conversation when it is running.${now} inbox thread ${env.id} shows queued, delivered or failed.` }],
        details: { envelope: env, file, ...(target ? { target } : {}) },
      }, hook);
    },
  } as any);
}
