import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveRoleForSwitch, type RoleSwitch } from "./herdra-role.ts";
import { temporaryAgencySettings, localSettingsPath } from "./local-settings.ts";
import { loadModelRoles, resolveExplicitModel, resolveReviewEntry, resolveRoleEntry, unsupportedThinking, type ResolvedRoleEntry, type RoleName, type RoleRegistry } from "./model-roles.ts";
import { THINKING_LEVELS, validateModelIdentifier } from "./subagents/profile.ts";

/**
 * The one per-launch model selection of every model-backed native launch (task-851): `dendra_start`
 * (scout, researcher, reviewer, worker), `manus_start` and `ceph_start` all take the same optional
 * exact `model` (`provider/id`) and `thinking`. Omitted, the launch is exactly its role/set default
 * (`resolveRoleForSwitch`, quota-only cutover included). Given, the pair is exact and locked: no
 * cutover and no fallback at launch, and the child keeps it at startup, on continuation and on a
 * provider 429 (`--agency-explicit-model`). Scriptify runs no Pi model and takes neither.
 */
export type LaunchRole = RoleName | "review";
export type LaunchOverride = { model?: string; thinking?: string };
export type LaunchSelection = {
  model: string;
  thinking: ThinkingLevel;
  /** `provider/id:thinking`, the exact `--model` value of the child. */
  argument: string;
  source: "default" | "override";
  requestedModel?: string;
  requestedThinking?: ThinkingLevel;
  set?: string;
  quota?: string;
  quotaCheckedAt?: number;
};
export type LaunchResolution = { selection: LaunchSelection; switched?: RoleSwitch } | { refusal: string; outcome?: RoleSwitch };

const selection = (model: string, thinking: ThinkingLevel, rest: Omit<LaunchSelection, "model" | "thinking" | "argument">): LaunchSelection => ({ model, thinking, argument: `${model}:${thinking}`, ...rest });

/** The caller's override, validated; throws before anything exists. */
export function parseOverride(override: LaunchOverride): { model?: string; thinking?: ThinkingLevel } {
  if (override.thinking !== undefined && !THINKING_LEVELS.has(override.thinking as ThinkingLevel)) {
    throw new Error(`thinking must be one of ${[...THINKING_LEVELS].join(", ")}. Nothing was started.`);
  }
  let model: string | undefined;
  if (override.model !== undefined) {
    try { model = validateModelIdentifier(override.model, "model"); }
    catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}. Nothing was started.`); }
  }
  return { ...(model !== undefined ? { model } : {}), ...(override.thinking !== undefined ? { thinking: override.thinking as ThinkingLevel } : {}) };
}

/** One-line summary every launch result carries: the resolved pair and whether the role default or the caller chose it. */
export function describeSelection(chosen: LaunchSelection): string {
  const asked = chosen.source === "override"
    ? `override${chosen.requestedModel ? "" : " (thinking only; model from the role default)"}`
    : "role default";
  return `${chosen.model} at ${chosen.thinking} (${asked}${chosen.set ? `; set ${chosen.set}` : ""}${chosen.quota ? `; quota ${chosen.quota}` : ""})`;
}

/**
 * Resolve one launch's pair. `refusal` (never a thrown availability error) names why an explicit
 * choice cannot launch; default-path failures keep their existing throws. Reviewer: an explicit
 * model replaces opposite-company routing, but a disabled or paused review still refuses.
 */
export async function selectLaunchModel(role: LaunchRole, override: LaunchOverride, registry: RoleRegistry, options: { callerModel?: string; signal?: AbortSignal } = {}): Promise<LaunchResolution> {
  const { model, thinking } = parseOverride(override);
  const resolveDefault = (): ResolvedRoleEntry => role === "review"
    ? resolveReviewEntry(options.callerModel!, registry)
    : resolveRoleEntry(role, registry);
  if (model === undefined) {
    const resolved = await resolveRoleForSwitch(role, registry, resolveDefault, { callerModel: options.callerModel, signal: options.signal });
    if ("refusal" in resolved) return resolved;
    const { entry, catalog, set, quota } = resolved.value;
    const bound = { ...(set ? { set } : {}), ...(quota ? { quota } : {}) };
    if (thinking === undefined) return { selection: selection(entry.model, entry.thinking, { source: "default", ...bound }), ...(resolved.switched ? { switched: resolved.switched } : {}) };
    const unsupported = unsupportedThinking(catalog, thinking);
    if (unsupported) return { refusal: `${unsupported}. Pass a supported thinking level.`, ...(resolved.switched ? { outcome: resolved.switched } : {}) };
    return { selection: selection(entry.model, thinking, { source: "override", requestedThinking: thinking, ...bound }), ...(resolved.switched ? { switched: resolved.switched } : {}) };
  }
  if (role === "review") {
    if (temporaryAgencySettings().review === "paused") return { refusal: `Reviews are paused by "pi-agency-temporary".review in ${localSettingsPath()}; remove that key to restore reviewer launches.` };
    if (!loadModelRoles().roles.review.enabled) return { refusal: "Review is disabled: roles.review.enabled is false in model-roles.json." };
  }
  try {
    const exact = resolveExplicitModel(role, model, thinking, registry);
    return { selection: selection(exact.model, exact.thinking, {
      source: "override", requestedModel: model, ...(thinking ? { requestedThinking: thinking } : {}),
      ...(exact.quota ? { quota: exact.quota } : {}), ...(exact.quotaCheckedAt !== undefined ? { quotaCheckedAt: exact.quotaCheckedAt } : {}),
    }) };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

/** The flag that makes a child hold exactly this explicit pair; none for a role default, whose child keeps its normal role policy. */
export function explicitFlagArgs(chosen: Pick<LaunchSelection, "argument" | "source">): string[] {
  return chosen.source === "override" ? [`--${EXPLICIT_MODEL_FLAG}`, chosen.argument] : [];
}

/** `--model` plus the flag, for a child (a helper) whose default launch passes no model at all. */
export function explicitLaunchArgs(chosen: Pick<LaunchSelection, "argument" | "source">): string[] {
  return chosen.source === "override" ? ["--model", chosen.argument, ...explicitFlagArgs(chosen)] : [];
}

/**
 * Child side. The flag carries the exact `provider/id:thinking` the parent preflighted. A child that
 * has it never re-resolves its role, never takes a pre-turn quota move and never switches on a 429:
 * it keeps this pair or fails at startup (`verifyExplicitLaunch`).
 */
export const EXPLICIT_MODEL_FLAG = "agency-explicit-model";

export function registerExplicitModelFlag(pi: ExtensionAPI): void {
  pi.registerFlag(EXPLICIT_MODEL_FLAG, { type: "string", description: "Native launch: the exact preflighted provider/id:thinking this session must keep (no role replacement, quota move or 429 switch)." });
}

/** The session's explicit pair; undefined when it was not launched with one. Throws on a malformed value. */
export function explicitLaunch(pi: ExtensionAPI): { model: string; thinking: ThinkingLevel } | undefined {
  const value = pi.getFlag(EXPLICIT_MODEL_FLAG);
  if (value === undefined || value === false || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`--${EXPLICIT_MODEL_FLAG} needs a provider/id:thinking value.`);
  const cut = value.lastIndexOf(":");
  const level = value.slice(cut + 1);
  if (cut < 0 || !THINKING_LEVELS.has(level as ThinkingLevel)) throw new Error(`--${EXPLICIT_MODEL_FLAG} ${value} is not provider/id:thinking.`);
  return { model: validateModelIdentifier(value.slice(0, cut), `--${EXPLICIT_MODEL_FLAG} model`), thinking: level as ThinkingLevel };
}

/** True when this session was launched with an explicit pair, even a malformed one (which startup then refuses). */
export function explicitLaunchActive(pi: ExtensionAPI): boolean {
  const value = pi.getFlag(EXPLICIT_MODEL_FLAG);
  return typeof value === "string" && value !== "";
}

/** Session entry recording whether an explicit pair held at its launch startup, so a reload or resume cannot silently lift a startup refusal. */
const STARTUP_ENTRY = "pi-agency-explicit-startup";

/** Records the launch-startup verification of the explicit pair in the session. */
export function recordExplicitStartup(pi: ExtensionAPI, expected: { model: string; thinking: ThinkingLevel }, failure: string | undefined): void {
  pi.appendEntry(STARTUP_ENTRY, { pair: `${expected.model}:${expected.thinking}`, ok: failure === undefined });
}

/**
 * Reload, resume and fork carry the session's model forward without launching again. A launch that
 * failed its startup verification stays refused across them until a deliberate model change (a
 * `model_change` entry after the failure, such as the operator's /model) or the exact pair is
 * back. Returns the refusal text, or undefined when nothing is owed.
 */
export function carriedExplicitFailure(ctx: ExtensionContext, expected: { model: string; thinking: ThinkingLevel }): string | undefined {
  const pair = `${expected.model}:${expected.thinking}`;
  const entries = ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: { pair?: string; ok?: boolean } }>;
  const at = entries.map((entry) => entry.type === "custom" && entry.customType === STARTUP_ENTRY && entry.data?.pair === pair ? entry.data.ok : undefined).findLastIndex((ok) => ok !== undefined);
  if (at < 0 || entries[at]!.data?.ok !== false) return undefined;
  if (entries.slice(at + 1).some((entry) => entry.type === "model_change")) return undefined;
  const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  if (active === expected.model) return undefined;
  return `This explicit launch never retained ${expected.model}${active ? ` (this session is on ${active})` : ""}, and a reload or resume does not lift that; choose a model with /model or relaunch.`;
}

/** Startup check of an explicit pair: the retained model and level must be exactly it. Returns the failure text, or undefined. */
export function verifyExplicitLaunch(pi: ExtensionAPI, ctx: ExtensionContext, expected: { model: string; thinking: ThinkingLevel }): string | undefined {
  const active = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  if (active !== expected.model) return `Explicit launch did not retain ${expected.model}${active ? ` (this session is on ${active})` : " (this session has no model)"}; nothing was substituted.`;
  if (pi.getThinkingLevel() !== expected.thinking) pi.setThinkingLevel(expected.thinking);
  if (pi.getThinkingLevel() !== expected.thinking) return `Explicit launch could not apply thinking ${expected.thinking} to ${expected.model} (now ${pi.getThinkingLevel()}); nothing was substituted.`;
  return undefined;
}
