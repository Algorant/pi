import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBuiltinToolRenderers } from "./builtins";
import { registerToolTiming } from "./core/timing";

/**
 * Register the official personal tool-call UI subsystem.
 *
 * Pi owns read, bash, edit, write, and codemode: execution, schemas, and prompt
 * metadata. This subsystem only installs a renderer resolver for them, during
 * extension load so reload scrollback rebuilds can see the custom renderers
 * before Pi emits session_start. It also records each top-level call's real
 * execution window into its result details for the cards' duration label.
 */
export function registerToolUi(pi: ExtensionAPI): void {
  registerBuiltinToolRenderers(pi);
  registerToolTiming(pi);
}

export { registerBuiltinToolRenderers } from "./builtins";
export { createBoxedToolRenderer, ToolBoxComponent } from "./core/card";
export * from "./core/text";
export { registerToolTiming } from "./core/timing";
export type * from "./core/types";
