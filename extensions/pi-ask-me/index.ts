import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAskMeRenderer } from "../pi-ui/tool-ui/custom-tools/ask-me";
import { runAskMe } from "./runner";
import { AskMePendingScope, type AskMeOutcome, REJECTION_MESSAGES } from "./pending";

export const MAX_QUESTIONS = 4;
export const MAX_OPTIONS = 5;
export const MAX_HEADER_LENGTH = 20;
/** Full rationale belongs in the transcript, not in the question picker. */
export const MIN_CONTEXT_LENGTH = 60;

const CONTEXT_REQUIREMENT =
	"the full decision explanation in structured Markdown: situation, proposed plan, trade-offs, and what needs deciding. It is rendered in the main conversation before the prompt opens";

export interface AskMeOption {
	title: string;
	description?: string;
}

export interface AskMeQuestion {
	id?: string;
	header: string;
	question: string;
	options: AskMeOption[];
	allowFreeform: boolean;
}

export interface AskMeAnswer {
	questionIndex: number;
	id?: string;
	question: string;
	kind: "selection" | "freeform";
	selection?: string;
	optionIndex?: number;
	text?: string;
}

/** Details payload attached to the tool result and read by the transcript card. */
export type AskMeToolDetails =
	| { status: "pending"; questions: AskMeQuestion[]; answers: AskMeAnswer[] }
	| AskMeOutcome;

export type { AskMeOutcome, AskMeAnswered, AskMeRejected, AskMeRejectionReason } from "./pending";

type RawOption = string | { title?: unknown; description?: unknown };
type RawQuestion = {
	id?: unknown;
	header?: unknown;
	question?: unknown;
	options?: unknown;
	allowFreeform?: unknown;
};

type RawParams = {
	context?: unknown;
	questions?: unknown;
};

const OptionSchema = Type.Union([
	Type.String({ description: "Short title for this option" }),
	Type.Object({
		title: Type.String({ description: "Short title for this option" }),
		description: Type.Optional(
			Type.String({
				description:
					"One short consequence or trade-off, shown when this option is highlighted. Put the full comparison in context before the dialog opens.",
			}),
		),
	}),
]);

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable identifier for this question, if useful for downstream work" })),
	header: Type.Optional(
		Type.String({
			maxLength: MAX_HEADER_LENGTH,
			description: "Short tab/chip label; defaults to Q1, Q2, etc.",
		}),
	),
	question: Type.String({ description: "The focused question to ask the user" }),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			maxItems: MAX_OPTIONS,
			description: "Optional choices to present; omit for pure freeform questions.",
		}),
	),
	allowFreeform: Type.Optional(
		Type.Boolean({
			description: "Append a custom answer row for option questions. Default: true. Ignored for pure freeform questions.",
		}),
	),
});

const ParamsSchema = Type.Object({
	context: Type.String({
		minLength: MIN_CONTEXT_LENGTH,
		description: `Required: ${CONTEXT_REQUIREMENT}. Use headings and short paragraphs or bullets, not an infodump.`,
	}),
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "Independent questions to answer in one blocking prompt.",
	}),
});

const PROMPT_SNIPPET = `Ask the user for clarification instead of guessing. Use ask_me for 1-${MAX_QUESTIONS} independent blocking questions. Always provide a clear explanation in context, rendered in the conversation before the simple question-and-options dialog opens.`;

const PROMPT_GUIDELINES = [
	"Use ask_me when ambiguity, high stakes, preference, or missing requirements would materially change the implementation.",
	"Cephs and manus (a project's long-running Pi tab) never use ask_me; they send questions to Herdra with agent_send per AGENTS.md.",
	"Before opening ask_me, always show a clear explanation of what is being asked and why. Put it in context: the tool renders it as Markdown in the main conversation before opening the picker. Show any plan you ask the user to approve or edit; do not bury the rationale in the dialog.",
	"The dialog only restates the current question and lists choices. Keep option descriptions short; only the highlighted option shows its detail. The last answer submits automatically, with no review step.",
	'When you recommend one option, list it first and append "(Recommended)" to its title.',
];

function result(text: string, details: AskMeToolDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function normalizeOption(option: RawOption): AskMeOption | null {
	if (typeof option === "string") {
		const title = option.trim();
		return title ? { title } : null;
	}
	if (!option || typeof option !== "object") return null;
	const title = typeof option.title === "string" ? option.title.trim() : "";
	if (!title) return null;
	const description = typeof option.description === "string" && option.description.trim()
		? option.description.trim()
		: undefined;
	return description ? { title, description } : { title };
}

function normalizeParams(
	params: RawParams,
): { ok: true; context: string; questions: AskMeQuestion[] } | { ok: false; error: string } {
	const context = typeof params.context === "string" ? params.context.trim() : "";
	if (context.length < MIN_CONTEXT_LENGTH) {
		return {
			ok: false,
			error: `context is ${context ? `too short (${context.length} chars, minimum ${MIN_CONTEXT_LENGTH})` : "required"}. Provide ${CONTEXT_REQUIREMENT}.`,
		};
	}
	if (!Array.isArray(params.questions)) return { ok: false, error: "questions must be an array" };
	if (params.questions.length === 0) return { ok: false, error: "at least one question is required" };
	if (params.questions.length > MAX_QUESTIONS) return { ok: false, error: `at most ${MAX_QUESTIONS} questions are allowed` };

	const questions: AskMeQuestion[] = [];
	const seenQuestionText = new Set<string>();

	for (let i = 0; i < params.questions.length; i++) {
		const raw = params.questions[i] as RawQuestion;
		if (!raw || typeof raw !== "object") return { ok: false, error: `question ${i + 1} must be an object` };
		const question = typeof raw.question === "string" ? raw.question.trim() : "";
		if (!question) return { ok: false, error: `question ${i + 1} is missing question text` };
		if (seenQuestionText.has(question)) return { ok: false, error: "question text must be unique within an ask_me call" };
		seenQuestionText.add(question);

		const headerRaw = typeof raw.header === "string" && raw.header.trim() ? raw.header.trim() : `Q${i + 1}`;
		const header = headerRaw.length > MAX_HEADER_LENGTH ? headerRaw.slice(0, MAX_HEADER_LENGTH) : headerRaw;
		const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
		const rawOptions = Array.isArray(raw.options) ? raw.options : [];
		if (rawOptions.length > MAX_OPTIONS) return { ok: false, error: `question ${i + 1} has more than ${MAX_OPTIONS} options` };
		const options = rawOptions.map((o) => normalizeOption(o as RawOption)).filter((o): o is AskMeOption => !!o);
		if (rawOptions.length > 0 && options.length !== rawOptions.length) {
			return { ok: false, error: `question ${i + 1} has an invalid option` };
		}
		const seenOptions = new Set<string>();
		for (const option of options) {
			if (seenOptions.has(option.title)) return { ok: false, error: `question ${i + 1} has duplicate option titles` };
			seenOptions.add(option.title);
		}
		const allowFreeform = raw.allowFreeform === false ? false : true;
		if (options.length === 0 && !allowFreeform) {
			return { ok: false, error: `question ${i + 1} has no options and freeform is disabled` };
		}

		questions.push({ ...(id ? { id } : {}), header, question, options, allowFreeform });
	}

	return { ok: true, context, questions };
}

function formatAnswer(answer: AskMeAnswer): string {
	if (answer.kind === "freeform") return `"${answer.question}"="${answer.text ?? ""}"`;
	const prefix = answer.optionIndex ? `${answer.optionIndex}. ` : "";
	return `"${answer.question}"="${prefix}${answer.selection ?? ""}"`;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.stack ? `${error.message}\n${error.stack}` : error.message;
	return String(error);
}

export default function piAskMe(pi: ExtensionAPI) {
	// Each extension instance owns its own pending-request scope. Session teardown
	// must never leave one of its tool calls suspended on an answer that cannot arrive.
	const pendingScope = new AskMePendingScope();
	pi.on?.("session_shutdown", () => {
		pendingScope.dispose();
	});

	pi.registerTool({
		name: "ask_me",
		label: "Ask Me",
		// Needs the inline interactive UI; never callable from codemode scripts.
		exposure: "model-only",
		description:
			"Ask the user one to four independent questions in a simple choice dialog. Always provide a clear explanation in context: it is rendered in the main conversation before the dialog opens. The dialog only restates the question and shows options; only the highlighted option shows its short description. Selecting the last answer submits immediately. Type to write a custom answer, or select an option. No multi-select.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		executionMode: "sequential",
		parameters: ParamsSchema,
		...createAskMeRenderer(),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const normalized = normalizeParams(params as RawParams);
			if (!normalized.ok) {
				throw new Error(`ask_me validation error: ${normalized.error}`);
			}

			const { questions } = normalized;
			if (signal?.aborted) {
				return result(REJECTION_MESSAGES.aborted, {
					status: "rejected",
					reason: "aborted",
					message: REJECTION_MESSAGES.aborted,
					questions,
					answers: [],
				});
			}
			if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.ui) {
				throw new Error("ask_me requires an interactive Pi UI. Please answer in chat instead.");
			}

			onUpdate?.({
				content: [{ type: "text", text: "Waiting for user input..." }],
				details: { status: "pending", questions, answers: [] },
			});

			let outcome: AskMeOutcome;
			try {
				outcome = await runAskMe(ctx.ui, questions, signal, { scope: pendingScope });
			} catch (error) {
				throw new Error(`ask_me failed: ${errorMessage(error)}`);
			}

			if (outcome.status === "rejected") {
				// No surface could be shown at all. That is a failure, not a decline.
				if (outcome.reason === "unavailable") {
					throw new Error(`ask_me failed: ${outcome.message}`);
				}
				const partial = outcome.answers.length > 0
					? ` Answers collected before stopping: ${outcome.answers.map(formatAnswer).join("; ")}.`
					: "";
				return result(`${outcome.message}${partial}`, outcome);
			}

			const summary = outcome.answers.map(formatAnswer).join("; ");
			const hasFreeformAnswer = outcome.answers.some((answer) => answer.kind === "freeform");
			if (hasFreeformAnswer) {
				return result(
					`User provided a custom response: ${summary}. Treat custom/freeform responses as unresolved feedback, not final answers. Pause the current task, address the user's custom response directly, then re-ask the relevant ask_me question with better context/options if a decision is still needed. Do not continue using the custom response as a selected option.`,
					outcome,
				);
			}
			return result(`User answered: ${summary}. Continue with these answers in mind.`, outcome);
		},
	});
}
