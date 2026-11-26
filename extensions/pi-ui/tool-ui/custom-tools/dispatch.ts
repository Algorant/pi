import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createBoxedToolRenderer, ToolBoxComponent } from "../core/card";
import { durationLabel, fieldLine, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRendererState, BoxedToolRenderInput, ToolRenderContext, ToolUiBoxModel, ToolUiTone } from "../core/types";
import { labelFrom } from "../../../../scripts/whois.ts";

/** The pi-herdr dispatch tools (pi-herdr/dispatch.ts): dendra_start, manus_start, ceph_start. */
export type DispatchTool = "dendra_start" | "manus_start" | "ceph_start";
type Args = { kind?: unknown; label?: unknown; task?: unknown; taskId?: unknown; brief?: unknown; needsAlgorant?: unknown; prompt?: unknown; worktree?: unknown; direction?: unknown; model?: unknown; thinking?: unknown; project?: unknown; folder?: unknown; kickoff?: unknown; from?: unknown };
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

/** A quota cutover this launch made before its side effects (task-745): never buried. */
function switchMove(s: Record<string, any>): string {
  const from = text(s.from) || "unset";
  const to = text(s.to);
  if (text(s.status) === "switched") return `${from} → ${to || "?"}`;
  return `${from} (${text(s.status) || "unchanged"})`;
}
function switchShort(d: Details): string {
  const s = d.modelSwitched && typeof d.modelSwitched === "object" ? d.modelSwitched : undefined;
  if (!s) return "";
  return `role set ${switchMove(s)}${s.partial ? " · partial" : ""}`;
}
function switchLong(d: Details): string {
  const s = d.modelSwitched && typeof d.modelSwitched === "object" ? d.modelSwitched : undefined;
  if (!s) return "";
  return `quota-switched ${switchMove(s)}${text(s.operation) ? ` · cutover ${text(s.operation)}` : ""}${s.partial ? " · partial: some typed requests failed or a Pi was skipped" : ""}`;
}

/** The advisory cold read a brief or kickoff launch started (task-755): started, or why not. */
function coldReadOf(d: Details): Details | undefined {
  return d.coldRead && typeof d.coldRead === "object" ? d.coldRead : undefined;
}
function coldReadShort(d: Details): string {
  const cold = coldReadOf(d);
  if (!cold) return "";
  return cold.status === "started" ? `cold read ${text(cold.name) || "started"}` : "no cold read";
}
function coldReadLong(d: Details): string {
  const cold = coldReadOf(d);
  if (!cold) return "";
  return cold.status === "started"
    ? `started ${text(cold.label)}${text(cold.name) ? ` (${text(cold.name)})` : ""} · its findings arrive in your inbox`
    : `not started · ${text(cold.error) || "refused"} · the launch stands`;
}

/** The pair a launch resolved (task-851), or before the result the override the call asked for. */
function selectionOf(d: Details): Details | undefined {
  return d.selection && typeof d.selection === "object" ? d.selection : undefined;
}
function selectionShort(args: Args, d: Details): string {
  const chosen = selectionOf(d);
  if (chosen) return ` · ${text(chosen.model)} · ${text(chosen.thinking)} · ${text(chosen.source) || "default"}`;
  return text(args.model) || text(args.thinking) ? ` · override ${[text(args.model), text(args.thinking)].filter(Boolean).join(" · ")}` : "";
}
function selectionLong(chosen: Details, expanded: boolean): string {
  const asked = text(chosen.source) === "override"
    ? `override${text(chosen.requestedModel) ? "" : " · thinking only, model from the role default"}${text(chosen.requestedThinking) || !text(chosen.requestedModel) ? "" : " · thinking inherited"}`
    : "role default";
  return joinTitleParts([text(chosen.model), `${text(chosen.thinking)} thinking`, asked, text(chosen.set) ? `set ${text(chosen.set)}` : undefined, text(chosen.quota) ? truncatePlain(text(chosen.quota), expanded ? 300 : 120) : undefined]);
}

/** Saved results only: the retired researcher Fable selector (task-851) stays readable in old transcripts. */
function fableText(d: Details): string {
  const fable = d.fable && typeof d.fable === "object" ? d.fable : undefined;
  return fable ? ` · Fable ${text(fable.model)} · ${text(fable.thinking)}` : "";
}

/** Saved results only: the retired Worker benchmark selector; a saved benchmark record still continues. */
function benchmarkText(d: Details): string {
  const benchmark = d.benchmark && typeof d.benchmark === "object" ? d.benchmark : undefined;
  if (!benchmark) return "";
  const selected = text(benchmark.selectedModel);
  return ` · benchmark ${selected} · ${text(benchmark.providerExemption)} for ${text(benchmark.providerExemptionModel) || selected}`;
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
  if (status) parts.push(theme.fg("muted", ` · ${status}${args.needsAlgorant === true ? " · needsAlgorant:true" : ""}${selectionShort(args, details)}`));
  else {
    parts.push(theme.fg("dim", idsOf(details)));
    const where = whereOf(tool, details);
    if (where) parts.push(theme.fg("muted", ` · ${where}`));
    if (details.requestClosed) parts.push(theme.fg("dim", ` · closed ${text(details.requestClosed)}`));
    if (details.requestCloseError || details.tabError || details.notChecked?.length) parts.push(theme.fg("warning", " · see details"));
    const move = switchShort(details);
    if (move) parts.push(theme.fg("warning", ` · ${move}`));
    const cold = coldReadShort(details);
    if (cold) parts.push(theme.fg(coldReadOf(details)!.status === "started" ? "dim" : "warning", ` · ${cold}`));
    const chosen = selectionOf(details);
    if (chosen) parts.push(theme.fg(text(chosen.source) === "override" ? "accent" : "dim", selectionShort(args, details)));
    const benchmark = benchmarkText(details);
    if (benchmark) parts.push(theme.fg("warning", benchmark));
    const fable = fableText(details);
    if (fable) parts.push(theme.fg("accent", fable));
  }
  return ` ${parts.join("")}`;
}

function build(tool: DispatchTool, { args, result, options, theme, pending, error, context, text: output }: BoxedToolRenderInput<Args, Details>): ToolUiBoxModel {
  const d = (result?.details ?? {}) as Details;
  const cold = coldReadOf(d);
  const tone: ToolUiTone = pending ? "pending" : error ? "error" : d.requestCloseError || d.tabError || (cold && cold.status !== "started") ? "warning" : "success";
  const expanded = Boolean(options.expanded);
  const status = pending ? (context.executionStarted ? "starting" : "queued") : error ? "refused" : "launched";
  const sections = error
    ? [section("Error", [
      theme.fg("error", truncatePlain(output, expanded ? 4000 : 500)),
      switchLong(d) ? fieldLine(theme, "role set", switchLong(d), "warning") : undefined,
      text(args.model) || text(args.thinking) ? fieldLine(theme, "requested", [text(args.model), text(args.thinking) ? `${text(args.thinking)} thinking` : ""].filter(Boolean).join(" · ") + " · nothing substituted", "warning") : undefined,
    ])]
    : pending ? [] : [section("Started", [
      fieldLine(theme, "label", labelOf(tool, args, d), "accent"),
      fieldLine(theme, "name", text(d.name) || "—", "muted"),
      fieldLine(theme, "terminal", text(d.terminal) || "—", "muted"),
      text(d.taskId) ? fieldLine(theme, "task", joinTitleParts([text(d.taskId), text(d.title) ? truncatePlain(text(d.title), expanded ? 200 : 80) : undefined]), "toolOutput") : undefined,
      d.benchmark ? fieldLine(theme, "benchmark", `${text(d.benchmark.requestedModel)} → ${text(d.benchmark.selectedModel)} · ${text(d.benchmark.providerExemption)} for ${text(d.benchmark.providerExemptionModel)} · high thinking · ${text(d.benchmark.quota)} · Fast ${d.benchmark.fast ? "on" : "off"}`, "warning") : undefined,
      d.fable ? fieldLine(theme, "researcher model", `${text(d.fable.model)} · ${text(d.fable.thinking)} thinking · ${text(d.fable.quota)}`, "accent") : undefined,
      selectionOf(d) ? fieldLine(theme, "model", selectionLong(selectionOf(d)!, expanded), text(selectionOf(d)!.source) === "override" ? "accent" : "muted")
        : text(d.model) && tool === "manus_start" ? fieldLine(theme, "model", joinTitleParts([text(d.model), text(d.modelSet) ? `set ${text(d.modelSet)}` : undefined, text(d.modelQuota) ? truncatePlain(text(d.modelQuota), expanded ? 300 : 120) : undefined]), "muted") : undefined,
      switchLong(d) ? fieldLine(theme, "role set", switchLong(d), "warning") : undefined,
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
      cold ? fieldLine(theme, "cold read", coldReadLong(d), cold.status === "started" ? "muted" : "warning") : undefined,
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
