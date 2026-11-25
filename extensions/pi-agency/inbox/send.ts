import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, inboxDir, inboxKey, localMachine, newId, splitHeadline, type Envelope } from "./envelope.ts";
import { hcFind, hcJson, hcMachine, hcMachines, hcText, piBackground } from "../../pi-herdr/core.ts";
import { hcAddress, terminalWho } from "../../../scripts/whois.ts";
import { writeAtomic } from "../state.ts";
import { validateFailures, type Failures } from "../../pi-tandem/failure-summary.ts";

export type SendParams = { terminal: string; kind: Envelope["kind"]; body: string; reply_to?: string; interrupt?: boolean; control?: Envelope["control"]; failures?: Failures };

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

/**
 * An unqualified recipient: what hc itself resolves (an address or name) always wins. Only when hc answers
 * a definitive not_found is it read as a project name, the target being that project's one live Ceph on
 * this core: whois's terminal rule (a pi in its space's `main` tab, `kind` ceph), the project compared
 * without case as the app space's name is. A machine/terminal address is never reinterpreted, nor is any
 * other hc failure (an unreachable core, a gone terminal): those fail as before. Several Cephs match, or
 * `hc ls` failing, is an error naming the cause, never a guess.
 */
export async function resolveRecipient(terminal: string): Promise<string> {
  if (terminal.includes("/")) return terminal;
  try {
    await hcJson(["get", terminal]);
    return terminal;
  } catch (error) {
    if ((error as { kind?: string }).kind !== "not_found") throw error;
    const project = terminal.toLowerCase();
    let listed;
    try { listed = await hcJson(["ls", "--json"]); }
    catch (lsError) { throw new Error(`${error instanceof Error ? error.message : error}; as a project name it could not be looked up (${lsError instanceof Error ? lsError.message : lsError}).`); }
    if (!Array.isArray(listed?.terminals)) throw new Error(`${error instanceof Error ? error.message : error}; as a project name it could not be looked up (hc ls returned no terminal list).`);
    const cephs: string[] = [];
    for (const entry of listed.terminals) {
      const where = typeof entry?.where === "string" ? entry.where : "";
      if (entry.state !== "live" || typeof entry.address !== "string" || entry.address.includes("/") || entry.agent !== "pi" || !where.endsWith(" / main")) continue;
      if (where.slice(0, -" / main".length).toLowerCase() !== project) continue;
      const who = terminalWho(await hcJson(["get", entry.address]));
      if (who.kind === "ceph") cephs.push(entry.address);
    }
    if (cephs.length === 1) return cephs[0]!;
    if (cephs.length > 1) throw new Error(`hc get: no terminal "${terminal}", and ${cephs.length} Cephs match project ${terminal} (${cephs.join(", ")}); send to one by address.`);
    throw error;
  }
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

type InterruptOutcome = { state: "stopped" | "idle" | "unconfirmed"; detail: string };
type InterruptObservation = { key: string; outcome: string };

function statusState(record: any): string | undefined {
  return typeof record?.status?.state === "string" ? record.status.state : undefined;
}

function shortObservation(value: string): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

/** What the recipient's status means for a message just queued for it. */
export function deliveryHint(status: TargetStatus, interruptOutcome?: InterruptOutcome): string {
  if (interruptOutcome?.state === "stopped") return `stopped it (${interruptOutcome.detail}) and queued; it reads this as its next turn`;
  if (interruptOutcome?.state === "idle") return `it was idle (${interruptOutcome.detail}); queued; it delivers now`;
  if (interruptOutcome?.state === "unconfirmed") return `stop not confirmed: ${interruptOutcome.detail}; queued; ${status.state === "idle" || status.state === "done" ? "it delivers now" : "it will deliver when the recipient can receive it"}`;
  switch (status.state) {
    case "idle": case "done": return "it delivers now and starts a turn";
    case "working": return "it is held until that turn ends and then starts the next turn";
    case "blocked": return "it waits until that is answered";
    case "none": return "no Pi status is reported there; it waits until a Pi runs";
    case "gone": return "the terminal is gone; nothing will deliver it";
    case "background": return "its Pi is stopped or a background job of its shell; it waits until that Pi is restarted";
    default: return "its delivery state is unknown";
  }
}

/** The single durable send path, shared by agent_send and other extension callers. */
export async function sendAgentMessage(context: ExtensionContext, params: SendParams): Promise<{ env: Envelope; file: string; interruptOutcome?: InterruptOutcome }> {
  if (!params.terminal) throw new Error("agent_send requires terminal: an HC terminal id/name or machine/terminal.");
  if (!process.env.HC_TERMINAL_ID) throw new Error("agent_send requires a Pi running in an HC terminal (HC_TERMINAL_ID is unset).");
  const target = await resolveRecipient(params.terminal);
  const [own, self] = await Promise.all([hcAddress(process.env.HC_TERMINAL_ID), hcJson(["get", process.env.HC_TERMINAL_ID])]);
  const machine = localMachine();
  const percent = context.getContextUsage()?.percent;
  // A manus's hc `task=` label links its requests to its track's Task (closed when that Task ends).
  const task = typeof self.labels?.task === "string" && self.labels.task ? self.labels.task : undefined;
  const env: Envelope = {
    v: 1, id: newId(), at: new Date().toISOString(), kind: params.kind, reply_to: params.reply_to ?? null,
    from: { machine, ...own, session: context.sessionManager.getSessionId(), ...(typeof percent === "number" ? { context: Math.round(percent) } : {}) },
    to: { machine, terminal: target, core: "", label: "" },
    body: splitHeadline(params.body),
    ...(params.control ? { control: params.control } : {}),
    ...(params.failures ? { failures: validateFailures(params.failures) } : {}),
    ...(params.interrupt ? { interrupt: true } : {}),
    ...(task ? { task } : {}),
  };
  let interruptOutcome: InterruptOutcome | undefined;
  if (params.interrupt) {
    let before: string | undefined;
    let beforeError: string | undefined;
    try { before = statusState(await hcJson(["get", target, "--json"], 3_000)); }
    catch (error) { beforeError = error instanceof Error ? error.message : String(error); }

    let observed: InterruptObservation | undefined;
    let interruptError: string | undefined;
    try {
      const raw = await hcText(["interrupt", target, "--json", "--timeout", "3"], undefined, 3_500);
      const parsed = JSON.parse(raw);
      if (typeof parsed?.key !== "string" || typeof parsed?.outcome !== "string") throw new Error("hc interrupt JSON omitted key or outcome");
      observed = { key: parsed.key, outcome: parsed.outcome };
    } catch (error) {
      interruptError = error instanceof Error ? error.message : String(error);
    }

    let after: string | undefined;
    let afterError: string | undefined;
    try { after = statusState(await hcJson(["get", target, "--json"], 3_000)); }
    catch (error) { afterError = error instanceof Error ? error.message : String(error); }

    const detail = shortObservation(observed ? `key=${observed.key}, outcome=${observed.outcome}` : `hc interrupt failed: ${shortObservation(interruptError ?? "invalid JSON observation")}`);
    if (before && before !== "working") {
      interruptOutcome = { state: "idle", detail: shortObservation(`${before} (${detail})`) };
    } else if (before === "working" && after && after !== "working") {
      interruptOutcome = { state: "stopped", detail: shortObservation(`${before} → ${after} (${detail})`) };
    } else {
      const states = `${before ?? `unknown${beforeError ? ` (${shortObservation(beforeError)})` : ""}`} → ${after ?? `unknown${afterError ? ` (${shortObservation(afterError)})` : ""}`}`;
      interruptOutcome = { state: "unconfirmed", detail: shortObservation(`${states} (${detail})`) };
    }
  }
  let file: string;
  try {
    file = await dropHcEnvelope(env, target);
  } catch (error) {
    // The send event is the only place this body is stored, so a failed drop still records it, with
    // the failure beside it: `inbox recent`/`thread` then show what was not delivered and why.
    const reason = error instanceof Error ? error.message : String(error);
    appendEvent({ op: "send", env });
    appendEvent({ op: "fail", id: env.id, at: new Date().toISOString(), note: reason });
    throw new Error(`Delivery not confirmed to terminal ${target}; inspect ${env.id} before retrying (${env.id}): ${reason}`);
  }
  appendEvent({ op: "send", env });
  return { env, file, ...(interruptOutcome ? { interruptOutcome } : {}) };
}
