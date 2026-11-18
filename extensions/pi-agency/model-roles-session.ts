import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hcJson } from "../pi-herdr/core.ts";
import { KIND_KEY } from "../../scripts/whois.ts";
import { LocalAgencySettingsError, localAgencySettings } from "./local-settings.ts";
import { resolveRoleEntry } from "./model-roles.ts";
import { workerContextRequested } from "./workers/context.ts";
import { hcProfileRequested } from "./subagents/profile.ts";

/**
 * Apply the role entry of agent/model-roles.json to a fresh interactive main
 * session: `herdra` for the native HC terminal named herdra once the machine
 * opts into named sets, `manus` for a terminal labelled kind=manus, and
 * `orchestrator` for every other session. Sets the session model and its
 * configured thinking level. Skipped for Workers, resumed sessions, reloads
 * and forks, and whenever the command line names a model or thinking level,
 * which still win (a launched manus passes its resolved `--model`).
 *
 * Without named sets the legacy behavior is unchanged: a terminal named herdra
 * uses the declared orchestrator list, because the herdra row exists only in
 * sets. A manus always uses its own independent role. If the named-set, herdra
 * or manus resolution fails, the session never runs on its unchecked startup
 * model: every turn is refused until a model is chosen explicitly (/model or a
 * cutover request), which fires model_select. The legacy orchestrator path
 * keeps its notify-only behavior.
 */
const EXPLICIT_MODEL_ARGS = /^--(model|models|provider|thinking)(=|$)/;

async function setRole(named: boolean): Promise<"herdra" | "manus" | "orchestrator"> {
  if (!process.env.HC_TERMINAL_ID) return "orchestrator";
  const terminal = await hcJson(["get", process.env.HC_TERMINAL_ID]);
  if (terminal.labels?.[KIND_KEY] === "manus") return "manus";
  // The herdra row exists only in named sets; legacy Herdra keeps the declared orchestrator list.
  return terminal.name === "herdra" && named ? "herdra" : "orchestrator";
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
    let role: "herdra" | "manus" | "orchestrator" = "orchestrator";
    try {
      named = localAgencySettings().modelSets !== undefined;
      role = await setRole(named);
      const { entry, catalog, skipped, set, quota } = resolveRoleEntry(role, ctx.modelRegistry);
      if (!(await pi.setModel(catalog))) throw new Error(`No credentials for ${entry.model}`);
      pi.setThinkingLevel(entry.thinking);
      const label = set ? `${role} model (set ${set})` : `${role} model`;
      ctx.ui.notify(`${label}: ${entry.model} (${pi.getThinkingLevel()})${quota ? `; quota ${quota}` : ""}${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!named && role === "orchestrator" && !(error instanceof LocalAgencySettingsError && error.modelSets)) {
        ctx.ui.notify(`Orchestrator model not applied: ${message}`, "error");
        return;
      }
      refusal = `${role} model not applied, so this session refuses to run on its unchecked startup model; choose one with /model: ${message}`;
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
