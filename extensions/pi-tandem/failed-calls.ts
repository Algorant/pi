import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

	pi.on("turn_start", async () => {
		failedCalls = [];
	});

	pi.on("tool_execution_end", async (event) => {
		if (!event.isError || event.parentToolCallId !== undefined) return;
		failedCalls.push({
			toolName: event.toolName,
			detail: errorDetail(event.result),
		});
	});

	pi.on("turn_end", async (event) => {
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
