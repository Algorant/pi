import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classify, FAILURE_MEMORY_EVENT, MEMORY_LIMIT, resultText, type FailureRecord } from "./failure-summary";

type FailedCall = { toolName: string; detail: string };

function errorDetail(result: unknown): string {
	const content = (result as { content?: unknown } | null)?.content;
	const text = Array.isArray(content)
		? content
				.filter(
					(part): part is { type: "text"; text: string } =>
						typeof part === "object" &&
						part !== null &&
						"text" in part &&
						typeof part.text === "string",
				)
				.map((part) => part.text)
				.join("\n")
		: "";
	const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (!firstLine) return "error";
	return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
}

export function registerFailedCallContext(pi: ExtensionAPI): void {
	let failedCalls: FailedCall[] = [];
	// In-process record of the failed calls (nested included) of the CURRENT turn only: its tool results are
	// not persisted until turn_end (documented), so a completion snapshot reads them here, and the session
	// branch holds everything earlier. Cleared at turn_end, at a scope marker and at every session start, so
	// nothing outlives its persistence, a resumed or replaced session starts empty, and `lost` can only mean
	// more than MEMORY_LIMIT failures in one unpersisted turn, never that already-persisted ones aged out.
	let records = new Map<string, FailureRecord>();
	let lost = false;
	pi.events.on(FAILURE_MEMORY_EVENT, (request: { op: "reset" | "read"; records?: FailureRecord[]; lost?: boolean }) => {
		if (request.op === "reset") { records = new Map(); lost = false; return; }
		request.records = [...records.values()];
		request.lost = lost;
	});

	pi.on("turn_start", async () => {
		failedCalls = [];
	});

	pi.on("session_start", async () => {
		records = new Map();
		lost = false;
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.isError) {
			if (records.size >= MEMORY_LIMIT) {
				records.delete(records.keys().next().value!);
				lost = true;
			}
			records.set(event.toolCallId, { id: event.toolCallId, tool: event.toolName, code: classify(resultText(event.result)) });
		}
		if (!event.isError || event.parentToolCallId !== undefined) return;
		failedCalls.push({
			toolName: event.toolName,
			detail: errorDetail(event.result),
		});
	});

	pi.on("turn_end", async (event) => {
		records = new Map();
		lost = false;
		if (!failedCalls.length) return;
		const calls = failedCalls
			.map(({ toolName, detail }) => `${toolName} (${detail})`)
			.join(", ");
		const line = `Failed tool calls this turn: ${calls}. Papercut only if the contract is brittle or the friction recurs; recover first.`;
		failedCalls = [];
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "failed-tool-calls",
					content: line,
					display: false,
				},
			],
		};
	});
}
