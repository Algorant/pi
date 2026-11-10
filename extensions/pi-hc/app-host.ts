import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { command, diagnosticText } from "../pi-agency/workers/shared.ts";
import { coreId, hcJson, hcMachines } from "./core.ts";

export type AppHost = { machine?: string; core: string; machines: Awaited<ReturnType<typeof hcMachines>> };
export type AppSpace = { app: any; host: AppHost; space: any; tab: any };

export async function appCommand(host: AppHost, args: string[]): Promise<string> {
  return host.machine
    ? command("hc", ["exec", "--on", host.machine, "--", "herdr-app", ...args], undefined, 15_000)
    : command("herdr-app", args, undefined, 15_000);
}

export async function localAppHost(): Promise<AppHost> {
  const [server, machines] = await Promise.all([hcJson(["server", "status"]), hcMachines()]);
  if (typeof server.core?.id !== "string") throw new Error("hc server status returned no local core id; cannot identify an app host.");
  return { core: server.core.id, machines };
}

function parseAppListing(raw: string): any {
  const app = JSON.parse(raw);
  if (!Array.isArray(app?.spaces)) throw new Error("herdr-app ls returned no spaces array");
  return app;
}

/** Another connected machine whose Herdr app window is closed: it can host no membership, so it is skipped, not fatal. */
function isAppClosed(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const text = typeof stderr === "string" ? stderr : error instanceof Error ? error.message : "";
  return /no Herdr window|Connection refused|ECONNREFUSED|No such file or directory/.test(text) && /herdr-app\.sock|Herdr window|Connection refused/i.test(text);
}

async function appListings(): Promise<{ listings: Array<{ app: any; host: AppHost }>; closed: string[] }> {
  const local = await localAppHost();
  const listings: Array<{ app: any; host: AppHost }> = [];
  const errors: string[] = [];
  const closed: string[] = [];
  const localHasApp = (process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, "herdr-app")));
  if (localHasApp) {
    try { listings.push({ app: parseAppListing(await appCommand(local, ["ls"])), host: local }); }
    catch (error) { errors.push(`local herdr-app ls: ${diagnosticText(error)}`); }
  }
  for (const machine of local.machines.filter((entry) => entry.state === "connected")) {
    try {
      const [raw, remoteMetadata] = await Promise.all([
        command("hc", ["exec", "--on", machine.name, "--", "herdr-app", "ls"], undefined, 15_000),
        command("hc", ["exec", "--on", machine.name, "--", "hc", "machine", "ls", "--json"], undefined, 15_000),
      ]);
      const remoteMachines = JSON.parse(remoteMetadata).machines;
      if (!Array.isArray(remoteMachines)) throw new Error("remote hc machine ls returned no machines array");
      listings.push({ app: parseAppListing(raw), host: { machine: machine.name, core: machine.id, machines: remoteMachines } });
    } catch (error) {
      if (isMissingHerdrApp(error)) continue;
      // A closed app on another machine is not a discovery failure: it simply owns no membership here.
      if (isAppClosed(error)) { closed.push(machine.name); continue; }
      errors.push(`${machine.name} herdr-app ls: ${diagnosticText(error)}`);
    }
  }
  if (errors.length) throw new Error(`Could not complete app-host discovery: ${errors.join("; ")}. Nothing was started.`);
  return { listings, closed };
}

function isMissingHerdrApp(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr !== "string") return false;
  try { return JSON.parse(stderr)?.error?.kind === "spawn_failed"; }
  catch { return false; }
}

function nativeMachineCore(host: AppHost, machine: unknown): string | undefined {
  if (machine == null || machine === "") return host.core;
  if (typeof machine !== "string") return undefined;
  return host.machines.find((entry) => entry.name === machine)?.id;
}

/** Resolve exact existing space/tab labels across current native app listings and verify core identity. */
export async function resolveAppSpace(spaceId: string, tabId: string | undefined, callerCore: string, callerTerminal: string): Promise<AppSpace> {
  const matches: AppSpace[] = [];
  const { listings, closed } = await appListings();
  const closedNote = closed.length ? ` Skipped ${closed.join(", ")}: that Herdr app window is closed.` : "";
  for (const { app, host } of listings) {
    for (const space of app.spaces ?? []) {
      if (coreId(space.machine, space.id) !== spaceId || nativeMachineCore(host, space.machine) !== callerCore) continue;
      for (const tab of space.tabs ?? []) {
        if (tabId && coreId(space.machine, tab.id) !== tabId) continue;
        if (!tab.terminals?.some((item: any) => coreId(space.machine, item.terminal) === callerTerminal)) continue;
        matches.push({ app, host, space, tab });
      }
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const groups = new Map<string, AppSpace[]>();
    for (const match of matches) {
      const key = JSON.stringify([
        callerCore,
        coreId(match.space.machine, match.space.id),
        coreId(match.space.machine, match.tab.id),
        callerTerminal,
      ]);
      const group = groups.get(key) ?? [];
      group.push(match);
      groups.set(key, group);
    }
    if (groups.size === 1) {
      const group = [...groups.values()][0]!;
      const directOwners = group.filter((match) => match.space.machine == null && match.host.core === callerCore);
      if (directOwners.length === 1) return directOwners[0]!;
    }
  }
  throw new Error(matches.length
    ? `App space/tab labels ${spaceId}/${tabId} match ${matches.length} app memberships; refusing ambiguous host. Nothing was started.`
    : `No connected Herdr app has space/tab labels ${spaceId}/${tabId} on this caller's native core.${closedNote} Nothing was started.`);
}

/** Read the private view belonging to the resolved app process/home, never the caller's remote HOME. */
export async function appView(host: AppHost): Promise<any> {
  let path: string;
  let raw: string;
  if (host.machine) {
    const home = (await command("hc", ["exec", "--on", host.machine, "--", "sh", "-c", 'printf "%s\\n" "${HERDR_APP_HOME:-$HOME/.config/herdr-app}"'], undefined, 15_000)).replace(/\r?\n$/, "");
    if (!isAbsolute(home)) throw new Error(`Could not resolve absolute HERDR_APP_HOME on app host ${host.machine}.`);
    path = join(home, "view.json");
    raw = await command("hc", ["file", "read", "--on", host.machine, path], undefined, 15_000);
  } else {
    path = join(process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app"), "view.json");
    raw = await readFile(path, "utf8");
  }
  try {
    const view = JSON.parse(raw);
    if (!view || typeof view !== "object" || !view.tabs || !view.spaces || typeof view.active !== "string") {
      throw new Error("missing active, spaces, or tabs view state");
    }
    return view;
  } catch (error) {
    throw new Error(`Could not validate Herdr saved view at ${path}: ${diagnosticText(error)}`);
  }
}
