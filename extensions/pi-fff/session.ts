import type { NativeFffFinder } from "./native/finder.ts";
import type { AuxFinderPool, ExternalCursorStore } from "./native/external.ts";

export type FffSessionResources = {
  finder: NativeFffFinder;
  externalFinders: AuxFinderPool;
  externalCursors: ExternalCursorStore;
  isActive: () => boolean;
};

export type FffSessionGetter = () => FffSessionResources | undefined;

export function disposedToolResult(kind: "find" | "grep") {
  return {
    content: [{ type: "text" as const, text: `FFF ${kind} session is no longer active; retry the search.` }],
    details: { error: "disposed-session" },
  };
}
