import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRoleEntry } from "./model-roles.ts";
import { workerContextRequested } from "./workers/context.ts";
import { hcProfileRequested } from "./subagents/profile.ts";

/**
 * Apply the "orchestrator" entry of agent/model-roles.json to a fresh
 * interactive main session (Herdra, Cephs, manus): set the session model and
 * thinking level (nothing else sets `high` for new sessions). Skipped for
 * Workers, resumed sessions, reloads and forks, and whenever the command line
 * names a model or thinking level, which still win.
 */
const EXPLICIT_MODEL_ARGS = /^--(model|models|provider|thinking)(=|$)/;

export function registerOrchestratorModel(pi: ExtensionAPI): void {
  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (event.reason !== "startup" && event.reason !== "new") return;
    if (workerContextRequested()) return;
    if (hcProfileRequested()) return;
    if (process.argv.some((arg) => EXPLICIT_MODEL_ARGS.test(arg))) return;
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    try {
      const { entry, catalog, skipped } = resolveRoleEntry("orchestrator", ctx.modelRegistry);
      if (!(await pi.setModel(catalog))) throw new Error(`No credentials for ${entry.model}`);
      pi.setThinkingLevel(entry.thinking);
      ctx.ui.notify(`Orchestrator model: ${entry.model} (${pi.getThinkingLevel()})${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}`, "info");
    } catch (error) {
      ctx.ui.notify(`Orchestrator model not applied: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });
}
