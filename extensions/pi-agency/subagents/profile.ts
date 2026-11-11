import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
/** `pi --agency-profile <name>` selects one of these definitions for a native HC helper (pi-herdr/profile.ts). */
export const AGENCY_PROFILE_FLAG = "agency-profile";
/** getFlag is extension-local; shared policies inspect this process's actual CLI mode. */
export function hcProfileRequested(): boolean {
  const end = process.argv.indexOf("--");
  return Boolean(process.env.HC_TERMINAL_ID) && process.argv.slice(0, end < 0 ? undefined : end)
    .some(arg => arg === `--${AGENCY_PROFILE_FLAG}` || arg.startsWith(`--${AGENCY_PROFILE_FLAG}=`));
}
export const PROFILE_TOOL_NAMES = [
  "read", "find", "grep", "bash", "web_search", "fetch_content", "code_search", "get_search_content",
] as const;
export type ProfileToolName = typeof PROFILE_TOOL_NAMES[number];

export type SubagentProfileName = "scout" | "researcher" | "reviewer";

export interface PiSubagentProfileDefinition {
  name: string;
  description: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools: readonly ProfileToolName[];
  prompt: string;
  path: string;
}

const PROFILE_FIELDS = new Set(["name", "description", "model", "thinking", "tools"]);
export const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function validateModelIdentifier(value: string, label: string): string {
  const model = value.trim();
  const separator = model.indexOf("/");
  if (separator <= 0 || separator === model.length - 1 || model.slice(separator + 1).includes("/")) {
    throw new TypeError(`${label} must be an exact provider/model identifier`);
  }
  return model;
}
const TOOL_NAMES = new Set<string>(PROFILE_TOOL_NAMES);
export const THINKING_NAMES = new Set<string>([...THINKING_LEVELS]);

function profileError(path: string, reason: string): TypeError {
  return new TypeError(`Invalid subagent profile ${path}: ${reason}`);
}

function scalar(value: string, path: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw profileError(path, `${field} must not be empty`);
  if ((trimmed.startsWith('"') && !trimmed.endsWith('"')) || (trimmed.startsWith("'") && !trimmed.endsWith("'"))) {
    throw profileError(path, `${field} has an unterminated quoted value`);
  }
  const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!unquoted.trim()) throw profileError(path, `${field} must not be empty`);
  return unquoted;
}

function parseProfileFile(path: string): PiSubagentProfileDefinition {
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  if (lines[0] !== "---") throw profileError(path, "frontmatter must start with ---");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw profileError(path, "frontmatter is unterminated");
  const values: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) throw profileError(path, `malformed frontmatter line ${index + 1}`);
    const [, key, value] = match;
    if (!PROFILE_FIELDS.has(key!)) throw profileError(path, `unknown frontmatter field ${key}`);
    if (values[key!] !== undefined) throw profileError(path, `duplicate frontmatter field ${key}`);
    values[key!] = value!;
  }
  if (!values.name) throw profileError(path, "missing required frontmatter field name");
  if (!values.description) throw profileError(path, "missing required frontmatter field description");
  const name = scalar(values.name, path, "name");
  const description = scalar(values.description, path, "description");
  const model = values.model === undefined ? undefined : validateModelIdentifier(scalar(values.model, path, "model"), `${path} model`);
  const thinkingValue = values.thinking === undefined ? undefined : scalar(values.thinking, path, "thinking");
  if (thinkingValue !== undefined && !THINKING_NAMES.has(thinkingValue)) throw profileError(path, `thinking must be one of ${[...THINKING_NAMES].join(", ")}`);
  const tools = values.tools === undefined ? [] : values.tools.split(",").map((item) => scalar(item, path, "tools"));
  for (const tool of tools) if (!TOOL_NAMES.has(tool)) throw profileError(path, `unknown tool ${tool}`);
  const uniqueTools = [...new Set(tools)] as ProfileToolName[];
  return {
    name, description, model, thinking: thinkingValue as ThinkingLevel | undefined,
    tools: Object.freeze(uniqueTools), prompt: lines.slice(end + 1).join("\n"),
    path,
  };
}

/** The profiles bundled beside this module, so a loaded extension always reads its own set. */
export const BUNDLED_SUBAGENT_PROFILES_DIRECTORY = fileURLToPath(new URL("../agents", import.meta.url));

/** Load every bundled markdown profile. Any malformed file aborts the whole load. */
export function loadSubagentProfiles(profileDirectory: string): readonly PiSubagentProfileDefinition[] {
  let files: string[];
  try {
    files = readdirSync(profileDirectory).filter((file) => file.endsWith(".md")).sort().map((file) => join(profileDirectory, file));
  } catch (error) {
    throw new TypeError(`Unable to load subagent profiles from ${profileDirectory}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return Object.freeze(files.map(parseProfileFile));
}

export function profilesByName(profiles: readonly PiSubagentProfileDefinition[]): ReadonlyMap<string, PiSubagentProfileDefinition> {
  const result = new Map<string, PiSubagentProfileDefinition>();
  for (const profile of profiles) {
    if (result.has(profile.name)) throw profileError(profile.path, `duplicate profile name ${profile.name}`);
    result.set(profile.name, profile);
  }
  return result;
}

export function resolveSubagentProfile(name: SubagentProfileName, profiles: readonly PiSubagentProfileDefinition[]): PiSubagentProfileDefinition {
  const profile = profilesByName(profiles).get(name);
  if (!profile) throw new TypeError(`Unknown subagent profile ${name}`);
  return profile;
}
