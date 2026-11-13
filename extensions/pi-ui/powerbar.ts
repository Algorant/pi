import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { OPENAI_FAST_STATE_EVENT, type OpenAIFastState } from "../pi-providers/openai/events.ts";
import {
	fetchAnthropicLimits, fetchCodexLimits, fetchXaiLimits, filterPowerbarWindows, getUsageFailureRetryAt,
	getUsageProvider, mapAnthropicUsage, prioritizeWindowsForModel, resetClaudeCodeVersionForTests, resolveClaudeCodeVersion,
	readCachedLimits, writeCachedLimits, isTruthyEnvFlag, CACHE_TTL_MS, POWERBAR_METER_WIDTH,
	type LimitState, type RateWindow, type UsageProvider,
} from "../pi-providers/quota/index.ts";

export { POWERBAR_METER_WIDTH };

const PLAN_FETCHERS: Record<UsageProvider, (ctx: ExtensionContext, signal?: AbortSignal) => Promise<RateWindow[]>> = {
	anthropic: (_ctx, signal) => fetchAnthropicLimits(signal),
	"openai-codex": (ctx, signal) => fetchCodexLimits(ctx.modelRegistry, signal),
	xai: (_ctx, signal) => fetchXaiLimits(signal),
};

type UsageTotals = { input: number; output: number; cost: number };

/**
 * Session usage is accumulated forward from a cursor instead of rescanned on
 * every paint. The cursor is an entry count, so a restored session is scanned
 * once and later turns cost only their own new entries.
 */
function createUsageAccumulator() {
	let totals: UsageTotals = { input: 0, output: 0, cost: 0 };
	let cursor = 0;
	return {
		reset() {
			totals = { input: 0, output: 0, cost: 0 };
			cursor = 0;
		},
		consume(ctx: ExtensionContext): UsageTotals {
			const entries = ctx.sessionManager.getEntries();
			if (entries.length < cursor) {
				totals = { input: 0, output: 0, cost: 0 };
				cursor = 0;
			}
			for (let index = cursor; index < entries.length; index += 1) {
				const entry = entries[index];
				if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
				const usage = entry.message.usage;
				if (!usage) continue;
				totals.input += usage.input ?? 0;
				totals.output += usage.output ?? 0;
				totals.cost += usage.cost?.total ?? 0;
			}
			cursor = entries.length;
			return totals;
		},
	};
}

function formatTokens(count: number): string {
	if (!Number.isFinite(count) || count <= 0) return "0";
	if (count < 1_000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatCwd(cwd: string): string {
	const home = homedir();
	if (home.length === 0 || home === "/") return cwd;
	if (cwd === home) return "~";
	const prefix = `${home}/`;
	if (cwd.startsWith(prefix)) return `~/${cwd.slice(prefix.length)}`;
	return cwd;
}

function getContextStats(ctx: ExtensionContext): { tokens?: number; percent?: number } | undefined {
	const usage = ctx.getContextUsage?.();
	if (!usage) return undefined;
	const tokens = typeof usage.tokens === "number" ? usage.tokens : undefined;
	const limit = typeof usage.contextWindow === "number" ? usage.contextWindow : undefined;
	const percent = typeof usage.percent === "number"
		? usage.percent
		: tokens && limit ? (tokens / limit) * 100 : undefined;
	if ((tokens === undefined || tokens === 0) && (percent === undefined || percent === 0)) return undefined;
	return { tokens, percent: percent !== undefined && Number.isFinite(percent) ? percent : undefined };
}

function formatContextBar(ctx: ExtensionContext, theme: Theme, tier: FooterTier): string | undefined {
	const stats = getContextStats(ctx);
	if (!stats) return undefined;
	const pct = stats.percent ?? 0;
	const tokenText = stats.tokens !== undefined ? formatTokens(stats.tokens) : "?";
	return [
		theme.fg("dim", tokenText),
		renderMiniBar(pct, theme, tier.barWidth),
		theme.fg(limitColor(pct), tier.wholePercent ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`),
	].join(" ");
}

function limitColor(pct: number): "muted" | "warning" | "error" {
	if (pct >= 80) return "error";
	if (pct >= 60) return "warning";
	return "muted";
}

function renderMiniBar(pct: number, theme: Theme, width = 8): string {
	const clamped = Math.max(0, Math.min(100, pct));
	const filled = Math.round((clamped / 100) * width);
	const color = limitColor(clamped);
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(width - filled));
}

function shortLimitLabel(label: string): string {
	return label === "Week" ? "W" : label.replace(/^GPT-[^ ]+ /i, "");
}

/**
 * Priority ladder: the first tier whose whole line fits is used. Context, 5h,
 * weekly and the model are in every tier; only detail is shed.
 */
type FooterTier = { barWidth: number; resets: boolean; wholePercent: boolean; tokens: boolean; cost: boolean; cwd: "full" | "basename" | "none" };
const FOOTER_TIERS: readonly FooterTier[] = [
	{ barWidth: POWERBAR_METER_WIDTH, resets: true, wholePercent: false, tokens: true, cost: true, cwd: "full" },
	{ barWidth: 8, resets: false, wholePercent: true, tokens: true, cost: true, cwd: "full" },
	{ barWidth: 8, resets: false, wholePercent: true, tokens: false, cost: true, cwd: "basename" },
	{ barWidth: 4, resets: false, wholePercent: true, tokens: false, cost: false, cwd: "none" },
];
const MAX_POWERBAR_WINDOWS = 2;

function formatLimits(provider: UsageProvider | undefined, ctx: ExtensionContext, theme: Theme, state: LimitState, tier: FooterTier, separator: string): string | undefined {
	if (!provider) return undefined;
	if (state.status === "loading" && state.windows.length === 0) return theme.fg("dim", "limits …");
	if (state.status === "error" && state.windows.length === 0) return theme.fg("warning", "limits ?");
	const windows = prioritizeWindowsForModel(filterPowerbarWindows(state.windows), ctx.model?.id).slice(0, MAX_POWERBAR_WINDOWS);
	if (windows.length === 0) return undefined;

	return windows.map((window) => {
		const pct = Math.round(window.usedPercent);
		const reset = tier.resets && window.resetDescription ? theme.fg("dim", window.resetDescription) : "";
		return [
			theme.fg("dim", shortLimitLabel(window.label)),
			renderMiniBar(pct, theme, tier.barWidth),
			theme.fg(limitColor(pct), `${pct}%`),
			reset,
		].filter(Boolean).join(" ");
	}).join(separator);
}

function buildLine(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	theme: Theme,
	width: number,
	provider: UsageProvider | undefined,
	limits: LimitState,
	fast: OpenAIFastState,
	totals: UsageTotals,
): string {
	if (width <= 1) return " ".slice(0, width);
	// Herdr repaints a VS16 emoji at the right edge as a monochrome text glyph
	// with only one reserved column. Leave three columns for this footer.
	const rightGutter = Math.min(3, width - 1);
	const model = ctx.model;
	const modelId = model?.id ?? "no-model";
	const modelName = model && model.provider !== "anthropic" && model.provider !== "openai-codex" ? `${model.provider}/${modelId}` : modelId;
	const thinking = model?.reasoning ? ` · ${pi.getThinkingLevel()}` : "";
	const fastIndicator = fast.enabled && fast.eligible ? " ⚡️" : "";

	const separator = theme.fg("dim", " │ ");
	const modelText = `${theme.fg("muted", `${modelName}${thinking}`)}${fastIndicator}`;
	const cwdBudget = width >= 110 ? 34 : width >= 90 ? 24 : 16;
	const contentWidth = Math.max(0, width - rightGutter);

	const compose = (tier: FooterTier) => {
		const cwdText = tier.cwd === "full" ? formatCwd(ctx.cwd) : basename(ctx.cwd) || ctx.cwd;
		const identity = [
			theme.fg("accent", "π"),
			tier.cwd === "none" ? "" : theme.fg("dim", truncateToWidth(cwdText, cwdBudget, "…")),
		].filter(Boolean).join(" ");
		const tokenParts: string[] = [];
		if (tier.tokens) tokenParts.push(`↑${formatTokens(totals.input)}`, `↓${formatTokens(totals.output)}`);
		if (tier.cost && totals.cost > 0) tokenParts.push(`$${totals.cost.toFixed(2)}`);
		const tokens = tokenParts.length > 0 ? theme.fg("dim", tokenParts.join(" ")) : "";
		const left = [identity, tokens, formatContextBar(ctx, theme, tier)].filter(Boolean).join(separator);
		const limitsText = formatLimits(provider, ctx, theme, limits, tier, separator) ?? "";
		const right = limitsText ? `${limitsText}${separator}${modelText}` : modelText;
		return { left, right };
	};

	const lastTier = FOOTER_TIERS[FOOTER_TIERS.length - 1]!;
	let { left, right } = compose(lastTier);
	for (const tier of FOOTER_TIERS) {
		const candidate = compose(tier);
		if (visibleWidth(candidate.left) + visibleWidth(candidate.right) + 1 <= contentWidth) {
			({ left, right } = candidate);
			break;
		}
	}
	// Narrower than the last tier: keep quota meters and model, clip the left side.
	left = truncateToWidth(left, Math.max(0, contentWidth - visibleWidth(right) - 1), "…");
	const padding = Math.max(1, contentWidth - visibleWidth(left) - visibleWidth(right));
	return `${truncateToWidth(`${left}${" ".repeat(padding)}${right}`, contentWidth)}${" ".repeat(rightGutter)}`;
}

export function registerPowerbar(pi: ExtensionAPI) {
	let currentCtx: ExtensionContext | undefined;
	const limitsByProvider = new Map<UsageProvider, LimitState>();
	let fast: OpenAIFastState = { enabled: false, eligible: false };
	const refreshInFlight = new Map<UsageProvider, Promise<void>>();
	const refreshControllers = new Map<UsageProvider, AbortController>();
	const usage = createUsageAccumulator();
	// Cleared on session_shutdown, so a render from a replaced instance paints nothing.
	let live = true;

	function getLimitState(provider: UsageProvider | undefined): LimitState {
		if (!provider) return { status: "idle", windows: [] };
		const existing = limitsByProvider.get(provider);
		if (existing) return existing;
		const cached = readCachedLimits(provider) ?? { status: "idle" as const, windows: [] };
		limitsByProvider.set(provider, cached);
		return cached;
	}

	// The powerbar owns the footer slot rather than a belowEditor widget so that no
	// built-in footer renders beneath it. It always renders exactly one line.
	function refresh() {
		const ctx = currentCtx;
		if (!ctx?.hasUI) return;
		// Resolved once per refresh (event-driven) so OAuth presence is not
		// re-read from disk on every footer paint.
		ctx.ui.setFooter((_tui, theme) => ({
			// A footer installed before a reload outlives it, and the ctx captured at
			// install time throws once the session is replaced: this render must never
			// take the process down, so it paints one empty line instead.
			render(width: number): string[] {
				if (!live) return [""];
				const current = currentCtx;
				if (!current) return [""];
				try {
					const provider = getUsageProvider(current);
					const totals = usage.consume(current);
					return [buildLine(pi, current, theme, width, provider, getLimitState(provider), fast, totals)];
				} catch {
					return [""];
				}
			},
			invalidate() {},
		}));
	}

	/** Called from timers too, where a throw would end the process: a ctx replaced by a reload just skips the refresh. */
	function scheduleLimitRefresh(ctx: ExtensionContext, force = false) {
		try { scheduleLimitRefreshOrThrow(ctx, force); } catch { /* stale ctx after a reload */ }
	}

	function scheduleLimitRefreshOrThrow(ctx: ExtensionContext, force = false) {
		const provider = getUsageProvider(ctx);
		if (!provider) return;
		if (isTruthyEnvFlag(process.env.PI_OFFLINE)) return;
		if (refreshInFlight.has(provider)) return;
		const limits = getLimitState(provider);
		const now = Date.now();
		if (limits.retryAt && now < limits.retryAt) return;
		if (!force && limits.fetchedAt && now - limits.fetchedAt < CACHE_TTL_MS) return;
		const loadingState = { ...limits, status: "loading" as const, retryAt: undefined };
		limitsByProvider.set(provider, loadingState);
		refresh();
		const fetcher = PLAN_FETCHERS[provider];
		const controller = new AbortController();
		refreshControllers.set(provider, controller);
		const refreshPromise = fetcher(ctx, controller.signal)
			.then((windows) => {
				limitsByProvider.set(provider, { status: "ready", windows, fetchedAt: Date.now() });
				writeCachedLimits(provider, { windows });
			})
			.catch((err) => {
				const failureAt = Date.now();
				const retryAt = getUsageFailureRetryAt(err, failureAt);
				limitsByProvider.set(provider, {
					...loadingState,
					status: "error",
					failureAt: retryAt === undefined ? undefined : failureAt,
					retryAt,
					error: "usage unavailable",
				});
			})
			.finally(() => {
				refreshInFlight.delete(provider);
				refreshControllers.delete(provider);
				refresh();
			});
		refreshInFlight.set(provider, refreshPromise);
	}

	pi.events.on(OPENAI_FAST_STATE_EVENT, (value: unknown) => {
		if (!value || typeof value !== "object") return;
		const candidate = value as Partial<OpenAIFastState>;
		if (typeof candidate.enabled !== "boolean" || typeof candidate.eligible !== "boolean") return;
		fast = {
			enabled: candidate.enabled,
			eligible: candidate.eligible,
			...(typeof candidate.provider === "string" ? { provider: candidate.provider } : {}),
			...(typeof candidate.modelId === "string" ? { modelId: candidate.modelId } : {}),
		};
		refresh();
	});

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		usage.reset();
		refresh();
		setTimeout(() => scheduleLimitRefresh(ctx), 0).unref?.();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// The instance is done: its footer must stop painting before the session it
		// was bound to is replaced, and a cleared footer is not this instance's to keep.
		live = false;
		try { if (ctx.hasUI) ctx.ui.setFooter(undefined); } catch { /* already replaced */ }
		for (const controller of refreshControllers.values()) controller.abort();
		refreshControllers.clear();
		usage.reset();
		currentCtx = undefined;
		fast = { enabled: false, eligible: false };
	});

	pi.on("model_select", async (_event, ctx) => {
		currentCtx = ctx;
		refresh();
		scheduleLimitRefresh(ctx);
	});

	for (const eventName of ["thinking_level_select", "message_end", "tool_result", "turn_end"] as const) {
		pi.on(eventName as any, async (_event: unknown, ctx: ExtensionContext) => {
			currentCtx = ctx;
			refresh();

			// Keep subscription limits fresh during active sessions without blocking UI.
			// scheduleLimitRefresh() is TTL-guarded by CACHE_TTL_MS and ignores in-flight fetches,
			// so calling it on common activity events is normally just a cheap freshness check.
			if (eventName === "message_end" || eventName === "turn_end") {
				scheduleLimitRefresh(ctx);
			}
		});
	}
}
