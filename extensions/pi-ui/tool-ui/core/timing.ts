import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Key under which a top-level tool result's details carry its recorded execution window. */
export const TOOL_TIMING_KEY = "piUiTiming";

export type ToolTiming = { startedAt: number; endedAt: number };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The recorded execution window in a result's details, or undefined for results that predate it. */
export function readToolTiming(details: unknown): ToolTiming | undefined {
  if (!isPlainObject(details)) return undefined;
  const timing = details[TOOL_TIMING_KEY];
  if (!isPlainObject(timing)) return undefined;
  const { startedAt, endedAt } = timing;
  return typeof startedAt === "number" && typeof endedAt === "number" ? { startedAt, endedAt } : undefined;
}

/**
 * Record each top-level tool call's real execution window into its persisted
 * result details, so live cards, session replay, and HTML export all show the
 * same duration. The window runs from Pi's tool_execution_start to its
 * tool_result. Calls made by another tool (parentToolCallId set) are skipped:
 * the calling tool already reports them, and their durations are never summed.
 * Content, structured content, and owner details are kept; details shapes that
 * are neither undefined nor a plain object stay untouched and show no duration.
 */
export function registerToolTiming(pi: ExtensionAPI): void {
  const startedAt = new Map<string, number>();
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId === undefined) startedAt.set(event.toolCallId, Date.now());
  });
  pi.on("tool_result", (event) => {
    if (event.parentToolCallId !== undefined) return;
    const started = startedAt.get(event.toolCallId);
    if (started === undefined) return;
    startedAt.delete(event.toolCallId);
    const details: unknown = event.details;
    if (details !== undefined && !isPlainObject(details)) return;
    return { details: { ...details, [TOOL_TIMING_KEY]: { startedAt: started, endedAt: Date.now() } } };
  });
  pi.on("session_shutdown", () => startedAt.clear());
}
