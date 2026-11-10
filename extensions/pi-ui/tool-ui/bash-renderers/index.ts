import { renderUniversalBash } from "./universal";
import type { BashRenderInput, BashSubRenderResult } from "./types";

export function renderBashSubcommand(input: BashRenderInput): BashSubRenderResult {
  return renderUniversalBash(input);
}

export { renderUniversalBash } from "./universal";
export { summarizeCommand, type CommandSummary } from "./command-summary";
export { classifyOutputShape, type OutputShape } from "./output-shape";

export type { BashRenderInput, BashSubRenderer, BashSubRenderResult } from "./types";
