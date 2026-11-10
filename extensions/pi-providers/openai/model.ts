import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResponsesReasoningConfig, ResponsesTextConfig } from "./remote-compaction.ts";

export type OpenAICodexModelLike = {
  provider?: unknown;
  api?: unknown;
  id?: unknown;
  baseUrl?: unknown;
  input?: readonly unknown[];
  reasoning?: unknown;
};

export const OPENAI_CODEX_GPT_56_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAICodexTarget(model: unknown): model is OpenAICodexModelLike {
  return isRecord(model)
    && model.provider === "openai-codex"
    && model.api === "openai-codex-responses"
    && typeof model.id === "string"
    && OPENAI_CODEX_GPT_56_MODELS.has(model.id);
}

/** GPT-6 Codex models measured faster with `service_tier: "priority"` (task-335-6). */
export const OPENAI_CODEX_GPT_6_FAST_MODELS = new Set([
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
]);

export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * True when Pi's `openai` provider credential is Sign in with ChatGPT (an OAuth
 * subscription grant) rather than a paid API key. Read on demand: a login or
 * logout in any Pi process changes it.
 */
export function hasChatGPTSignIn(): boolean {
  try {
    const authPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
    if (!existsSync(authPath)) return false;
    return JSON.parse(readFileSync(authPath, "utf8")).openai?.type === "oauth";
  } catch {
    return false;
  }
}

// Fast eligibility is broader than the GPT-5.6-only remote compaction/replay path.
// On `openai` it requires Sign in with ChatGPT: with an API key, priority is
// billed at the priority rate instead of drawing on the ChatGPT plan. The
// subscription route accepted `service_tier: "priority"` on 2026-10-06 (about
// 55 vs 34 tok/s for GPT-6.1 Sol, task-378) although OpenAI documents it as
// unsupported; a rejection would surface as a request error.
export function isOpenAICodexFastTarget(model: unknown): model is OpenAICodexModelLike {
  if (isOpenAICodexTarget(model)) return true;
  if (!isRecord(model) || typeof model.id !== "string" || !OPENAI_CODEX_GPT_6_FAST_MODELS.has(model.id)) return false;
  if (model.provider === "openai-codex") return model.api === "openai-codex-responses";
  return model.provider === "openai"
    && model.api === "openai-responses"
    && model.baseUrl === OPENAI_API_BASE_URL
    && hasChatGPTSignIn();
}

export function modelKey(model: OpenAICodexModelLike): string {
  return `${String(model.provider)}:${String(model.api)}:${String(model.id)}`;
}

export function thinkingLevelToResponsesReasoning(value: unknown): ResponsesReasoningConfig | undefined {
  if (["minimal", "low", "medium", "high", "xhigh"].includes(String(value))) {
    return { effort: value as ResponsesReasoningConfig["effort"], summary: "auto" };
  }
  return undefined;
}

export function extractResponsesReasoningConfig(payload: unknown): ResponsesReasoningConfig | undefined {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  const effort = payload.reasoning.effort;
  const summary = payload.reasoning.summary;
  const result: ResponsesReasoningConfig = {
    ...(typeof effort === "string" ? { effort: effort as ResponsesReasoningConfig["effort"] } : {}),
    ...(summary === null || typeof summary === "string"
      ? { summary: summary as ResponsesReasoningConfig["summary"] }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

export function extractResponsesTextConfig(payload: unknown): ResponsesTextConfig | undefined {
  return isRecord(payload) && isRecord(payload.text) ? payload.text : undefined;
}
