import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { localAgencySettings, type ModelSetRole } from "./local-settings.ts";
import { ModelSetUnavailableError, eligibleReviewSetNames, eligibleSetNames, type RoleRegistry } from "./model-roles.ts";

const run = promisify(execFile);

/**
 * The one quota gate for a role whose selected set is blocked (task-745). Selection
 * policy stays split by owner: .pi supplies the candidate set names it has validated
 * against the real catalog, credentials and Fast tier (and, for review, the effective
 * routed row), and Herdra's `herdra-cutover role` orders those names by its own quota
 * rule, compares `--expect` with the set in force, and commits exactly one role key
 * under its lock while opening the grouped cutover for that role's long-lived Pis.
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
export async function switchRole(role: ModelSetRole, eligible: readonly EligibleCandidate[], options: { expect: string; current: string; excludeCaller?: boolean; signal?: AbortSignal }): Promise<RoleSwitch> {
  // `--expect` is the configured key the failing resolution read, never a fresh read: a concurrent
  // watch/launch write is then answered with `stale` instead of being overwritten. `--current` is
  // the effective row that same snapshot checked (review routing can differ from the stored key),
  // so Herdra judges `unchanged` on the providers this caller can actually use.
  const args = ["role", role, "--json", "--expect", options.expect, "--current", options.current, "--eligible", JSON.stringify([...eligible]), ...(options.excludeCaller ? ["--exclude-caller"] : [])];
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
 * Resolve a role; when (and only when) the selected set is quota-blocked, ask the
 * cutover command for a column with room and resolve ONCE more against the committed
 * map. Any other failure (catalog, credentials, Fast, a missing cell, a paused review)
 * is reported unchanged: it is never answered with a set switch.
 */
export async function resolveRoleForSwitch<T>(role: ModelSetRole, registry: RoleRegistry, resolve: () => T, options: { callerModel?: string; excludeCaller?: boolean; signal?: AbortSignal } = {}): Promise<RoleResolution<T>> {
  try {
    return { value: resolve() };
  } catch (error) {
    if (!quotaOnly(error)) throw error;
    if (localAgencySettings().modelSets === undefined) throw error;
    const eligible: EligibleCandidate[] = role === "review"
      ? (options.callerModel ? eligibleReviewSetNames(options.callerModel, registry) : [])
      : eligibleSetNames(role, registry);
    if (eligible.length === 0) return { refusal: `${error.message} No other set is usable for ${role} on this machine.` };
    let outcome: RoleSwitch;
    try {
      // `--expect` is the configured key the failing resolution read. For review that is NOT the
      // routed row the message names: a claude/openai key routes to another set's row, while the
      // command compares the stored key, so passing the row would be stale on every attempt.
      // The routed row goes in `--current`, so `unchanged` is judged on the entries this caller can use.
      outcome = await switchRole(role, eligible, { expect: error.configuredSet, current: error.set || error.configuredSet, excludeCaller: options.excludeCaller, signal: options.signal });
    } catch (failure) {
      const why = failure instanceof Error ? failure.message : String(failure);
      return { refusal: `Model set for ${role} is blocked and ${HERDRA_CUTOVER} role ${role} failed: ${why}` };
    }
    // Whatever the owner answered — switched, stale, or a fresh reading that disagrees with this
    // machine's cache — re-resolve ONCE against the committed map and use it if it now resolves.
    // No second command call, no retry, never a launch on parsed stdout alone.
    try {
      return { value: resolve(), switched: outcome };
    } catch (failure) {
      const why = failure instanceof Error ? failure.message : String(failure);
      if (outcome.status === "switched") {
        return { refusal: `Set ${outcome.from ?? "unset"} → ${outcome.to ?? "unset"} was written for ${role}, but the committed choice cannot be used: ${why}`, outcome };
      }
      const opening = outcome.status === "unchanged"
        ? `Model set for ${role} is blocked by this machine's cached usage, while ${HERDRA_CUTOVER} reports it still has room`
        : outcome.status === "stale"
          ? `The set in force for ${role} changed while deciding, so no switch was made`
          : `Model set for ${role} is blocked and no eligible set has room`;
      return { refusal: `${opening}: ${outcome.reason ?? why}`, outcome };
    }
  }
}
