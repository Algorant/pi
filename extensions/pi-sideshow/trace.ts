import { requestJson } from "./http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SideshowState } from "./state";

export const TRACE_MAX_DETAIL = 1800;
export const TRACE_MAX_LABEL = 140;

type TraceStep = { kind: string; label: string; detail?: string; ts?: string };

type Message = Record<string, any>;

function trunc(value: unknown, max: number): string {
	const text = String(value ?? "");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => {
		if (typeof block === "string") return block;
		return block?.type === "text" && typeof block.text === "string" ? block.text : "";
	}).join("");
}

function entryTimestamp(entry: any, message: Message): string | undefined {
	if (typeof message.timestamp === "number") return new Date(message.timestamp).toISOString();
	return typeof entry?.timestamp === "string" ? entry.timestamp : undefined;
}

function baseName(path: unknown): string {
	return typeof path === "string" ? path.split(/[\\/]/).pop() || path : "";
}

function summarizeTool(name: unknown, args: any): { kind: string; label: string } {
	if (name === "read") return { kind: "read", label: `Read ${baseName(args?.path)}` };
	if (name === "edit" || name === "write") return { kind: "edit", label: `Edit ${baseName(args?.path)}` };
	if (name === "bash") return { kind: "run", label: args?.command ?? "command" };
	if (name === "web_fetch") return { kind: "web", label: `Fetch ${args?.url ?? ""}` };
	if (name === "web_search") return { kind: "web", label: `Search ${JSON.stringify(args?.query ?? "")}` };
	if (name === "subagent") return { kind: "agent", label: args?.agent ?? args?.action ?? "Subagent" };
	if (typeof name === "string" && name.startsWith("sideshow_")) return { kind: "sideshow", label: name.replace(/^sideshow_/, "") };
	return { kind: String(name || "tool").toLowerCase().slice(0, 20), label: String(name || "tool") };
}

export function buildPiTraceSteps(ctx: ExtensionContext): TraceStep[] {
	const steps: TraceStep[] = [];
	const pending = new Map<string, number>();
	for (const entry of ctx.sessionManager.getBranch()) {
		const message: Message | undefined = entry?.type === "message" ? entry.message : undefined;
		if (!message) continue;
		const ts = entryTimestamp(entry, message);
		if (message.role === "user") {
			const prompt = contentText(message.content).trim();
			if (prompt) steps.push({ kind: "prompt", label: trunc(prompt.split("\n")[0], TRACE_MAX_LABEL), detail: trunc(prompt, TRACE_MAX_DETAIL), ts });
			continue;
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block?.type === "thinking" && typeof block.thinking === "string") {
					const thought = block.thinking.trim();
					if (thought) steps.push({ kind: "think", label: trunc(thought.split("\n")[0], TRACE_MAX_LABEL), ts });
				} else if (block?.type === "text" && typeof block.text === "string") {
					const say = block.text.trim();
					if (say) steps.push({ kind: "say", label: trunc(say.split("\n")[0], TRACE_MAX_LABEL), detail: trunc(say, TRACE_MAX_DETAIL), ts });
				} else if (block?.type === "toolCall") {
					const summary = summarizeTool(block.name, block.arguments);
					steps.push({ kind: summary.kind, label: trunc(summary.label, TRACE_MAX_LABEL), detail: trunc(JSON.stringify(block.arguments ?? {}), TRACE_MAX_DETAIL), ts });
					if (block.id) pending.set(block.id, steps.length - 1);
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const index = pending.get(message.toolCallId);
			if (index !== undefined) {
				const output = trunc(contentText(message.content), 1200).trim();
				if (output) steps[index].detail = trunc(`${steps[index].detail}\n\n→ ${output}`, TRACE_MAX_DETAIL);
				pending.delete(message.toolCallId);
			}
			continue;
		}
		if (message.role === "bashExecution") steps.push({ kind: "run", label: trunc(message.command ?? "shell command", TRACE_MAX_LABEL), detail: trunc(message.output ?? "", TRACE_MAX_DETAIL), ts });
	}
	return steps;
}

export function scopeToSurfaces(steps: TraceStep[], surfaceTimes: number[], pad = 5): TraceStep[] {
	if (!surfaceTimes.length) return steps;
	const promptTimes = steps.filter((step) => step.kind === "prompt" && step.ts).map((step) => Date.parse(step.ts!)).filter(Number.isFinite).sort((a, b) => a - b);
	if (!promptTimes.length) return steps;
	const countAtOrBefore = (time: number) => promptTimes.filter((prompt) => prompt <= time).length;
	const startIndex = Math.max(0, countAtOrBefore(surfaceTimes[0]) - 1 - pad);
	const endIndex = Math.min(promptTimes.length - 1, Math.max(0, countAtOrBefore(surfaceTimes[surfaceTimes.length - 1]) - 1) + pad);
	const startTs = promptTimes[startIndex];
	const endTs = endIndex + 1 < promptTimes.length ? promptTimes[endIndex + 1] : Infinity;
	return steps.filter((step) => { const time = step.ts ? Date.parse(step.ts) : NaN; return Number.isFinite(time) && time >= startTs && time < endTs; });
}

export async function syncPiTrace(state: SideshowState, ctx: ExtensionContext, options: { all?: boolean; pad?: number } = {}): Promise<Record<string, unknown>> {
	if (!state.sessionId) return { skipped: true, reason: "no-session" };
	let steps = buildPiTraceSteps(ctx);
	if (!options.all) {
		const surfaces = await requestJson<any[]>(`/api/sessions/${encodeURIComponent(state.sessionId)}/posts`, { skipStartup: true });
		const times = (Array.isArray(surfaces) ? surfaces : []).map((surface) => Date.parse(surface.createdAt)).filter(Number.isFinite).sort((a, b) => a - b);
		steps = scopeToSurfaces(steps, times, options.pad ?? 5);
	}
	const result = await requestJson<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(state.sessionId)}/trace`, { method: "POST", body: JSON.stringify({ steps, reset: true }), skipStartup: true });
	return { ...result, sent: steps.length, sessionId: state.sessionId };
}
