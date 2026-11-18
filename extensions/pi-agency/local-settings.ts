import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The machine-local `"pi-agency"` section of the global Pi settings.json
 * (untracked machine state). No Pi imports, so the inbox CLI can load it.
 *
 * - `machine`: this machine's name for inbox addresses, for machines without
 *   Tailscale (work-machine).
 * - `modelProviders`: when set, only model-roles entries from these providers
 *   are available on this machine (work-machine: Copilot only).
 * - `modelSets`: opts this machine into the named sets of model-roles.json
 *   (task-714): one set name per role, all six roles. Replaces
 *   `modelProviders`; the two never combine. Only the shape is checked here;
 *   model-roles.ts checks that each named set exists and fills its role.
 */
export const MODEL_SET_ROLES = ["herdra", "orchestrator", "manus", "worker", "subagent", "review"] as const;
export type ModelSetRole = (typeof MODEL_SET_ROLES)[number];
export type ModelSetSelection = Readonly<Record<ModelSetRole, string>>;
export type LocalAgencySettings = { machine?: string; modelProviders?: readonly string[]; modelSets?: ModelSetSelection };

/** A malformed `"pi-agency"` section; `modelSets` says whether it opts into named sets. */
export class LocalAgencySettingsError extends Error {
  constructor(message: string, readonly modelSets: boolean) {
    super(message);
  }
}

export const localSettingsPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");

/** The settings file's text, or undefined when this machine has none yet. */
function settingsText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read per call so settings edits apply to the next launch. */
export function localAgencySettings(): LocalAgencySettings {
  const path = localSettingsPath();
  const text = settingsText(path);
  if (text === undefined) return {};
  const section: unknown = JSON.parse(text)?.["pi-agency"];
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) throw new Error(`${path}: "pi-agency" must be an object.`);
  // An opt-in (a modelSets key) that fails validation must still fail closed, not read as legacy.
  const named = Object.hasOwn(section, "modelSets");
  function fail(message: string): never {
    throw new LocalAgencySettingsError(message, named);
  }
  for (const key of Object.keys(section)) {
    if (key !== "machine" && key !== "modelProviders" && key !== "modelSets") fail(`${path}: "pi-agency" has unknown key "${key}" (known: machine, modelProviders, modelSets).`);
  }
  const { machine, modelProviders, modelSets } = section as Record<string, unknown>;
  if (machine !== undefined && (typeof machine !== "string" || !/^[A-Za-z0-9-]+$/.test(machine))) {
    fail(`${path}: "pi-agency".machine must be a short machine name (letters, digits, -).`);
  }
  if (modelProviders !== undefined && (!Array.isArray(modelProviders) || modelProviders.length === 0 || !modelProviders.every((p) => typeof p === "string" && p.length > 0))) {
    fail(`${path}: "pi-agency".modelProviders must be a non-empty array of provider ids.`);
  }
  if (modelSets !== undefined) {
    const roles = `one set name for each of ${MODEL_SET_ROLES.join(", ")}`;
    if (typeof modelSets !== "object" || modelSets === null || Array.isArray(modelSets)) fail(`${path}: "pi-agency".modelSets must be an object with ${roles}.`);
    const keys = Object.keys(modelSets);
    const values = modelSets as Record<string, unknown>;
    if (keys.length !== MODEL_SET_ROLES.length || !MODEL_SET_ROLES.every((role) => typeof values[role] === "string" && (values[role] as string).length > 0)) {
      fail(`${path}: "pi-agency".modelSets must have exactly ${roles} (got keys ${keys.join(", ") || "none"}).`);
    }
    if (modelProviders !== undefined) fail(`${path}: "pi-agency" sets both modelSets and modelProviders; modelSets replaces modelProviders, so remove modelProviders.`);
  }
  return { machine: machine as string | undefined, modelProviders: modelProviders as string[] | undefined, modelSets: modelSets as ModelSetSelection | undefined };
}

/**
 * The optional machine-local `"pi-agency-temporary"` section of the same
 * settings.json, deliberately a separate top-level key so a Pi running an older
 * `"pi-agency"` reader (which rejects unknown keys) keeps working. Both keys are
 * optional and only these exact values are accepted; an absent section is the
 * normal routing, and removing it (or a key) restores the old path.
 *
 * - `review: "paused"`: reviewer launches and review resolution fail clearly.
 */
export type TemporaryAgencySettings = { review?: "paused" };

/** Read per launch so adding or removing the section applies to the next dispatch. */
export function temporaryAgencySettings(): TemporaryAgencySettings {
  const path = localSettingsPath();
  const text = settingsText(path);
  if (text === undefined) return {};
  const section: unknown = JSON.parse(text)?.["pi-agency-temporary"];
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    throw new Error(`${path}: "pi-agency-temporary" must be an object.`);
  }
  for (const key of Object.keys(section)) {
    if (key !== "review") throw new Error(`${path}: "pi-agency-temporary" has unknown key "${key}" (known: review).`);
  }
  const { review } = section as Record<string, unknown>;
  if (review !== undefined && review !== "paused") throw new Error(`${path}: "pi-agency-temporary".review must be "paused"; remove it to restore reviews.`);
  return { ...(review === undefined ? {} : { review: "paused" }) };
}
