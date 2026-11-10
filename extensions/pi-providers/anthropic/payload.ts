import { isCustomToolName, rewriteOAuthSystemText, toSourceToolName, toWireToolName } from "./aliases.ts";

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collect the flat Pi tool names carried by this exact request. Prompt prose is
 * rewritten against the live tool list, so it cannot drift from the session.
 */
function customToolNames(tools: unknown): string[] {
	if (!Array.isArray(tools)) return [];
	const names: string[] = [];
	for (const tool of tools) {
		// Anthropic typed tools (for example computer_use) have their own wire
		// contract. They are not flat Pi tools.
		if (!isRecord(tool) || typeof tool.type === "string" || typeof tool.name !== "string") continue;
		if (isCustomToolName(tool.name)) names.push(tool.name);
	}
	return names;
}

function rewriteSystem(value: unknown, names: readonly string[]): unknown {
	if (typeof value === "string") return rewriteOAuthSystemText(value, names);
	if (!Array.isArray(value)) return value;
	return value.map((block) => {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
		return { ...block, text: rewriteOAuthSystemText(block.text, names) };
	});
}

function rewriteToolDefinition(tool: unknown): unknown {
	if (!isRecord(tool)) return tool;
	if (typeof tool.type === "string") return tool;
	if (typeof tool.name !== "string") return tool;
	const name = toWireToolName(tool.name);
	return name === tool.name ? tool : { ...tool, name };
}

function rewriteToolChoice(value: unknown): unknown {
	if (!isRecord(value) || value.type !== "tool" || typeof value.name !== "string") return value;
	return { ...value, name: toWireToolName(value.name) };
}

function rewriteAssistantContent(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") return block;
		const name = toWireToolName(block.name);
		return name === block.name ? block : { ...block, name };
	});
}

/**
 * Mid-conversation system messages carry prompt-section text plus native
 * `tool_addition`/`tool_removal` references. Both must use the wire names that
 * `tools[]` declares, or Anthropic rejects the reference as an unknown tool.
 */
function rewriteSystemMessageContent(content: unknown, names: readonly string[]): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (!isRecord(block)) return block;
		if (block.type === "text" && typeof block.text === "string") {
			return { ...block, text: rewriteOAuthSystemText(block.text, names) };
		}
		if ((block.type === "tool_addition" || block.type === "tool_removal") && isRecord(block.tool) && typeof block.tool.name === "string") {
			const name = toWireToolName(block.tool.name);
			return name === block.tool.name ? block : { ...block, tool: { ...block.tool, name } };
		}
		return block;
	});
}

/**
 * History is immutable and can name tools that were renamed or deleted after
 * the turn was recorded. The prefix rule applies to those names too, so an old
 * transcript stays sendable instead of bricking the session.
 */
function rewriteHistoricalMessage(message: unknown, names: readonly string[]): unknown {
	if (!isRecord(message)) return message;
	if (message.role === "system") {
		const content = rewriteSystemMessageContent(message.content, names);
		return content === message.content ? message : { ...message, content };
	}
	if (message.role !== "assistant") return message;
	const content = rewriteAssistantContent(message.content);
	return content === message.content ? message : { ...message, content };
}

/**
 * Transform only the final Anthropic OAuth request representation.
 * User message content is intentionally never traversed or rewritten.
 */
export function transformOAuthPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const next: RecordLike = { ...payload };
	const names = customToolNames(next.tools);
	if ("system" in next) next.system = rewriteSystem(next.system, names);
	if (Array.isArray(next.tools)) next.tools = next.tools.map(rewriteToolDefinition);
	if ("tool_choice" in next) next.tool_choice = rewriteToolChoice(next.tool_choice);
	if (Array.isArray(next.messages)) next.messages = next.messages.map((message) => rewriteHistoricalMessage(message, names));
	return next;
}

/**
 * Rename an aliased tool call at its source. Pi's Anthropic transport awaits
 * `provider_stream_event` handlers with the raw SSE event before it reads
 * `content_block.name` to create the toolCall, so the call, its dispatch, and
 * its transcript row all start with the flat local name.
 */
export function unaliasStreamEvent(data: unknown): boolean {
	if (!isRecord(data) || data.type !== "content_block_start") return false;
	const block = data.content_block;
	if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string") return false;
	const name = toSourceToolName(block.name);
	if (name === block.name) return false;
	block.name = name;
	return true;
}

/** Display-only unaliasing. It never changes persisted or provider messages. */
export function unaliasDisplayedText(text: string): string {
	if (!text) return text;
	return text.replace(/\bmcp__pi_cc__([A-Za-z0-9_]+)\b/g, (_match, name: string) => name);
}

/**
 * Anthropic rejects a tool_result with `is_error: true` unless all its content is
 * text (400 "all content must be type `text` if `is_error` is true"). Pi keeps
 * images in failed tool results (e.g. a codemode script that called image() and
 * then threw), and every retry resends that history, so one such result breaks
 * the session for good. Replace the non-text parts of error results with a text
 * note before each request; the saved image paths stay in the result's text.
 * Returns the payload unchanged (same object) when nothing needed fixing.
 */
export function textOnlyErrorResults(payload: unknown): unknown {
	const messages = (payload as { messages?: unknown })?.messages;
	if (!Array.isArray(messages)) return payload;
	let changed = false;
	const fixed = messages.map((message: any) => {
		if (!Array.isArray(message?.content)) return message;
		let messageChanged = false;
		const content = message.content.map((block: any) => {
			if (block?.type !== "tool_result" || block.is_error !== true || !Array.isArray(block.content)) return block;
			if (block.content.every((part: any) => part?.type === "text")) return block;
			messageChanged = true;
			return {
				...block,
				content: block.content.map((part: any) => part?.type === "text"
					? part
					: { type: "text", text: `[${part?.type ?? "non-text"} content omitted: Anthropic accepts only text in an error tool result]` }),
			};
		});
		if (!messageChanged) return message;
		changed = true;
		return { ...message, content };
	});
	return changed ? { ...(payload as object), messages: fixed } : payload;
}
