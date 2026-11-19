import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hcJson } from "../pi-herdr/core.ts";
import { OPENAI_FAST_SET_EVENT, OPENAI_FAST_STATE_EVENT, type OpenAIFastState } from "../pi-providers/openai/events.ts";
import { KIND_KEY } from "../../scripts/whois.ts";
import { LocalAgencySettingsError, localAgencySettings } from "./local-settings.ts";
import { ModelSetUnavailableError, committedCellModels, resolveRoleEntry } from "./model-roles.ts";
import { resolveRoleForSwitch } from "./herdra-role.ts";
import { workerContextRequested } from "./workers/context.ts";
import { hcProfileRequested } from "./subagents/profile.ts";

/**
 * Apply the role entry of agent/model-roles.json to a fresh interactive main
 * session: `herdra` for the native HC terminal named herdra once the machine
 * opts into named sets, `manus` for a terminal labelled kind=manus, and
 * `orchestrator` for every other session. Sets the session model and its
 * configured thinking level. This startup application is skipped for Workers,
 * resumed sessions, reloads and forks, and whenever the command line names a
 * model or thinking level, which still win (a launched manus or Ceph passes its
 * resolved `--model`).
 *
 * Without named sets the legacy behavior is unchanged: a terminal named herdra
 * uses the declared orchestrator list, because the herdra row exists only in
 * sets. A manus always uses its own independent role. If the named-set, herdra
 * or manus resolution fails, the session never runs on its unchecked startup
 * model: every turn is refused until a model is chosen explicitly (/model or a
 * cutover request), which fires model_select. The legacy orchestrator path
 * keeps its notify-only behavior.
 *
 * Quota gate (task-745), independent of that startup application: every managed
 * long-lived session (herdra, Ceph, manus) — including one resumed, reloaded or
 * started with an explicit `--model` — checks its own role before each run. When
 * the selected set is blocked by quota ALONE and the session is still on that
 * cell's model, it asks Herdra's `herdra-cutover role` (the same selector and
 * apply the machine-wide watch uses) for a column with room, re-resolves the
 * committed map once, and applies the differing model, thinking and Fast
 * in-process at `before_agent_start` — before that run builds its provider
 * request. The already-delivered kickoff or inbox input is the run's own input,
 * so nothing is replayed, queued or awaited. A model that differs from the
 * blocked cell (a human /model, or another deliberate pin) is left alone, and a
 * change of the committed map alone always arrives through the one typed cutover,
 * never as a second self-applied workflow. When no column has room, or the
 * command fails or answers stale, the session shows ONE notice and the run
 * continues normally on its current model — never an abort, an in-turn retry, or
 * permission for a new launch on a blocked selection.
 */
const EXPLICIT_MODEL_ARGS = /^--(model|models|provider|thinking)(=|$)/;
type Role = "herdra" | "manus" | "orchestrator";
const modelId = (ctx: ExtensionContext): string | undefined => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

/**
 * The session's role and whether this machine's model policy manages it. Only a native
 * long-lived actor does — Herdra, a Ceph (`kind=ceph`) or a manus (`kind=manus`) — so a
 * plain interactive Pi, a short-lived child, a Worker or a hand-started `pi --model`
 * session is never chased, while it keeps the startup row it always had.
 */
async function identity(named: boolean): Promise<{ role: Role; managed: boolean }> {
  if (!process.env.HC_TERMINAL_ID) return { role: "orchestrator", managed: false };
  const terminal = await hcJson(["get", process.env.HC_TERMINAL_ID]);
  const kind = terminal.labels?.[KIND_KEY];
  if (kind === "manus") return { role: "manus", managed: true };
  // The herdra row exists only in named sets; legacy Herdra keeps the declared orchestrator list.
  if (terminal.name === "herdra" && named) return { role: "herdra", managed: true };
  return { role: "orchestrator", managed: kind === "ceph" };
}

export function registerOrchestratorModel(pi: ExtensionAPI): void {
  let refusal: string | undefined;
  /** The managed actor for this session, resolved on every session start; undefined when unmanaged. */
  let actor: { role: Role } | undefined;
  /**
   * The model this session started on (or last took from the policy map), in memory only. A model
   * that differs from it is an in-session choice and is left alone — unless it is exactly the
   * committed cell's model, which is what a typed cutover or an earlier policy apply sets. A model
   * that still equals it (a launch default, a resumed model, a fresh session that never got its
   * role model) is the policy's to move. No durable marker is written.
   */
  let baseline: string | undefined;
  /** One notice per distinct reason per session; a repeated block says nothing new. */
  const notices = new Set<string>();
  let fast: OpenAIFastState | undefined;
  pi.events.on(OPENAI_FAST_STATE_EVENT, (state) => { fast = state as OpenAIFastState; });

  const tell = (ctx: ExtensionContext, text: string, key = text) => {
    if (notices.has(key)) return;
    notices.add(key);
    ctx.ui.notify(text, "warning");
  };

  pi.on("session_start", async (event, ctx) => {
    refusal = undefined;
    actor = undefined;
    baseline = undefined;
    notices.clear();
    if (ctx.mode !== "tui") return;
    if (workerContextRequested()) return;
    if (hcProfileRequested()) return;
    let named = false;
    try {
      named = localAgencySettings().modelSets !== undefined;
      const who = await identity(named);
      // Identity is read on every start (startup, new, resume, reload), so a long-lived Pi
      // that was already running when this shipped still gets the gate.
      actor = who.managed ? { role: who.role } : undefined;
    } catch {
      // An unreadable role fact leaves this session unmanaged; the startup application below
      // reports the same failure once, as before.
    }
    // The model this session starts on: a launch default or a resumed model, never an in-session choice.
    baseline = modelId(ctx);
    // The role's default selection is applied only to a fresh session with no messages and no
    // explicit model on the command line; the gate above is independent of this.
    if (event.reason !== "startup" && event.reason !== "new") return;
    if (ctx.sessionManager.getEntries().some((entry) => entry.type === "message")) return;
    if (process.argv.some((arg) => EXPLICIT_MODEL_ARGS.test(arg))) return;
    const role: Role = actor?.role ?? "orchestrator";
    try {
      const { entry, catalog, skipped, set, quota } = resolveRoleEntry(role, ctx.modelRegistry);
      if (!(await pi.setModel(catalog))) throw new Error(`No credentials for ${entry.model}`);
      pi.setThinkingLevel(entry.thinking);
      baseline = entry.model;
      const label = set ? `${role} model (set ${set})` : `${role} model`;
      ctx.ui.notify(`${label}: ${entry.model} (${pi.getThinkingLevel()})${quota ? `; quota ${quota}` : ""}${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}`, "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A managed actor blocked by quota alone is not refused: the gate cuts it over before its
      // next run. Everything else keeps the existing behaviour exactly.
      if (actor && error instanceof ModelSetUnavailableError && error.kind === "quota") {
        ctx.ui.notify(`${role} model set is quota-blocked; the pre-turn gate will move it to a column with room: ${message}`, "warning");
        return;
      }
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

  /** The quota gate, before this run builds its provider request (task-745). */
  pi.on("before_agent_start", async (_event, ctx) => {
    const current = actor;
    if (!current) return;
    const model = modelId(ctx);
    try {
      if (localAgencySettings().modelSets === undefined) return;
      // Existing provenance, in memory only: this session's starting model, and the committed
      // cell's model as what the policy (a typed cutover or an earlier apply) sets. A model that
      // is neither is a deliberate in-session choice and stands.
      if (model !== baseline) {
        if (model !== undefined && committedCellModels(current.role).includes(model)) baseline = model;
        else return;
      }
      try {
        resolveRoleEntry(current.role, ctx.modelRegistry);
        return; // the selected set is usable: nothing to do here
      } catch (error) {
        if (!(error instanceof ModelSetUnavailableError) || error.kind !== "quota") return;
      }
      // The model is the policy's (unchanged since the session started, or set to the committed
      // cell): a quota-only block on the role is answered by a cutover, not by standing still.
      const resolution = await resolveRoleForSwitch(current.role, ctx.modelRegistry, () => resolveRoleEntry(current.role, ctx.modelRegistry), { excludeCaller: true });
      if ("refusal" in resolution) {
        tell(ctx, resolution.refusal, `${current.role}:${resolution.outcome?.status ?? "error"}`);
        return;
      }
      const { entry, catalog, set, quota } = resolution.value;
      const switched = resolution.switched;
      const wanted = entry.fast === true;
      const apply = model !== entry.model || pi.getThinkingLevel() !== entry.thinking || (fast?.enabled === true) !== wanted;
      if (apply) {
        if (!(await pi.setModel(catalog))) throw new Error(`No credentials for ${entry.model}`);
        pi.setThinkingLevel(entry.thinking);
        if ((fast?.enabled === true) !== wanted) pi.events.emit(OPENAI_FAST_SET_EVENT, { enabled: wanted });
      }
      baseline = entry.model;
      const move = switched === undefined        ? `set ${set ?? "unknown"}`
        : switched.status === "switched"
          ? `set ${switched.from ?? "unset"} → ${switched.to ?? "unset"} (quota-switched${switched.partial ? ", partially: some typed requests failed or a Pi was skipped" : ""})`
          : `committed set ${switched.from ?? "unset"} → ${switched.to ?? "unchanged"} (${switched.status}; re-resolved once, no retry)`;
      ctx.ui.notify(`Role model for ${current.role}: ${move}; ${apply ? "now " : "already "}${entry.model} (${pi.getThinkingLevel()}), Fast ${wanted ? "on" : "off"}${quota ? `; quota ${quota}` : ""}`, "info");
    } catch (error) {
      // Never abort a run for the model map: one notice, then the input runs as it came.
      tell(ctx, `Role model unchanged, so this run continues on ${model ?? "its current model"}: ${error instanceof Error ? error.message : String(error)}`, `${current.role}:failure`);
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!refusal) return;
    ctx.ui.notify(refusal, "error");
    ctx.abort();
  });
}
