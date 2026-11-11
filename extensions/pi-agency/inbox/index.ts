import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { createAgentSendRenderer, renderAgentMessage } from "../../pi-ui/tool-ui/custom-tools/agent-inbox";
import { NSTAR_INBOX } from "../nstar-note.ts";
import { inboxGate } from "./gate.ts";
import { deliveryHint, dropLocalEnvelope, sendAgentMessage, statusText, targetStatus, type SendParams } from "./send.ts";
import { InboxOverlay, type InboxRow } from "../../pi-ui/tool-ui/custom-tools/inbox-overlay";
import { addressText, ageText, checkHeadline, closeMessage, HEADLINE_MAX, ID_PATTERN, inboxDir, inboxKey, KINDS, localMachine, messages, openMessages, readEvents, recordDelivery, steersWhileWorking, thread, type Endpoint, type Envelope, type MessageView } from "./envelope.ts";
import { hcMachines, type HcMachine } from "../../pi-herdr/core.ts";
import { hcAddress, peerName, peerText } from "../../../scripts/whois.ts";

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

export default function piAgentInbox(pi: ExtensionAPI, transform?: InboxTransform): void {
  let ctx: ExtensionContext | undefined;
  let endpoint: Endpoint | undefined;
  let watcher: FSWatcher | undefined;
  let detachCompactionAbort: (() => void) | undefined;

  function releaseCompaction(): void {
    detachCompactionAbort?.();
    detachCompactionAbort = undefined;
    inboxGate.release();
  }

  pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => renderAgentMessage(message as any, options, theme));

  async function deliverPending(): Promise<void> {
    // Held during any compaction (see gate.ts); files stay until the release rescan.
    if (!ctx || !endpoint || inboxGate.held) return;
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
      if (!ctx || inboxGate.held) return; // reloaded or compacting meanwhile: the files wait
    }
    for (const { path, env } of pending) {
      // New work waits its turn: while this Pi is working, a message that is not a blocked message, an
      // answer to a question it asked, or a flagged correction stays in its inbox folder. The scan after
      // the turn ends (agent_settled) delivers it as a follow-up that starts the next turn.
      if (!steersWhileWorking(env) && !ctx.isIdle()) continue;
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // an overlapping scan delivered it
        throw error;
      }
      const session = ctx.sessionManager.getSessionId();
      const transformed = transform ? await transform(env, ctx) : undefined;
      if (transformed === null) {
        recordDelivery(env, session);
        continue;
      }
      const delivered = transformed ?? env;
      // Reloaded or shut down while the transform ran: requeue its result for the next runtime.
      if (!ctx) { dropLocalEnvelope(delivered); return; }
      // Only delivered messages: consumed reload controls never enter note capture.
      pi.events.emit(NSTAR_INBOX, { env: delivered, ctx });
      const idle = ctx.isIdle();
      if (idle) inboxGate.turnPending = true;
      pi.sendMessage({
        customType: MESSAGE_TYPE,
        content: `${header(delivered, routes)}\n${delivered.body}`,
        display: true,
        details: delivered,
      }, idle ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "steer" });
      recordDelivery(delivered, ctx.sessionManager.getSessionId());
    }
  }

  function scan(): void {
    deliverPending().catch((error) => console.error(`[pi-agent-inbox] Inbox scan failed: ${error}`));
  }

  pi.on("session_start", async (_event, context) => {
    endpoint = await hcAddress(process.env.HC_TERMINAL_ID!);
    ctx = context;
    // Reload/session replacement must not inherit a hold from the previous runtime.
    detachCompactionAbort?.();
    detachCompactionAbort = undefined;
    inboxGate.held = false;
    inboxGate.turnPending = false;
    const dir = inboxDir(inboxKey(endpoint));
    mkdirSync(dir, { recursive: true });
    watcher?.close();
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
    description: "Queue a durable labelled message to another Pi. The recipient is terminal: an HC terminal id/name, or machine/terminal for another machine in hc machine ls, resolved at send time by its own core. Use hc ls for HC discovery; do not reuse a saved Herdra terminal id after relaunch. Delivery uses Pi's conversation API, never its composer; queued messages survive reload. A recipient that is working holds a request or result until that turn ends, then starts the next turn with it; only a blocked message, a reply (reply_to) or interrupt: true is steered into the running turn. Line 1 of body is the answer: one headline line of at most 160 characters, details below; a longer first line is rejected unsent. Kinds: request, result, blocked. A reply_to message id closes that request; so do a dispatch naming it (from:) and its linked Task (sender's task= label, or task-N in it) completing or being cancelled. The result says what the recipient is doing now. Results, questions and blockers go up one level: a manus to its starter, a Ceph to Herdra (local terminal herdra, or its supplied machine-qualified route), which relays choices Algorant must make. History: ~/.pi/agent/scripts/inbox (open, recent, thread, close, reopen).",
    promptSnippet: "Message another Pi by native HC terminal/name using its durable inbox.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        terminal: { type: "string", minLength: 1, description: "HC terminal: id/name in the local core (e.g. herdra), or machine/terminal on a machine from hc machine ls (e.g. laptop/t3); resolved by its own core at send time." },
        kind: { type: "string", enum: [...KINDS], description: "request, result, or blocked." },
        body: { type: "string", minLength: 1, description: `Message text: line 1 is the answer, a one-line headline of at most ${HEADLINE_MAX} characters; details below. A longer first line is rejected and nothing is sent.` },
        reply_to: { type: "string", pattern: ID_PATTERN.source, description: "Id of the agent message this answers, e.g. m4f1a2c9." },
        interrupt: { type: "boolean", description: "Set true only for a correction to work the recipient is doing now: it is then steered into that running turn. Default false: a request or result is held until the recipient's turn ends and then starts the next turn, so it never displaces work in hand. Blocked messages and replies (reply_to) always steer." },
      },
      required: ["terminal", "kind", "body"],
    },
    ...createAgentSendRenderer(),
    async execute(_id: string, params: SendParams, _signal: unknown, _update: unknown, context: ExtensionContext) {
      checkHeadline(params.body);
      const { env, file } = await sendAgentMessage(context, params);
      const to = peerName(env.to, localMachine());
      // Delivery itself is asynchronous; the recipient's status now says when it lands (task-555).
      const target = await targetStatus(env.to, env.from.core!);
      const now = target ? ` ${to} is ${statusText(target)} now: ${deliveryHint(target, env)}.` : "";
      return {
        content: [{ type: "text" as const, text: `Queued ${env.kind} ${env.id}${env.reply_to ? ` (reply to ${env.reply_to})` : ""} for ${to} (${addressText(env.to)}); it is delivered into that Pi conversation when it is running.${now} inbox thread ${env.id} shows queued, delivered or failed.` }],
        details: { envelope: env, file, ...(target ? { target } : {}) },
      };
    },
  } as any);
}
