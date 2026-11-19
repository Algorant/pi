export const OPENAI_FAST_STATE_EVENT = "pi-openai:fast-state";
/** One request to set the owner's session-local Fast state (task-745); the owner publishes OPENAI_FAST_STATE_EVENT back. */
export const OPENAI_FAST_SET_EVENT = "pi-openai:fast-set";
export type OpenAIFastRequest = { enabled: boolean };

export type OpenAIFastState = {
  enabled: boolean;
  eligible: boolean;
  provider?: string;
  modelId?: string;
};
