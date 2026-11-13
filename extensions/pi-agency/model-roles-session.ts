import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hcJson } from "../pi-herdr/core.ts";
import { LocalAgencySettingsError, localAgencySettings } from "./local-settings.ts";
import { resolveRoleEntry } from "./model-roles.ts";
import { workerContextRequested } from "./workers/context.ts";
import { hcProfileRequested } from "./subagents/profile.ts";

/**
 * Apply the "orchestrator" entry of agent/model-roles.json to a fresh
 * interactive main session (Herdra, Cephs, manus): set the session model and
 * thinking level (nothing else sets `high` for new sessions). Skipped for
 * Workers, resumed sessions, reloads and forks, and whenever the command line
 * names a model or thinking level, which still win.
 *
 * With named sets ("pi-agency".modelSets, task-714) the native HC terminal named
 * `herdra` takes the `herdra` row and every other main session the orchestrator
 * row. If that fails, the session never runs on its unchecked startup model:
 * every turn is refused until a model is chosen explicitly (/model or a cutover
 * request), which fires model_select.
 */
const EXPLICIT_MODEL_ARGS = /^--(model|models|provider|thinking)(=|$)/;

async function setRole(): Promise<"herdra" | "orchestrator"> {
  if (!process.env.HC_TERMINAL_ID) return "orchestrator";
  return (await hcJson(["get", process.env.HC_TERMINAL_ID])).name === "herdra" ? "herdra" : "orchestrator";
}

export function registerOrchestratorModel(pi: ExtensionAPI): void {
  let refusal: string | undefined;
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.reason !== "startup" && event.reason !== "new") return;
    if (workerContextRequested()) return;
    if (hcProfileRequested()) return;
    if (process.argv.some((arg) => EXPLICIT_MODEL_ARGS.test(arg))) return;
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    let named = false;
    try {
      named = localAgencySettings().modelSets !== undefined;
      const role = named ? await setRole() : "orchestrator";
      const { entry, catalog, skipped, set, quota } = resolveRoleEntry(role, ctx.modelRegistry);
      if (!(await pi.setModel(catalog))) throw new Error(`No credentials for ${entry.model}`);
      pi.setThinkingLevel(entry.thinking);
      const label = set ? `${role} model (set ${set})` : "Orchestrator model";
      ctx.ui.notify(`${label}: ${entry.model} (${pi.getThinkingLevel()})${quota ? `; quota ${quota}` : ""}${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!named && !(error instanceof LocalAgencySettingsError && error.modelSets)) {
        ctx.ui.notify(`Orchestrator model not applied: ${message}`, "error");
        return;
      }
      refusal = `Named model set not applied, so this session refuses to run on its unchecked startup model; choose one with /model: ${message}`;
      ctx.ui.notify(refusal, "error");
    }
  });
  pi.on("model_select", () => {
    refusal = undefined;
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!refusal) return;
    ctx.ui.notify(refusal, "error");
    ctx.abort();
  });
}
