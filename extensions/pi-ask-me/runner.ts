import type { AskMeQuestion } from "./index";
import type { AskMeOutcome, AskMePendingScope } from "./pending";
import type { AskMeWaitOptions, AskMeUiHost } from "./ui";

/** Load the TUI implementation only when an interactive tool call needs it. */
export async function runAskMe(
	ui: AskMeUiHost,
	questions: AskMeQuestion[],
	signal?: AbortSignal,
	waitOptions: AskMeWaitOptions & { scope?: AskMePendingScope } = {},
): Promise<AskMeOutcome> {
	const module = await import("./ui");
	return module.runAskMe(ui, questions, signal, waitOptions);
}
