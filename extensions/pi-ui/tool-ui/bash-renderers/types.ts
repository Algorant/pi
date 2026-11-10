import type { BashToolDetails, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolUiSectionModel, ToolUiTone } from "../core/types";

export type BashRenderInput = {
  command: string;
  outputText: string;
  cwd: string;
  expanded: boolean;
  failed: boolean;
  pending: boolean;
  theme: Theme;
  details?: BashToolDetails;
  exitCode?: number;
  timedOut?: boolean;
  aborted?: boolean;
};

export type BashSubRenderResult = {
  /** Override the tool name in the title, e.g. "Python" instead of "Bash". */
  toolName?: string;
  label?: string;
  body?: string[];
  sections?: ToolUiSectionModel[];
  tone?: ToolUiTone;
  /** Hide generic raw output in collapsed view when the specialized renderer covers it. */
  suppressRawOutput?: boolean;
  /** Also hide generic raw output on collapsed failures; expanded views still show it. */
  suppressRawOutputOnError?: boolean;
  /** Hide generic failure suffixes like "exit 1" when the label/body explain the failure. */
  suppressFailureStatus?: boolean;
  /** Compact command shown in Details instead of a potentially multiline shell command. */
  commandSummary?: string;
  /** Treat a command-specific non-zero exit as a successful result. */
  treatAsSuccess?: boolean;
};

export type BashSubRenderer = {
  id: string;
  match(input: BashRenderInput): boolean;
  render(input: BashRenderInput): BashSubRenderResult | undefined;
};
