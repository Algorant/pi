import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

export type ToolRenderContext<TState = any, TArgs = any> = {
  args: TArgs;
  state: TState;
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  executionStarted: boolean;
  lastComponent?: Component;
};

export type ToolUiTone = "success" | "error" | "warning" | "pending" | "neutral";

export type ToolUiTextTone =
  | "accent"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "toolOutput"
  | "toolTitle"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext";

export type ToolUiSectionModel = {
  title?: string;
  lines: string[];
  /** Wrap lines to the card width instead of clipping them. */
  wrap?: boolean;
};

export type ToolUiBoxModel = {
  title: string;
  status?: string;
  tone: ToolUiTone;
  body?: string[];
  sections?: ToolUiSectionModel[];
};

export type ToolUiResultLike<TDetails = unknown> = AgentToolResult<TDetails> & { isError?: boolean };

export type BoxedToolRendererState<TDetails = unknown> = {
  box?: unknown;
  result?: ToolUiResultLike<TDetails>;
  options?: ToolRenderResultOptions;
  startedAt?: number;
  endedAt?: number;
};

export type BoxedToolRenderInput<TArgs, TDetails> = {
  args: TArgs;
  result?: ToolUiResultLike<TDetails>;
  options: ToolRenderResultOptions;
  theme: Theme;
  context: ToolRenderContext<BoxedToolRendererState<TDetails>, TArgs>;
  text: string;
  pending: boolean;
  error: boolean;
};
