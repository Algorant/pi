import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BalanceInfo, MoneyLine, ProviderLimits, RateWindow, UsageProvider } from "./quota-service.ts";
import { CACHE_TTL_MS, fetchAnthropicLimits, fetchBasetenLimits, fetchCodexLimits, fetchOpenCodeGoLimits, fetchOpenRouterLimits, fetchXaiLimits, filterPowerbarWindows, hasUsageCredentials, readCachedLimits, writeCachedLimits } from "./quota-service.ts";

export { CACHE_TTL_MS };
export * from "./quota-service.ts";

export const PLAN_PROVIDERS = ["openai-codex", "xai", "anthropic"] as const;
export const API_PROVIDERS = ["opencode-go", "openrouter", "baseten"] as const;
export type LimitsProvider = (typeof PLAN_PROVIDERS)[number] | (typeof API_PROVIDERS)[number];
export const LIMITS_PROVIDERS: readonly LimitsProvider[] = [...PLAN_PROVIDERS, ...API_PROVIDERS];

const planSet = new Set<string>(PLAN_PROVIDERS);

export const LABELS: Record<LimitsProvider, string> = {
  anthropic: "Anthropic Claude",
  "openai-codex": "OpenAI Codex",
  xai: "xAI Grok",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  baseten: "Baseten",
};


export type ProviderView = {
  provider: LimitsProvider;
  status: "loading" | "ready" | "error";
  windows: RateWindow[];
  money?: MoneyLine[];
  balance?: BalanceInfo;
  fetchedAt?: number;
};

/** The credential source differs by provider kind: plan tokens vs registry API keys. */
export function providerConfigured(provider: LimitsProvider, ctx: ExtensionCommandContext): boolean {
  return planSet.has(provider)
    ? hasUsageCredentials(provider as UsageProvider)
    : ctx.modelRegistry.getProviderAuthStatus(provider)?.configured === true;
}

export function buildFetchers(ctx: ExtensionCommandContext): Partial<Record<LimitsProvider, (signal?: AbortSignal) => Promise<ProviderLimits | RateWindow[]>>> {
  return {
    anthropic: fetchAnthropicLimits,
    "openai-codex": (signal) => fetchCodexLimits(ctx.modelRegistry, signal),
    xai: fetchXaiLimits,
    "opencode-go": (signal) => fetchOpenCodeGoLimits(ctx, signal),
    openrouter: (signal) => fetchOpenRouterLimits(ctx, signal),
    baseten: (signal) => fetchBasetenLimits(ctx, signal),
  };
}

/**
 * Owns provider state and refresh. Fetchers are injected so tests exercise
 * partial failure, cancellation, and stale display without network access.
 */
export class LimitsController {
  private readonly views = new Map<LimitsProvider, ProviderView>();
  private readonly controllers = new Map<LimitsProvider, AbortController>();
  readonly configured: LimitsProvider[];

  constructor(
    private readonly onChange: () => void,
    private readonly deps: {
      hasCredentials?: (provider: LimitsProvider) => boolean;
      readCache?: (provider: LimitsProvider) => (Partial<ProviderLimits> & { fetchedAt?: number }) | undefined;
      writeCache?: (provider: LimitsProvider, data: ProviderLimits) => void;
      fetchers?: Partial<Record<LimitsProvider, (signal?: AbortSignal) => Promise<ProviderLimits | RateWindow[]>>>;
      now?: () => number;
    } = {},
  ) {
    const hasCredentials = deps.hasCredentials ?? ((provider: LimitsProvider) => hasUsageCredentials(provider as UsageProvider));
    const readCache = deps.readCache ?? readCachedLimits;
    this.configured = LIMITS_PROVIDERS.filter((provider) => hasCredentials(provider));
    for (const provider of this.configured) {
      const cached = readCache(provider);
      this.views.set(provider, {
        provider,
        status: "loading",
        windows: cached?.windows ?? [],
        money: cached?.money ?? [],
        balance: cached?.balance,
        fetchedAt: cached?.fetchedAt,
      });
    }
  }

  snapshot(): ProviderView[] {
    return this.configured.map((provider) => this.views.get(provider)!);
  }

  abort(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  /** Every provider is independent: one failure or hang never blocks another. */
  async refresh(): Promise<void> {
    this.abort();
    const writeCache = this.deps.writeCache ?? writeCachedLimits;
    const now = this.deps.now ?? Date.now;
    await Promise.all(this.configured.map(async (provider) => {
      const previous = this.views.get(provider)!;
      const controller = new AbortController();
      this.controllers.set(provider, controller);
      this.views.set(provider, { ...previous, status: "loading" });
      this.onChange();
      try {
        const fetcher = this.deps.fetchers?.[provider];
        if (!fetcher) throw new Error(`no fetcher for ${provider}`);
        // Codex Spark windows are omitted for the same reason as in the powerbar.
        const raw = await fetcher(controller.signal);
        const { windows, money, balance } = Array.isArray(raw)
          ? { windows: filterPowerbarWindows(raw), money: [], balance: undefined }
          : { windows: filterPowerbarWindows(raw.windows), money: raw.money ?? [], balance: raw.balance };
        if (controller.signal.aborted) return;
        this.views.set(provider, { provider, status: "ready", windows, money, balance, fetchedAt: now() });
        writeCache(provider, { windows, money, balance });
      } catch {
        if (!controller.signal.aborted) this.views.set(provider, { ...previous, status: "error" });
      } finally {
        this.controllers.delete(provider);
        this.onChange();
      }
    }));
  }
}

