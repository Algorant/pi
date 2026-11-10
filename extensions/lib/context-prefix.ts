import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Same-process bridge for provider adapters which replace persisted history.
// The producer supplies the very messages it prepends in `context`; consumers
// must not derive their own Task state or save the prefix in replay/history.
export const CONTEXT_PREFIX_EVENT = "pi:context-prefix";
export type ContextPrefix = { sessionId: string; source: "worker" | "nstar"; messages: AgentMessage[] };
