import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { RenderCache, renderCached } from "../core/render-cache";

type KetchSearchResult = { title?: string; url?: string; description?: string; snippet?: string; content?: string; markdown?: string; text?: string; [key: string]: unknown };
type KetchScrapeResult = { url?: string; title?: string; markdown?: string; content?: string; text?: string; error?: string; [key: string]: unknown };
type KetchCodeResult = { repo?: string; path?: string; url?: string; snippet?: string; language?: string; stars?: number; source?: string; [key: string]: unknown };

function asArray<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (value == null) return [];
	return [value as T];
}

function searchResultBody(r: KetchSearchResult): string {
	return String(r.content || r.markdown || r.text || "");
}

function scrapeResultBody(item: KetchScrapeResult): string {
	return String(item.markdown || item.content || item.text || item.error || "");
}

export type KetchToolKind = "web_search" | "fetch_content" | "code_search" | "get_search_content";

type KetchRenderState = {
	kind?: KetchToolKind;
	args?: any;
	result?: AgentToolResult<any>;
	options?: ToolRenderResultOptions;
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	executionStarted?: boolean;
};

type CardWriter = {
	addLine(text?: string): void;
	addWrapped(text: string, indent?: string, maxLines?: number): void;
	section(title: string): void;
};

const EMPTY_COMPONENT: Component = {
	render: () => [],
	invalidate: () => {},
};

export function createWebToolsRenderer(kind: KetchToolKind) {
	return {
		renderShell: "self" as const,
		renderCall(args: any, theme: Theme, context: any): Component {
			context.state.kind = kind;
			context.state.args = args;
			context.state.expanded = context.expanded;
			context.state.isPartial = context.isPartial;
			context.state.isError = context.isError || hasErrorDetails(context.state.result?.details);
			context.state.executionStarted = context.executionStarted;
			return new KetchToolCard(context.state, theme);
		},
		renderResult(result: AgentToolResult<any>, options: ToolRenderResultOptions, _theme: Theme, context: any): Component {
			context.state.kind = kind;
			context.state.result = result;
			context.state.options = options;
			context.state.expanded = options.expanded;
			context.state.isPartial = options.isPartial;
			context.state.isError = context.isError || hasErrorDetails(result.details);
			return EMPTY_COMPONENT;
		},
	};
}

class KetchToolCard implements Component {
	private readonly cache = new RenderCache();

	constructor(private state: KetchRenderState, private theme: Theme) {}

	/** Pi's signal that cached output is stale, for example after a theme change. */
	invalidate(): void {
		this.cache.clear();
	}

	render(width: number): string[] {
		// The renderer state object is mutated in place by renderResult, so the
		// cache also compares the identity of every state field the card reads.
		return renderCached(this.cache, width, this.theme, (w) => this.buildLines(w), [
			this.state.kind,
			this.state.args,
			this.state.result,
			this.state.options,
			this.state.expanded,
			this.state.isPartial,
			this.state.isError,
			this.state.executionStarted,
		]);
	}

	private buildLines(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const details = detailsRecord(this.state.result);
		const expanded = Boolean(this.state.options?.expanded ?? this.state.expanded);
		const partial = Boolean(this.state.options?.isPartial ?? this.state.isPartial ?? !this.state.result);
		const error = Boolean(this.state.isError || hasErrorDetails(details));
		const cancelled = isCancelledDetails(details);
		const warning = isWarningDetails(details);
		const label = toolLabel(this.state.kind);
		const status = error
			? this.theme.fg("error", "✗")
			: warning
				? this.theme.fg("warning", "⚠")
				: partial
					? this.theme.fg("accent", "…")
					: this.theme.fg("success", "✓");

		if (!expanded) {
			const metadata = headerMetadata(this.state.kind, details, this.state.args, partial);
			const title = `${status} ${this.theme.fg("accent", this.theme.bold(label))}${metadata ? this.theme.fg("dim", ` · ${metadata}`) : ""}`;
			return [truncateToWidth(title, safeWidth, "…", true)];
		}

		if (safeWidth < 24) {
			return [truncateToWidth(`${status} ${label}`, safeWidth, "…")];
		}

		const borderColor = (s: string) => this.theme.fg(error ? "error" : "borderMuted", s);
		const headerMeta = headerMetadata(this.state.kind, details, this.state.args, partial);
		const title = `${status} ${this.theme.fg("accent", this.theme.bold(label))}${headerMeta ? this.theme.fg("dim", ` · ${headerMeta}`) : ""}`;
		const lines: string[] = [topBorder(title, safeWidth, borderColor)];
		const contentWidth = Math.max(1, safeWidth - 4);

		const addLine = (text = "") => {
			const content = truncateToWidth(text, contentWidth, "…", true);
			lines.push(borderColor("│ ") + content + borderColor(" │"));
		};
		const addWrapped = (text: string, indent = "", maxLines?: number) => {
			const wrapWidth = Math.max(1, contentWidth - visibleWidth(indent));
			const wrapped = wrapTextWithAnsi(text, wrapWidth);
			const shown = maxLines === undefined ? wrapped : wrapped.slice(0, maxLines);
			for (const line of shown) addLine(indent + line);
			if (maxLines !== undefined && wrapped.length > maxLines) addLine(indent + this.theme.fg("dim", "…"));
		};
		const section = (titleText: string) => {
			const label = truncateToWidth(this.theme.fg("muted", ` ${titleText} `), Math.max(1, safeWidth - 3), "…");
			const fill = Math.max(0, safeWidth - 3 - visibleWidth(label));
			lines.push(borderColor("├─") + label + borderColor(`${"─".repeat(fill)}┤`));
		};
		const writer: CardWriter = { addLine, addWrapped, section };

		if (error) {
			this.renderError(writer);
		} else if (cancelled) {
			this.renderCancellation(writer);
		} else {
			switch (this.state.kind) {
				case "web_search":
					this.renderWebSearch(writer, expanded, partial);
					break;
				case "fetch_content":
					this.renderFetchContent(writer, expanded, partial);
					break;
				case "code_search":
					this.renderCodeSearch(writer, expanded, partial);
					break;
				case "get_search_content":
					this.renderStoredContent(writer, expanded, partial);
					break;
				default:
					this.renderPending(writer);
			}
		}

		lines.push(bottomBorder(safeWidth, borderColor));
		return lines;
	}

	private renderPending(writer: CardWriter): void {
		writer.section("Input");
		writer.addWrapped(this.theme.fg("muted", summarizeArgs(this.state.args)));
		const progress = compactText(textContent(this.state.result));
		if (progress) {
			writer.section("Progress");
			writer.addWrapped(this.theme.fg("muted", progress));
		}
	}

	private renderError(writer: CardWriter): void {
		this.renderInput(writer);
		writer.section("Error");
		writer.addWrapped(this.theme.fg("error", errorMessage(this.state.result)), "", 6);
	}

	private renderCancellation(writer: CardWriter): void {
		this.renderInput(writer);
		writer.section("Cancelled");
		writer.addWrapped(this.theme.fg("warning", errorMessage(this.state.result)), "", 4);
	}

	private renderInput(writer: CardWriter): void {
		switch (this.state.kind) {
			case "web_search":
			case "code_search": {
				writer.section("Query");
				const query = querySummary(this.state.args, this.state.kind === "web_search" ? "queries" : "query");
				writer.addWrapped(this.theme.fg("text", query) + dimSuffix(this.theme, inputChips(this.state.args, this.state.kind)));
				return;
			}
			case "fetch_content": {
				writer.section("Input");
				writer.addWrapped(this.theme.fg("text", urlSummary(this.state.args)) + dimSuffix(this.theme, inputChips(this.state.args, this.state.kind)));
				return;
			}
			case "get_search_content":
				writer.section("Input");
				writer.addWrapped(this.theme.fg("text", String(this.state.args?.responseId ?? "stored content")) + dimSuffix(this.theme, inputChips(this.state.args, this.state.kind)));
				return;
		}
		writer.section("Input");
		writer.addWrapped(this.theme.fg("muted", summarizeArgs(this.state.args)));
	}

	private renderWebSearch(writer: CardWriter, expanded: boolean, partial: boolean): void {
		this.renderInput(writer);
		if (partial) {
			this.renderProgress(writer);
			return;
		}

		const details = detailsRecord(this.state.result);
		const groups = searchGroups(details, this.state.args);
		const sources = groups.flatMap((group) => group.results.map((item) => ({ query: group.query, item })));
		writer.section("Sources");
		if (!sources.length) {
			writer.addLine(this.theme.fg("dim", "No results."));
		} else {
			const shown = expanded ? sources : sources.slice(0, 4);
			for (let i = 0; i < shown.length; i++) {
				const source = shown[i]!;
				this.renderSearchSource(writer, source.item, i + 1, expanded, source.query, i === 0);
			}
			if (!expanded && sources.length > shown.length) writer.addLine(this.theme.fg("dim", `… ${sources.length - shown.length} more source(s)`));
		}
		this.renderMetadata(writer, metadataChips([
			details.searchId ? `id ${details.searchId}` : undefined,
			`${sources.length} source${sources.length === 1 ? "" : "s"}`,
			groups.length > 1 ? `${groups.length} queries` : undefined,
			this.state.args?.includeContent ? "scraped" : this.state.args?.fetchResult ? "first result fetched" : undefined,
		]), expanded);
	}

	private renderSearchSource(writer: CardWriter, item: KetchSearchResult, index: number, expanded: boolean, query: string, firstShown: boolean): void {
		const title = compactText(item.title || item.url || `Result ${index}`, 180);
		const url = String(item.url || "");
		const site = siteFromUrl(url);
		const queryNote = expanded && query ? this.theme.fg("dim", ` [${query}]`) : "";
		writer.addWrapped(`${this.theme.fg("accent", `${index}.`)} ${this.theme.fg("text", title)}${site ? this.theme.fg("dim", ` — ${site}`) : ""}${queryNote}`, "", 2);
		const snippet = compactText(item.description || item.snippet, expanded ? 500 : 220);
		if (snippet) writer.addWrapped(this.theme.fg("muted", snippet), "   ", expanded ? 2 : 1);
		if (url) writer.addWrapped(this.theme.fg("dim", url), "   ", 1);
		const body = compactText(searchResultBody(item), expanded ? 900 : 260);
		if (body && (expanded || firstShown)) writer.addWrapped(this.theme.fg("dim", `Preview: ${body}`), "   ", expanded ? 4 : 2);
	}

	private renderFetchContent(writer: CardWriter, expanded: boolean, partial: boolean): void {
		this.renderInput(writer);
		if (partial) {
			this.renderProgress(writer);
			return;
		}

		const details = detailsRecord(this.state.result);
		const documents = asArray<KetchScrapeResult>(details.results);
		writer.section("Documents");
		if (!documents.length) {
			writer.addLine(this.theme.fg("dim", "No documents returned."));
		} else {
			const shown = expanded ? documents : documents.slice(0, 3);
			for (let i = 0; i < shown.length; i++) this.renderDocument(writer, shown[i]!, i + 1, expanded);
			if (!expanded && documents.length > shown.length) writer.addLine(this.theme.fg("dim", `… ${documents.length - shown.length} more document(s)`));
		}
		this.renderMetadata(writer, metadataChips([
			details.fetchId ? `id ${details.fetchId}` : undefined,
			`${documents.length || asArray(details.urls).length} document${(documents.length || asArray(details.urls).length) === 1 ? "" : "s"}`,
			this.state.args?.raw ? "raw html" : undefined,
			this.state.args?.trim ? "trimmed" : undefined,
		]), expanded);
	}

	private renderDocument(writer: CardWriter, item: KetchScrapeResult, index: number, expanded: boolean): void {
		const title = compactText(item.title || item.url || `Document ${index}`, 180);
		const url = String(item.url || "");
		const site = siteFromUrl(url);
		writer.addWrapped(`${this.theme.fg("accent", `${index}.`)} ${this.theme.fg("text", title)}${site ? this.theme.fg("dim", ` — ${site}`) : ""}`, "", 2);
		if (item.error) writer.addWrapped(this.theme.fg("warning", compactText(item.error, 260)), "   ", 2);
		else {
			const body = compactText(scrapeResultBody(item), expanded ? 900 : 260);
			if (body) writer.addWrapped(this.theme.fg("muted", body), "   ", expanded ? 4 : 2);
		}
		if (expanded && url) writer.addWrapped(this.theme.fg("dim", url), "   ", 1);
	}

	private renderCodeSearch(writer: CardWriter, expanded: boolean, partial: boolean): void {
		this.renderInput(writer);
		if (partial) {
			this.renderProgress(writer);
			return;
		}

		const details = detailsRecord(this.state.result);
		const matches = asArray<KetchCodeResult>(details.results);
		writer.section("Matches");
		if (!matches.length) {
			writer.addLine(this.theme.fg("dim", "No matches returned."));
		} else {
			const shown = expanded ? matches : matches.slice(0, 5);
			for (let i = 0; i < shown.length; i++) this.renderCodeMatch(writer, shown[i]!, i + 1, expanded);
			if (!expanded && matches.length > shown.length) writer.addLine(this.theme.fg("dim", `… ${matches.length - shown.length} more match(es)`));
		}
		this.renderMetadata(writer, metadataChips([
			details.codeId ? `id ${details.codeId}` : undefined,
			`${matches.length} match${matches.length === 1 ? "" : "es"}`,
			this.state.args?.lang ? `lang ${this.state.args.lang}` : undefined,
			this.state.args?.regex ? "regex" : undefined,
		]), expanded);
	}

	private renderCodeMatch(writer: CardWriter, item: KetchCodeResult, index: number, expanded: boolean): void {
		const repo = compactText(item.repo || item.url || "result", 120);
		const path = item.path ? compactText(item.path, 160) : "";
		const language = item.language ? this.theme.fg("dim", ` (${item.language})`) : "";
		writer.addWrapped(`${this.theme.fg("accent", `${index}.`)} ${this.theme.fg("text", repo)}${path ? this.theme.fg("dim", ` — ${path}`) : ""}${language}`, "", 2);
		const snippetLines = snippetPreviewLines(item.snippet, expanded ? 5 : 2);
		for (const line of snippetLines) writer.addWrapped(this.theme.fg("muted", line), "   ", 1);
		if (expanded && item.url) writer.addWrapped(this.theme.fg("dim", String(item.url)), "   ", 1);
	}

	private renderStoredContent(writer: CardWriter, expanded: boolean, partial: boolean): void {
		this.renderInput(writer);
		if (partial) {
			this.renderProgress(writer);
			return;
		}
		const details = detailsRecord(this.state.result);
		writer.section("Stored Content");
		const id = details.id || this.state.args?.responseId;
		const type = details.type ? String(details.type) : "unknown";
		writer.addWrapped(this.theme.fg("text", `${type}${id ? ` · ${id}` : ""}`) + dimSuffix(this.theme, metadataChips([formatAge(details.timestamp)])));
		const text = textContent(this.state.result).trim();
		if (text) {
			writer.section("Preview");
			const previewLines = text.split("\n").filter((line) => line.trim()).slice(0, expanded ? 14 : 5);
			for (const line of previewLines) writer.addWrapped(this.theme.fg("muted", compactText(line, 240)), "", 1);
			const totalLines = text.split("\n").length;
			if (totalLines > previewLines.length) writer.addLine(this.theme.fg("dim", `… ${totalLines - previewLines.length} more line(s) in model-facing result`));
		}
		this.renderMetadata(writer, metadataChips([
			id ? `id ${id}` : undefined,
			details.type ? `type ${details.type}` : undefined,
			storedPageRange(details),
			details.nextOffset !== undefined ? `next offset ${details.nextOffset}` : Number(details.offset) > 0 ? "last page" : undefined,
			formatAge(details.timestamp),
		]), expanded);
	}

	private renderProgress(writer: CardWriter): void {
		writer.section("Progress");
		const progress = compactText(textContent(this.state.result)) || (this.state.executionStarted ? "Running ketch…" : "Preparing…");
		writer.addWrapped(this.theme.fg("muted", progress));
	}

	private renderMetadata(writer: CardWriter, chips: string[], expanded: boolean): void {
		if (!chips.length) return;
		if (expanded) {
			writer.section("Metadata");
			writer.addWrapped(this.theme.fg("dim", chips.join(" · ")));
		} else {
			writer.addLine();
			writer.addWrapped(this.theme.fg("dim", `Metadata  ${chips.join(" · ")}`));
		}
	}
}

function topBorder(title: string, width: number, color: (s: string) => string): string {
	const label = truncateToWidth(` ${title} `, Math.max(1, width - 6), "…");
	const fill = Math.max(0, width - 3 - visibleWidth(label));
	return color("╭─") + label + color(`${"─".repeat(fill)}╮`);
}

function bottomBorder(width: number, color: (s: string) => string): string {
	return color(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function toolLabel(kind?: KetchToolKind): string {
	switch (kind) {
		case "web_search": return "Web Search";
		case "fetch_content": return "Fetch Content";
		case "code_search": return "Code Search";
		case "get_search_content": return "Stored Web Content";
		default: return "Ketch";
	}
}

function headerMetadata(kind: KetchToolKind | undefined, details: Record<string, any>, args: any, partial: boolean): string | undefined {
	if (partial || hasErrorDetails(details)) return undefined;
	switch (kind) {
		case "web_search": {
			const count = searchGroups(details, args).reduce((total, group) => total + group.results.length, 0);
			return count ? `${count} source${count === 1 ? "" : "s"}` : undefined;
		}
		case "fetch_content": {
			const count = asArray(details.results).length || asArray(details.urls).length;
			return count ? `${count} document${count === 1 ? "" : "s"}` : undefined;
		}
		case "code_search": {
			const count = asArray(details.results).length;
			return count ? `${count} match${count === 1 ? "" : "es"}` : undefined;
		}
		case "get_search_content":
			return metadataChips([details.type ? String(details.type) : undefined, storedPageRange(details)]).join(" · ") || undefined;
		default:
			return undefined;
	}
}

function detailsRecord(result?: AgentToolResult<any>): Record<string, any> {
	return asRecord(result?.details) ?? {};
}

function asRecord(value: unknown): Record<string, any> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
	return undefined;
}

function hasErrorDetails(details: unknown): boolean {
	const record = asRecord(details);
	return Boolean(record?.error || record?.critical);
}

function isWarningDetails(details: Record<string, any>): boolean {
	return Boolean(details.cancelled);
}

function isCancelledDetails(details: Record<string, any>): boolean {
	return details.cancelled === true;
}

function textContent(result?: AgentToolResult<any>): string {
	const block = result?.content?.find((item: any) => item?.type === "text") as { text?: unknown } | undefined;
	return block?.text === undefined ? "" : String(block.text);
}

function errorMessage(result?: AgentToolResult<any>): string {
	const text = textContent(result).trim();
	if (text) return text;
	const details = detailsRecord(result);
	return String(details.error || details.critical || "Tool failed.");
}

function compactText(value: unknown, maxChars = 400): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function summarizeArgs(args: any): string {
	if (!args || typeof args !== "object") return "No input.";
	return compactText(JSON.stringify(args), 500);
}

function querySummary(args: any, mode: "query" | "queries"): string {
	const queries = mode === "queries" ? queryList(args) : [String(args?.query ?? "").trim()].filter(Boolean);
	if (!queries.length) return "No query provided.";
	const shown = queries.slice(0, 2).map((query) => `"${query}"`).join(", ");
	return queries.length > 2 ? `${shown} +${queries.length - 2} more` : shown;
}

function queryList(args: any): string[] {
	const raw = Array.isArray(args?.queries) ? args.queries : (args?.query ? [args.query] : []);
	return raw.map(String).map((query) => query.trim()).filter(Boolean);
}

function urlSummary(args: any): string {
	const urls = Array.isArray(args?.urls) ? args.urls : (args?.url ? [args.url] : []);
	const list = urls.map(String).map((url) => url.trim()).filter(Boolean);
	if (!list.length) return "No URL provided.";
	const shown = list.slice(0, 2).join(", ");
	return list.length > 2 ? `${shown} +${list.length - 2} more` : shown;
}

function inputChips(args: any, kind?: KetchToolKind): string[] {
	const chips: Array<string | undefined> = [];
	if (!args || typeof args !== "object") return [];
	if (kind === "web_search") {
		chips.push(args.backend || (["brave", "ddg", "searxng"].includes(String(args.provider)) ? String(args.provider) : undefined));
		if (args.numResults) chips.push(`limit ${args.numResults}`);
		if (args.includeContent) chips.push("scrape all");
		else if (args.fetchResult) chips.push("fetch first");
		if (args.trim) chips.push("trimmed");
	}
	if (kind === "fetch_content") {
		if (args.maxChars) chips.push(`max ${args.maxChars} chars`);
		if (args.raw) chips.push("raw html");
		if (args.trim) chips.push("trimmed");
		if (args.select) chips.push(`select ${args.select}`);
	}
	if (kind === "code_search") {
		if (args.backend) chips.push(String(args.backend));
		if (args.lang) chips.push(String(args.lang));
		if (args.regex) chips.push("regex");
		if (args.limit) chips.push(`limit ${args.limit}`);
	}
	if (kind === "get_search_content") {
		if (args.offset) chips.push(`offset ${args.offset}`);
		if (args.maxChars) chips.push(`max ${args.maxChars} chars`);
	}
	return metadataChips(chips);
}

function storedPageRange(details: Record<string, any>): string | undefined {
	const { offset, end, total } = details;
	if (![offset, end, total].every((n) => Number.isFinite(Number(n)))) return undefined;
	return `chars ${offset}–${end} of ${total}`;
}

function dimSuffix(theme: Theme, chips: string[]): string {
	return chips.length ? theme.fg("dim", ` · ${chips.join(" · ")}`) : "";
}

function metadataChips(values: Array<string | undefined | false | null>): string[] {
	return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function searchGroups(details: Record<string, any>, args: any): Array<{ query: string; results: KetchSearchResult[] }> {
	const fromDetails = asArray<any>(details.results);
	if (fromDetails.some((item) => asRecord(item)?.data !== undefined || asRecord(item)?.query !== undefined)) {
		return fromDetails.map((item, index) => {
			const record = asRecord(item) ?? {};
			return {
				query: String(record.query ?? queryList(args)[index] ?? ""),
				results: asArray<KetchSearchResult>(record.data),
			};
		});
	}
	return [{ query: queryList(args)[0] ?? "", results: fromDetails as KetchSearchResult[] }];
}

function siteFromUrl(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function snippetPreviewLines(value: unknown, maxLines: number): string[] {
	return String(value ?? "")
		.split("\n")
		.map((line) => compactText(line, 220))
		.filter(Boolean)
		.slice(0, maxLines);
}

function formatAge(value: unknown): string | undefined {
	const timestamp = Number(value);
	if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
	const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
