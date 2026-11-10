import { createBoxedToolRenderer } from "../core/card";
import { durationLabel, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRenderInput, ToolUiBoxModel, ToolUiTone } from "../core/types";

type HistoryArgs = { phrase?: unknown; otherMachine?: unknown };
type HistoryDetails = { source?: unknown; messages?: unknown; excerpts?: unknown };

export function createNstarHistoryRenderer() {
  return createBoxedToolRenderer<HistoryArgs, HistoryDetails>(buildHistoryBox);
}

function buildHistoryBox({ args, result, options, theme, text, pending, error, context }: BoxedToolRenderInput<HistoryArgs, HistoryDetails>): ToolUiBoxModel {
  const details = record(result?.details);
  const tone: ToolUiTone = error ? "error" : pending ? "pending" : "success";
  const status = error ? "failed" : pending ? "searching" : `${number(details.messages)} message${number(details.messages) === 1 ? "" : "s"}`;
  const sections = [];
  if (error) {
    sections.push(section("Error", [theme.fg("error", truncatePlain(text || "Conversation history search failed", 500))]));
  } else if (!pending && text) {
    const stored = Array.isArray(details.excerpts) ? details.excerpts.filter((excerpt): excerpt is string => typeof excerpt === "string") : [];
    const excerpts = stored.length ? stored : [text];
    const shown = options.expanded ? excerpts : excerpts.slice(0, 1);
    sections.push({ ...section("User-message excerpts", shown.map((excerpt) => theme.fg("toolOutput", truncatePlain(excerpt, options.expanded ? 1200 : 180)))), wrap: options.expanded });
    if (!options.expanded && excerpts.length > shown.length) sections.push(section("More", [theme.fg("dim", `${excerpts.length - shown.length} additional matching message(s); expand to view`)]));
  }
  return {
    title: `${statusIcon(theme, tone)} ${toolName(theme, "Conversation History")}`,
    status: joinTitleParts([status, pending ? args.otherMachine === true ? "homelab-server synced store" : "local sessions" : details.source === "homelab-server" ? "homelab-server synced store" : "local sessions", durationLabel(context.state)]),
    tone,
    body: [theme.fg("muted", `literal phrase: ${truncatePlain(stringValue(args.phrase), 120)}`)],
    sections,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
