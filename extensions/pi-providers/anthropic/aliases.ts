/**
 * Anthropic's OAuth endpoint rejects flat custom tool names, so Pi's local
 * tools travel under an `mcp__pi_cc__` label. The mapping is a prefix rule, not
 * a registry: any flat name that is not a Pi core tool and not an Anthropic
 * typed tool is a Pi custom tool.
 */
export const WIRE_PREFIX = "mcp__pi_cc__";

export const CORE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"find",
	"grep",
	"ls",
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"LS",
]);

/** Names used by Anthropic's typed tools or Claude Code's built-in tools. */
export const ANTHROPIC_TYPED_TOOL_NAMES = new Set([
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
	// Anthropic computer-use and typed-tool names are not flat Pi tools.
	"computer",
	"computer_use",
	"computer_20241022",
	"computer_20250124",
	"text_editor",
	"text_editor_20241022",
	"text_editor_20250124",
	"str_replace_editor",
	"str_replace_editor_20250124",
	"bash_20241022",
	"bash_20250124",
]);

export function isMcpToolName(name: string): boolean {
	return name.startsWith("mcp__");
}

/** True for a flat name that Pi owns and Anthropic OAuth will not accept. */
export function isCustomToolName(name: string): boolean {
	return !!name && !CORE_TOOL_NAMES.has(name) && !ANTHROPIC_TYPED_TOOL_NAMES.has(name) && !isMcpToolName(name);
}

export function toWireToolName(name: string): string {
	return isCustomToolName(name) ? `${WIRE_PREFIX}${name}` : name;
}

export function toSourceToolName(name: string): string {
	return name.startsWith(WIRE_PREFIX) ? name.slice(WIRE_PREFIX.length) : name;
}

/**
 * Rewrite bare tool names inside prompt prose. The names come from the live
 * tool list on the same request, so this never drifts from the session.
 */
export function rewriteCustomToolReferences(text: string, names: readonly string[]): string {
	if (!text || names.length === 0) return text;
	const ordered = [...new Set(names)].sort((a, b) => b.length - a.length);
	// File names, hyphenated words, and member access (`docs/mcp.md`,
	// `pi-mcp-adapter`, `tools.read`) are not tool references. Slash-joined
	// names (`worker_handoff/worker_finish`) and a sentence-ending period are.
	const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])(${ordered.join("|")})(?=$|[^A-Za-z0-9_.-]|\\.(?![A-Za-z0-9_]))`, "g");
	return text.replace(pattern, (_match, prefix: string, name: string) => `${prefix}${toWireToolName(name)}`);
}

export function rewritePromptIdentity(text: string): string {
	return text
		.replace(/\bthe\s+pi itself\b/gi, (match) => (match.startsWith("T") ? "The cli itself" : "the cli itself"))
		.replace(/\bpi itself\b/gi, (_match, offset: number, source: string) => {
			const previous = source[offset - 1];
			return previous && previous !== " " ? "cli itself" : "the cli itself";
		})
		.replace(/\bpi \.md files\b/gi, "cli .md files")
		.replace(/\bpi packages\b/gi, "cli packages");
}

export function rewriteOAuthSystemText(text: string, names: readonly string[]): string {
	return rewriteCustomToolReferences(rewritePromptIdentity(text), names);
}
