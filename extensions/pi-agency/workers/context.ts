import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTEXT_PREFIX_EVENT, type ContextPrefix } from "../../lib/context-prefix.ts";

export const WORKER_CONTEXT_FLAG = "worker-context";
export const WORKER_CONTEXT_MODE_ENTRY = "pi-worker-context-mode";

/**
 * getFlag is extension-local and pi-hc registers this flag, so other extensions
 * (pi-agency, pi-ui) read this process's actual CLI mode instead.
 */
export function workerContextRequested(): boolean {
  const end = process.argv.indexOf("--");
  return process.argv.slice(0, end < 0 ? undefined : end).includes(`--${WORKER_CONTEXT_FLAG}`);
}

export function workerContextCapability(sessionFile: string): string {
  return `v1:${createHash("sha256").update(sessionFile).digest("hex")}`;
}

type LoadedWorkerContext = { brief: string; targetCheckoutPath: string; sharedCheckout?: boolean };

type ContextDependencies = {
  /** True when this Pi runs under native HC, which owns this Worker runtime. */
  hosted(): boolean;
  discoverWorker(): Promise<boolean>;
  advertise(capability: string): Promise<void>;
  loadBrief(ctx: ExtensionContext): Promise<LoadedWorkerContext>;
};

export function workerPathIsInTarget(path: string, cwd: string, target: string): boolean {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const candidate = resolve(cwd, expanded);
  const targetPath = resolve(target);
  const fromTarget = relative(targetPath, candidate);
  return fromTarget === "" || (fromTarget !== ".." && !fromTarget.startsWith(`..${sep}`) && !isAbsolute(fromTarget));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function workerBashNamesTarget(command: string, target: string): boolean {
  const targetPath = resolve(target);
  const home = homedir();
  const homeRelative = relative(home, targetPath);
  const forms = [targetPath];
  if (homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative)) {
    const homeForm = homeRelative === "." ? "" : `/${homeRelative.split(sep).join("/")}`;
    forms.push(`~${homeForm}`, `$HOME${homeForm}`, `\${HOME}${homeForm}`);
  }
  const boundary = String.raw`(?=$|[\/\s'";&|()<>])`;
  return forms.some((form) => new RegExp(`${escapeRegExp(form)}${boundary}`).test(command));
}

function validTargetPath(value: string | undefined): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

/** One source load per agent run, not per tool/model round. No brief is persisted. */
export function registerWorkerContext(pi: ExtensionAPI, dependencies: ContextDependencies): void {
  pi.registerFlag(WORKER_CONTEXT_FLAG, {
    type: "boolean", default: false,
    description: "Require the authoritative pi-agency Worker brief for this session.",
  });
  let enabled = false;
  let prefix: AgentMessage[] = [];
  let targetCheckoutPath: string | undefined;
  let sharedCheckout = false;
  let failure: string | undefined;
  let advertised = false;

  const publish = (ctx: ExtensionContext) => {
    const event: ContextPrefix = { sessionId: ctx.sessionManager.getSessionId(), source: "worker", messages: prefix };
    pi.events.emit(CONTEXT_PREFIX_EVENT, event);
  };
  const stop = (ctx: ExtensionContext, error: unknown) => {
    prefix = [];
    failure = `Worker context unavailable: ${error instanceof Error ? error.message : String(error)}`;
    // Pi catches hook exceptions and continues. Abort explicitly, and keep the
    // tool guard below closed even if a provider responds despite cancellation.
    ctx.abort();
    publish(ctx);
    ctx.ui.notify(failure, "error");
    console.error(`[pi-workers] ${failure}`);
  };

  pi.on("session_start", async (event, ctx) => {
    prefix = [];
    targetCheckoutPath = undefined;
    failure = undefined;
    advertised = false;
    const sessionId = ctx.sessionManager.getSessionId();
    const saved = ctx.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === WORKER_CONTEXT_MODE_ENTRY &&
      (entry.data as { sessionId?: unknown } | undefined)?.sessionId === sessionId);
    enabled = pi.getFlag(WORKER_CONTEXT_FLAG) === true || saved;
    try {
      // Native role discovery adopts retained Workers on reload and keeps a
      // same-terminal native fork guarded. A separate peer has a different session
      // ID and cannot inherit this mode just by copying historical entries.
      if (!enabled && ["reload", "fork"].includes(event.reason) && ctx.mode === "tui" && dependencies.hosted()) {
        enabled = true; // unknown role must not fail open if discovery throws
        enabled = await dependencies.discoverWorker();
      }
      if (!enabled) return;
      const file = ctx.sessionManager.getSessionFile();
      if (!file || ctx.mode !== "tui" || !dependencies.hosted()) {
        throw new Error("Managed Workers require a durable interactive Pi session inside their host.");
      }
      if (!saved) pi.appendEntry(WORKER_CONTEXT_MODE_ENTRY, { version: 1, sessionId });
      await dependencies.advertise(workerContextCapability(file));
      advertised = true;
    } catch (error) {
      stop(ctx, error);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    prefix = [];
    targetCheckoutPath = undefined;
    failure = undefined;
    if (!enabled) return;
    try {
      // agent_start is awaited by Pi 0.85.1, including custom-message wakeups.
      // Resolve the current native binding here, not at session_start (which runs
      // before a fresh Worker's delivery record/binding exists).
      const loaded = await dependencies.loadBrief(ctx);
      if (!loaded || typeof loaded.brief !== "string" || !validTargetPath(loaded.targetCheckoutPath)) {
        throw new Error("Current Worker brief lacks a valid captured integration target checkout path.");
      }
      targetCheckoutPath = loaded.targetCheckoutPath;
      sharedCheckout = loaded.sharedCheckout === true;
      prefix = [{ role: "user", content: loaded.brief, timestamp: 0 }];
    } catch (error) {
      stop(ctx, error);
    }
  });

  pi.on("context", (event, ctx) => {
    if (!enabled) return;
    if (failure || prefix.length !== 1) {
      if (!failure) stop(ctx, "No current brief was loaded for this run.");
      else { ctx.abort(); publish(ctx); }
      return { messages: [] };
    }
    publish(ctx);
    return { messages: [...prefix, ...event.messages] };
  });

  pi.on("tool_call", (event, ctx) => {
    if (!enabled) return;
    if (failure || prefix.length !== 1 || !targetCheckoutPath) {
      if (!failure) stop(ctx, "No current Worker brief or valid captured target checkout path.");
      return { block: true, terminate: true, reason: failure ?? "No current Worker brief or valid captured target checkout path. Recover context before using tools." };
    }
    if (sharedCheckout) return; // Explicit worktree:false: the captured source is the shared checkout.
    if (event.toolName === "bash" && typeof (event.input as { command?: unknown }).command === "string" &&
        workerBashNamesTarget((event.input as { command: string }).command, targetCheckoutPath)) {
      return { block: true, terminate: false, reason: `Blocked because this command names the orchestrator target checkout ${targetCheckoutPath}. Use your own Worker checkout with relative paths.` };
    }
    const path = (event.input as { path?: unknown }).path;
    if (typeof path === "string" && workerPathIsInTarget(path, ctx.cwd, targetCheckoutPath)) {
      return { block: true, terminate: false, reason: `Blocked because this path resolves inside the orchestrator target checkout ${targetCheckoutPath}. Use your own Worker checkout with relative paths.` };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    prefix = [];
    targetCheckoutPath = undefined;
    publish(ctx);
    // A downgrade/reload must not leave a stale capability on the terminal.
    if (advertised) await dependencies.advertise("unloaded");
    advertised = false;
  });
}
