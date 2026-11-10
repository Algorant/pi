import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasChatGPTSignIn } from "../openai/model.ts";

export type RateWindow = {
	label: string;
	usedPercent: number;
	resetDescription?: string;
	resetAt?: string;
};

export type LimitState = {
	status: "idle" | "loading" | "ready" | "error";
	windows: RateWindow[];
	fetchedAt?: number;
	failureAt?: number;
	retryAt?: number;
	error?: string;
};

/** A money figure without a real limit denominator, e.g. spend or usage. */
export type MoneyLine = { label: string; text: string };
/** A meter that always means consumed (B1), carrying an explicit money detail. */
export type BalanceInfo = { usedPercent: number; detail: string };
/** Everything `/limits` renders for one provider. */
export type ProviderLimits = { windows: RateWindow[]; money?: MoneyLine[]; balance?: BalanceInfo };

export type UsageProvider = "openai-codex" | "anthropic" | "xai";

const CACHE_PATHS: Record<string, string> = {
	"openai-codex": join(homedir(), ".pi", "cache", "powerbar-codex-usage.json"),
	anthropic: join(homedir(), ".pi", "cache", "powerbar-anthropic-usage.json"),
	xai: join(homedir(), ".pi", "cache", "powerbar-xai-usage.json"),
	"opencode-go": join(homedir(), ".pi", "cache", "limits-opencode-go-usage.json"),
	openrouter: join(homedir(), ".pi", "cache", "limits-openrouter-usage.json"),
	baseten: join(homedir(), ".pi", "cache", "limits-baseten-usage.json"),
};
const LEGACY_CACHE_PATH = join(homedir(), ".pi", "cache", "powerbar-lite-codex-usage.json");
export const CACHE_TTL_MS = 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const API_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);
export const POWERBAR_METER_WIDTH = 12;

/** Resolves a provider credential through Pi, refreshing expired OAuth tokens. */
export type ProviderAuthSource = Pick<ExtensionContext["modelRegistry"], "getProviderAuth">;

export function getUsageProvider(ctx: Pick<ExtensionContext, "model">): UsageProvider | undefined {
	if (
		ctx.model?.provider === "openai-codex"
		|| ctx.model?.provider === "anthropic"
	) {
		return ctx.model.provider;
	}
	// Sign in with ChatGPT on `openai` draws on the same ChatGPT plan, but its
	// token is rejected by wham/usage (401 no_matching_rule) and its responses
	// carry no quota headers, so the plan meters come from the legacy login.
	if (ctx.model?.provider === "openai" && hasChatGPTSignIn() && hasUsageCredentials("openai-codex")) {
		return "openai-codex";
	}
	// xAI subscription meters exist only for Pi-managed OAuth. An account with
	// just an `XAI_API_KEY` is not a plan provider and must not show meters.
	if (ctx.model?.provider === "xai" && hasUsageCredentials("xai")) return "xai";
	return undefined;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
	return !!value && ["1", "true", "yes"].includes(value.toLowerCase());
}

function formatReset(date: Date): string {
	const diffMs = date.getTime() - Date.now();
	if (diffMs < 0) return "now";
	const diffMins = Math.floor(diffMs / 60_000);
	if (diffMins < 60) return `${diffMins}m`;
	const hours = Math.floor(diffMins / 60);
	const mins = diffMins % 60;
	if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function getWindowLabel(windowSeconds?: number, fallbackWindowSeconds?: number): string {
	const safeWindowSeconds =
		typeof windowSeconds === "number" && windowSeconds > 0
			? windowSeconds
			: typeof fallbackWindowSeconds === "number" && fallbackWindowSeconds > 0
				? fallbackWindowSeconds
				: 0;
	if (!safeWindowSeconds) return "0h";
	const windowHours = Math.round(safeWindowSeconds / 3600);
	if (windowHours >= 144) return "Week";
	if (windowHours >= 24) return "Day";
	return `${windowHours}h`;
}

function pushWindow(
	windows: RateWindow[],
	prefix: string | undefined,
	window: { reset_at?: number; limit_window_seconds?: number; used_percent?: number } | undefined,
	fallbackWindowSeconds?: number,
): void {
	if (!window) return;
	const resetDate = window.reset_at ? new Date(window.reset_at * 1000) : undefined;
	const label = getWindowLabel(window.limit_window_seconds, fallbackWindowSeconds);
	windows.push({
		label: prefix ? `${prefix} ${label}` : label,
		usedPercent: window.used_percent || 0,
		resetDescription: resetDate ? formatReset(resetDate) : undefined,
		resetAt: resetDate?.toISOString(),
	});
}

function addRateWindows(windows: RateWindow[], rateLimit: any, prefix?: string): void {
	pushWindow(windows, prefix, rateLimit?.primary_window, 10_800);
	pushWindow(windows, prefix, rateLimit?.secondary_window, 86_400);
}

function normalizeTokens(value: string): string[] {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

export function filterPowerbarWindows(windows: RateWindow[]): RateWindow[] {
	return windows.filter((window) => !normalizeTokens(window.label).includes("spark"));
}

function prioritizeModelWindows(windows: RateWindow[], modelId?: string): RateWindow[] {
	if (!modelId || windows.length <= 1) return windows;
	const modelTokens = normalizeTokens(modelId);
	if (modelTokens.length === 0) return windows;
	const matched: RateWindow[] = [];
	const rest: RateWindow[] = [];
	for (const window of windows) {
		const labelTokens = normalizeTokens(window.label);
		const exactMatch = modelTokens.every((token) => labelTokens.includes(token))
			&& modelTokens.length * 2 > labelTokens.length;
		// Anthropic's usage endpoint exposes family windows as just "Opus" or
		// "Sonnet", while model ids include the provider and version tokens.
		const familyMatch = !exactMatch
			&& labelTokens.length === 1
			&& labelTokens.some((token) => modelTokens.includes(token));
		(exactMatch || familyMatch ? matched : rest).push(window);
	}
	return matched.length === 0 || matched.length === windows.length ? windows : [...matched, ...rest];
}

/** Provider-wide 5h and Week always lead, then any per-model window. */
export function prioritizeWindowsForModel(windows: RateWindow[], modelId?: string): RateWindow[] {
	const ordered = prioritizeModelWindows(windows, modelId);
	const core = (["5h", "Week"] as const).flatMap((label) => ordered.filter((window) => window.label === label));
	return [...core, ...ordered.filter((window) => !core.includes(window))];
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

type CodexUsageCredential = { envAccessToken?: string; accountId?: string };

/**
 * An explicit env token overrides; otherwise the Pi-managed `openai-codex`
 * OAuth login is the credential. Its access token is resolved through Pi at
 * fetch time so an expired token is refreshed: with openai/* models in use,
 * inference no longer exercises (and refreshes) the legacy login.
 */
function loadCodexCredentials(): CodexUsageCredential | undefined {
	const envAccessToken = (
		process.env.OPENAI_CODEX_OAUTH_TOKEN ||
		process.env.OPENAI_CODEX_ACCESS_TOKEN ||
		process.env.CODEX_OAUTH_TOKEN ||
		process.env.CODEX_ACCESS_TOKEN
	)?.trim();
	const envAccountId = (process.env.OPENAI_CODEX_ACCOUNT_ID || process.env.CHATGPT_ACCOUNT_ID)?.trim();
	if (envAccessToken) return { envAccessToken, accountId: envAccountId || undefined };

	try {
		const authPath = join(getAgentDir(), "auth.json");
		if (!existsSync(authPath)) return undefined;
		const entry = JSON.parse(readFileSync(authPath, "utf8"))["openai-codex"];
		if (entry?.type !== "oauth") return undefined;
		return { accountId: typeof entry.accountId === "string" ? entry.accountId : undefined };
	} catch {
		// Ignore malformed auth files; the UI will show no credentials/error state.
		return undefined;
	}
}

function loadAnthropicCredentials(): { accessToken?: string } {
	const envAccessToken = (
		process.env.ANTHROPIC_OAUTH_TOKEN ||
		process.env.ANTHROPIC_ACCESS_TOKEN ||
		process.env.CLAUDE_CODE_OAUTH_TOKEN
	)?.trim();
	if (envAccessToken) return { accessToken: envAccessToken };

	try {
		const authPath = join(getAgentDir(), "auth.json");
		if (!existsSync(authPath)) return {};
		const data = JSON.parse(readFileSync(authPath, "utf8"));
		if (data.anthropic?.access) return { accessToken: data.anthropic.access };
	} catch {
		// Ignore malformed auth files; the UI will show no credentials/error state.
	}
	return {};
}

/**
 * Pi-managed xAI OAuth only. API-key auth (`auth.json` `xai.type=api_key` or an
 * `XAI_API_KEY` env var) is deliberately ignored so an api-key account never
 * selects the plan provider.
 */
function loadXaiCredentials(): { accessToken?: string } {
	try {
		const authPath = join(getAgentDir(), "auth.json");
		if (!existsSync(authPath)) return {};
		const data = JSON.parse(readFileSync(authPath, "utf8"));
		const entry = data.xai;
		if (entry?.type !== "oauth") return {};
		return typeof entry.access === "string" && entry.access ? { accessToken: entry.access } : {};
	} catch {
		// Ignore malformed auth files; the UI will show no credentials/error state.
	}
	return {};
}

/**
 * Configured-state detection must use the same credential source the provider's
 * fetch actually uses. Claude and Codex authenticate with OAuth access tokens,
 * so `getProviderAuth().apiKey` reports them as unconfigured.
 */
export function hasUsageCredentials(provider: UsageProvider): boolean {
	if (provider === "openai-codex") return !!loadCodexCredentials();
	if (provider === "anthropic") return !!loadAnthropicCredentials().accessToken;
	if (provider === "xai") return !!loadXaiCredentials().accessToken;
	return false;
}

/**
 * One provider-wide window by exact label ("Week": Anthropic seven_day, Codex
 * secondary window; "5h": Anthropic five_hour, Codex primary window) when the
 * reading still belongs to the current window, i.e. its reset is in the future.
 * A missing, unlabelled or already-reset reading is unknown and returns
 * undefined; per-model windows (Opus, Sonnet, Spark) are not considered.
 */
export function currentWindowUsage(windows: readonly RateWindow[], label: "Week" | "5h", now = Date.now()): { usedPercent: number; resetDescription: string } | undefined {
	const week = windows.find((window) => window.label === label);
	if (!week || typeof week.usedPercent !== "number" || !Number.isFinite(week.usedPercent) || !week.resetAt) return undefined;
	const resetAt = Date.parse(week.resetAt);
	if (!Number.isFinite(resetAt) || resetAt <= now) return undefined;
	return { usedPercent: week.usedPercent, resetDescription: formatReset(new Date(resetAt)) };
}

export function readCachedLimits(provider: string): (LimitState & Pick<ProviderLimits, "money" | "balance">) | undefined {
	try {
		const primaryPath = CACHE_PATHS[provider];
		const cachePath = existsSync(primaryPath)
			? primaryPath
			: provider === "openai-codex" ? LEGACY_CACHE_PATH : undefined;
		if (!cachePath || !existsSync(cachePath)) return undefined;
		const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
		if (!Array.isArray(parsed.windows)) return undefined;
		return {
			status: "ready",
			windows: parsed.windows,
			money: Array.isArray(parsed.money) ? parsed.money : undefined,
			balance: parsed.balance && typeof parsed.balance === "object" ? parsed.balance : undefined,
			fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : undefined,
		};
	} catch {
		return undefined;
	}
}

export function writeCachedLimits(provider: string, data: ProviderLimits): void {
	try {
		mkdirSync(join(homedir(), ".pi", "cache"), { recursive: true });
		const { windows, money, balance } = data;
		writeFileSync(CACHE_PATHS[provider], JSON.stringify({ fetchedAt: Date.now(), windows, money, balance }, null, 2) + "\n");
	} catch {
		// Cache failures should not affect the UI.
	}
}

class MissingUsageCredentialsError extends Error {
	constructor(provider: UsageProvider) {
		super(`no ${provider} credentials`);
		this.name = "MissingUsageCredentialsError";
	}
}

class UsageHttpError extends Error {
	readonly status: number;
	readonly retryAfterMs?: number;

	constructor(status: number, retryAfterMs?: number) {
		super(`HTTP ${status}`);
		this.name = "UsageHttpError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value.trim());
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function createUsageHttpError(response: Response): UsageHttpError {
	return new UsageHttpError(response.status, parseRetryAfter(response.headers.get("Retry-After")));
}

export function getUsageFailureRetryAt(error: unknown, failedAt = Date.now()): number | undefined {
	if (error instanceof MissingUsageCredentialsError) return undefined;
	if (error instanceof UsageHttpError && error.status === 429) {
		return failedAt + Math.max(RATE_LIMIT_BACKOFF_MS, error.retryAfterMs ?? 0);
	}
	return failedAt + FAILURE_BACKOFF_MS;
}

export async function fetchCodexLimits(auth: ProviderAuthSource, signal?: AbortSignal): Promise<RateWindow[]> {
	const credential = loadCodexCredentials();
	if (!credential) throw new MissingUsageCredentialsError("openai-codex");
	const accessToken = credential.envAccessToken ?? (await auth.getProviderAuth("openai-codex"))?.auth.apiKey;
	if (!accessToken) throw new MissingUsageCredentialsError("openai-codex");
	const { accountId } = credential;
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json",
		};
		if (accountId) headers["ChatGPT-Account-Id"] = accountId;
		const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
			headers,
			signal: controller.signal,
		});
		if (!res.ok) throw createUsageHttpError(res);
		const data = await res.json() as {
			rate_limit?: unknown;
			additional_rate_limits?: Array<{ limit_name?: string; metered_feature?: string; rate_limit?: unknown }>;
		};
		const windows: RateWindow[] = [];
		addRateWindows(windows, data.rate_limit);
		if (Array.isArray(data.additional_rate_limits)) {
			for (const entry of data.additional_rate_limits) {
				const prefix = typeof entry.limit_name === "string" && entry.limit_name.trim()
					? entry.limit_name.trim()
					: typeof entry.metered_feature === "string" && entry.metered_feature.trim()
						? entry.metered_feature.trim()
						: "Additional";
				addRateWindows(windows, entry.rate_limit, prefix);
			}
		}
		return windows;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

type AnthropicUsageWindow = {
	utilization?: number;
	resets_at?: string;
};

export type AnthropicUsageResponse = {
	five_hour?: AnthropicUsageWindow | null;
	seven_day?: AnthropicUsageWindow | null;
	seven_day_opus?: AnthropicUsageWindow | null;
	seven_day_sonnet?: AnthropicUsageWindow | null;
};

function addAnthropicWindow(windows: RateWindow[], label: string, value: AnthropicUsageWindow | null | undefined): void {
	if (!value || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return;
	const resetDate = typeof value.resets_at === "string" ? new Date(value.resets_at) : undefined;
	const hasReset = resetDate !== undefined && Number.isFinite(resetDate.getTime());
	windows.push({
		label,
		usedPercent: value.utilization,
		resetDescription: hasReset ? formatReset(resetDate) : undefined,
		resetAt: hasReset ? resetDate.toISOString() : undefined,
	});
}

export function mapAnthropicUsage(data: AnthropicUsageResponse): RateWindow[] {
	const windows: RateWindow[] = [];
	addAnthropicWindow(windows, "5h", data.five_hour);
	addAnthropicWindow(windows, "Week", data.seven_day);
	addAnthropicWindow(windows, "Opus", data.seven_day_opus);
	addAnthropicWindow(windows, "Sonnet", data.seven_day_sonnet);
	return windows;
}

function formatDuration(totalSeconds: number): string {
	if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
	const mins = Math.floor(totalSeconds / 60);
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	const remMin = mins % 60;
	if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	const remHours = hours % 24;
	return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function nonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Shared JSON fetch for api-key pay-as-you-go providers, with size/timeout/abort bounds. */
async function fetchProviderJson(ctx: ExtensionContext, provider: string, url: string, signal?: AbortSignal): Promise<any> {
	const auth = await ctx.modelRegistry.getProviderAuth(provider);
	const apiKey = auth?.auth?.apiKey;
	if (!apiKey) throw new Error(`no ${provider} credentials`);
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${apiKey}` };
		for (const [key, value] of Object.entries(auth?.auth?.headers ?? {})) {
			if (typeof value === "string") headers[key] = value;
		}
		const res = await fetch(url, { headers, redirect: "error", signal: controller.signal });
		if (!res.ok) throw createUsageHttpError(res);
		const text = await res.text();
		if (text.length > 1_000_000) throw new Error("response too large");
		return JSON.parse(text);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}

/**
 * OpenCode Go is not officially documented but `GET /opencode.ai/zen/go/v1/usage`
 * is live and key-authenticated (the same endpoint opencode-quota reads via the
 * API key). Response: `{ usage: { rolling|weekly|monthly: { status, percent, resetsAt } } }`.
 */
export function mapOpenCodeGoUsage(data: any, now = Date.now()): ProviderLimits {
	const usage = data?.usage;
	const windows: RateWindow[] = [];
	for (const [label, key] of [["5h", "rolling"], ["Week", "weekly"], ["Month", "monthly"]] as const) {
		const item = usage?.[key];
		if (!item || item.status !== "ok") continue;
		const percent = nonNegative(item.percent);
		if (percent === undefined) continue;
		const resetAt = typeof item.resetsAt === "string" ? Date.parse(item.resetsAt) : NaN;
		const remainingSec = Number.isFinite(resetAt) ? Math.max(0, Math.floor((resetAt - now) / 1000)) : undefined;
		windows.push({
			label,
			usedPercent: Math.min(100, percent),
			resetDescription: remainingSec !== undefined ? formatDuration(remainingSec) : undefined,
		});
	}
	return { windows };
}

/** Balance renders as consumed (B1): percent used of the limit. Spend renders as money. */
export function mapOpenRouterUsage(data: any): ProviderLimits {
	const d = data?.data ?? data;
	const limit = nonNegative(d?.limit);
	const remaining = nonNegative(d?.limit_remaining);
	const used = nonNegative(d?.usage);
	let balance: BalanceInfo | undefined;
	if (limit !== undefined && limit > 0 && remaining !== undefined) {
		const consumed = Math.max(0, limit - remaining);
		balance = { usedPercent: Math.min(100, (consumed / limit) * 100), detail: `$${consumed.toFixed(2)} of $${limit.toFixed(2)} used` };
	} else if (limit !== undefined && limit > 0 && used !== undefined) {
		balance = { usedPercent: Math.min(100, (used / limit) * 100), detail: `$${used.toFixed(2)} of $${limit.toFixed(2)} used` };
	}
	const parts: string[] = [];
	const daily = nonNegative(d?.usage_daily);
	const weekly = nonNegative(d?.usage_weekly);
	const monthly = nonNegative(d?.usage_monthly);
	if (daily !== undefined) parts.push(`$${daily.toFixed(2)} today`);
	if (weekly !== undefined) parts.push(`$${weekly.toFixed(2)} week`);
	if (monthly !== undefined) parts.push(`$${monthly.toFixed(2)} month`);
	return { windows: [], money: parts.length ? [{ label: "Spend", text: parts.join(" · ") }] : undefined, balance };
}

/** Baseten `/v1/billing/usage_summary`; shape not publicly schematized so read a numeric month total defensively. */
export function mapBasetenUsage(data: any): ProviderLimits {
	const month = data?.month ?? data?.current_month ?? data;
	const total = nonNegative(
		month?.total ?? data?.total_usage ?? data?.month_usage
		?? data?.model_apis_usage?.total ?? data?.dedicated_usage?.total ?? data?.training_usage?.total
		?? data?.usage,
	);
	return { windows: [], money: total !== undefined ? [{ label: "Month usage", text: `$${total.toFixed(2)}` }] : undefined };
}

export async function fetchOpenCodeGoLimits(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderLimits> {
	return mapOpenCodeGoUsage(await fetchProviderJson(ctx, "opencode-go", "https://opencode.ai/zen/go/v1/usage", signal));
}

export async function fetchOpenRouterLimits(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderLimits> {
	return mapOpenRouterUsage(await fetchProviderJson(ctx, "openrouter", "https://openrouter.ai/api/v1/key", signal));
}

export async function fetchBasetenLimits(ctx: ExtensionContext, signal?: AbortSignal): Promise<ProviderLimits> {
	return mapBasetenUsage(await fetchProviderJson(ctx, "baseten", "https://api.baseten.co/v1/billing/usage_summary", signal));
}

export type ClaudeVersionRunner = () => Promise<{ stdout: string }>;
export type ClaudeVersionFileReader = () => Promise<string | undefined>;

function parseClaudeCodeVersion(output: string): string | undefined {
	return output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/)?.[1];
}

const runClaudeVersion: ClaudeVersionRunner = async () => {
	return await execFileAsync("claude", ["--version"], {
		encoding: "utf8",
		timeout: 1000,
	}) as { stdout: string };
};

const readClaudeVersionFile: ClaudeVersionFileReader = async () => {
	try {
		const data = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8"));
		return typeof data.lastOnboardingVersion === "string" ? data.lastOnboardingVersion : undefined;
	} catch {
		return undefined;
	}
};

let cachedClaudeCodeVersion: string | undefined;
let claudeCodeVersionPromise: Promise<void> | undefined;
let claudeCodeVersionResolved = false;

export async function resolveClaudeCodeVersion(
	run: ClaudeVersionRunner = runClaudeVersion,
	readFallback: ClaudeVersionFileReader = readClaudeVersionFile,
): Promise<string | undefined> {
	try {
		const version = parseClaudeCodeVersion((await run()).stdout);
		if (version) {
			cachedClaudeCodeVersion = version;
			claudeCodeVersionResolved = true;
			return version;
		}
	} catch {
		// Fall through to the cheap local version file.
	}
	try {
		cachedClaudeCodeVersion = await readFallback();
	} catch {
		cachedClaudeCodeVersion = undefined;
	}
	claudeCodeVersionResolved = true;
	return cachedClaudeCodeVersion;
}

/** Test hook: forget the process-wide resolved version so the next call re-resolves. */
export function resetClaudeCodeVersionForTests(): void {
	cachedClaudeCodeVersion = undefined;
	claudeCodeVersionPromise = undefined;
	claudeCodeVersionResolved = false;
}

/**
 * Resolve once per process. Version lookup never rejects into the usage-fetch
 * error path: a failure degrades to `unknown` and must not trigger backoff.
 */
function ensureClaudeCodeVersion(): Promise<void> {
	if (claudeCodeVersionResolved) return Promise.resolve();
	if (!claudeCodeVersionPromise) {
		claudeCodeVersionPromise = resolveClaudeCodeVersion()
			.then(() => undefined)
			.catch(() => {
				cachedClaudeCodeVersion = undefined;
			});
	}
	return claudeCodeVersionPromise;
}

/**
 * Awaited rather than sync: a bad User-Agent lands in an aggressively
 * rate-limited bucket, so the very first request should not ship `unknown`
 * when a real version is cheaply available. Resolution is async and never
 * blocks the event loop.
 */
async function getAnthropicUserAgent(): Promise<string> {
	const configuredVersion = process.env.CLAUDE_CODE_VERSION?.trim();
	if (configuredVersion) return `claude-code/${configuredVersion}`;
	if (!cachedClaudeCodeVersion) await ensureClaudeCodeVersion();
	return `claude-code/${cachedClaudeCodeVersion || "unknown"}`;
}

export async function fetchAnthropicLimits(signal?: AbortSignal): Promise<RateWindow[]> {
	const { accessToken } = loadAnthropicCredentials();
	if (!accessToken) throw new MissingUsageCredentialsError("anthropic");
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
			method: "GET",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": await getAnthropicUserAgent(),
				"Content-Type": "application/json",
			},
			signal: controller.signal,
		});
		if (!res.ok) throw createUsageHttpError(res);
		return mapAnthropicUsage(await res.json() as AnthropicUsageResponse);
	} finally {
		clearTimeout(timeout);
	}
}

const XAI_CLI_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const XAI_CLI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_CLIENT_IDENTIFIER = "grok-shell";
const XAI_CLIENT_VERSION = "0.2.101";
const XAI_MAX_USER_ID_LENGTH = 256;
const XAI_USER_ID_PATTERN = /^[\x21-\x7e]+$/;

/** Headers the unofficial cli-chat-proxy expects from a Grok CLI client. */
function xaiProxyHeaders(accessToken: string, userId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		Accept: "application/json",
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-identifier": XAI_CLIENT_IDENTIFIER,
		"x-grok-client-version": XAI_CLIENT_VERSION,
		"x-grok-client-mode": "interactive",
	};
	if (userId) headers["x-userid"] = userId;
	return headers;
}

function parseXaiUserId(data: any): string {
	const userId = data?.userId;
	if (
		typeof userId !== "string"
		|| !userId
		|| userId.length > XAI_MAX_USER_ID_LENGTH
		|| !XAI_USER_ID_PATTERN.test(userId)
	) {
		throw new Error("invalid xAI user id");
	}
	return userId;
}

function centsValue(value: unknown): number | undefined {
	if (typeof value === "number") return nonNegative(value);
	if (value && typeof value === "object" && typeof (value as { val?: unknown }).val === "number") {
		return nonNegative((value as { val: number }).val);
	}
	return undefined;
}

function xaiPeriodLabel(type: unknown): string {
	const stem = typeof type === "string" ? type.replace(/^USAGE_PERIOD_TYPE_/i, "").toLowerCase() : "";
	if (stem.includes("week")) return "Week";
	if (stem.includes("month")) return "Month";
	if (stem.includes("day")) return "Day";
	if (stem.includes("hour") || stem.includes("five")) return "5h";
	return "Usage";
}

/**
 * Map the unofficial cli-chat-proxy `billing?format=credits` snapshot to at most
 * one window. The proxy reports a single current period (`USAGE_PERIOD_TYPE_WEEKLY`
 * or `..._MONTHLY`). Unified-billing snapshots may omit `creditUsagePercent`;
 * percent falls back to `used / monthlyLimit` when the limit is positive, then
 * to 0% when a current period is present. No second meter is synthesized.
 */
export function mapXaiUsage(data: any): RateWindow[] {
	const config = data?.config && typeof data.config === "object" ? data.config : data;
	if (!config || typeof config !== "object") return [];
	const percent = nonNegative(config.creditUsagePercent);
	const monthlyLimit = centsValue(config.monthlyLimit);
	const used = centsValue(config.used);
	const ratio = monthlyLimit !== undefined && monthlyLimit > 0 && used !== undefined
		? (used / monthlyLimit) * 100
		: undefined;
	const period = config.currentPeriod && typeof config.currentPeriod === "object" ? config.currentPeriod : undefined;
	const hasPeriod = !!period || typeof config.billingPeriodEnd === "string";
	const usedPercent = percent ?? ratio ?? (hasPeriod ? 0 : undefined);
	if (usedPercent === undefined) return [];
	const end = typeof period?.end === "string"
		? period.end
		: typeof config.billingPeriodEnd === "string" ? config.billingPeriodEnd : undefined;
	const resetDate = end ? new Date(end) : undefined;
	const hasReset = resetDate !== undefined && Number.isFinite(resetDate.getTime());
	return [{
		label: xaiPeriodLabel(period?.type),
		usedPercent: Math.min(100, usedPercent),
		resetDescription: hasReset ? formatReset(resetDate) : undefined,
		resetAt: hasReset ? resetDate.toISOString() : undefined,
	}];
}

export async function fetchXaiLimits(signal?: AbortSignal): Promise<RateWindow[]> {
	const { accessToken } = loadXaiCredentials();
	if (!accessToken) throw new MissingUsageCredentialsError("xai");
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
	try {
		const userRes = await fetch(XAI_CLI_USER_URL, {
			headers: xaiProxyHeaders(accessToken),
			redirect: "error",
			signal: controller.signal,
		});
		if (!userRes.ok) throw createUsageHttpError(userRes);
		const userId = parseXaiUserId(await userRes.json());
		const billingRes = await fetch(XAI_CLI_BILLING_URL, {
			headers: xaiProxyHeaders(accessToken, userId),
			redirect: "error",
			signal: controller.signal,
		});
		if (!billingRes.ok) throw createUsageHttpError(billingRes);
		return mapXaiUsage(await billingRes.json());
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", abort);
	}
}
