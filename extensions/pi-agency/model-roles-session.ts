import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hcJson } from "../pi-herdr/core.ts";
import { OPENAI_FAST_SET_EVENT, OPENAI_FAST_STATE_EVENT, type OpenAIFastState } from "../pi-providers/openai/events.ts";
import { KIND_KEY, terminalWho } from "../../scripts/whois.ts";
import { holdActive, LocalAgencySettingsError, localAgencySettings, quotaHolds, type QuotaHolds } from "./local-settings.ts";
import { ModelSetUnavailableError, committedCellModels, resolveRoleEntry, type ResolvedRoleEntry } from "./model-roles.ts";
import { resolveRoleForSwitch, type RoleResolution } from "./herdra-role.ts";
import { workerContextRequested } from "./workers/context.ts";
import { hcProfileRequested } from "./subagents/profile.ts";
import { carriedExplicitFailure, explicitLaunch, EXPLICIT_MODEL_FLAG, recordExplicitStartup, verifyExplicitLaunch } from "./launch-model.ts";
import { registerProvider429Recovery } from "./provider-rate-limit.ts";

/**
 * Apply the role entry of agent/model-roles.json to a fresh interactive main
 * session: `herdra` for the native HC terminal named herdra once the machine
 * opts into named sets, `manus` for a terminal labelled kind=manus, and
 * `orchestrator` for every other session. Sets the session model and its
 * configured thinking level. This startup application is skipped for Workers,
 * resumed sessions, reloads and forks, and whenever the command line names a
 * model or thinking level, which still win (a launched manus or Ceph passes its
 * resolved `--model`). A session launched with an explicit per-launch pair
 * (`--agency-explicit-model`, launch-model.ts) is never managed: it keeps that exact pair.
 *
 * Without named sets the legacy behavior is unchanged: a terminal named herdra
 * uses the declared orchestrator list, because the herdra row exists only in
 * sets. A manus always uses its own independent role. If the named-set, herdra
 * or manus resolution fails, the session never runs on its unchecked startup
 * model: every turn is refused until a model is chosen explicitly (/model or a
 * cutover request), which fires model_select. The legacy orchestrator path
 * keeps its notify-only behavior.
 *
 * Session start vs an ordinary turn (task-745). A session start — `startup`, `new`,
 * `resume`, `reload`, `fork` — is the moment this module re-reads the role and the
 * starting model. It arms exactly one healthy reconciliation except on `reload`, where
 * the carried model may be a deliberate in-session choice and must remain untouched.
 * A healthy reconciliation is consumed by the session's first policy-owned turn: a loaded
 * session whose start carried another model (a resume on a stale one, a fresh session that
 * never got its
 * role model) catches up to the committed model, thinking and Fast once, in process.
 * Every ordinary turn after it leaves a healthy row alone, so an ordinary later change
 * of the committed map never self-applies here — it arrives only through the existing
 * typed cutover, which sets the model, thinking and Fast itself, and which this gate
 * recognises as the policy's own model rather than as a human choice. On `/reload` the
 * baseline is still reset to the carried model, but healthy reconciliation is not armed.
 *
 * Pre-turn gate (task-745), independent of that startup application: every managed
 * long-lived session (herdra, Ceph, manus) — including one resumed, reloaded or
 * started with an explicit `--model` — checks its own role before each run. One
 * resolution answers both cases. A usable set never writes the map. When the selected
 * set is blocked by quota ALONE and the session is still on that cell's model, the gate
 * asks Herdra's `herdra-cutover role` (the same selector and apply the machine-wide
 * watch uses) for a column with room, re-resolves the committed map once, and applies
 * the differing model, thinking and Fast in-process at `before_agent_start` — before
 * that run builds its provider request. A quota move is decided by that selector, not by
 * this in-memory debt, so it is never bounded to one turn. A session already on its
 * committed model is left exactly as it is, so an in-session thinking or Fast change on
 * a normal turn stands. The already-delivered kickoff or inbox input is the run's own
 * input, so nothing is replayed, queued or awaited. A model that differs from the cell
 * it started on (a human /model, or another deliberate pin) is left alone. When no
 * column has room, or the command fails or answers stale, the session shows ONE notice
 * and the run continues normally on its current model — never an abort, an in-turn retry,
 * or permission for a new launch on a blocked selection.
 */
const EXPLICIT_MODEL_ARGS = /^--(model|models|provider|thinking)(=|$)/;
type Role = "herdra" | "manus" | "orchestrator";
const modelId = (ctx: ExtensionContext): string | undefined => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

function formatHoldUntil(until: string, now = new Date()): string {
  const end = new Date(until);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(end);
  const dayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  if (dayKey(end) === dayKey(now)) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return `${time} ${dayKey(end) === dayKey(tomorrow) ? "tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(end)}`;
}

/**
 * The session's role and whether this machine's model policy manages it. Only a native
 * long-lived actor does — Herdra, a Ceph or a manus — so a plain interactive Pi, a
 * short-lived child, a Worker or a hand-started `pi --model` session is never chased, while
 * it keeps the startup row it always had. The role is whois's terminal rule, the one naming
 * system: an explicit `kind` (or label) wins, and a Pi with neither that sits in its space's
 * main tab is that space's Ceph. That location is the terminal's own label written when the
 * space/tab was created, so it is already readable when a resume or revive evaluates identity,
 * and no durable marker is needed for a Ceph started without its creation labels.
 */
async function identity(named: boolean): Promise<{ role: Role; managed: boolean }> {
  if (!process.env.HC_TERMINAL_ID) return { role: "orchestrator", managed: false };
  const terminal = await hcJson(["get", process.env.HC_TERMINAL_ID]);
  const kind = terminal.labels?.[KIND_KEY] ?? terminalWho(terminal).kind;
  if (kind === "manus") return { role: "manus", managed: true };
  // The herdra row exists only in named sets; legacy Herdra keeps the declared orchestrator list.
  if (terminal.name === "herdra" && named) return { role: "herdra", managed: true };
  return { role: "orchestrator", managed: kind === "ceph" };
}

export function registerOrchestratorModel(pi: ExtensionAPI): void {
  let refusal: string | undefined;
  /** The managed actor for this session, resolved on every session start; undefined when unmanaged. */
  let actor: { role: Role } | undefined;
  registerProvider429Recovery(pi, async () => actor ? { role: actor.role } : undefined);
  /**
   * The model this session started on (or last took from the policy map), in memory only. A model
   * that differs from it is an in-session choice and is left alone — unless it is exactly the
   * committed cell's model, which is what a typed cutover or an earlier policy apply sets. A model
   * that still equals it (a launch default, a resumed model, a fresh session that never got its
   * role model) is the policy's to move. No durable marker is written.
   */
  let baseline: string | undefined;
  /**
   * Whether this session's one healthy reconciliation is still owed, in memory only. Armed on every
   * session start and consumed by the first policy-owned turn that finds a healthy row; after that
   * an ordinary turn never moves a healthy row again, so a later change of the committed map arrives
   * only through the typed cutover. A quota switch never consults it. No durable marker is written.
   */
  let reconciliationOwed = false;
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
    reconciliationOwed = false;
    notices.clear();
    if (ctx.mode !== "tui") return;
    if (hcProfileRequested()) return;
    // An explicit per-launch pair (task-851) is exact: this session is never role-managed, so no
    // startup replacement, pre-turn quota move or 429 switch can change it. A start that did not
    // retain it refuses every run instead of continuing on another model.
    try {
      const exact = explicitLaunch(pi);
      if (exact) {
        // The launch startup verifies; reload, resume and fork carry a recorded startup refusal forward.
        const launching = event.reason === "startup" || event.reason === "new";
        const failure = launching ? verifyExplicitLaunch(pi, ctx, exact) : carriedExplicitFailure(ctx, exact);
        if (launching) recordExplicitStartup(pi, exact, failure);
        if (failure) {
          refusal = failure;
          ctx.ui.notify(failure, "error");
        }
        return;
      }
    } catch (error) {
      refusal = `--${EXPLICIT_MODEL_FLAG} is invalid, so this session refuses to run: ${error instanceof Error ? error.message : String(error)}`;
      ctx.ui.notify(refusal, "error");
      return;
    }
    if (workerContextRequested()) return;
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
    // A managed session owes its first policy-owned turn one catch-up to the committed model,
    // except on reload: that event carries the in-session selection and must not healthy-reconcile it.
    reconciliationOwed = actor !== undefined && event.reason !== "reload";
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
      const holds = quotaHolds();
      const holdNow = Date.now();
      const holdUntil = holds[role];
      const holdMark = holdUntil && holdActive(role, holdNow, holds) ? `; quota hold until ${formatHoldUntil(holdUntil, new Date(holdNow))}` : "";
      ctx.ui.notify(`${label}: ${entry.model} (${pi.getThinkingLevel()})${quota ? `; quota ${quota}` : ""}${holdMark}${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}`, "info");
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

  /** The pre-turn role gate, before this run builds its provider request (task-745). */
  pi.on("before_agent_start", async (_event, ctx) => {
    const current = actor;
    if (!current) return;
    let holds: QuotaHolds;
    try { holds = quotaHolds(); }
    catch (error) {
      tell(ctx, `Automatic quota moves for ${current.role} are disabled by invalid hold settings: ${error instanceof Error ? error.message : String(error)}.`, `${current.role}:invalid-hold`);
      return;
    }
    const holdNow = Date.now();
    const holdUntil = holds[current.role];
    if (holdUntil && holdActive(current.role, holdNow, holds)) {
      tell(ctx, `Automatic quota moves for ${current.role} are held until ${formatHoldUntil(holdUntil, new Date(holdNow))}; continuing on ${modelId(ctx) ?? "the current model"}.`, `${current.role}:hold:${holdUntil}`);
      return;
    }
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
      // The model is the policy's (unchanged since the session started, or set to the committed
      // cell): resolve it once here. Only a quota-only block consults Herdra's selector. A usable
      // set is handed to the one reconciliation a non-reload session start armed; an ordinary
      // turn after that leaves the healthy row exactly as it is instead of applying the map again.
      let resolution: RoleResolution<ResolvedRoleEntry>;
      try {
        resolution = await resolveRoleForSwitch(current.role, ctx.modelRegistry, () => resolveRoleEntry(current.role, ctx.modelRegistry), { excludeCaller: true });
      } catch (error) {
        if (error instanceof ModelSetUnavailableError && error.kind !== "quota") return;
        throw error; // unexpected resolver/selector failure reaches the one actionable notice
      }
      if ("refusal" in resolution) {
        tell(ctx, resolution.refusal, `${current.role}:${resolution.outcome?.status ?? "error"}`);
        return;
      }
      const { entry, catalog, set, quota } = resolution.value;
      const switched = resolution.switched;
      // Healthy row: only the one reconciliation an eligible session start armed may move it.
      // Once consumed, an ordinary turn returns here, so a later change of the committed map
      // applies only through
      // the existing typed cutover, never as a second self-applied path.
      if (switched === undefined) {
        if (!reconciliationOwed) return;
        reconciliationOwed = false;
        // Already on the committed model: the consuming turn itself changes nothing, so it never
        // re-pins thinking or Fast over an in-session change.
        if (model === entry.model) return;
      }
      const wanted = entry.fast === true;
      const apply = model !== entry.model || pi.getThinkingLevel() !== entry.thinking || (fast?.enabled === true) !== wanted;
      if (apply) {
        if (!(await pi.setModel(catalog))) throw new Error(`No credentials for ${entry.model}`);
        pi.setThinkingLevel(entry.thinking);
        if ((fast?.enabled === true) !== wanted) pi.events.emit(OPENAI_FAST_SET_EVENT, { enabled: wanted });
      }
      reconciliationOwed = false;
      baseline = entry.model;
      const move = switched === undefined        ? `set ${set ?? "unknown"}, session was on ${model ?? "no model"}`
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
