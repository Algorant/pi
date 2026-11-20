import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { OPENAI_FAST_SET_EVENT } from "../pi-providers/openai/events.ts";
import { resolveRoleEntry, resolveReviewEntry, type RoleRegistry } from "./model-roles.ts";
import { resolveRoleForSwitch } from "./herdra-role.ts";
import type { ModelSetRole } from "./local-settings.ts";

const MESSAGE_TYPE = "pi-agency-provider-rate-limit-retry";
const REFUSED_TYPE = "pi-agency-provider-rate-limit-refused";

type Role = ModelSetRole;
type SessionRow = { id?: string; type?: string; customType?: string; data?: any; message?: { role?: string; stopReason?: string; errorMessage?: string } };

export function provider429(message: unknown): boolean {
  return typeof message === "string" && /\b429\b/i.test(message) && /rate[ _-]?limit|too many requests/i.test(message);
}

/** One bounded recovery for the same user input; erase the failed assistant response and continue its transcript. */
export function provider429Diagnostic(ctx: ExtensionContext): string | undefined {
  const branch = ctx.sessionManager.getBranch() as SessionRow[];
  const failed = [...branch].reverse().find((row) => row.type === "message" && row.message?.role === "assistant");
  const failure = failed?.message?.errorMessage ?? "";
  if (failed?.message?.stopReason !== "error" || !provider429(failure)) return undefined;
  const userMessageId = [...branch].reverse().find((row) => row.type === "message" && row.message?.role === "user")?.id;
  const refused = branch.findLast((row) => row.type === "custom" && row.customType === REFUSED_TYPE && row.data?.userMessageId === userMessageId);
  if (refused) return `provider 429 rate limit from ${refused.data.provider}; no switch: ${refused.data.reason}`;
  const retried = branch.some((row) => row.type === "custom" && row.customType === MESSAGE_TYPE && row.data?.userMessageId === userMessageId);
  return retried
    ? `provider 429 rate limit from ${ctx.model?.provider ?? "unknown"}; the one switched retry for this input also failed: ${failure}`
    : `provider 429 rate limit from ${ctx.model?.provider ?? "unknown"}: ${failure}`;
}

export function registerProvider429Recovery(pi: ExtensionAPI, roleFor: (ctx: ExtensionContext) => Promise<{ role: Role; callerModel?: string } | undefined>): void {
  pi.on("agent_before_settle", async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch() as SessionRow[];
    const failed = [...branch].reverse().find((row) => row.type === "message" && row.message?.role === "assistant");
    const failure = failed?.message?.errorMessage ?? "";
    if (!failed?.id || failed.message?.stopReason !== "error" || !provider429(failure)) return;
    const user = [...branch].reverse().find((row) => row.type === "message" && row.message?.role === "user");
    if (!user?.id) return;
    const priorRecovery = branch.some((row: any) => row.type === "custom" && row.customType === MESSAGE_TYPE && row.data?.userMessageId === user.id);
    if (priorRecovery) return;
    const refuse = (provider: string, reason: string) => ({
      entries: [...event.entries, { type: "custom", customType: REFUSED_TYPE, data: { userMessageId: user.id, provider, reason } }],
    });
    const provider = ctx.model?.provider;
    if (!provider) return refuse("unknown", "the active provider could not be identified");
    const actor = await roleFor(ctx);
    if (!actor) return; // another registration may own this session; unmanaged sessions do not emit refusal markers
    let resolution;
    try {
      resolution = await resolveRoleForSwitch(actor.role, ctx.modelRegistry as RoleRegistry,
        () => actor.role === "review"
          ? resolveReviewEntry(actor.callerModel!, ctx.modelRegistry)
          : resolveRoleEntry(actor.role as Exclude<Role, "review">, ctx.modelRegistry),
        { callerModel: actor.callerModel, blockedProvider: provider, excludeCaller: true });
    } catch (error) {
      return refuse(provider, error instanceof Error ? error.message : String(error));
    }
    if ("refusal" in resolution) return refuse(provider, resolution.refusal);
    const { entry, catalog } = resolution.value;
    if (!(await pi.setModel(catalog))) return refuse(provider, `Pi refused model ${entry.model}`);
    pi.setThinkingLevel(entry.thinking);
    pi.events.emit(OPENAI_FAST_SET_EVENT, { enabled: entry.fast === true });
    return {
      entries: [
        ...event.entries,
        { type: "context_edit", targetId: failed.id, replacement: null },
        { type: "custom", customType: MESSAGE_TYPE, data: { userMessageId: user.id, provider, model: entry.model } },
      ],
      continue: true,
    };
  });
}
