import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Every Pi child runs under child-exit: an end without any inbox report still reaches its parent or starter. */
export const CHILD_EXIT = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/child-exit");

/**
 * An app that shows this core as a remote machine qualifies its ids as
 * `<machine>/<id>`; hc labels and addresses are this core's own, unqualified.
 * A local app gives unqualified ids, which pass through unchanged.
 */
export function coreId(machine: unknown, id: unknown): unknown {
  const prefix = `${machine}/`;
  return typeof machine === "string" && machine && typeof id === "string" && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

/**
 * When a Pi's process group is not its terminal's foreground job (a shell reclaimed the tty after a
 * stop), the name of the foreground program; otherwise undefined. Such a Pi still renders and runs
 * inbox turns, but its next tty read (a key, or the replies to a reload's colour query) stops it with
 * SIGTTIN (task-632). Reads the Pi's own `pi.pgid` label against hc's foreground; a Pi that has not
 * published the label yet is not judged.
 */
export function piBackground(record: any): string | undefined {
  const pgid = Number(record?.labels?.["pi.pgid"]);
  const foreground = record?.foreground;
  if (!pgid || typeof foreground?.pid !== "number" || foreground.pid === pgid) return undefined;
  return typeof foreground.name === "string" && foreground.name ? foreground.name : `pid ${foreground.pid}`;
}

/** Native integration registers only inside an HC terminal. */
export function isHc(): boolean { return Boolean(process.env.HC_TERMINAL_ID); }

/** `input` is piped to hc's stdin (for `exec -i` and `file write`). */
export async function hcText(args: string[], input?: string, timeoutMs = 10_000): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = execFile("hc", args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve(stdout);
      });
      child.stdin?.end(input ?? "");
    });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    let reason = failure.stderr?.trim();
    let kind: string | undefined;
    if (reason) {
      try { const parsed = JSON.parse(reason).error; kind = parsed?.kind; reason = parsed?.message ?? reason; } catch { /* CLI diagnostic */ }
    }
    throw Object.assign(new Error(`hc ${args[0]}: ${reason || failure.message || String(error)}`), { kind });
  }
}

export async function hcJson(args: string[], timeoutMs?: number): Promise<any> {
  return JSON.parse(await hcText(args, undefined, timeoutMs));
}

/** A terminal that no longer exists is an answer, not an error. */
export async function hcFind(target: string): Promise<any | undefined> {
  try { return await hcJson(["get", target]); }
  catch (error) { if ((error as { kind?: string }).kind === "not_found") return undefined; throw error; }
}

/**
 * A live terminal in this core: its address, the core's permanent id, and hc's record of it. Names
 * may now name a different terminal, so callers resolve at use time. Its display name is whois's.
 */
export async function hcEndpoint(target: string): Promise<{ terminal: string; core: string; record: any }> {
  if (target.includes("/")) throw new Error(`${target} is a machine/terminal address; it is resolved by that machine's own hc core, not this one.`);
  const [terminal, server] = await Promise.all([hcJson(["get", target]), hcJson(["server", "status"])]);
  if (terminal.state !== "live") throw new Error(`HC terminal ${target} is ${terminal.state}; resolve its current live name/address with hc ls.`);
  if (typeof terminal.address !== "string" || typeof server.core?.id !== "string") {
    throw new Error("hc did not return a terminal address and permanent core id.");
  }
  return { terminal: terminal.address, core: server.core.id, record: terminal };
}

/** One entry of native `hc machine ls`: `id` is that machine's permanent core id. */
export type HcMachine = { name: string; id: string; host: string; target: string; state: string };

export async function hcMachines(): Promise<HcMachine[]> {
  const result = await hcJson(["machine", "ls", "--json"]);
  if (!Array.isArray(result.machines)) throw new Error("hc machine ls did not return its machine list.");
  return result.machines;
}

/** A machine by its native hc name only (no host/target aliases), connected now. */
export async function hcMachine(name: string): Promise<HcMachine> {
  const machines = await hcMachines();
  const machine = machines.find((m) => m.name === name);
  if (!machine) throw new Error(`Unknown hc machine "${name}" (hc machine ls: ${machines.map((m) => m.name).join(", ") || "none"}).`);
  if (machine.state !== "connected") throw new Error(`hc machine ${name} is ${machine.state}, not connected.`);
  if (typeof machine.id !== "string" || !machine.id) throw new Error(`hc machine ls reported no core id for ${name}.`);
  return machine;
}
