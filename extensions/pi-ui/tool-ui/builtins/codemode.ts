import type { CodemodeToolDetails, Theme } from "@earendil-works/pi-coding-agent";
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { createBoxedToolRenderer } from "../core/card";
import {
  durationLabel,
  fieldLine,
  formatDuration,
  hiddenHint,
  joinTitleParts,
  paint,
  plainTextLines,
  section,
  statusIcon,
  statusTone,
  toolName,
  truncatePlain,
} from "../core/text";
import type { ToolUiTone } from "../core/types";

type CodemodeArgs = { code?: string };
type NestedCall = CodemodeToolDetails["calls"][number];

const SCRIPT_LINES = { collapsed: 6, expanded: 60 };
const CALL_LINES = { collapsed: 6, expanded: 200 };
const ARGS_WIDTH = { collapsed: 60, expanded: 160 };
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n/;

/** `mcp__obscura__browser_navigate` → `obscura/browser_navigate`, like Pi's MCP call titles. */
export function displayCallName(name: string): string {
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  return match ? `${match[1]}/${match[2]}` : name;
}

const TITLE_DOMAINS = 5;

/** Distinct call domains in first-use order: `bash`, `read ×3`, `obscura ×2` (MCP grouped by server). */
export function callDomains(calls: Array<{ name: string }>): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const domain = displayCallName(call.name).split("/")[0];
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const parts = [...counts].map(([domain, count]) => (count > 1 ? `${domain} ×${count}` : domain));
  const shown = parts.slice(0, TITLE_DOMAINS).join(", ");
  return parts.length > TITLE_DOMAINS ? `${shown} +${parts.length - TITLE_DOMAINS}` : shown;
}

function callTone(call: NestedCall): ToolUiTone {
  if (call.status === "ok") return "success";
  if (call.status === "error") return "error";
  if (call.status === "cancelled") return "warning";
  return "pending";
}

function formatCost(cost: number): string {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

function callLine(theme: Theme, call: NestedCall, expanded: boolean): string[] {
  const args = call.args ? truncatePlain(call.args, expanded ? ARGS_WIDTH.expanded : ARGS_WIDTH.collapsed) : undefined;
  const line = [
    `${statusIcon(theme, callTone(call))} ${toolName(theme, displayCallName(call.name))}`,
    args ? theme.fg("muted", args) : undefined,
    call.durationMs !== undefined ? theme.fg("dim", formatDuration(call.durationMs) ?? "") : undefined,
    call.cost ? theme.fg("dim", formatCost(call.cost)) : undefined,
  ].filter(Boolean).join(" ");
  if (!expanded || !call.error) return [line];
  return [line, ...call.error.split("\n").map((errorLine) => `  ${paint(theme, "error", errorLine)}`)];
}

function scriptLines(theme: Theme, code: string, expanded: boolean): string[] {
  const source = code.replace(/\r/g, "").replace(/\t/g, "  ").trimEnd();
  if (!source) return [theme.fg("muted", "Empty script")];
  const highlighted = highlightCode(source, "javascript");
  const limit = expanded ? SCRIPT_LINES.expanded : SCRIPT_LINES.collapsed;
  const shown = highlighted.slice(0, limit);
  if (highlighted.length > shown.length) shown.push(hiddenHint(theme, highlighted.length - shown.length, "line", expanded));
  return shown;
}

/** Scripts often `return` an object; show it as indented JSON instead of one clipped line. */
function readableOutput(output: string): string {
  if (!/^[[{]/.test(output)) return output;
  try {
    return JSON.stringify(JSON.parse(output), null, 2);
  } catch {
    return output;
  }
}

function callsSection(theme: Theme, calls: NestedCall[], expanded: boolean) {
  const limit = expanded ? CALL_LINES.expanded : CALL_LINES.collapsed;
  const shown = calls.slice(-limit);
  const lines = shown.flatMap((call) => callLine(theme, call, expanded));
  if (shown.length < calls.length) lines.unshift(hiddenHint(theme, calls.length - shown.length, "earlier call", expanded));
  return section("Calls", lines);
}

export function createCodemodeRenderer() {
  return createBoxedToolRenderer<CodemodeArgs, CodemodeToolDetails | undefined>(({ args, result, options, theme, text, pending, error, context }) => {
    const details = result?.details;
    const calls = details?.calls ?? [];
    const failedCalls = calls.filter((call) => call.status === "error").length;
    const cost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);
    const scriptFailed = /^Script failed/.test(text);
    const failed = error || scriptFailed;
    const tone = statusTone({ pending, error: failed, warning: !failed && failedCalls > 0 });
    const output = readableOutput(text.replace(SCRIPT_HEADER, "").trim());

    const title = joinTitleParts([
      `${statusIcon(theme, tone)} ${toolName(theme, "codemode")}`,
      calls.length > 0 ? callDomains(calls) : undefined,
      failedCalls > 0 ? `${failedCalls} failed` : undefined,
      !pending && scriptFailed ? "script failed" : undefined,
      cost > 0 ? formatCost(cost) : undefined,
      durationLabel(context.state),
    ]);

    const outputLines = pending || !output
      ? []
      : plainTextLines(theme, output, options.expanded, { collapsed: 5, expanded: 40 });
    const detailLines = [
      details?.fullOutputPath ? fieldLine(theme, "full output", details.fullOutputPath, "muted") : undefined,
    ];

    return {
      title,
      tone,
      body: scriptLines(theme, args.code ?? "", options.expanded),
      sections: [
        ...(calls.length > 0 ? [callsSection(theme, calls, options.expanded)] : []),
        ...(outputLines.length > 0 ? [section(failed ? "Error" : "Output", outputLines)] : []),
        ...(detailLines.some(Boolean) ? [section("Details", detailLines)] : []),
      ],
    };
  });
}
