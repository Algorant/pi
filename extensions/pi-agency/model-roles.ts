import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOpenAICodexFastTarget } from "../pi-providers/openai/model.ts";
import { currentWindowUsage, readCachedLimits } from "../pi-providers/quota/quota-service.ts";
import { THINKING_LEVELS, validateModelIdentifier } from "./subagents/profile.ts";
import { localAgencySettings, localSettingsPath } from "./local-settings.ts";

/**
 * The single source of default models (task-404). `agent/model-roles.json` holds
 * an ordered list per role; the first entry that is available wins. Explicit
 * model/thinking arguments from a caller still win over the file. An entry whose
 * provider (anthropic, openai-codex) is at or above `quota.weeklyThreshold` or
 * `quota.fiveHourThreshold` in the corresponding window counts as unavailable.
 * On a machine whose local settings set `"pi-agency": { "modelProviders": [...] }`,
 * entries from other providers count as unavailable too.
 */
export const ROLE_NAMES = ["orchestrator", "worker", "subagent"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export type RoleEntry = { model: string; thinking: ThinkingLevel; fast: boolean };
export type ModelRoles = {
  quota: { weeklyThreshold: number; fiveHourThreshold: number };
  roles: Record<RoleName, readonly RoleEntry[]> & { review: { enabled: boolean; models: readonly RoleEntry[] } };
};
const QUOTA_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai-codex"]);
const BENCHMARK_QUOTA_MAX_AGE_MS = 30 * 60_000;
const BENCHMARK_QUOTA_THRESHOLD = 0.9;
export const BENCHMARK_WORKER_MODELS = ["openai-codex/gpt-6-luna", "anthropic/claude-sonnet-5-5"] as const;
export type BenchmarkWorkerModel = (typeof BENCHMARK_WORKER_MODELS)[number];
export type RoleRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "hasConfiguredAuth">;
type CatalogModel = NonNullable<ReturnType<RoleRegistry["find"]>>;

export function modelRolesPath(): string {
  return join(getAgentDir(), "model-roles.json");
}

function object(value: unknown, where: string, keys: readonly string[], path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${path}: ${where} must be an object`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new TypeError(`${path}: ${where} has unknown key "${key}"`);
  }
  return value as Record<string, unknown>;
}

function entries(value: unknown, where: string, path: string): readonly RoleEntry[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path}: ${where} must be a non-empty array`);
  return value.map((item, index) => {
    const at = `${where}[${index}]`;
    const entry = object(item, at, ["model", "thinking", "fast"], path);
    if (typeof entry.model !== "string") throw new TypeError(`${path}: ${at}.model must be a "provider/id" string`);
    if (typeof entry.thinking !== "string" || !THINKING_LEVELS.has(entry.thinking as ThinkingLevel)) throw new TypeError(`${path}: ${at}.thinking must be one of ${[...THINKING_LEVELS].join(", ")}`);
    if (entry.fast !== undefined && typeof entry.fast !== "boolean") throw new TypeError(`${path}: ${at}.fast must be a boolean`);
    return { model: validateModelIdentifier(entry.model, `${path}: ${at}.model`), thinking: entry.thinking as ThinkingLevel, fast: entry.fast === true };
  });
}

/** Read and strictly validate the roles file. Read per call so edits apply to the next launch. */
export function loadModelRoles(path = modelRolesPath()): ModelRoles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read model roles from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = object(parsed, "the file", ["quota", "roles"], path);
  const quota = object(root.quota, "quota", ["weeklyThreshold", "fiveHourThreshold"], path);
  const threshold = quota.weeklyThreshold;
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new TypeError(`${path}: quota.weeklyThreshold must be a number above 0 and at most 1 (for example 0.9)`);
  const fiveHourThreshold = quota.fiveHourThreshold;
  if (typeof fiveHourThreshold !== "number" || !Number.isFinite(fiveHourThreshold) || fiveHourThreshold <= 0 || fiveHourThreshold > 1) throw new TypeError(`${path}: quota.fiveHourThreshold must be a number above 0 and at most 1 (for example 0.9)`);
  const roles = object(root.roles, "roles", [...ROLE_NAMES, "review"], path);
  const review = object(roles.review, "roles.review", ["enabled", "models"], path);
  if (typeof review.enabled !== "boolean") throw new TypeError(`${path}: roles.review.enabled must be a boolean`);
  return {
    quota: { weeklyThreshold: threshold, fiveHourThreshold },
    roles: {
      orchestrator: entries(roles.orchestrator, "roles.orchestrator", path),
      worker: entries(roles.worker, "roles.worker", path),
      subagent: entries(roles.subagent, "roles.subagent", path),
      review: { enabled: review.enabled, models: entries(review.models, "roles.review.models", path) },
    },
  };
}

/**
 * The one per-entry availability check: catalog/auth, machine provider policy and
 * quota. Ordinary role selection retains its historical unknown-cache behavior;
 * the private strict policy is used only by resolveBenchmarkWorkerModel below.
 */
type EntryPolicy = { providerException?: string; requireFreshQuota?: boolean };
type EntryCheck = { catalog: CatalogModel; quota?: string };
function checkEntry(entry: RoleEntry, registry: RoleRegistry, { weeklyThreshold, fiveHourThreshold }: ModelRoles["quota"], allowedProviders: readonly string[] | undefined, policy: EntryPolicy = {}): { reason: string } | EntryCheck {
  const separator = entry.model.indexOf("/");
  const provider = entry.model.slice(0, separator);
  if (allowedProviders && !allowedProviders.includes(provider) && policy.providerException !== entry.model) return { reason: `provider ${provider} is not in "pi-agency".modelProviders in ${localSettingsPath()}` };
  const catalog = registry.find(provider, entry.model.slice(separator + 1));
  if (!catalog) return { reason: "not in the model catalog" };
  if (!registry.hasConfiguredAuth(catalog)) return { reason: `no credentials for provider ${provider}` };
  if (QUOTA_PROVIDERS.has(provider)) {
    const cached = readCachedLimits(provider);
    if (policy.requireFreshQuota) {
      const age = cached?.fetchedAt === undefined ? undefined : Date.now() - cached.fetchedAt;
      if (age === undefined || age < 0 || age > BENCHMARK_QUOTA_MAX_AGE_MS) return { reason: "quota cache missing, future-dated, or older than 30 minutes" };
      const windows = cached.windows;
      const weekWindows = windows.filter((window) => window.label === "Week");
      const fiveHourWindows = windows.filter((window) => window.label === "5h");
      if (!weekWindows.length) return { reason: "weekly quota is missing" };
      const checkedWindows: Array<{ label: "Week" | "5h"; usedPercent: number }> = [];
      for (const [label, reports] of [["Week", weekWindows], ["5h", fiveHourWindows]] as const) {
        for (const reported of reports) {
          const current = currentWindowUsage([reported], label);
          if (!current || current.usedPercent < 0 || current.usedPercent > 100) return { reason: `reported ${label} quota is malformed or not current` };
          if (current.usedPercent / 100 >= BENCHMARK_QUOTA_THRESHOLD) return { reason: `${label} quota ${Math.round(current.usedPercent)}% is at or above the 90% threshold` };
          checkedWindows.push({ label, usedPercent: current.usedPercent });
        }
      }
      const weekSummary = checkedWindows.filter((window) => window.label === "Week").map((window) => `Week ${Math.round(window.usedPercent)}%`).join(", ");
      const fiveHourSummary = checkedWindows.filter((window) => window.label === "5h").map((window) => `5h ${Math.round(window.usedPercent)}%`).join(", ") || "5h not reported";
      return { catalog, quota: `${weekSummary}; ${fiveHourSummary}` };
    }
    const windows = cached?.windows ?? [];
    const week = currentWindowUsage(windows, "Week");
    if (week && week.usedPercent / 100 >= weeklyThreshold) {
      return { reason: `weekly quota ${Math.round(week.usedPercent)}% is at or above the ${Math.round(weeklyThreshold * 100)}% threshold, resets in ${week.resetDescription}` };
    }
    const fiveHour = currentWindowUsage(windows, "5h");
    if (fiveHour && fiveHour.usedPercent / 100 >= fiveHourThreshold) {
      return { reason: `5h quota ${Math.round(fiveHour.usedPercent)}% is at or above the ${Math.round(fiveHourThreshold * 100)}% threshold, resets in ${fiveHour.resetDescription}` };
    }
  }
  return { catalog };
}

/** `skipped` lists the earlier entries passed over, each with its reason (also for quota). */
export type ResolvedRoleEntry = { entry: RoleEntry; catalog: CatalogModel; skipped: string[] };

/**
 * Provider ID to the company that trains its models, for the adversarial review
 * rule (task-407). Explicit on purpose: an unmapped provider is an error, never
 * a guess. An aggregator that serves several companies (github-copilot) maps
 * through the model id's family prefix instead.
 */
export const PROVIDER_COMPANY: Readonly<Record<string, string>> = Object.freeze({
  anthropic: "anthropic",
  openai: "openai",
  "openai-codex": "openai",
});
const AGGREGATOR_PROVIDERS: ReadonlySet<string> = new Set(["github-copilot", "opencode-go"]);
// Algorant approved opencode-go/grok-4.7 as a temporary numbered-model exception: it is the newest verified selectable Grok catalog model.
const MODEL_FAMILY_COMPANY: Readonly<Record<string, string>> = Object.freeze({ claude: "anthropic", gpt: "openai", deepseek: "deepseek", grok: "xai" });

/** The company behind a `provider/id` model. Throws when it is not explicitly mapped. */
export function modelCompany(model: string, where: string): string {
  const separator = model.indexOf("/");
  const provider = model.slice(0, separator);
  if (AGGREGATOR_PROVIDERS.has(provider)) {
    const family = model.slice(separator + 1).split("-")[0]!;
    const company = Object.hasOwn(MODEL_FAMILY_COMPANY, family) ? MODEL_FAMILY_COMPANY[family] : undefined;
    if (!company) throw new Error(`${where}: model "${model}" has no company mapping for family "${family}" (known: ${Object.keys(MODEL_FAMILY_COMPANY).join(", ")}); add it to MODEL_FAMILY_COMPANY in model-roles.ts`);
    return company;
  }
  const company = Object.hasOwn(PROVIDER_COMPANY, provider) ? PROVIDER_COMPANY[provider] : undefined;
  if (!company) throw new Error(`${where}: provider "${provider}" has no company mapping (known: ${[...Object.keys(PROVIDER_COMPANY), ...AGGREGATOR_PROVIDERS].join(", ")}); add it to PROVIDER_COMPANY in model-roles.ts`);
  return company;
}

/** The first available entry of a role. Throws, naming the role, when none is. */
export function resolveRoleEntry(role: RoleName, registry: RoleRegistry, path = modelRolesPath()): ResolvedRoleEntry {
  const { quota, roles } = loadModelRoles(path);
  const allowed = localAgencySettings().modelProviders;
  const rejected: string[] = [];
  for (const entry of roles[role]) {
    const checked = checkEntry(entry, registry, quota, allowed);
    if ("reason" in checked) {
      rejected.push(`${entry.model} (${checked.reason})`);
      continue;
    }
    if (entry.fast && !isOpenAICodexFastTarget(checked.catalog)) {
      throw new Error(`${path}: ${role} entry ${entry.model} sets fast:true but is not eligible for the Fast priority tier`);
    }
    return { entry, catalog: checked.catalog, skipped: rejected };
  }
  throw new Error(`No available model for role "${role}" in ${path}: ${rejected.join("; ")}`);
}

/**
 * Model and thinking for a Worker or Subagent launch. An explicit model skips
 * the list (its thinking defaults to the role's first entry); an explicit
 * thinking level replaces only the chosen entry's thinking.
 */
export function resolveRole(role: Exclude<RoleName, "orchestrator">, registry: RoleRegistry, overrides: { model?: string; thinking?: ThinkingLevel } = {}, path = modelRolesPath()): { model: string; thinking: ThinkingLevel } {
  if (overrides.model !== undefined) {
    return { model: validateModelIdentifier(overrides.model, `${role} model`), thinking: overrides.thinking ?? loadModelRoles(path).roles[role][0]!.thinking };
  }
  const { entry } = resolveRoleEntry(role, registry, path);
  return { model: entry.model, thinking: overrides.thinking ?? entry.thinking };
}

/**
 * The approved native-Worker benchmark route. Its selector is a closed union,
 * thinking is fixed at high, and only this path can make the selected model's
 * provider exception while retaining the shared catalog/auth/quota check.
 */
export function resolveBenchmarkWorkerModel(model: string, registry: RoleRegistry, path = modelRolesPath()): { model: BenchmarkWorkerModel; thinking: "high"; fast: boolean; providerExemption: "approved-benchmark-provider-exception"; providerExemptionModel: BenchmarkWorkerModel; quota: string; quotaCheckedAt: number } {
  if (!(BENCHMARK_WORKER_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Benchmark Worker model must be exactly one of ${BENCHMARK_WORKER_MODELS.join(" or ")}.`);
  }
  const selected = model as BenchmarkWorkerModel;
  const { quota } = loadModelRoles(path);
  const fast = selected === "openai-codex/gpt-6-luna";
  const entry: RoleEntry = { model: selected, thinking: "high", fast };
  const checked = checkEntry(entry, registry, quota, localAgencySettings().modelProviders, {
    providerException: selected,
    requireFreshQuota: true,
  });
  if ("reason" in checked) throw new Error(`Benchmark Worker contender ${selected} is unavailable: ${checked.reason}.`);
  if (fast && !isOpenAICodexFastTarget(checked.catalog)) {
    throw new Error(`Benchmark Worker contender ${selected} is not eligible for the Fast priority tier.`);
  }
  if (checked.quota === undefined) throw new Error(`Benchmark Worker contender ${selected} passed availability without strict quota evidence.`);
  return { model: selected, thinking: "high", fast, providerExemption: "approved-benchmark-provider-exception", providerExemptionModel: selected, quota: checked.quota, quotaCheckedAt: Date.now() };
}

/**
 * Adversarial review (task-407): the first available `review.models` entry whose
 * company differs from the caller's own model (`provider/id`). Throws when review
 * is disabled, either company is unmapped, or no opposite-company entry is available.
 */
export function resolveReviewEntry(callerModel: string, registry: RoleRegistry, path = modelRolesPath()): ResolvedRoleEntry {
  const { quota, roles } = loadModelRoles(path);
  const review = roles.review;
  if (!review.enabled) throw new Error(`Review is disabled: set roles.review.enabled to true in ${path}`);
  const callerCompany = modelCompany(callerModel, "Review caller");
  const allowed = localAgencySettings().modelProviders;
  const rejected: string[] = [];
  for (const entry of review.models) {
    if (modelCompany(entry.model, `${path}: roles.review entry ${entry.model}`) === callerCompany) {
      rejected.push(`${entry.model} (same company as the caller's ${callerModel})`);
      continue;
    }
    const checked = checkEntry(entry, registry, quota, allowed);
    if ("reason" in checked) {
      rejected.push(`${entry.model} (${checked.reason})`);
      continue;
    }
    if (entry.fast && !isOpenAICodexFastTarget(checked.catalog)) {
      throw new Error(`${path}: review entry ${entry.model} sets fast:true but is not eligible for the Fast priority tier`);
    }
    return { entry, catalog: checked.catalog, skipped: rejected };
  }
  throw new Error(`No available opposite-company review model for caller "${callerModel}" in ${path}: ${rejected.join("; ")}`);
}
