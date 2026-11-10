import { isOpenAICodexFastTarget, isRecord } from "./model.ts";

export const OPENAI_FAST_SERVICE_TIER = "priority" as const;

export function applyOpenAIFastRequestPolicy(
  model: unknown,
  payload: unknown,
  enabled = true,
): Record<string, unknown> | undefined {
  if (!enabled || !isOpenAICodexFastTarget(model) || !isRecord(payload)) return undefined;
  return { ...payload, service_tier: OPENAI_FAST_SERVICE_TIER };
}
