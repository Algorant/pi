import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHcReportRenderer, type HcReportDetails } from "../pi-ui/tool-ui/custom-tools/hc-report.ts";
import { sendAgentMessage } from "../pi-agency/inbox/send.ts";
import { HEADLINE_MAX, splitHeadline } from "../pi-agency/inbox/envelope.ts";
import { KIND_KEY, peerText } from "../../scripts/whois.ts";
import { collectFailures, FAILURE_SCOPE, openFailureScope, trackScope } from "../pi-tandem/failure-summary.ts";
import { AGENCY_PROFILE_FLAG } from "../pi-agency/subagents/profile.ts";
import { provider429 } from "../pi-agency/provider-rate-limit.ts";
import { WORKER_CONTEXT_FLAG } from "../pi-agency/workers/context.ts";
import { hcJson } from "./core.ts";

type ReportArgs = { text: string; question?: boolean };

/** Every native Pi child finishes its job; only an explicit native keep retains it. */
export function registerHcReport(pi: ExtensionAPI) {
  let parent: string | undefined;
  let role = "child";
  let attempted = false;
  let ended = false;
  let plainFinal: string | undefined;
  let lastStop: string | undefined;
  /** This helper invocation's failed-call scope, opened before its first tool can run. */
  let scope: string | undefined;
  const reset = () => { attempted = false; ended = false; plainFinal = undefined; lastStop = undefined; };

  async function closeUnlessKept(ctx: ExtensionContext): Promise<void> {
    const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
    if (!self.keep) ctx.shutdown();
  }

  async function fail(ctx: ExtensionContext, message: string): Promise<void> {
    attempted = true;
    plainFinal = undefined;
    const file = ctx.sessionManager.getSessionFile();
    const record = file && existsSync(file) ? file : `No child transcript written before startup; session ${ctx.sessionManager.getSessionId()}. This parent notice is the error record.`;
    pi.appendEntry("pi-herdr-job-error", { error: message, session: file });
    console.error(`[pi-herdr] ${message}`);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    try {
      // Do not retry an ambiguous native send. Queue the ERROR outcome through
      // the existing durable inbox, which does not type into a parent dialog.
      // The headline names the failure itself: exit 0 after ctx.shutdown() is Pi's design, not success.
      if (parent) await sendAgentMessage(ctx, { terminal: parent, kind: "result", body: `Error (${role}): ${message}\nSession: ${record}` });
    } catch (error) {
      // A vanished parent cannot receive anything. Native exit notes and the
      // existing session remain the record; do not leave an orphan process.
      const reason = error instanceof Error ? error.message : String(error);
      pi.appendEntry("pi-herdr-job-error-notice", { error: reason });
      console.error(`[pi-herdr] Parent error notice unavailable: ${reason}`);
    }
    ended = true;
  }

  async function deliver(args: ReportArgs, ctx: ExtensionContext): Promise<AgentToolResult<HcReportDetails> & { terminate: true }> {
    if (attempted) throw new Error("This job already attempted a report; wait for new parent instructions.");
    attempted = true;
    const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
    if (!parent) throw new Error("report requires a native HC parent.");
    const text = args.text.trim();
    if (!text) throw new Error("report text must not be empty.");
    const session = ctx.sessionManager.getSessionFile();
    if (!session) throw new Error("Native child reports require a durable session.");
    // Every outcome is a private artifact; the parent gets a short labelled
    // agent message through the durable inbox (pi.sendMessage), never its composer.
    const file = join(await mkdtemp(join(tmpdir(), "pi-herdr-report-")), "report.md");
    await writeFile(file, text, { mode: 0o600 });
    // The whole text is the artifact; the parent's notice carries the same first line, normalized by the
    // shared splitter so any overflow stays as the notice's first body line, before Report and Session.
    const label = `${args.question ? "Question" : "Final report"} (${role}): `;
    const notice = splitHeadline(`${label}${text.split("\n")[0]?.trim() ?? ""}`);
    // One attempt; an unconfirmed drop fails into the error outcome and is never resent.
    // The failed-call summary belongs to a final report, never to a question.
    const failures = args.question ? undefined : collectFailures(pi, ctx, scope!);
    const { env } = await sendAgentMessage(ctx, { terminal: parent, kind: "result",
      body: `${notice}\nReport: ${file}\nSession: ${session}`, ...(failures ? { failures } : {}) });
    ended = true; // questions finish this job too; keep is the only retention opt-out
    return { content: [{ type: "text", text: `${args.question ? "Question" : "Final report"} queued as ${env.id} in the parent's inbox. This job is finished.` }],
      details: { parent: peerText(env.to, env.from.machine), terminal: peerText(env.from, env.from.machine), session, file, message: env.id, question: !!args.question, kept: self.keep }, terminate: true };
  }

  const tool = {
    name: "report", label: "Report",
    description: `Queue the job's answer or question for its native parent's inbox, then end this job. Line 1 of text is the answer: one line of at most ${HEADLINE_MAX} characters, details below; a longer first line is split at its last word boundary within ${HEADLINE_MAX}, and its overflow becomes the first line of the parent notice (the whole text stays in the report artifact). The child closes unless the parent/user explicitly kept it. Call alone after other tools finish.`,
    parameters: Type.Object({ text: Type.String({ minLength: 1 }), question: Type.Optional(Type.Boolean()) }),
    ...createHcReportRenderer(),
    async execute(_id: string, args: ReportArgs, _signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
      // An overlong headline is normalized by the shared splitter (task-737); it never blocks a report.
      try { return await deliver(args, ctx); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await fail(ctx, message);
        return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true, terminate: true };
      }
    },
  };
  pi.on("session_start", async (_event, ctx) => {
    reset();
    const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
    // A Worker hands back through its Task record instead (workers.ts), with the same close rule.
    parent = ctx.mode === "tui" && pi.getFlag(WORKER_CONTEXT_FLAG) !== true ? self.parent ?? undefined : undefined;
    // A manus track is one failed-call scope for its whole session; a resumed session keeps its marker.
    const track = trackScope(ctx.sessionManager.getSessionId());
    if (self.labels?.[KIND_KEY] === "manus" && !ctx.sessionManager.getBranch().some((entry: any) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.id === track)) openFailureScope(pi, track);
    role = String(pi.getFlag(AGENCY_PROFILE_FLAG) || self.name || self.template || "child");
    pi.registerTool({ ...tool, exposure: parent ? "model-only" : "hidden" });
  });
  pi.on("before_agent_start", () => {
    reset();
    // Each helper invocation is its own scope: one origin id, opened before any tool call.
    if (parent) { scope = `helper-${randomUUID()}`; openFailureScope(pi, scope); }
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (!parent || message.role !== "assistant") return;
    plainFinal = message.stopReason === "stop"
      ? message.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim() || undefined : undefined;
    lastStop = message.stopReason;
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!parent || attempted || !lastStop) return; // startup idle is not a job ending
    if (lastStop === "error") {
      const branch = ctx.sessionManager.getBranch().filter((entry: any) => entry?.type === "message");
      const errorMessage = branch.at(-1)?.message?.errorMessage;
      if (provider429(errorMessage)) {
        const userMessageId = [...branch].reverse().find((entry: any) => entry.message?.role === "user")?.id;
        const marker = event.entries.find((entry: any) => entry.type === "custom" && entry.customType === "pi-agency-provider-rate-limit-retry" && entry.data?.userMessageId === userMessageId);
        if (marker) return; // earlier profile hook committed the one retry; same user input continues
        const refused = event.entries.findLast((entry: any) => entry.type === "custom" && entry.customType === "pi-agency-provider-rate-limit-refused" && entry.data?.userMessageId === userMessageId)?.data;
        const alreadyRetried = branch.some((entry: any) => entry.type === "custom" && entry.customType === "pi-agency-provider-rate-limit-retry" && entry.data?.userMessageId === userMessageId);
        const provider = refused?.provider ?? ctx.model?.provider ?? "unknown";
        const outcome = alreadyRetried
          ? `switched retry failed: ${refused?.reason ?? "the provider returned another 429"}`
          : `no switch: ${refused?.reason ?? "role recovery did not take over"}`;
        await fail(ctx, `provider 429 rate limit from ${provider}; ${outcome}`);
        return;
      }
    }
    if (["error", "aborted", "length"].includes(lastStop)) { await fail(ctx, `Child ended on ${lastStop}; see its saved session.`); return; }
    const text = plainFinal || "The job ended; its scoped output is recorded in the saved session.";
    plainFinal = undefined;
    try {
      const result = await deliver({ text }, ctx);
      pi.appendEntry("pi-herdr-auto-report", result.details);
      if (ctx.hasUI) ctx.ui.notify(`Outcome queued for ${parent}${result.details.kept ? " · kept" : " · closing"}`, "info");
    } catch (error) { await fail(ctx, error instanceof Error ? error.message : String(error)); }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    if (!parent || !ended) return;
    ended = false;
    await closeUnlessKept(ctx);
  });
  return {
    async startupFailed(ctx: ExtensionContext, message: string) {
      await fail(ctx, message);
      await closeUnlessKept(ctx);
    },
  };
}
