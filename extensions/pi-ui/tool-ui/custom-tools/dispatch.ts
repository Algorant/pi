import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createBoxedToolRenderer, ToolBoxComponent } from "../core/card";
import { durationLabel, fieldLine, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRendererState, BoxedToolRenderInput, ToolRenderContext, ToolUiBoxModel, ToolUiTone } from "../core/types";
import { labelFrom } from "../../../../scripts/whois.ts";

/** The pi-hc dispatch tools (pi-hc/dispatch.ts): dendra_start, manus_start, ceph_start. */
export type DispatchTool = "dendra_start" | "manus_start" | "ceph_start";
type Args = { kind?: unknown; label?: unknown; task?: unknown; taskId?: unknown; brief?: unknown; needsAlgorant?: unknown; prompt?: unknown; worktree?: unknown; direction?: unknown; project?: unknown; folder?: unknown; kickoff?: unknown; from?: unknown };
type Details = Record<string, any>;

const LABEL: Record<DispatchTool, string> = { dendra_start: "Dendra Start", manus_start: "Manus Start", ceph_start: "Ceph Start" };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

function kindOf(tool: DispatchTool, args: Args, d: Details): string {
  return tool === "dendra_start" ? text(d.kind) || text(args.kind) || "dendra" : tool === "manus_start" ? "manus" : "ceph";
}

/** Its whois label: the started label, or before the result the label given or the start path's own default. */
function labelOf(tool: DispatchTool, args: Args, d: Details): string {
  return text(d.label) || text(args.label) || (tool === "ceph_start" ? `${text(args.project)} Ceph` : labelFrom(text(args.task))) || text(args.taskId) || "?";
}

/** The ids underneath, in parentheses: hc name and terminal. */
function idsOf(d: Details): string {
  const ids = [text(d.name), text(d.terminal)].filter(Boolean);
  return ids.length ? ` (${ids.join(", ")})` : "";
}

/** Where it started, in a few words: the place Algorant would look for it. */
function whereOf(tool: DispatchTool, d: Details): string {
  const tab = d.tab === "pending" ? "tab pending" : text(d.tabName) ? `tab ${text(d.tabName)}` : "";
  if (tool === "dendra_start") return d.kind === "worker" ? joinTitleParts([text(d.taskId) || "Task-free", d.worktree === false ? "shared checkout" : text(d.branch), `needsAlgorant:${d.needsAlgorant === true}`]) : `in ${text(d.cwd)}`;
  if (tool === "manus_start") return joinTitleParts([text(d.taskId) || "Task-free", d.branch ? `wt ${text(d.branch)}` : "project checkout", `needsAlgorant:${d.needsAlgorant === true}`, tab]);
  return joinTitleParts([`space ${text(d.spaceName) || text(d.space)}${d.createdSpace ? " (new)" : " (reused)"}`, tab]);
}

/** One collapsed line: `⇢ <kind> <label> (<name>, <terminal>) · <where>`. */
function line(tool: DispatchTool, args: Args, d: Details | undefined, theme: Theme, status?: string): string {
  const details = d ?? {};
  const parts = [theme.fg("accent", "⇢"), " ", theme.fg("toolTitle", kindOf(tool, args, details)), " ", theme.fg("text", labelOf(tool, args, details))];
  if (status) parts.push(theme.fg("muted", ` · ${status}${args.needsAlgorant === true ? " · needsAlgorant:true" : ""}`));
  else {
    parts.push(theme.fg("dim", idsOf(details)));
    const where = whereOf(tool, details);
    if (where) parts.push(theme.fg("muted", ` · ${where}`));
    if (details.requestClosed) parts.push(theme.fg("dim", ` · closed ${text(details.requestClosed)}`));
    if (details.requestCloseError || details.tabError || details.notChecked?.length) parts.push(theme.fg("warning", " · see details"));
  }
  return ` ${parts.join("")}`;
}

function build(tool: DispatchTool, { args, result, options, theme, pending, error, context, text: output }: BoxedToolRenderInput<Args, Details>): ToolUiBoxModel {
  const d = (result?.details ?? {}) as Details;
  const tone: ToolUiTone = pending ? "pending" : error ? "error" : d.requestCloseError || d.tabError ? "warning" : "success";
  const expanded = Boolean(options.expanded);
  const status = pending ? (context.executionStarted ? "starting" : "queued") : error ? "refused" : "launched";
  const sections = error
    ? [section("Error", [theme.fg("error", truncatePlain(output, expanded ? 4000 : 500))])]
    : pending ? [] : [section("Started", [
      fieldLine(theme, "label", labelOf(tool, args, d), "accent"),
      fieldLine(theme, "name", text(d.name) || "—", "muted"),
      fieldLine(theme, "terminal", text(d.terminal) || "—", "muted"),
      text(d.taskId) ? fieldLine(theme, "task", joinTitleParts([text(d.taskId), text(d.title) ? truncatePlain(text(d.title), expanded ? 200 : 80) : undefined]), "toolOutput") : undefined,
      tool !== "ceph_start" && (tool === "manus_start" || d.kind === "worker") ? fieldLine(theme, "needsAlgorant", String(d.needsAlgorant ?? false), d.needsAlgorant ? "warning" : "muted") : undefined,
      tool !== "ceph_start" && (tool === "manus_start" || d.kind === "worker") ? fieldLine(theme, "isolation", d.worktree === false ? "shared checkout · retained on finish" : "Worktrunk worktree", "muted") : undefined,
      text(d.cwd) ? fieldLine(theme, "cwd", truncatePlain(text(d.cwd), 200), "muted") : undefined,
      text(d.branch) ? fieldLine(theme, "branch", text(d.branch), "muted") : undefined,
      text(d.space) ? fieldLine(theme, "space", joinTitleParts([text(d.spaceName) || undefined, text(d.space), tool === "ceph_start" ? (d.createdSpace ? "created (shown)" : "reused, not switched") : undefined]), "muted") : undefined,
      tool === "manus_start" && text(d.appHost) ? fieldLine(theme, "app host", text(d.appHost), "muted") : undefined,
      d.tab !== undefined ? fieldLine(theme, "tab", d.tab === "pending" ? "adoption pending · the brief tells it to name its tab" : joinTitleParts([text(d.tabName), text(d.tab)]), d.tab === "pending" ? "warning" : "muted") : undefined,
      text(d.tabError) ? fieldLine(theme, "tab rename", text(d.tabError), "warning") : undefined,
      text(d.tandemTab) ? fieldLine(theme, "tandem tab", text(d.tandemTab), "muted") : undefined,
      d.firstMessage !== undefined ? fieldLine(theme, "first message", d.firstMessage ? "sent" : "not sent", d.firstMessage ? "muted" : "warning") : undefined,
      text(d.route) ? fieldLine(theme, "reports to", text(d.route), "muted") : undefined,
      text(d.requestClosed) ? fieldLine(theme, "request", `${text(d.requestClosed)} closed: dispatched to ${labelOf(tool, args, d)}${idsOf({ name: d.name })}`, "muted") : undefined,
      text(d.requestCloseError) ? fieldLine(theme, "request close", text(d.requestCloseError), "warning") : undefined,
      Array.isArray(d.notChecked) && d.notChecked.length ? fieldLine(theme, "not checked", d.notChecked.join(", "), "warning") : undefined,
      expanded && d.labels ? fieldLine(theme, "labels", Object.entries(d.labels).map(([k, v]) => `${k}=${v}`).join(" "), "dim") : undefined,
      expanded && text(d.deliveryId) ? fieldLine(theme, "delivery", text(d.deliveryId), "dim") : undefined,
      expanded && text(d.worktreePath) ? fieldLine(theme, "worktree", text(d.worktreePath), "dim") : undefined,
      expanded && text(d.brief) ? fieldLine(theme, tool === "ceph_start" ? "kickoff" : "brief", truncatePlain(text(d.brief), 600), "dim") : undefined,
    ])];
  return {
    title: `${statusIcon(theme, tone)} ${toolName(theme, LABEL[tool])}`,
    status: joinTitleParts([status, durationLabel(context.state)]),
    tone,
    body: [theme.fg("muted", `${kindOf(tool, args, d)} ${labelOf(tool, args, d)}${pending || error ? (args.needsAlgorant === true ? " · needsAlgorant:true" : "") : ` · ${whereOf(tool, d)}`}`)],
    sections,
  };
}

type State = BoxedToolRendererState<Details> & { line?: string; compact?: boolean };

/** Shows the collapsed line or the boxed card for whichever of call/result currently owns the card. */
class DispatchSlot implements Component {
  constructor(readonly role: "call" | "result", private readonly state: State) {}
  render(width: number): string[] {
    const owner = this.state.result === undefined ? "call" : "result";
    if (owner !== this.role) return [];
    if (this.state.compact && this.state.line) return width <= 0 ? [] : [truncateToWidth(this.state.line, width, "…")];
    return this.state.box instanceof ToolBoxComponent ? this.state.box.render(width) : [];
  }
  invalidate(): void {
    if (this.state.box instanceof ToolBoxComponent) this.state.box.invalidate();
  }
}

/** One line when collapsed (pending or launched); the boxed card when expanded or refused. */
export function createDispatchRenderer(tool: DispatchTool) {
  const boxed = createBoxedToolRenderer<Args, Details>((input) => build(tool, input));
  type Context = ToolRenderContext<State, Args>;
  const slot = (role: "call" | "result", context: Context) =>
    context.lastComponent instanceof DispatchSlot && context.lastComponent.role === role ? context.lastComponent : new DispatchSlot(role, context.state);
  return {
    renderShell: "self" as const,
    renderCall(args: Args, theme: Theme, context: Context) {
      boxed.renderCall(args, theme, context as any);
      if (context.state.result === undefined) {
        context.state.compact = !context.expanded;
        context.state.line = line(tool, args, undefined, theme, context.executionStarted ? "starting" : "queued");
      }
      return slot("call", context);
    },
    renderResult(result: AgentToolResult<Details>, options: ToolRenderResultOptions, theme: Theme, context: Context) {
      boxed.renderResult(result, options, theme, context as any);
      const failed = context.isError || (result as { isError?: boolean }).isError === true;
      context.state.compact = !options.expanded && !failed;
      context.state.line = line(tool, context.args, result.details, theme, options.isPartial ? "starting" : undefined);
      return slot("result", context);
    },
  };
}
