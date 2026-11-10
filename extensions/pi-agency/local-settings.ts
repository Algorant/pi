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
 */
export type LocalAgencySettings = { machine?: string; modelProviders?: readonly string[] };

export const localSettingsPath = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");

/** Read per call so settings edits apply to the next launch. */
export function localAgencySettings(): LocalAgencySettings {
  const path = localSettingsPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const section: unknown = JSON.parse(text)?.["pi-agency"];
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section)) throw new Error(`${path}: "pi-agency" must be an object.`);
  for (const key of Object.keys(section)) {
    if (key !== "machine" && key !== "modelProviders") throw new Error(`${path}: "pi-agency" has unknown key "${key}" (known: machine, modelProviders).`);
  }
  const { machine, modelProviders } = section as Record<string, unknown>;
  if (machine !== undefined && (typeof machine !== "string" || !/^[A-Za-z0-9-]+$/.test(machine))) {
    throw new Error(`${path}: "pi-agency".machine must be a short machine name (letters, digits, -).`);
  }
  if (modelProviders !== undefined && (!Array.isArray(modelProviders) || modelProviders.length === 0 || !modelProviders.every((p) => typeof p === "string" && p.length > 0))) {
    throw new Error(`${path}: "pi-agency".modelProviders must be a non-empty array of provider ids.`);
  }
  return { machine: machine as string | undefined, modelProviders: modelProviders as string[] | undefined };
}
