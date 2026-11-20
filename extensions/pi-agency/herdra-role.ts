import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localAgencySettings, type ModelSetRole } from "./local-settings.ts";
import { ModelSetUnavailableError, eligibleReviewSetNames, eligibleSetNames, type RoleRegistry } from "./model-roles.ts";

const run = promisify(execFile);

/**
 * The shared role gate for quota blocks and provider-reported 429s. Selection policy
 * stays split by owner: .pi supplies candidate sets validated against the real catalog,
 * credentials and Fast tier (and, for review, the effective routed row); Herdra's
 * `herdra-cutover role` applies its quota and per-decision blocked-provider rules,
 * compares `--expect` with the set in force, and commits exactly one role key under its
 * lock while opening the grouped cutover for that role's long-lived Pis.
 *
 * The wire result is exactly `{status, role, from, to, operation, partial, reason}`;
 * nothing here launches on a decision parsed from stdout — the caller re-resolves the
 * committed map through the ordinary resolver, so the launch always follows what the
 * machine now says.
 */
export const HERDRA_CUTOVER = join(homedir(), "Projects/herdra/bin/herdra-cutover");

export type RoleSwitchStatus = "switched" | "unchanged" | "blocked" | "stale";
export type RoleSwitch = { status: RoleSwitchStatus; role: string; from: string | null; to: string | null; operation: string | null; partial: boolean; reason: string | null };
/**
 * One `--eligible` item: a plain set name, or (review only, Herdra 4f80fe7) a set with the
 * providers whose entries this caller could use, so Herdra judges that row's quota alone.
 */
export type EligibleCandidate = string | { set: string; providers: string[] };

const STATUSES: ReadonlySet<string> = new Set(["switched", "unchanged", "blocked", "stale"]);

/** The command's one JSON object, validated strictly so a changed wire fails loudly instead of being guessed at. */
export function parseRoleSwitch(text: string, role: string): RoleSwitch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${HERDRA_CUTOVER} role ${role} printed no JSON: ${text.trim().slice(0, 300)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${HERDRA_CUTOVER} role ${role} printed ${JSON.stringify(parsed).slice(0, 300)}`);
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "from,operation,partial,reason,role,status,to") throw new Error(`${HERDRA_CUTOVER} role ${role} printed unexpected fields (${keys})`);
  if (typeof value.status !== "string" || !STATUSES.has(value.status)) throw new Error(`${HERDRA_CUTOVER} role ${role} printed status ${String(value.status)}`);
  if (value.role !== role) throw new Error(`${HERDRA_CUTOVER} answered for role ${String(value.role)}, not ${role}`);
  if (value.from !== null && typeof value.from !== "string") throw new Error(`${HERDRA_CUTOVER} role ${role} printed a non-string from`);
  if (value.to !== null && typeof value.to !== "string") throw new Error(`${HERDRA_CUTOVER} role ${role} printed a non-string to`);
  if (value.operation !== null && typeof value.operation !== "string") throw new Error(`${HERDRA_CUTOVER} role ${role} printed a non-string operation`);
  if (typeof value.partial !== "boolean") throw new Error(`${HERDRA_CUTOVER} role ${role} printed a non-boolean partial`);
  if (value.reason !== null && typeof value.reason !== "string") throw new Error(`${HERDRA_CUTOVER} role ${role} printed a non-string reason`);
  return value as RoleSwitch;
}

/** One call: ask Herdra to put `role` on one of the prevalidated sets, or say why it cannot. */
export async function switchRole(role: ModelSetRole, eligible: readonly EligibleCandidate[], options: { expect: string; current: string; excludeCaller?: boolean; blockedProvider?: string; signal?: AbortSignal }): Promise<RoleSwitch> {
  // `--expect` is the configured key the failing resolution read, never a fresh read: a concurrent
  // watch/launch write is then answered with `stale` instead of being overwritten. `--current` is
  // the effective row that same snapshot checked (review routing can differ from the stored key),
  // so Herdra judges `unchanged` on the providers this caller can actually use.
  const args = ["role", role, "--json", "--expect", options.expect, "--current", options.current, "--eligible", JSON.stringify([...eligible]), ...(options.excludeCaller ? ["--exclude-caller"] : []), ...(options.blockedProvider ? ["--blocked", options.blockedProvider] : [])];
  let text: string;
  try {
    ({ stdout: text } = await run(HERDRA_CUTOVER, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, signal: options.signal }));
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string; message: string };
    const detail = [failure.stderr, failure.stdout, failure.message].filter(Boolean).join("\n").trim();
    throw new Error(`${HERDRA_CUTOVER} role ${role} failed: ${detail}`);
  }
  return parseRoleSwitch(text, role);
}

/** A role resolution, or the reason nothing may be launched on it. */
export type RoleResolution<T> = { value: T; switched?: RoleSwitch } | { refusal: string; outcome?: RoleSwitch };

function quotaOnly(error: unknown): error is ModelSetUnavailableError {
  return error instanceof ModelSetUnavailableError && error.kind === "quota";
}

/**
 * Resolve a role; when quota blocks it or a provider reports a 429, ask the cutover
 * command for an eligible set (passing `--blocked <provider>` for the latter) and
 * resolve ONCE more against the committed map. Catalog, credentials, Fast, missing
 * cells and paused review remain errors, never availability signals.
 */
export async function resolveRoleForSwitch<T extends { set?: string }>(role: ModelSetRole, registry: RoleRegistry, resolve: () => T, options: { callerModel?: string; excludeCaller?: boolean; blockedProvider?: string; signal?: AbortSignal } = {}): Promise<RoleResolution<T>> {
  let initial: T | undefined;
  let blocked: ModelSetUnavailableError | undefined;
  try { initial = resolve(); }
  catch (error) {
    if (!quotaOnly(error)) throw error;
    blocked = error;
  }
  if (!blocked && !options.blockedProvider) return { value: initial! };
  const settings = localAgencySettings().modelSets;
  if (!settings) {
    if (blocked) throw blocked;
    if (options.blockedProvider) return { refusal: `Cannot cut over ${role} after provider ${options.blockedProvider} rate-limited: named model sets are not configured.` };
    return { value: initial! };
  }
  const eligible: EligibleCandidate[] = role === "review"
    ? (options.callerModel ? eligibleReviewSetNames(options.callerModel, registry) : [])
    : eligibleSetNames(role, registry);
  if (eligible.length === 0) return { refusal: `No other set is usable for ${role} on this machine.` };
  // For review, --expect is its configured key while --current is the routed row actually checked.
  const expect = blocked?.configuredSet ?? settings[role];
  const current = blocked?.set ?? initial?.set ?? expect;
  let outcome: RoleSwitch;
  try {
    outcome = await switchRole(role, eligible, { expect, current, excludeCaller: options.excludeCaller, blockedProvider: options.blockedProvider, signal: options.signal });
  } catch (failure) {
    const why = failure instanceof Error ? failure.message : String(failure);
    return { refusal: `Model set for ${role} is blocked and ${HERDRA_CUTOVER} role ${role} failed: ${why}` };
  }
  // The selector's output is never trusted as the model; re-resolve its committed map once.
  try {
    const value = resolve();
    const model = (value as any)?.entry?.model ?? (value as any)?.argument ?? (value as any)?.model;
    if (options.blockedProvider && typeof model === "string" && model.startsWith(`${options.blockedProvider}/`)) {
      return { refusal: `The selected ${role} set still resolves to rate-limited provider ${options.blockedProvider}; no retry was made.`, outcome };
    }
    return { value, switched: outcome };
  }
  catch (failure) {
    const why = failure instanceof Error ? failure.message : String(failure);
    if (outcome.status === "switched") return { refusal: `Set ${outcome.from ?? "unset"} → ${outcome.to ?? "unset"} was written for ${role}, but the committed choice cannot be used: ${why}`, outcome };
    const opening = outcome.status === "unchanged"
      ? options.blockedProvider ? `Model set for ${role} still uses blocked provider ${options.blockedProvider}` : `Model set for ${role} is blocked by this machine's cached usage, while ${HERDRA_CUTOVER} reports it still has room`
      : outcome.status === "stale" ? `The set in force for ${role} changed while deciding, so no switch was made`
        : `Model set for ${role} is blocked and no eligible set has room`;
    return { refusal: `${opening}: ${outcome.reason ?? why}`, outcome };
  }
}
