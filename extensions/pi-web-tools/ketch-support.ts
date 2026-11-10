export type ScrapeParams = {
	maxChars?: number;
	trim?: boolean;
	noCache?: boolean;
	select?: string;
	raw?: boolean;
	noLlmsTxt?: boolean;
	concurrency?: number;
	forceBrowser?: boolean;
};

export const DEFAULT_KETCH_MAX_CHARS = 30_000;

function clampNumber(value: unknown, defaultValue: number, min: number, max: number): number {
	const n = Number(value ?? defaultValue);
	if (!Number.isFinite(n)) return defaultValue;
	return Math.max(min, Math.min(max, n));
}

export function parseKetchWarnings(stderr: string): string[] {
	return [...new Set(stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

export function isTransientCodeSearchError(error: unknown): boolean {
	// A spawn failure is reported by errno, which is more reliable than the
	// message: runKetch prefers stderr text and only falls back to err.message.
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT" || code === "EACCES") return false;
	const message = error instanceof Error ? error.message : String(error);
	if (/\b429\b|rate limit|malformed\s+query|invalid\s+query|query\s+syntax|ENOENT|spawn ketch/i.test(message)) return false;
	return /\b(?:408|504)\b|gateway\s+timeout|timed?\s*out|timeout/i.test(message);
}

export function classifyKetchError(error: string): string {
	if (/^pi-web-tools requires (?:a recognized )?ketch/i.test(error)) return error;
	if (/api key not set|token not found|no token found/i.test(error)) return "A selected ketch backend is missing credentials on this machine.";
	if (/--force-browser requires a configured browser/i.test(error)) return "The Chromium retry requires a browser configured in Ketch. Run: ketch config set browser /path/to/chromium";
	if (/rate limited|\b429\b|connection reset/i.test(error)) return "The selected ketch backend was rate-limited or reset the connection; retry later or use the approved default backend.";
	if (/no elements matched selector/i.test(error)) return "The requested CSS selector matched no elements; retry without select or with a selector that exists on the page.";
	if (/HTTP\s*403|403 Forbidden/i.test(error)) {
		return "The site rejected Ketch's configured renderer path with HTTP 403. No further automatic retry is available.";
	}
	if (/aborted/i.test(error)) return "The ketch command was aborted before it completed.";
	return "ketch returned a non-zero exit for this request.";
}

export function buildScrapeArgs(urls: string[], params: ScrapeParams): string[] {
	const maxChars = clampNumber(params.maxChars, DEFAULT_KETCH_MAX_CHARS, 0, 1_000_000);
	const args = ["scrape", ...urls, "--max-chars", String(maxChars)];
	if (params.trim) args.push("--trim");
	if (params.noCache) args.push("--no-cache");
	if (params.select) args.push("--select", String(params.select));
	if (params.raw) args.push("--raw");
	if (params.noLlmsTxt) args.push("--no-llms-txt");
	if (params.concurrency !== undefined) args.push("--concurrency", String(clampNumber(params.concurrency, 5, 1, 50)));
	if (params.forceBrowser) args.push("--force-browser");
	return args;
}
