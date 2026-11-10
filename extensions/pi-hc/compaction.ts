import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { inboxGate } from "../pi-agency/inbox/gate.ts";
import { hcJson } from "./core.ts";

/**
 * Idle compaction (task-399, task-597): an unparented app Pi (Herdra, a Ceph or a
 * manus) that settles idle at or above 60% of its window compacts. Nothing else:
 * nstar (pi-agency/nstar.ts) is the only post-compaction injector. Pi's native
 * auto-compaction stays the backstop; the inbox holds delivery during any compaction.
 */
const THRESHOLD_PERCENT = 60;

function endedOnProviderError(ctx: ExtensionContext): boolean {
  const last = ctx.sessionManager.getBranch().filter((entry) => entry.type === "message").at(-1);
  return last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "error";
}

export function registerHcIdleCompaction(pi: ExtensionAPI): void {
  let compacting = false;
  /** Tokens at the last failed attempt; retry only once the session has grown past them. */
  let failedAtTokens: number | undefined;
  /** Pi settles a run a shutdown aborts after session_shutdown: that settlement is not idle. */
  let live = false;

  pi.on("session_start", () => { live = true; compacting = false; failedAtTokens = undefined; });
  pi.on("session_shutdown", () => { live = false; });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (!live || ctx.mode !== "tui" || endedOnProviderError(ctx)) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.percent === null || usage.tokens === null || usage.percent < THRESHOLD_PERCENT) return;
    // The inbox registers first: a message it just delivered starts a turn, and the next settle re-evaluates.
    if (compacting || inboxGate.turnPending || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (failedAtTokens !== undefined && usage.tokens <= failedAtTokens) return;
    compacting = true;
    inboxGate.hold(); // nothing is delivered from this decision until the compaction ends
    // Return before native lifecycle reporting finishes (task-438).
    void compactWhenIdle(ctx, usage.tokens, usage.percent);
  });

  async function compactWhenIdle(ctx: ExtensionContext, tokens: number, percent: number): Promise<void> {
    const abort = () => { compacting = false; inboxGate.release(); };
    const fail = (message: string) => {
      abort();
      failedAtTokens = tokens;
      if (ctx.hasUI) ctx.ui.notify(`Idle compaction skipped: ${message}`, "error");
    };
    try {
      const self = await hcJson(["get", process.env.HC_TERMINAL_ID!]);
      // Children and terminals outside the app are excluded, not failures.
      if (self.parent != null || !self.labels?.["herdr.space"]) return abort();
    } catch (error) {
      return fail(`cannot read this HC terminal (${error instanceof Error ? error.message.split("\n")[0] : error})`);
    }
    if (inboxGate.turnPending || !ctx.isIdle() || ctx.hasPendingMessages()) return abort();
    if (ctx.hasUI) ctx.ui.notify(`Compacting idle at ${Math.round(percent)}%`, "info");
    try {
      ctx.compact({
        // session_compact / session_compact_failed release the inbox hold.
        onComplete: () => { compacting = false; failedAtTokens = undefined; },
        onError: (error) => {
          compacting = false;
          inboxGate.release(); // in case the compaction failed before session_before_compact
          failedAtTokens = tokens;
          if (ctx.hasUI) ctx.ui.notify(`Idle compaction failed: ${error.message}`, "error");
        },
      });
    } catch (error) {
      fail(`compaction could not start (${error instanceof Error ? error.message.split("\n")[0] : error})`);
    }
  }
}
