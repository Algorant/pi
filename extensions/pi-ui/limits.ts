import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { CACHE_TTL_MS, LABELS, LimitsController, buildFetchers, providerConfigured, type BalanceInfo, type LimitsProvider, type MoneyLine, type ProviderLimits, type ProviderView, type RateWindow } from "../pi-providers/quota/index.ts";

export { LimitsController } from "../pi-providers/quota/index.ts";

const METER_WIDTH = 18;

export const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center" as const,
    width: "80%" as const,
    minWidth: 48,
    maxHeight: "90%" as const,
    margin: 1,
  },
};

export function formatAge(fetchedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

export function meter(usedPercent: number): string {
  const clamped = Math.max(0, Math.min(100, usedPercent));
  const filled = Math.round((clamped / 100) * METER_WIDTH);
  return `${"█".repeat(filled)}${"░".repeat(METER_WIDTH - filled)}`;
}

function tone(usedPercent: number): "error" | "warning" | "success" {
  if (usedPercent >= 90) return "error";
  return usedPercent >= 70 ? "warning" : "success";
}

export function labelColumnWidth(views: ProviderView[]): number {
  const labels = views.flatMap((view) => [
    ...view.windows.map((window) => window.label),
    ...(view.money ?? []).map((money) => money.label),
    ...(view.balance ? ["Balance"] : []),
  ]);
  return labels.length ? Math.max(...labels.map((label) => visibleWidth(label))) : 0;
}

function meterRow(label: string, usedPercent: number, detail: string | undefined, labelWidth: number, theme: Theme, width: number): string {
  const percent = Math.max(0, Math.min(100, usedPercent));
  const suffix = detail ? theme.fg("dim", ` · ${detail}`) : "";
  const bar = theme.fg(tone(percent), meter(percent));
  const padded = theme.fg("text", label.padEnd(labelWidth));
  return truncateToWidth(`  ${padded}  ${bar} ${String(Math.round(percent)).padStart(3)}%${suffix}`, width);
}

function moneyRow(label: string, text: string, labelWidth: number, theme: Theme, width: number): string {
  const padded = theme.fg("text", label.padEnd(labelWidth));
  return truncateToWidth(`  ${padded}  ${theme.fg("secondary", text)}`, width);
}

export function renderProviderSection(view: ProviderView, width: number, theme: Theme, now: number, labelWidth = labelColumnWidth([view])): string[] {
  const lines = [theme.bold(theme.fg("accent", LABELS[view.provider]))];
  const hasData = view.windows.length > 0 || (view.money?.length ?? 0) > 0 || view.balance !== undefined;
  if (view.status === "loading" && !hasData) {
    lines.push(theme.fg("dim", "  loading…"));
    return lines;
  }
  if (!hasData) {
    lines.push(theme.fg("warning", "  usage unavailable"));
    return lines;
  }

  for (const window of view.windows) {
    const detail = window.resetDescription ? `resets ${window.resetDescription}` : undefined;
    lines.push(meterRow(window.label, window.usedPercent, detail, labelWidth, theme, width));
  }
  if (view.balance) {
    lines.push(meterRow("Balance", view.balance.usedPercent, view.balance.detail, labelWidth, theme, width));
  }
  for (const money of view.money ?? []) {
    lines.push(moneyRow(money.label, money.text, labelWidth, theme, width));
  }

  if (view.status === "loading") {
    lines.push(theme.fg("dim", "  refreshing…"));
  } else if (view.fetchedAt !== undefined) {
    const stale = view.status === "error" || now - view.fetchedAt > CACHE_TTL_MS;
    const age = formatAge(view.fetchedAt, now);
    lines.push(theme.fg(stale ? "warning" : "dim", `  ${stale ? `stale · ${age}` : `updated ${age}`}`));
  }
  return lines;
}

export function renderLimitsView(views: ProviderView[], width: number, theme: Theme, now: number): string[] {
  const border = new DynamicBorder((value: string) => theme.fg("accent", value)).render(width)[0] ?? "";
  const labelWidth = labelColumnWidth(views);
  const body = views.length
    ? views.flatMap((view, index) => [
      ...(index ? [""] : []),
      ...renderProviderSection(view, width, theme, now, labelWidth),
    ])
    : [theme.fg("warning", "  No configured providers.")];
  const lines = [
    border,
    theme.bold(theme.fg("accent", "LIMITS")),
    theme.fg("muted", "Usage · all configured providers"),
    "",
    ...body,
    "",
    theme.fg("dim", "r refresh · Esc close · q close"),
    border,
  ];
  return lines.map((line) => {
    const clipped = truncateToWidth(line, Math.max(1, width));
    return clipped + theme.bg("customMessageBg", " ".repeat(Math.max(0, width - visibleWidth(clipped))));
  });
}

class LimitsOverlay implements Component {
  private readonly controller: LimitsController;

  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly done: () => void, ctx: ExtensionCommandContext) {
    this.controller = new LimitsController(() => this.tui.requestRender(), {
      hasCredentials: (provider) => providerConfigured(provider, ctx),
      fetchers: buildFetchers(ctx),
    });
    void this.controller.refresh();
  }

  handleInput(data: string): void {
    if (data === "q" || matchesKey(data, Key.escape)) {
      this.controller.abort();
      this.done();
      return;
    }
    if (data === "r") void this.controller.refresh();
  }

  render(width: number): string[] {
    return renderLimitsView(this.controller.snapshot(), width, this.theme, Date.now());
  }

  invalidate(): void {}
}

export function registerLimits(pi: ExtensionAPI): void {
  pi.registerCommand("limits", {
    description: "Show usage for configured providers",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode && ctx.mode !== "tui") {
        ctx.ui.notify("/limits requires interactive mode", "warning");
        return;
      }
      await ctx.ui.custom<void>(
        (tui: TUI, theme: Theme, _keybindings: unknown, done: () => void) => new LimitsOverlay(tui, theme, done, ctx),
        OVERLAY_OPTIONS,
      );
    },
  });
}
