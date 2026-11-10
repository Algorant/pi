import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { OPENAI_FAST_STATE_EVENT, type OpenAIFastState } from "./events.ts";
import { CONTEXT_PREFIX_EVENT, type ContextPrefix } from "../../lib/context-prefix.ts";
import { applyOpenAIFastRequestPolicy } from "./fast-request.ts";
import type { ProjectImages } from "../image-projection.ts";
import {
  extractResponsesReasoningConfig,
  extractResponsesTextConfig,
  isOpenAICodexFastTarget,
  isOpenAICodexTarget,
  isRecord,
  modelKey,
  thinkingLevelToResponsesReasoning,
  type OpenAICodexModelLike,
} from "./model.ts";
import {
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generatePortablePiSummary,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  projectBranchEntryMessages,
  reconstructRemoteReplayStateFromBranch,
  type BranchContextEntry,
} from "./remote-compaction.ts";
import {
  clearAllRuntimeState,
  clearResponsesRequestShapeState,
  getResponsesRequestShapeState,
  setResponsesRequestShapeState,
} from "./state.ts";

type BranchEntry = BranchContextEntry;

type SessionContextLike = {
  model?: Model<any>;
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
    getLeafId(): string | null;
  };
};

function sessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function branchMessages(entries: BranchEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => projectBranchEntryMessages(entry));
}

function branchThinkingLevel(entries: BranchEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
      return entry.thinkingLevel;
    }
  }
  return undefined;
}

function applyRemoteHistoryPayloadPatch(payload: Record<string, unknown>, explicitHistory: unknown[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload, input: explicitHistory };
  delete next.messages;
  delete next.previous_response_id;
  return next;
}

function fastState(enabled: boolean, model: OpenAICodexModelLike | undefined): OpenAIFastState {
  return {
    enabled,
    eligible: isOpenAICodexFastTarget(model),
    ...(typeof model?.provider === "string" ? { provider: model.provider } : {}),
    ...(typeof model?.id === "string" ? { modelId: model.id } : {}),
  };
}

function formatFastStatus(state: OpenAIFastState): string {
  const status = state.enabled ? "on" : "off";
  if (state.eligible) return `OpenAI Fast mode is ${status} for this session.`;
  const target = state.provider && state.modelId ? ` Current model: ${state.provider}/${state.modelId}.` : "";
  return `OpenAI Fast mode is ${status}, but the current model is not eligible.${target}`;
}

export default function piOpenAI(pi: ExtensionAPI, projectImages: ProjectImages) {
  let fastEnabled = true;
  let currentModel: OpenAICodexModelLike | undefined;
  const contextPrefixes = new Map<ContextPrefix["source"], ContextPrefix>();
  // Branch leaf at the most recent replay seed (session start, tree navigation,
  // or compaction). Replay projects completed history only up to this boundary
  // and then the entries appended after it, so an older answerless prompt that
  // the seed intentionally dropped is never resurrected by a later reply.
  let replaySeedEntryId: string | null = null;
  // A context producer supplies the same non-persisted messages it prepends to
  // Pi's input. Remote replay must keep them, without saving them in its history
  // or trying to recognize arbitrary user text as a runtime context sentinel.
  const unsubscribeContext = pi.events.on(CONTEXT_PREFIX_EVENT, (value) => {
    const prefix = value as ContextPrefix;
    // Context handlers prepend their messages: the last producer goes first.
    contextPrefixes.delete(prefix.source);
    contextPrefixes.set(prefix.source, prefix);
  });
  pi.on("agent_start", () => { contextPrefixes.clear(); });

  const publishFastState = () => pi.events.emit(OPENAI_FAST_STATE_EVENT, fastState(fastEnabled, currentModel));

  pi.registerCommand("fast", {
    description: "Control session-local OpenAI Fast mode: /fast on|off|toggle|status.",
    handler: async (args, ctx) => {
      currentModel = ctx.model;
      const action = args.trim().toLowerCase() || "status";
      if (action === "on") fastEnabled = true;
      else if (action === "off") fastEnabled = false;
      else if (action === "toggle") fastEnabled = !fastEnabled;
      else if (action !== "status") {
        ctx.ui.notify("Usage: /fast on|off|toggle|status", "warning");
        return;
      }
      publishFastState();
      ctx.ui.notify(formatFastStatus(fastState(fastEnabled, currentModel)), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const id = sessionId(ctx);
    fastEnabled = true;
    currentModel = ctx.model;
    contextPrefixes.clear();
    replaySeedEntryId = ctx.sessionManager.getLeafId();
    clearResponsesRequestShapeState(id);
    publishFastState();
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike) => {
    // Persisted remote replay remains valid if another extension cancels the action.
    // Successful replacement tears this runtime down; successful tree navigation
    // reconstructs replay in session_tree.
    clearResponsesRequestShapeState(sessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterHistoryChange = (_event: unknown, ctx: SessionContextLike) => {
    replaySeedEntryId = ctx.sessionManager.getLeafId();
    clearResponsesRequestShapeState(sessionId(ctx));
  };
  pi.on("session_tree", syncAfterHistoryChange);
  pi.on("session_compact", syncAfterHistoryChange);

  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    clearResponsesRequestShapeState(sessionId(ctx));
    publishFastState();
  });

  pi.on("session_shutdown", () => {
    unsubscribeContext();
    contextPrefixes.clear();
    replaySeedEntryId = null;
    fastEnabled = false;
    currentModel = undefined;
    clearAllRuntimeState();
    publishFastState();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!isOpenAICodexTarget(model)) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;

    const id = sessionId(ctx);
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const entries = event.branchEntries as BranchEntry[];
    // Rebuild from the persisted branch so custom_message notices participate in
    // the remote compaction input alongside normal messages. The modelKey gate
    // keeps a different model's opaque replacement history out of this request.
    const reconstructed = reconstructRemoteReplayStateFromBranch({
      branchEntries: entries,
      seedEntryId: replaySeedEntryId,
      expectedModelKey: modelKey(model),
    });
    const responseItems = reconstructed
      ? reconstructed.explicitHistory
      : messagesToResponseItems(branchMessages(entries));
    const requestShape = getResponsesRequestShapeState(id);
    const thinkingLevel = pi.getThinkingLevel();
    const reasoning = requestShape?.reasoning ?? (model.reasoning
      ? thinkingLevelToResponsesReasoning(thinkingLevel ?? branchThinkingLevel(entries))
      : undefined);

    const [localResult, remoteResult] = await Promise.allSettled([
      generatePortablePiSummary({
        preparation: event.preparation,
        model: requestModel,
        apiKey: auth.apiKey,
        headers: auth.headers,
        customInstructions: event.customInstructions,
        signal: event.signal,
        thinkingLevel,
        env: auth.env,
      }),
      callRemoteCompactionEndpoint({
        model: requestModel,
        apiKey: auth.apiKey,
        headers: auth.headers,
        sessionId: id,
        input: projectImages(normalizeResponseItemsForPrompt(responseItems, model), ctx),
        instructions: ctx.getSystemPrompt(),
        tools: buildToolsPayload(pi.getAllTools(), pi.getActiveTools()),
        parallelToolCalls: true,
        reasoning,
        text: requestShape?.text,
        serviceTier: fastEnabled ? "priority" : undefined,
        signal: event.signal,
      }),
    ]);

    if (localResult.status !== "fulfilled") {
      if (!event.signal.aborted && ctx.hasUI) {
        ctx.ui.notify("Portable Pi compaction failed; Pi will use its default safety path.", "warning");
      }
      return undefined;
    }
    if (remoteResult.status !== "fulfilled") return { compaction: localResult.value };

    return {
      compaction: {
        ...localResult.value,
        details: {
          ...(localResult.value.details !== undefined ? { localSummaryDetails: localResult.value.details } : {}),
          remoteCompaction: buildRemoteCompactionDetails(requestModel, remoteResult.value.output, remoteResult.value.usage),
        },
      },
    };
  });

  pi.on("message_end", (_event, ctx) => {
    currentModel = ctx.model;
  });

  pi.on("before_provider_request", (event, ctx) => {
    currentModel = ctx.model;
    if (!isRecord(event.payload)) return undefined;
    // GPT-6 uses Fast mode without entering the GPT-5.6 remote replay path.
    if (!isOpenAICodexTarget(ctx.model)) return applyOpenAIFastRequestPolicy(ctx.model, event.payload, fastEnabled);

    const id = sessionId(ctx);
    setResponsesRequestShapeState(id, {
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractResponsesTextConfig(event.payload),
    });

    const remoteState = reconstructRemoteReplayStateFromBranch({
      branchEntries: ctx.sessionManager.getBranch(),
      seedEntryId: replaySeedEntryId,
      expectedModelKey: modelKey(ctx.model),
    });
    let payload: Record<string, unknown>;
    if (remoteState) {
      // The persisted branch is bounded by the replay seed: completed history
      // only up to that boundary, then the entries appended after it.
      // Custom_message notices are present there even though Pi's documented
      // message_end lifecycle does not report them. Re-deriving every request
      // keeps replay exactly-once without custom events.
      payload = applyRemoteHistoryPayloadPatch(
        event.payload,
        normalizeResponseItemsForPrompt([
          // Keep the opaque replacement prefix intact; the current context
          // precedes the subsequent live conversation, not its old summary.
          ...remoteState.explicitHistory.slice(0, remoteState.replacementHistory.length),
          ...messagesToResponseItems([...contextPrefixes.values()].reverse().flatMap((prefix) => prefix.sessionId === id ? prefix.messages : [])),
          ...remoteState.explicitHistory.slice(remoteState.replacementHistory.length),
        ], ctx.model),
      );
    } else {
      payload = { ...event.payload };
    }
    return applyOpenAIFastRequestPolicy(ctx.model, payload, fastEnabled) ?? payload;
  });
}
