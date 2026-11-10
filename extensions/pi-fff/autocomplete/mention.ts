import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import type { NativeFffFinder } from "../native/finder";

const ANSI_RESET = "\x1b[0m";
const ANSI_OCHRE = "\x1b[38;2;230;191;134m";
const ANSI_CYAN = "\x1b[38;2;131;165;152m";
const MAX_DISPLAY_PATH_CHARS = 240;

function token(before: string): string | undefined {
	const m = before.match(/@([^\s@]*)$/);
	return m?.[1];
}

function quote(p: string) {
	return /\s/.test(p) ? `@"${p.replaceAll('"', '\\"')}"` : `@${p}`;
}

function singleLinePath(path: string): string {
	return path.replace(/[\r\n\t]+/g, " ").trim();
}

function displayPath(path: string, isDirectory: boolean): string {
	const clean = singleLinePath(path);
	const withSlash = isDirectory && clean && !clean.endsWith("/") ? `${clean}/` : clean;
	return withSlash.length > MAX_DISPLAY_PATH_CHARS ? `${withSlash.slice(0, MAX_DISPLAY_PATH_CHARS)}…` : withSlash;
}

function labelFor(path: string, isDirectory: boolean): string {
	const icon = isDirectory ? "󰉋" : "󰈔";
	const color = isDirectory ? ANSI_OCHRE : ANSI_CYAN;
	return `${color}${icon}${ANSI_RESET} ${path}`;
}

export function registerMentionAutocomplete(ctx: ExtensionContext, finder: NativeFffFinder, isActive: () => boolean = () => true) {
	ctx.ui.addAutocompleteProvider(
		(current: AutocompleteProvider): AutocompleteProvider => ({
			async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
				const q = token((lines[cursorLine] || "").slice(0, cursorCol));
				if (q === undefined || !isActive()) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				const r = await finder.mixed(q, 0, 20);
				if (!isActive() || options.signal.aborted || !r.ok || !r.value.items.length) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				return {
					prefix: `@${q}`,
					items: r.value.items.map((x) => {
						const rel = singleLinePath((x.item as any).relativePath || "");
						const isDirectory = x.type === "directory";
						const valuePath = isDirectory && rel && !rel.endsWith("/") ? `${rel}/` : rel;
						const path = displayPath(rel, isDirectory);
						return { value: quote(valuePath), label: labelFor(path, isDirectory) };
					}),
				};
			},
			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}),
	);
}
