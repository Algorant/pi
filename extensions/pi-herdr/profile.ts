import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENCY_PROFILE_FLAG, hcProfileRequested, resolveSubagentProfile, loadSubagentProfiles, BUNDLED_SUBAGENT_PROFILES_DIRECTORY, type PiSubagentProfileDefinition, type SubagentProfileName } from "../pi-agency/subagents/profile.ts";
import { FABLE_RESEARCHER_MODEL, resolveRoleEntry, resolveReviewEntry } from "../pi-agency/model-roles.ts";
import { registerProvider429Recovery } from "../pi-agency/provider-rate-limit.ts";
import { hcJson } from "./core.ts";

const FABLE_FLAG = "agency-fable";
let activeProfile: PiSubagentProfileDefinition | undefined;
let activeFable = false;
let activeReviewerCallerModel: string | undefined;

/** Register before report so provider recovery runs before report settlement. */
export function registerAgencyProfileRecovery(pi: ExtensionAPI): void {
  registerProvider429Recovery(pi, async () => activeProfile && !activeFable ? {
    role: activeProfile.name === "reviewer" ? "review" : "subagent",
    ...(activeReviewerCallerModel ? { callerModel: activeReviewerCallerModel } : {}),
  } : undefined);
}

/** Native profile policy only. No launch/placement/observation/retention runtime. */
export function registerAgencyProfile(pi: ExtensionAPI, startupFailed: (ctx: ExtensionContext, message: string) => Promise<void>): void {
  pi.registerFlag(AGENCY_PROFILE_FLAG, { type: "string", description: "Native HC read-only child profile: scout, researcher or reviewer." });
  pi.registerFlag(FABLE_FLAG, { type: "boolean", default: false, description: "Use the explicitly preflighted Fable 5.1 researcher selection at fixed high thinking; only when Algorant explicitly instructs this selection." });
  if (!hcProfileRequested()) return;
  let profile: PiSubagentProfileDefinition | undefined;
  let reviewerCallerModel: string | undefined;
  let allowed = new Set<string>();
  let failure: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const name = pi.getFlag(AGENCY_PROFILE_FLAG);
    profile = undefined;
    reviewerCallerModel = undefined;
    activeProfile = undefined;
    activeReviewerCallerModel = undefined;
    activeFable = false;
    allowed = new Set();
    failure = undefined;
    pi.setActiveTools([]); // fail closed before any async selection
    try {
      if (ctx.mode !== "tui" || !ctx.sessionManager.getSessionFile()) throw new Error("HC profiles require an interactive Pi and a durable session (no --no-session).");
      if (!["scout", "researcher", "reviewer"].includes(String(name))) throw new Error(`Unknown HC agency profile ${name}.`);
      const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
      if (!self.parent) throw new Error("HC profiles must be launched as native children with hc run.");
      const useFable = pi.getFlag(FABLE_FLAG) === true;
      if (useFable && name !== "researcher") throw new Error("The Fable selection is available only for the researcher profile.");
      if (useFable && (!ctx.model || `${ctx.model.provider}/${ctx.model.id}` !== FABLE_RESEARCHER_MODEL)) throw new Error(`Fable researcher launch did not retain the exact preflighted model ${FABLE_RESEARCHER_MODEL}.`);
      const selected = resolveSubagentProfile(name as SubagentProfileName, loadSubagentProfiles(BUNDLED_SUBAGENT_PROFILES_DIRECTORY));
      profile = selected;
      activeProfile = selected;
      activeFable = useFable;
      let callerModel: string | undefined;
      if (name === "reviewer") {
        callerModel = (await hcJson(["get", self.parent])).labels?.["pi.model"];
        if (!callerModel) throw new Error("Reviewer requires the native parent's pi.model label; reload that parent Pi before launching a reviewer.");
        reviewerCallerModel = callerModel;
        activeReviewerCallerModel = callerModel;
      }
      const entry = useFable ? undefined : name === "reviewer"
        ? resolveReviewEntry(callerModel!, ctx.modelRegistry)
        : resolveRoleEntry("subagent", ctx.modelRegistry);
      if (entry && !(await pi.setModel(entry.catalog))) throw new Error(`Could not apply profile model ${entry.entry.model}.`);
      pi.setThinkingLevel(useFable ? "high" : entry!.entry.thinking);
      allowed = new Set([...profile.tools, "codemode", "report"]);
      const available = new Set(pi.getAllTools().map(tool => tool.name));
      for (const tool of allowed) if (!available.has(tool)) throw new Error(`Profile tool ${tool} is not registered.`);
      pi.setActiveTools([...allowed]);
      const model = useFable ? FABLE_RESEARCHER_MODEL : entry!.entry.model;
      pi.appendEntry("pi-herdr-profile", { profile: name, terminal: self.address, parent: self.parent, model });
      ctx.ui.notify(`HC ${name}: ${model}${entry?.set ? `; set ${entry.set}, quota ${entry.quota}` : useFable ? "; explicit Fable selection, high thinking" : ""}${entry?.skipped?.length ? `; skipped ${entry.skipped.join("; ")}` : ""}`, "info");
    } catch (error) {
      profile = undefined;
      activeProfile = undefined;
      activeReviewerCallerModel = undefined;
      activeFable = false;
      allowed.clear();
      failure = `HC profile startup failed: ${error instanceof Error ? error.message : String(error)}`;
      pi.setActiveTools([]);
      await startupFailed(ctx, failure);
    }
  });
  pi.on("tool_call", (event, ctx) => {
    // SDK nested calls re-enter here with their REAL tool name (e.g. memory_write),
    // not the outer codemode name. Its inventory is not an authorization grant.
    if (!profile || !allowed.has(event.toolName)) return { block: true, reason: failure ?? `HC ${pi.getFlag(AGENCY_PROFILE_FLAG)} forbids ${event.toolName}.` };
    if (event.toolName === "report") {
      const assistant = [...ctx.sessionManager.getBranch()].reverse().find((entry: any) => entry.type === "message" && entry.message.role === "assistant") as any;
      if (assistant?.message.content.filter((block: any) => block.type === "toolCall").length !== 1) {
        return { block: true, reason: "Call report alone after all other tools have finished; its result ends the turn." };
      }
    }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!profile) { ctx.abort(); return; }
    pi.setActiveTools([...allowed]);
    // Same profile body on both hosts; only the concrete caller channel differs.
    return { systemPrompt: `${profile.prompt}\n\nYou are a bounded, read-only native HC child. Use only the profile's tools (${profile.tools.join(", ")}) and codemode over those tools. Read-only by role: commands are for inspecting and querying, never for mutations; no delegation or Tandem. Questions MUST use report({text, question:true}); sending the question finishes this job and closes this child unless the parent explicitly kept it. A kept child can receive a parent answer; otherwise the parent starts follow-up work with the saved session/artifacts. Plain text is always a FINAL answer, never a question. Finish with your final answer in the profile's required format; the runtime automatically forwards that actual answer to the parent exactly once and closes this Pi unless native keep is true. You can also use report({text}) to send the final answer explicitly with the same behavior. Call report ALONE, after other tools finish. A codemode catalog lists registered tools, not permissions: only the named profile tools are authorized, and nested calls pass through the same permission gate. Do not retry a failed report without the parent. Return text findings, not images or base64.` };
  });
}
