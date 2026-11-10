import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { RenderCache, renderCached } from "./render-cache";
import { getTextOutput, isErrorResult } from "./text";
import { readToolTiming } from "./timing";
import type {
  BoxedToolRenderInput,
  BoxedToolRendererState,
  ToolRenderContext,
  ToolUiBoxModel,
  ToolUiResultLike,
} from "./types";

export class ToolBoxComponent implements Component {
  private model: ToolUiBoxModel;
  private theme: Theme;
  private readonly cache = new RenderCache();

  constructor(model: ToolUiBoxModel, theme: Theme) {
    this.model = model;
    this.theme = theme;
  }

  setModel(model: ToolUiBoxModel, theme: Theme): void {
    this.model = model;
    this.theme = theme;
    this.cache.clear();
  }

  render(width: number): string[] {
    return renderCached(this.cache, width, this.theme, (w) => this.buildLines(w), [this.model, this.theme]);
  }

  /** Pi's signal that cached output is stale, for example after a theme change. */
  invalidate(): void {
    this.cache.clear();
  }

  private buildLines(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (safeWidth < 8) {
      return [truncateToWidth(this.model.title, safeWidth, "…", true)];
    }

    const contentWidth = safeWidth - 4;
    const lines: string[] = [this.topBorder(safeWidth)];

    if (this.model.body?.length) {
      lines.push(...this.model.body.map((line) => this.bodyLine(line, contentWidth)));
    }

    for (const section of this.model.sections ?? []) {
      if (section.lines.length === 0) continue;
      if (section.title) lines.push(this.divider(safeWidth, section.title));
      const sectionLines = section.wrap
        ? section.lines.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
        : section.lines;
      lines.push(...sectionLines.map((line) => this.bodyLine(line, contentWidth)));
    }

    lines.push(this.bottomBorder(safeWidth));
    return lines;
  }

  private border(text: string): string {
    const color = this.model.tone === "error"
      ? "error"
      : this.model.tone === "warning"
        ? "warning"
        : "borderMuted";
    return this.theme.fg(color, text);
  }

  private title(text: string): string {
    return this.theme.bold(text);
  }

  private topBorder(width: number): string {
    const rawTitle = ` ${this.model.status ? `${this.model.title} · ${this.model.status}` : this.model.title} `;
    const renderedTitle = truncateToWidth(this.title(rawTitle), Math.max(1, width - 6));
    const fillWidth = Math.max(0, width - 3 - visibleWidth(renderedTitle));
    return `${this.border("╭─")}${renderedTitle}${this.border(`${"─".repeat(fillWidth)}╮`)}`;
  }

  private divider(width: number, label: string): string {
    const renderedLabel = truncateToWidth(this.theme.fg("muted", ` ${label} `), Math.max(1, width - 3), "…");
    const fillWidth = Math.max(0, width - 3 - visibleWidth(renderedLabel));
    return `${this.border("├─")}${renderedLabel}${this.border(`${"─".repeat(fillWidth)}┤`)}`;
  }

  private bottomBorder(width: number): string {
    return this.border(`╰${"─".repeat(Math.max(1, width - 2))}╯`);
  }

  private bodyLine(line: string, contentWidth: number): string {
    const clipped = truncateToWidth(line, contentWidth);
    const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
    return `${this.border("│ ")}${clipped}${padding}${this.border(" │")}`;
  }
}

/**
 * One framed card per tool call, shown through whichever of Pi's two renderer
 * slots currently owns it. Pi calls renderCall and then renderResult in every
 * display cycle and stacks both components, so both hand out a CardSlot over
 * the box held in renderer state: the call slot renders the card until a result
 * exists, the result slot renders it afterwards. Exactly one slot is ever
 * visible, and the visible one is a real component, so Pi's HTML export, which
 * stringifies call and result separately, also receives a completed card.
 */
class CardSlot implements Component {
  constructor(
    readonly role: "call" | "result",
    private readonly state: BoxedToolRendererState<any>,
  ) {}

  render(width: number): string[] {
    const owner = this.state.result === undefined ? "call" : "result";
    return owner === this.role && this.state.box instanceof ToolBoxComponent ? this.state.box.render(width) : [];
  }

  invalidate(): void {
    if (this.state.box instanceof ToolBoxComponent) this.state.box.invalidate();
  }
}

function slotFor(role: "call" | "result", state: BoxedToolRendererState<any>, last: Component | undefined): CardSlot {
  return last instanceof CardSlot && last.role === role ? last : new CardSlot(role, state);
}

export function createBoxedToolRenderer<TArgs, TDetails>(
  build: (input: BoxedToolRenderInput<TArgs, TDetails>) => ToolUiBoxModel,
) {
  function updateBox(
    args: TArgs,
    theme: Theme,
    context: ToolRenderContext<BoxedToolRendererState<TDetails>, TArgs>,
    result: ToolUiResultLike<TDetails> | undefined,
    options: ToolRenderResultOptions,
  ): void {
    const state = context.state;
    const text = getTextOutput(result);
    const model = build({
      args,
      result,
      options,
      theme,
      context,
      text,
      pending: !result || options.isPartial,
      error: context.isError || isErrorResult(result, text),
    });
    if (state.box instanceof ToolBoxComponent) state.box.setModel(model, theme);
    else state.box = new ToolBoxComponent(model, theme);
  }

  return {
    renderShell: "self" as const,
    renderCall(args: TArgs, theme: Theme, context: ToolRenderContext<BoxedToolRendererState<TDetails>, TArgs>) {
      const state = context.state;
      // Once a result exists, renderResult owns the model and its current options.
      if (state.result === undefined) {
        updateBox(args, theme, context, undefined, state.options ?? { expanded: context.expanded, isPartial: context.isPartial });
      }
      return slotFor("call", state, context.lastComponent);
    },
    renderResult(
      result: AgentToolResult<TDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ToolRenderContext<BoxedToolRendererState<TDetails>, TArgs>,
    ) {
      const state = context.state;
      state.result = result as ToolUiResultLike<TDetails>;
      state.options = options;
      // Only a recorded execution window counts; never infer one from render time.
      const timing = readToolTiming(result.details);
      state.startedAt = timing?.startedAt;
      state.endedAt = timing?.endedAt;
      updateBox(context.args, theme, context, state.result, options);
      return slotFor("result", state, context.lastComponent);
    },
  };
}
