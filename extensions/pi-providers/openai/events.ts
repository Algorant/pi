export const OPENAI_FAST_STATE_EVENT = "pi-openai:fast-state";

export type OpenAIFastState = {
  enabled: boolean;
  eligible: boolean;
  provider?: string;
  modelId?: string;
};
