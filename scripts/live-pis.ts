import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendEvent, localMachine, modelControlError, newId, type Envelope, type ModelControl } from "../extensions/pi-agency/inbox/envelope.ts";
import { dropHcEnvelope } from "../extensions/pi-agency/inbox/send.ts";
import { coreId, hcJson, hcMachines, isHc, piBackground } from "../extensions/pi-herdr/core.ts";
import { hcAddress, terminalWho } from "./whois.ts";

/** Read-only native discovery shared by /pi-reload and Herdra's model cutover. */
export type PiStatus = "idle" | "done" | "working" | "blocked" | "error" | "unknown";
export type PiMachine = {
  name: string;
  core: string;
  local: boolean;
  state: string;
  resourcePath: string | null;
  targetRevision: string | null;
  resourcesDirty: boolean | null;
  /** Read-only note for a connected machine whose ~/.pi HEAD differs from the caller's: "~/.pi is N commits behind", ahead, diverged or unknown. */
  history: string | null;
  /** The same comparison as a machine-readable relation; only "behind" (strictly, shared history) permits a fast-forward pull. */
  relation: "behind" | "ahead" | "diverged" | "unknown" | null;
  error: string | null;
};
export type LivePi = {
  /** Exact native route resolved in this snapshot, not a movable hc name. */
  address: string;
  terminal: string;
  machine: string;
  core: string;
  name: string | null;
  label: string;
  role: string;
  project: string | null;
  status: PiStatus;
  statusAt: number | null;
  model: string | null;
  loadedRevision: string | null;
  /** Present only after this Pi has loaded the typed inbox reload receiver. */
  reloadCapable: boolean;
  /** Present only after this Pi has loaded the typed inbox model receiver; an older Pi would feed the request to its model. */
  modelCapable: boolean;
  shortLived: boolean;
  /** The terminal's foreground program when this Pi is stopped or a background job of its shell (see piBackground); null when it is the foreground or unknown. */
  background: string | null;
  /** The session file this Pi published (`pi.session`), for a restart hint. */
  session: string | null;
  targetRevision: string | null;
  resourcesDirty: boolean | null;
  error: string | null;
};
export type LivePiInventory = {
  capturedAt: string;
  localMachine: string;
  machines: PiMachine[];
  pis: LivePi[];
};

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
const revision = (value: unknown): string | null => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value) ? value : null;
const label = (value: unknown): string | null => typeof value === "string" && value ? value : null;
const status = (value: unknown): PiStatus => ["idle", "done", "working", "blocked", "error"].includes(String(value)) ? value as PiStatus : "unknown";

/** Native children/Workers are lifecycle-owned jobs, not durable reload endpoints. */
export const reloadOwner = (terminal: any): boolean => terminal.parent == null && !["worker", "scout", "researcher", "reviewer"].includes(terminal.labels?.kind);

const run = promisify(execFile);
export type ResourceRevision = { resourcePath: string; targetRevision: string; resourcesDirty: boolean };

/** Repository HEAD plus informational local changes (resourcesDirty); never a reload gate or byte attestation. */
export async function resourceRevision(root = join(homedir(), ".pi")): Promise<ResourceRevision> {
  const [identity, dirty] = await Promise.all([
    run("git", ["-C", root, "rev-parse", "--show-toplevel", "HEAD"], { timeout: 5000 }),
    run("git", ["-C", root, "status", "--porcelain", "--untracked-files=normal"], { timeout: 5000 }),
  ]);
  const [resourcePath, head] = identity.stdout.trimEnd().split("\n");
  if (!resourcePath || !revision(head)) throw new Error("git did not return a resource path and full revision.");
  return { resourcePath, targetRevision: head!, resourcesDirty: Boolean(dirty.stdout.trim()) };
}

/** Inspect that machine's own ~/.pi, never the caller's checkout or a remote pull. */
async function resources(machine: PiMachine): Promise<void> {
  try {
    if (machine.local) {
      Object.assign(machine, await resourceRevision());
      return;
    }
    const result = await hcJson([
      "exec", "--json", "--on", machine.name, "--timeout", "5", "--", "sh", "-c",
      'git -C "$HOME/.pi" rev-parse --show-toplevel HEAD && git -C "$HOME/.pi" status --porcelain --untracked-files=normal',
    ]);
    if (result.code !== 0 || result.timed_out || result.truncated) {
      const stderr = Buffer.from(String(result.stderr ?? ""), "base64").toString("utf8").trim();
      throw new Error(`Cannot read ~/.pi resources (${result.timed_out ? "timed out" : `exit ${result.code}`}): ${stderr || "no complete result"}`);
    }
    const [path, head, ...dirty] = Buffer.from(String(result.stdout ?? ""), "base64").toString("utf8").trimEnd().split("\n");
    if (!path || !revision(head)) throw new Error("git did not return a resource path and full revision.");
    machine.resourcePath = path;
    machine.targetRevision = head!;
    machine.resourcesDirty = dirty.some(Boolean);
  } catch (error) {
    machine.error = message(error);
  }
}

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
const relate = (remote: PiMachine, onlyHere: number, onlyThere: number): void => {
  remote.relation = onlyHere && !onlyThere ? "behind" : !onlyHere && onlyThere ? "ahead" : "diverged";
  remote.history = remote.relation === "behind" ? `~/.pi is ${commits(onlyHere)} behind`
    : remote.relation === "ahead" ? `~/.pi is ${commits(onlyThere)} ahead`
      : `~/.pi has diverged (${commits(onlyThere)} not here, ${commits(onlyHere)} missing there)`;
};

/**
 * How a connected machine's ~/.pi HEAD relates to the caller's, from history only: one local
 * read-only `git rev-list --left-right --count`, else the same on that machine through `hc exec`
 * when only it knows the caller's commit. No fetch, pull or write; unknown history is said so.
 */
async function history(local: PiMachine, remote: PiMachine): Promise<void> {
  const here = local.targetRevision!;
  const there = remote.targetRevision!;
  const counts = (out: string) => out.trim().split(/\s+/).map(Number) as [number, number];
  try {
    const out = await run("git", ["-C", local.resourcePath!, "rev-list", "--left-right", "--count", `${here}...${there}`], { timeout: 5000 });
    const [onlyHere, onlyThere] = counts(out.stdout);
    relate(remote, onlyHere, onlyThere);
    return;
  } catch { /* the caller does not know the remote HEAD: ask the remote */ }
  try {
    const result = await hcJson(["exec", "--json", "--on", remote.name, "--timeout", "5", "--", "sh", "-c", `git -C "$HOME/.pi" rev-list --left-right --count ${there}...${here}`]);
    if (result.code !== 0 || result.timed_out || result.truncated) throw new Error("no complete result");
    const [onlyThere, onlyHere] = counts(Buffer.from(String(result.stdout ?? ""), "base64").toString("utf8"));
    relate(remote, onlyHere, onlyThere);
  } catch {
    remote.relation = "unknown";
    remote.history = "~/.pi history unknown (neither checkout has the other's HEAD)";
  }
}

export type Pull = { ok: boolean; from: string; to: string | null; why?: string };

/**
 * Fast-forward a connected machine's own checkout (`git pull --ff-only`, run there through `hc exec`) only when
 * its history is strictly behind the caller's. Never forced, reset or stashed: local changes stay, and a pull
 * that cannot fast-forward fails with git's own message. On success the machine's target revision is the new
 * HEAD; otherwise nothing changes. Returns undefined when no pull was attempted.
 */
export async function pullBehind(machine: PiMachine): Promise<Pull | undefined> {
  if (machine.local || machine.state !== "connected" || machine.error || machine.relation !== "behind" || !machine.targetRevision) return undefined;
  const from = machine.targetRevision;
  const text = (value: unknown) => Buffer.from(String(value ?? ""), "base64").toString("utf8").trim();
  try {
    const result = await hcJson([
      "exec", "--json", "--on", machine.name, "--timeout", "60", "--", "sh", "-c",
      'git -C "$HOME/.pi" pull --ff-only >&2 && git -C "$HOME/.pi" rev-parse HEAD',
    ], 75_000);
    if (result.code !== 0 || result.timed_out || result.truncated) {
      const stderr = text(result.stderr).split("\n").filter(Boolean).at(-1);
      throw new Error(`${result.timed_out ? "timed out" : `exit ${result.code}`}: ${stderr || "no complete result"}`);
    }
    const to = text(result.stdout);
    if (!revision(to)) throw new Error("git did not return the new HEAD.");
    machine.targetRevision = to;
    return { ok: true, from, to };
  } catch (error) {
    return { ok: false, from, to: null, why: message(error) };
  }
}

/**
 * One snapshot, no keys, screen reads, registry, watcher, retries or status inference.
 * Native hc ls covers local and connected cores; hc get supplies each Pi's current
 * status and labels. Missing pi.resources means unknown, not current. Roles/names
 * come from whois's terminalWho, not another naming table. A snapshot is NOT a
 * safe-input guarantee: idle/done does not establish an empty editor or no dialog.
 */
export async function livePis(): Promise<LivePiInventory> {
  const [server, configured, listed] = await Promise.all([
    hcJson(["server", "status", "--json"]), hcMachines(), hcJson(["ls", "--json"]),
  ]);
  if (!server.core?.id || !server.core?.name || !Array.isArray(listed.terminals)) {
    throw new Error("hc did not return its core identity and terminal list.");
  }
  const machines: PiMachine[] = [
    { name: server.core.name, core: server.core.id, local: true, state: "connected", resourcePath: null, targetRevision: null, resourcesDirty: null, history: null, relation: null, error: null },
    ...configured.map((m) => ({ name: m.name, core: m.id, local: false, state: m.state, resourcePath: null, targetRevision: null, resourcesDirty: null, history: null, relation: null, error: m.state === "connected" ? null : `Machine ${m.name} is ${m.state}; not inspected.` })),
  ];
  // hc ls can discover a connection failure after machine ls captured "connected".
  for (const observed of listed.machines ?? []) {
    const machine = machines.find((m) => !m.local && m.name === observed.name);
    if (machine && observed.state !== "connected") {
      machine.state = observed.state;
      machine.error = observed.why || `Machine ${machine.name} is ${observed.state}; not inspected.`;
    }
  }
  await Promise.all(machines.filter((m) => m.state === "connected").map(resources));
  const caller = machines[0]!;
  await Promise.all(machines.filter((m) => !m.local && m.state === "connected" && !m.error && m.targetRevision && caller.targetRevision && m.targetRevision !== caller.targetRevision).map((m) => history(caller, m)));
  const pis: LivePi[] = await Promise.all(listed.terminals.filter((t: any) => t.state === "live" && t.agent === "pi").map(async (entry: any): Promise<LivePi> => {
    if (typeof entry.address !== "string" || !entry.address) throw new Error("hc listed a Pi without an exact address.");
    const slash = entry.address.indexOf("/");
    const machine = slash < 0 ? machines[0]! : machines.find((m) => !m.local && m.name === entry.address.slice(0, slash));
    if (!machine) throw new Error(`hc listed ${entry.address} without a matching configured machine.`);
    const named = terminalWho(entry);
    const pi: LivePi = {
      address: entry.address, terminal: slash < 0 ? entry.address : entry.address.slice(slash + 1),
      machine: machine.name, core: machine.core, name: entry.name ?? null,
      label: named.label, role: named.kind, project: named.project,
      status: "unknown", statusAt: null, model: null, loadedRevision: null, reloadCapable: false, modelCapable: false, shortLived: false, background: null, session: null,
      targetRevision: machine.targetRevision, resourcesDirty: machine.resourcesDirty, error: null,
    };
    try {
      if (machine.state !== "connected") throw new Error(machine.error!);
      const current = await hcJson(["get", entry.address, "--json"]);
      if (current.state !== "live" || current.status?.app !== "pi") throw new Error("Terminal is no longer a live native Pi.");
      // hc versions may qualify the remote get address or leave it core-local.
      if (coreId(machine.local ? "" : machine.name, current.address) !== pi.terminal) throw new Error("hc get returned a different terminal address.");
      const who = terminalWho(current);
      pi.label = who.label;
      pi.role = who.kind;
      pi.project = who.project;
      pi.name = current.name ?? null;
      pi.status = status(current.status?.state);
      pi.statusAt = typeof current.status_ms === "number" ? current.status_ms : null;
      pi.model = label(current.labels?.["pi.model"]);
      pi.loadedRevision = revision(current.labels?.["pi.resources"]);
      pi.shortLived = !reloadOwner(current);
      pi.reloadCapable = !pi.shortLived && current.labels?.["pi.reload"] === "1";
      pi.modelCapable = !pi.shortLived && current.labels?.["pi.model-control"] === "1";
      pi.background = piBackground(current) ?? null;
      pi.session = label(current.labels?.["pi.session"]);
      if (pi.status === "unknown") pi.error = "Native Pi status is unknown.";
    } catch (error) {
      pi.error = message(error);
    }
    return pi;
  }));
  return { capturedAt: new Date().toISOString(), localMachine: server.core.name, machines, pis };
}

/**
 * Queue one typed model cutover request (`pi-model`) for the long-lived Pi at `target` (a LivePi.address),
 * through the same atomic drop and send event as agent_send. Standalone: a real Bun script in an hc
 * terminal, no Pi runtime. The target applies it at idle/agent_settled with no model turn and replies
 * with one inbox `result` (reply_to the returned id) stating its actual model, thinking and Fast, or the failure.
 */
export async function requestModel(target: string, request: Pick<ModelControl, "model" | "thinking" | "fast">): Promise<{ id: string; route: string }> {
  const control: ModelControl = { type: "pi-model", ...request };
  const invalid = modelControlError(control);
  if (invalid) throw new Error(`Invalid model request: ${invalid}`);
  if (!isHc()) throw new Error("requestModel needs a native hc terminal (HC_TERMINAL_ID).");
  const current = await hcJson(["get", target, "--json"]);
  if (current.labels?.["pi.model-control"] !== "1") throw new Error(`${target} does not advertise pi.model-control=1 (no model receiver loaded); nothing was queued. It needs one ordinary /reload with these resources.`);
  const body = `Switch to ${control.model} · thinking ${control.thinking} · fast ${control.fast ? "on" : "off"} at your next idle boundary.\nTyped control, not model instructions.`;
  const env: Envelope = {
    v: 1, id: newId(), at: new Date().toISOString(), kind: "request", reply_to: null,
    from: { machine: localMachine(), ...await hcAddress(process.env.HC_TERMINAL_ID!) },
    to: { machine: localMachine(), terminal: target, core: "", label: "" },
    body, control,
  };
  try { await dropHcEnvelope(env, target); } catch (error) { throw new Error(`Model request not sent to ${target}: ${error instanceof Error ? error.message : error}`); }
  appendEvent({ op: "send", env });
  return { id: env.id, route: target };
}
