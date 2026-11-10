import {
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createWebToolsRenderer } from "../pi-ui/tool-ui/custom-tools/web-tools";
import {
	buildScrapeArgs,
	classifyKetchError,
	DEFAULT_KETCH_MAX_CHARS,
	parseKetchWarnings,
	isTransientCodeSearchError,
	type ScrapeParams,
} from "./ketch-support";
import { Type } from "typebox";
import { registerXBookmarks } from "./x-bookmarks/index.ts";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// General-purpose web and X access. Each tool family owns its backend: the search/fetch/code tools below
// use Ketch (installed and configured, e.g. the Brave key via `ketch config`); `x_bookmarks` lives in
// ./x-bookmarks and uses xurl (through fnox) plus the Obsidian CLI.

type StoredData = { id: string; type: "search" | "fetch" | "code"; timestamp: number; data: unknown };
type KetchSearchResult = { title?: string; url?: string; description?: string; snippet?: string; content?: string; markdown?: string; text?: string; fetchError?: string; [key: string]: unknown };
type KetchScrapeResult = { url?: string; title?: string; markdown?: string; content?: string; text?: string; error?: string; [key: string]: unknown };
type KetchCodeResult = { repo?: string; path?: string; url?: string; snippet?: string; language?: string; stars?: number; source?: string; [key: string]: unknown };
type KetchRunResult = { data: unknown; warnings: string[] };
type ToolContent = { type: "text"; text: string };
type KetchCredential = "brave";

const store = new Map<string, StoredData>();

class KetchCancelledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AbortError";
	}
}

const SEARCH_CONTENT_PREVIEW_CHARS = 8_000;
const STORED_PAGE_DEFAULT_CHARS = 80_000;
const STORED_PAGE_MAX_CHARS = 200_000;
const CODE_SEARCH_MAX_ATTEMPTS = 3;
const CODE_SEARCH_RETRY_DELAY_MS = 300;

const KETCH_CREDENTIALS: Record<KetchCredential, { label: string; configKey: string; env: string[]; setCommand: string }> = {
	brave: {
		label: "Brave Search API key",
		configKey: "brave_api_key",
		env: ["BRAVE_API_KEY", "KETCH_BRAVE_API_KEY"],
		setCommand: "ketch config set brave_api_key <key>",
	},
};

function id(): string {
	return Math.random().toString(36).slice(2, 10);
}

function normalizeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

function readKetchConfig(): Record<string, unknown> {
	const configPath = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ketch", "config.json");
	try {
		if (!existsSync(configPath)) return {};
		const parsed = JSON.parse(readFileSync(configPath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
	} catch {
		return {};
	}
}

function credentialSource(name: KetchCredential): string | undefined {
	const spec = KETCH_CREDENTIALS[name];
	const envName = spec.env.find((key) => Boolean(process.env[key]?.trim()));
	if (envName) return `environment variable ${envName}`;
	const value = readKetchConfig()[spec.configKey];
	return typeof value === "string" && value.trim() ? "ketch config file" : undefined;
}

function credentialDiagnostic(names: KetchCredential[]): string {
	const lines = ["Ketch credential check:"];
	for (const name of names) {
		const spec = KETCH_CREDENTIALS[name];
		const source = credentialSource(name);
		lines.push(source
			? `- ${spec.label}: configured via ${source}.`
			: `- ${spec.label}: missing. Set it with: ${spec.setCommand}`);
	}
	return lines.join("\n");
}

function fetchContentParameters() {
	return Type.Object({
		url: Type.Optional(Type.String()),
		urls: Type.Optional(Type.Array(Type.String())),
		maxChars: Type.Optional(Type.Number()),
		trim: Type.Optional(Type.Boolean()),
		noCache: Type.Optional(Type.Boolean()),
		select: Type.Optional(Type.String()),
		raw: Type.Optional(Type.Boolean({ description: "Return raw HTML instead of markdown." })),
		noLlmsTxt: Type.Optional(Type.Boolean({ description: "Disable automatic /llms.txt detection for bare domains." })),
		concurrency: Type.Optional(Type.Number({ description: "Maximum concurrent requests for multiple URLs. Defaults to ketch's setting." })),
	});
}


async function runKetch(args: string[], signal?: AbortSignal, timeoutMs = 45_000): Promise<KetchRunResult> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const child = execFile("ketch", [...args, "--json"], {
			timeout: timeoutMs,
			maxBuffer: 10 * 1024 * 1024,
		}, (err, stdout, stderr) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			if (err) {
				const msg = stderr?.trim() || stdout?.trim() || err.message;
				const failure = new Error(msg);
				Object.assign(failure, { code: (err as NodeJS.ErrnoException).code });
				reject(signal?.aborted ? new KetchCancelledError("ketch command cancelled") : failure);
				return;
			}
			const text = stdout.trim();
			const warnings = parseKetchWarnings(stderr || "");
			if (!text) {
				resolve({ data: null, warnings });
				return;
			}
			try {
				resolve({ data: JSON.parse(text), warnings });
			} catch {
				resolve({ data: text, warnings });
			}
		});

		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			signal?.removeEventListener("abort", abort);
			reject(new KetchCancelledError("ketch command cancelled"));
		};
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function waitForCodeSearchRetry(signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, CODE_SEARCH_RETRY_DELAY_MS);
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new KetchCancelledError("ketch command cancelled"));
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

async function runCodeSearch(args: string[], signal?: AbortSignal, onUpdate?: (attempt: number) => void): Promise<KetchRunResult> {
	for (let attempt = 1; attempt <= CODE_SEARCH_MAX_ATTEMPTS; attempt++) {
		try {
			return await runKetch(args, signal);
		} catch (error) {
			if (isCancellation(error) || attempt === CODE_SEARCH_MAX_ATTEMPTS || !isTransientCodeSearchError(error)) throw error;
			onUpdate?.(attempt + 1);
			await waitForCodeSearchRetry(signal);
		}
	}
	throw new Error("unreachable");
}

function asArray<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (value == null) return [];
	return [value as T];
}

function storedText(data: unknown): string {
	return typeof data === "string" ? data : JSON.stringify(data, null, 2);
}

// `stored` names the stored copy a truncated display can be paged from; offsets count characters of its JSON text.
function resultText(value: unknown, maxChars = DEFAULT_KETCH_MAX_CHARS, stored?: { id: string; data: unknown }): string {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	if (text.length <= maxChars) return text;
	const notice = stored
		? `the full stored result is JSON text of ${storedText(stored.data).length} characters; offsets count its characters. Read it with get_search_content {"responseId":"${stored.id}","offset":0}`
		: "no stored copy";
	return `${text.slice(0, maxChars)}\n\n[display truncated at ${maxChars} of ${text.length} characters; ${notice}]`;
}

function pageStoredText(item: StoredData, offset: number, maxChars: number): { text: string; details: Record<string, unknown> } {
	const full = storedText(item.data);
	const total = full.length;
	if (offset > 0 && offset >= total) throw new Error(`get_search_content failed: offset ${offset} is at or past the end of ${item.id} (${total} characters)`);
	let end = Math.min(total, offset + maxChars);
	if (end < total && end - 1 > offset) {
		const last = full.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
	}
	const nextOffset = end < total ? end : undefined;
	let text = full.slice(offset, end);
	if (offset > 0 || nextOffset !== undefined) {
		const span = `JSON text characters ${offset}-${end} of ${total}`;
		const sizeArg = maxChars === STORED_PAGE_DEFAULT_CHARS ? "" : `,"maxChars":${maxChars}`;
		text += nextOffset !== undefined
			? `\n\n[stored ${item.id}: ${span}; next: get_search_content {"responseId":"${item.id}","offset":${nextOffset}${sizeArg}}]`
			: `\n\n[stored ${item.id}: ${span}; end of stored result]`;
	}
	return { text, details: { id: item.id, type: item.type, timestamp: item.timestamp, offset, end, total, ...(nextOffset !== undefined ? { nextOffset } : {}) } };
}

function previewText(text: string, maxChars = SEARCH_CONTENT_PREVIEW_CHARS): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return `${trimmed.slice(0, maxChars)}\n\n[content preview truncated at ${maxChars} of ${trimmed.length} characters; the stored result id is in the "Stored as" line; read it with get_search_content responseId, offset and maxChars]`;
}

function searchResultBody(r: KetchSearchResult): string {
	return String(r.content || r.markdown || r.text || "");
}

function withKetchWarnings(text: string, warnings: string[]): string {
	if (!warnings.length) return text;
	return `${text}\n\n---\n\n**Ketch warnings:**\n${warnings.map(warning => `- ${warning}`).join("\n")}`;
}

function scrapeResultBody(item: KetchScrapeResult): string {
	return String(item.markdown || item.content || item.text || item.error || "");
}

function formatSearch(query: string, data: unknown): string {
	const results = asArray<KetchSearchResult>(data);
	let out = `## Query: ${JSON.stringify(query)} (ketch)\n`;
	if (!results.length) return `${out}\nNo results.`;
	out += results.map((r, i) => {
		const title = r.title || r.url || `Result ${i + 1}`;
		const url = r.url || "";
		const snippet = r.description || r.snippet || "";
		const body = searchResultBody(r);
		let text = `${i + 1}. ${title}\n   ${url}`;
		if (snippet) text += `\n   ${snippet}`;
		if (r.fetchError) text += `\n   fetch warning: ${r.fetchError}`;
		if (body) text += `\n   content:\n${previewText(body)}`;
		return text.trimEnd();
	}).join("\n\n");
	out += "\n\n---\n\n**Sources:**\n" + results.map((r, i) => `${i + 1}. ${r.title || r.url || `Result ${i + 1}`}\n   ${r.url || ""}`).join("\n\n");
	return out;
}

function formatScrape(data: unknown): string {
	const items = asArray<KetchScrapeResult>(data);
	if (!items.length) return resultText(data);
	return items.map(item => {
		const title = item.title || item.url || "Fetched Content";
		const body = scrapeResultBody(item);
		return `# ${title}\n${item.url || ""}\n\n${body}`.trim();
	}).join("\n\n---\n\n");
}

function formatCode(query: string, data: unknown): string {
	const results = asArray<KetchCodeResult>(data);
	let out = `## Code search: ${JSON.stringify(query)} (ketch)\n`;
	if (!results.length) return `${out}\nNo results.`;
	out += results.map((r, i) => `${i + 1}. ${r.repo || r.url || "result"}${r.path ? ` — ${r.path}` : ""}${r.language ? ` (${r.language})` : ""}\n   ${r.url || ""}\n   ${(r.snippet || "").trim()}`).join("\n\n");
	return out;
}

async function attachFirstSearchResultContent(data: unknown, params: ScrapeParams, signal?: AbortSignal): Promise<string[]> {
	const first = asArray<KetchSearchResult>(data)[0];
	if (!first?.url || searchResultBody(first)) return [];
	try {
		const result = await runKetch(buildScrapeArgs([first.url], params), signal);
		const item = asArray<KetchScrapeResult>(result.data)[0];
		const body = item ? scrapeResultBody(item) : "";
		if (body) first.content = body;
		return result.warnings;
	} catch (err) {
		if (isCancellation(err)) throw err;
		first.fetchError = normalizeError(err);
		return [`Failed to fetch ${first.url}: ${first.fetchError}`];
	}
}

function isCancellation(error: unknown): boolean {
	return error instanceof KetchCancelledError || (error instanceof Error && error.name === "AbortError");
}

function ketchCancellationResult(toolName: string, err: unknown): { content: ToolContent[]; details: Record<string, unknown>; cancelled: true } {
	const error = normalizeError(err);
	return {
		content: [{ type: "text", text: `${toolName} cancelled.\n${error}` }],
		details: { toolName, error, cancelled: true },
		cancelled: true,
	};
}

function ketchFailureResult(toolName: string, err: unknown, credentials: KetchCredential[] = []): never {
	const error = normalizeError(err);
	const diagnostic = credentials.length ? `${credentialDiagnostic(credentials)}\n\n` : "";
	const category = classifyKetchError(error);
	throw new Error(`${diagnostic}${toolName} failed.\n${category}\n\nError: ${error}`);
}

function ketchErrorResult(toolName: string, err: unknown, credentials: KetchCredential[] = []): { content: ToolContent[]; details: Record<string, unknown>; cancelled: true } {
	if (isCancellation(err)) return ketchCancellationResult(toolName, err);
	return ketchFailureResult(toolName, err, credentials);
}

export default function piWebTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		exposure: "codemode",
		label: "Web Search",
		description: "Search the web through local ketch using Brave. Default: one query and 5 results. Returns source citations.",
		promptSnippet: "Use web_search for current web research or source discovery. Start with one query and the default 5 results. Do not set includeContent for a lookup: it scrapes every result page and can be slow and large. Use fetchResult for one page, or fetch_content for a known URL. Use queries:[...] only for genuinely independent searches. For extensive multi-angle research, use one background Pi research Subagent; keep one-shot searches direct.",

		parameters: Type.Object({
			query: Type.Optional(Type.String()),
			queries: Type.Optional(Type.Array(Type.String())),
			numResults: Type.Optional(Type.Number({ description: "Results per query. Defaults to 5; clamped to 1-20. Keep small for lookup." })),
			includeContent: Type.Optional(Type.Boolean({ description: "Expensive: scrape every returned result page. Usually leave false; use fetchResult or fetch_content for one page." })),
			fetchResult: Type.Optional(Type.Boolean({ description: "Fetch markdown for only the first result. Lower-cost alternative to includeContent." })),
			trim: Type.Optional(Type.Boolean({ description: "Strip markdown formatting from scraped result content." })),
		}),
		...createWebToolsRenderer("web_search"),
		async execute(_toolCallId, params, signal, onUpdate) {
			const queries = Array.isArray(params.queries) ? params.queries : (params.query ? [params.query] : []);
			const queryList = queries.map(String).map(q => q.trim()).filter(Boolean);
			if (!queryList.length) throw new Error("web_search validation error: provide query or queries.");
			try {
				const limit = Math.max(1, Math.min(20, Number(params.numResults || 5)));
				const outputs: string[] = [];
				const details: Array<{ query: string; data: unknown; warnings: string[] }> = [];
				for (let i = 0; i < queryList.length; i++) {
					onUpdate?.({ content: [{ type: "text", text: `ketch search ${i + 1}/${queryList.length}: ${queryList[i]}` }], details: { progress: i / queryList.length } });
					const args = ["search", queryList[i], "--backend", "brave", "--limit", String(limit), "--max-chars", String(DEFAULT_KETCH_MAX_CHARS)];
					if (params.includeContent) args.push("--scrape");
					if (params.trim) args.push("--trim");
					const result = await runKetch(args, signal);
					const data = result.data;
					const warnings = [...result.warnings];
					if (params.fetchResult && !params.includeContent) {
						onUpdate?.({ content: [{ type: "text", text: `ketch scrape first result for: ${queryList[i]}` }], details: { progress: (i + 0.5) / queryList.length } });
						warnings.push(...await attachFirstSearchResultContent(data, {
							maxChars: DEFAULT_KETCH_MAX_CHARS,
							trim: params.trim,
						}, signal));
					}
					details.push({ query: queryList[i], data, warnings });
					outputs.push(withKetchWarnings(formatSearch(queryList[i], data), warnings));
				}
				const searchId = id();
				const warnings = details.flatMap(item => item.warnings);
				store.set(searchId, { id: searchId, type: "search", timestamp: Date.now(), data: details });
				const text = `${outputs.join("\n\n---\n\n")}\n\n---\nStored as [${searchId}].`;
				return { content: [{ type: "text", text: resultText(text, 80_000, { id: searchId, data: details }) }], details: { searchId, queries: queryList, results: details, warnings } };
			} catch (err) {
				return ketchErrorResult("web_search", err, ["brave"]);
			}
		},
	});

	pi.registerTool({
		name: "fetch_content",
		exposure: "codemode",
		label: "Fetch Content",
		description: "Fetch URL(s) and extract clean markdown using the local ketch scrape command. Ketch manages direct HTTP and its configured Obscura renderer.",
		promptSnippet: "Use fetch_content to retrieve readable markdown/text from URL(s) via ketch scrape.",
		promptGuidelines: [
			"Prefer fetch_content over bash/curl for web pages; it returns cleaned markdown for agent context.",
		],
		parameters: fetchContentParameters(),
		...createWebToolsRenderer("fetch_content"),
		async execute(_toolCallId, params, signal, onUpdate) {
			const urls = Array.isArray(params.urls) ? params.urls : (params.url ? [params.url] : []);
			const urlList = urls.map(String).map(u => u.trim()).filter(Boolean);
			if (!urlList.length) throw new Error("fetch_content validation error: provide url or urls.");
			try {
				onUpdate?.({ content: [{ type: "text", text: `ketch scrape ${urlList.length} URL(s)` }], details: { progress: 0.1 } });
				const result = await runKetch(buildScrapeArgs(urlList, params), signal);
				const fetchId = id();
				store.set(fetchId, { id: fetchId, type: "fetch", timestamp: Date.now(), data: result.data });
				const text = withKetchWarnings(formatScrape(result.data), result.warnings);
				return { content: [{ type: "text", text: `${resultText(text, 80_000, { id: fetchId, data: result.data })}\n\n---\nStored as [${fetchId}].` }], details: { fetchId, urls: urlList, results: result.data, warnings: result.warnings } };
			} catch (err) {
				return ketchErrorResult("fetch_content", err);
			}
		},
	});

	pi.registerTool({
		name: "code_search",
		exposure: "codemode",
		label: "Code Search",
		description: "Search open-source code through ketch. The backend is selected by Ketch configuration or its runtime default; this tool does not force one. Current Ketch defaults to grepapp when unset. Default limit: 5, clamped to 1-20.",
		promptSnippet: "Use code_search for examples, API usage, and implementation references in public code; prefer short queries.",
		parameters: Type.Object({
			query: Type.String(),
			limit: Type.Optional(Type.Number({ description: "Results to return. Defaults to 5; clamped to 1-20." })),
			lang: Type.Optional(Type.String({ description: "Optional language filter." })),
			regex: Type.Optional(Type.Boolean({ description: "Interpret query as a regular expression when the backend supports it." })),
		}),
		...createWebToolsRenderer("code_search"),
		async execute(_toolCallId, params, signal, onUpdate) {
			try {
				onUpdate?.({ content: [{ type: "text", text: `ketch code: ${params.query}` }], details: { progress: 0.2 } });
				const args = ["code", String(params.query), "--limit", String(Math.max(1, Math.min(20, Number(params.limit || 5))))];
				if (params.lang) args.push("--lang", String(params.lang));
				if (params.regex) args.push("--regex");
				const result = await runCodeSearch(args, signal, (attempt) => {
					onUpdate?.({ content: [{ type: "text", text: `ketch code: ${params.query} (retrying, attempt ${attempt}/${CODE_SEARCH_MAX_ATTEMPTS})` }], details: { progress: 0.2 } });
				});
				const codeId = id();
				store.set(codeId, { id: codeId, type: "code", timestamp: Date.now(), data: result.data });
				const text = withKetchWarnings(formatCode(String(params.query), result.data), result.warnings);
				return { content: [{ type: "text", text: `${text}\n\n---\nStored as [${codeId}].` }], details: { codeId, results: result.data, warnings: result.warnings } };
			} catch (err) {
				return ketchErrorResult("code_search", err);
			}
		},
	});

	pi.registerTool({
		name: "get_search_content",
		exposure: "codemode",
		label: "Get Stored Web Content",
		description: `Retrieve stored content from a previous web_search, fetch_content, or code_search call by id. Returns up to ${STORED_PAGE_DEFAULT_CHARS} characters of the stored result's JSON text per call; page through longer results with offset.`,
		promptSnippet: "Use get_search_content with a stored id to retrieve previous web search, fetch, or code content. For a long result, repeat the call with the offset given in its trailing notice.",
		parameters: Type.Object({
			responseId: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the stored result's JSON text. Defaults to 0; use the next offset from the previous page's notice." })),
			maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: STORED_PAGE_MAX_CHARS, description: `Characters to return. Defaults to ${STORED_PAGE_DEFAULT_CHARS}; maximum ${STORED_PAGE_MAX_CHARS}.` })),
		}),
		...createWebToolsRenderer("get_search_content"),
		async execute(_toolCallId, params) {
			const item = store.get(String(params.responseId));
			if (!item) throw new Error(`get_search_content failed: No stored content found for ${params.responseId}`);
			const page = pageStoredText(item, params.offset ?? 0, params.maxChars ?? STORED_PAGE_DEFAULT_CHARS);
			return { content: [{ type: "text", text: page.text }], details: page.details };
		},
	});

	registerXBookmarks(pi);
}
