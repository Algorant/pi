import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, headlineOf, inboxDir, inboxKey, localMachine, newId, type Envelope } from "./envelope.ts";
import { hcFind, hcJson, hcMachine, hcMachines, hcText, piBackground } from "../../pi-hc/core.ts";
import { hcAddress } from "../../../scripts/whois.ts";
import { writeAtomic } from "../state.ts";

export type SendParams = { terminal: string; kind: Envelope["kind"]; body: string; reply_to?: string; control?: Envelope["control"] };

/** Shared atomic local drop; callers record the same send event after success. */
export function dropLocalEnvelope(env: Envelope): string {
  const file = join(inboxDir(inboxKey(env.to)), `${env.id}.json`);
  writeAtomic(file, JSON.stringify(env), 0o644);
  return file;
}

/**
 * The receiving machine runs these same Pi resources at the same path below
 * its home (normally `.pi/agent`), so its inbox CLI is at this relative path;
 * `hc exec --on` starts in that machine's home.
 */
function peerInboxCli(): string {
  const path = relative(homedir(), fileURLToPath(new URL("../../../scripts/inbox", import.meta.url)));
  if (path.startsWith("..") || isAbsolute(path)) throw new Error(`Pi resources at ${path} are outside the home folder, so no peer path for the inbox CLI exists.`);
  return path;
}

/**
 * Queue an envelope for a native HC terminal: `t7`/a name in this core, or
 * `machine/t7` on a machine from `hc machine ls`. A remote terminal is resolved
 * and dropped by that machine's own core and inbox CLI (`inbox drop`, through
 * native `hc exec --on`), into the same atomic queue its Pi watches.
 * `env.to` is replaced by the resolved recipient; returns where it landed.
 */
export async function dropHcEnvelope(env: Envelope, terminal: string): Promise<string> {
  const slash = terminal.indexOf("/");
  if (slash < 0) {
    env.to = { machine: env.from.machine, ...await hcAddress(terminal) };
    return dropLocalEnvelope(env);
  }
  const name = terminal.slice(0, slash);
  const remote = terminal.slice(slash + 1);
  if (!name || !remote || remote.includes("/")) throw new Error(`HC address ${terminal} must be machine/terminal.`);
  const peer = await hcMachine(name);
  env.to = { machine: peer.name, terminal: remote, core: peer.id, label: "" };
  let landed;
  try {
    landed = JSON.parse(await hcText(["exec", "--on", peer.name, "-i", "--timeout", "10", "--", peerInboxCli(), "drop"], JSON.stringify(env)));
  } catch (error) {
    throw new Error(`on ${peer.name}: ${error instanceof Error ? error.message : error}`);
  }
  env.to = landed.env.to;
  return `${peer.name}:${landed.file}`;
}

/** A recipient's current hc status: hc's own state word (idle, working, done, blocked, error), `none`, `gone`, `background` (its Pi no longer owns the terminal) or `unknown`. */
export type TargetStatus = { route: string; state: string; kind?: string; msg?: string };

/**
 * Read once, now, from the recipient's own core (`machine/terminal` for another machine, found by its
 * core id in hc machine ls): what its Pi is doing decides when a queued message is delivered.
 * A recipient that never resolved to a core has no hc status (undefined).
 */
export async function targetStatus(to: Envelope["to"], ownCore: string): Promise<TargetStatus | undefined> {
  if (!to.core) return undefined; // a send that never resolved its recipient
  let route = to.terminal;
  try {
    if (to.core !== ownCore) {
      const machine = (await hcMachines()).find((entry) => entry.id === to.core);
      if (!machine) return { route: `${to.machine}/${to.terminal}`, state: "unknown", msg: `no machine in hc machine ls has core ${to.core}` };
      route = `${machine.name}/${to.terminal}`;
    }
    const found = await hcFind(route);
    if (!found || found.state !== "live") return { route, state: "gone" };
    // hc's status word is the Pi's last report; a stopped or backgrounded Pi keeps reporting idle/done (task-632).
    const foreground = piBackground(found);
    if (foreground) return { route, state: "background", msg: `terminal foreground: ${foreground}` };
    const status = found.status;
    if (!status?.state) return { route, state: "none" };
    return { route, state: status.state, ...(status.kind ? { kind: status.kind } : {}), ...(status.msg ? { msg: status.msg } : {}) };
  } catch (error) {
    return { route, state: "unknown", msg: error instanceof Error ? error.message : String(error) };
  }
}

/** `blocked (permission: Allow edit?)`, `working`, `gone`, `reporting no hc status`: reads after "is". */
export const statusText = (status: TargetStatus) => status.state === "none" ? "reporting no hc status"
  : `${status.state}${status.kind || status.msg ? ` (${[status.kind, status.msg].filter(Boolean).join(": ")})` : ""}`;

/** What the recipient's status means for a message just queued for it. */
export function deliveryHint(status: TargetStatus): string {
  switch (status.state) {
    case "idle": case "done": return "it delivers now and starts a turn";
    case "working": return "it is steered into the current turn, after any long tool call, dialog or compaction ends";
    case "blocked": return "it waits until that is answered";
    case "none": return "no Pi status is reported there; it waits until a Pi runs";
    case "gone": return "the terminal is gone; nothing will deliver it";
    case "background": return "its Pi is stopped or a background job of its shell; it waits until that Pi is restarted";
    default: return "its delivery state is unknown";
  }
}

/** The single durable send path, shared by agent_send and other extension callers. */
export async function sendAgentMessage(context: ExtensionContext, params: SendParams): Promise<{ env: Envelope; file: string }> {
  if (!params.terminal) throw new Error("agent_send requires terminal: an HC terminal id/name or machine/terminal.");
  if (!process.env.HC_TERMINAL_ID) throw new Error("agent_send requires a Pi running in an HC terminal (HC_TERMINAL_ID is unset).");
  const [own, self] = await Promise.all([hcAddress(process.env.HC_TERMINAL_ID), hcJson(["get", process.env.HC_TERMINAL_ID])]);
  const machine = localMachine();
  const percent = context.getContextUsage()?.percent;
  // A manus's hc `task=` label links its requests to its track's Task (closed when that Task ends).
  const task = typeof self.labels?.task === "string" && self.labels.task ? self.labels.task : undefined;
  const env: Envelope = {
    v: 1, id: newId(), at: new Date().toISOString(), kind: params.kind, reply_to: params.reply_to ?? null,
    from: { machine, ...own, session: context.sessionManager.getSessionId(), ...(typeof percent === "number" ? { context: Math.round(percent) } : {}) },
    to: { machine, terminal: params.terminal, core: "", label: "" },
    headline: headlineOf(params.body), body: params.body,
    ...(params.control ? { control: params.control } : {}),
    ...(task ? { task } : {}),
  };
  let file: string;
  try {
    file = await dropHcEnvelope(env, params.terminal);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    appendEvent({ op: "fail", env, at: new Date().toISOString(), error: reason });
    throw new Error(`Delivery not confirmed to terminal ${params.terminal}; inspect ${env.id} before retrying (${env.id}): ${reason}`);
  }
  appendEvent({ op: "send", env });
  return { env, file };
}
