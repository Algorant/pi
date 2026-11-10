import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createBoxedToolRenderer, ToolBoxComponent } from "../core/card";
import { durationLabel, fieldLine, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRendererState, BoxedToolRenderInput, ToolRenderContext, ToolUiBoxModel, ToolUiTone } from "../core/types";
import { peerName, type Peer as Address } from "../../../../scripts/whois.ts";

type AgentSendArgs = { terminal?: unknown; kind?: unknown; body?: unknown; reply_to?: unknown; interrupt?: unknown };
type Peer = Address & { context?: unknown };
/** The inbox envelope (pi-agency/inbox/envelope.ts); older delivered messages carry only kind and from. */
type EnvelopeLike = { id?: unknown; reply_to?: unknown; kind?: unknown; interrupt?: unknown; from?: Peer; to?: Peer };
/** The recipient's hc status when the message was queued (pi-agency/inbox/send.ts targetStatus). */
type TargetLike = { state?: unknown; kind?: unknown; msg?: unknown };
type AgentSendDetails = { envelope?: EnvelopeLike; file?: unknown; target?: TargetLike };

/** `recipient working`, `recipient blocked (permission: …)`: what the recipient was doing when it was queued. */
function targetText(target: TargetLike | undefined): string | undefined {
  const state = text(target?.state);
  if (!state) return undefined;
  const why = [text(target?.kind), text(target?.msg)].filter(Boolean).join(": ");
  return `recipient ${state === "none" ? "reports no hc status" : state}${why ? ` (${why})` : ""}`;
}

/** `m4f1a2c9 ↩ m3c9d0e1`, or nothing for messages from before ids existed. */
function idText(env: EnvelopeLike | undefined): string {
  const id = text(env?.id);
  if (!id) return "";
  const reply = text(env?.reply_to);
  return reply ? `${id} ↩ ${reply}` : id;
}

/** One line for collapsed mode; the full box otherwise. Both card kinds share this. */
class LineComponent implements Component {
  constructor(private readonly line: string) {}
  render(width: number): string[] {
    return width <= 0 ? [] : [truncateToWidth(this.line, width, "…")];
  }
  invalidate(): void {}
}

/** `· <first line>  +N lines`, the collapsed gist of a message body. */
function gist(body: string, theme: Theme): string {
  const lines = body.trim().split("\n");
  const first = lines[0]?.trim() ?? "";
  const more = lines.length - 1;
  return `${theme.fg("muted", ` · ${first}`)}${more > 0 ? theme.fg("dim", `  +${more} line${more === 1 ? "" : "s"}`) : ""}`;
}

/** Kind colours, shared by both directions: blocked ochre, result fern, request dim. */
function kindText(kind: string, theme: Theme): string {
  const tone = kind === "blocked" ? "warning" : kind === "result" ? "accent" : "dim";
  return theme.fg(tone as any, kind);
}

/**
 * One collapsed line for either direction: `✉ <kind> <arrow> <peer> · <first line>  +N lines`; the
 * arrow tells direction (→ sent, ← received). ✉ renders double-width in some terminals, so a second
 * space keeps it off the kind word. ✉ is ochre when the message needs Algorant (blocked, or a
 * request to Herdra, which is how agents ask for his choice), fern otherwise.
 */
function messageLine(needsAlgorant: boolean, kind: string, arrow: string, peer: string, body: string, theme: Theme, status?: string, context?: unknown, ids?: string, interrupt?: boolean): string {
  const glyph = theme.fg(needsAlgorant ? "warning" : "accent", "✉");
  const percent = typeof context === "number" ? theme.fg("muted", ` · ${context}%`) : "";
  const idPart = ids ? theme.fg("dim", ` · ${ids}`) : "";
  const flag = interrupt ? theme.fg("warning", " · interrupt") : "";
  return ` ${glyph}  ${kindText(kind, theme)}${flag}${theme.fg("muted", ` ${arrow} `)}${theme.fg("text", peer)}${percent}${idPart}${status ? theme.fg("muted", ` · ${status}`) : ""}${gist(body, theme)}`;
}

type AgentSendState = BoxedToolRendererState<AgentSendDetails> & { line?: string; compact?: boolean };

/** Shows the collapsed line or the boxed card for whichever of call/result currently owns the card. */
class AgentSendSlot implements Component {
  constructor(readonly role: "call" | "result", private readonly state: AgentSendState) {}
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

/**
 * `agent_send` card: one line (`✉ kind → recipient · <first line>  +N lines`)
 * when collapsed and successful; the boxed card when expanded or failed.
 */
export function createAgentSendRenderer() {
  const boxed = createBoxedToolRenderer<AgentSendArgs, AgentSendDetails>(buildAgentSendBox);
  type Context = ToolRenderContext<AgentSendState, AgentSendArgs>;
  const slot = (role: "call" | "result", context: Context) =>
    context.lastComponent instanceof AgentSendSlot && context.lastComponent.role === role ? context.lastComponent : new AgentSendSlot(role, context.state);
  function line(args: AgentSendArgs, theme: Theme, peer: string, status?: string, context?: unknown, ids?: string, interrupt?: boolean): string {
    const kind = text(args.kind) || "message";
    return messageLine(needsAlgorant(kind, peer), kind, "→", peer, text(args.body), theme, status, context, ids, interrupt);
  }
  return {
    renderShell: "self" as const,
    renderCall(args: AgentSendArgs, theme: Theme, context: Context) {
      boxed.renderCall(args, theme, context as any);
      if (context.state.result === undefined) {
        context.state.compact = !context.expanded;
        context.state.line = line(args, theme, text(args.terminal) || "?", context.executionStarted ? "sending" : "queued", undefined, undefined, args.interrupt === true);
      }
      return slot("call", context);
    },
    renderResult(result: AgentToolResult<AgentSendDetails>, options: ToolRenderResultOptions, theme: Theme, context: Context) {
      boxed.renderResult(result, options, theme, context as any);
      const failed = context.isError || (result as { isError?: boolean }).isError === true;
      context.state.compact = !options.expanded && !failed && !options.isPartial;
      const env = asRecord(result.details).envelope as EnvelopeLike | undefined;
      const peer = env?.to ? peerName(env.to, env.from?.machine) : text(context.args.terminal) || "?";
      context.state.line = line(context.args, theme, peer, failed ? undefined : targetText(asRecord(result.details).target as TargetLike | undefined), env?.from?.context, idText(env), env?.interrupt === true);
      return slot("result", context);
    },
  };
}

function buildAgentSendBox(
  { args, result, options, theme, text: resultText, pending, error, context }: BoxedToolRenderInput<AgentSendArgs, AgentSendDetails>,
): ToolUiBoxModel {
  const details = asRecord(result?.details) as AgentSendDetails;
  const tone: ToolUiTone = pending ? "pending" : error ? "error" : "success";
  const status = pending ? (context.executionStarted ? "sending" : "queued") : error ? "failed" : "queued in inbox";
  const target = pending || error ? undefined : targetText(details.target);
  const interrupt = args.interrupt === true || details.envelope?.interrupt === true;
  const sections = [];
  if (!pending && error) {
    sections.push(section("Error", [theme.fg("error", truncatePlain(resultText || "agent_send failed", 500))]));
  } else if (!pending) {
    sections.push(section("Message", [
      theme.fg("toolOutput", truncatePlain(text(args.body), 2000)),
      text(details.file) ? fieldLine(theme, "file", text(details.file), "muted") : undefined,
      interrupt ? fieldLine(theme, "delivery", "interrupts the recipient's running turn", "warning") : undefined,
      target ? fieldLine(theme, "recipient", target.replace(/^recipient /, ""), details.target?.state === "blocked" || details.target?.state === "gone" ? "warning" : "muted") : undefined,
    ]));
  }
  return {
    title: `${statusIcon(theme, tone)} ${toolName(theme, "Agent Send")}`,
    status: joinTitleParts([status, interrupt && !pending && !error ? "interrupt" : undefined, durationLabel(context.state)]),
    tone,
    body: [theme.fg("muted", `${text(args.kind) || "message"}${interrupt ? " · interrupt" : ""} → ${details.envelope?.to ? `${peerName(details.envelope.to, details.envelope.from?.machine)} (${peerAddress(details.envelope.to)})` : peerAddress(args)}${details.envelope ? ` · ${idText(details.envelope)}` : ""}`)],
    sections,
  };
}

/**
 * Transcript card for a delivered `pi-agent-message`: one line
 * (`✉ kind ← sender · <first line>  +N lines`) by default, the full box when
 * expanded. The model always receives the full message content.
 */
export function renderAgentMessage(message: { content: unknown; details?: unknown }, options: { expanded?: boolean }, theme: Theme): Component {
  const details = asRecord(message.details) as EnvelopeLike;
  const from = asRecord(details.from) as Peer;
  const sender = peerName(from, details.to?.machine ?? from.machine);
  const kind = text(details.kind) || "message";
  const content = typeof message.content === "string" ? message.content : "";
  const body = content.replace(/^\[Agent message[^\n]*\]\n?/, "");
  if (!options.expanded) {
    return new LineComponent(messageLine(needsAlgorant(kind, text(details.to?.label)), kind, "←", sender, body, theme, undefined, from.context, idText(details), details.interrupt === true));
  }
  const tone: ToolUiTone = kind === "blocked" ? "warning" : "neutral";
  return new ToolBoxComponent({
    title: `${statusIcon(theme, tone)} ${toolName(theme, "Agent Message")}`,
    status: joinTitleParts([kind, details.interrupt === true ? "interrupt" : undefined, idText(details) || undefined, `from ${sender}`, text(from.terminal) ? peerAddress(from) : undefined, typeof from.context === "number" ? `context ${from.context}%` : undefined]),
    tone,
    sections: [{ lines: body.split("\n"), wrap: true }],
  }, theme);
}

function peerAddress(peer: { terminal?: unknown }): string {
  return `terminal ${text(peer.terminal)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Blocked messages, and requests to Herdra (how agents ask for Algorant's choice), need Algorant. */
function needsAlgorant(kind: string, recipient: string): boolean {
  return kind === "blocked" || (kind === "request" && recipient.split("@")[0]!.toLowerCase() === "herdra");
}
