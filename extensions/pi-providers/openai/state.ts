import type { ResponsesReasoningConfig, ResponsesTextConfig } from "./remote-compaction.ts";

export type ResponsesRequestShapeState = {
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
};

const requestShapeBySessionId = new Map<string, ResponsesRequestShapeState>();

export function getResponsesRequestShapeState(sessionId: string): ResponsesRequestShapeState | undefined {
  return requestShapeBySessionId.get(sessionId);
}

export function setResponsesRequestShapeState(sessionId: string, state: ResponsesRequestShapeState): void {
  requestShapeBySessionId.set(sessionId, state);
}

export function clearResponsesRequestShapeState(sessionId?: string): void {
  if (sessionId) requestShapeBySessionId.delete(sessionId);
}

export function clearAllRuntimeState(): void {
  requestShapeBySessionId.clear();
}
