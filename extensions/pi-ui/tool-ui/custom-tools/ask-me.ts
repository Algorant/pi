import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer } from "@earendil-works/pi-tui";
import { createBoxedToolRenderer } from "../core/card";
import { durationLabel, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRenderInput, ToolUiBoxModel, ToolUiSectionModel, ToolUiTone } from "../core/types";

type AskMeOption = string | { title?: unknown; description?: unknown };

type AskMeQuestion = {
  id?: unknown;
  header?: unknown;
  question?: unknown;
  options?: unknown;
  allowFreeform?: unknown;
};

type AskMeInput = {
  context?: unknown;
  questions?: unknown;
};

type AskMeAnswer = {
  questionIndex?: unknown;
  id?: unknown;
  question?: unknown;
  kind?: unknown;
  selection?: unknown;
  optionIndex?: unknown;
  text?: unknown;
};

type AskMeDetails = {
  status?: unknown;
  reason?: unknown;
  message?: unknown;
  questions?: unknown;
  answers?: unknown;
};

type NormalizedQuestion = {
  header: string;
  question: string;
  optionCount: number;
  allowFreeform: boolean;
};

export function createAskMeRenderer() {
  const boxed = createBoxedToolRenderer<AskMeInput, AskMeDetails>((input) => buildAskMeBox(input));
  return {
    ...boxed,
    renderCall(...args: Parameters<typeof boxed.renderCall>) {
      const content = new Container();
      const context = stringValue(args[0].context);
      // Full rationale is ordinary Markdown in the transcript, not a paragraph
      // squeezed into the live dock or hidden behind tool-card expansion.
      if (context) {
        content.addChild(new Markdown(context, 0, 0, getMarkdownTheme()));
        content.addChild(new Spacer(1));
      }
      content.addChild(boxed.renderCall(...args));
      return content;
    },
  };
}

function buildAskMeBox({ args, result, options, theme, text, pending, error, context }: BoxedToolRenderInput<AskMeInput, AskMeDetails>): ToolUiBoxModel {
  const details = asRecord(result?.details) as AskMeDetails;
  const questions = normalizeQuestions(firstArray(details.questions, args.questions));
  const answers = normalizeAnswers(details.answers);
  const rejected = stringValue(details.status) === "rejected";
  const reason = stringValue(details.reason);
  const failed = Boolean(error);
  const hasFreeform = answers.some((answer) => answer.kind === "freeform");
  const tone = askMeTone({ pending, failed, rejected, hasFreeform });
  const status = pending
    ? "waiting"
    : failed
      ? "failed"
      : rejected
        ? reason || "rejected"
        : answers.length > 0
          ? "answered"
          : "done";

  // The live dialog already shows the question. Repeating it here pushes
  // the useful main-thread explanation out of the viewport.
  if (pending) return {
    title: `${statusIcon(theme, tone)} ${toolName(theme, "Ask Me")}`,
    status: joinTitleParts(["waiting", plural(questions.length || countRawQuestions(args.questions), "question")]),
    tone,
  };

  const body = [
    theme.fg("muted", plural(questions.length || countRawQuestions(args.questions), "question")),
  ];

  const sections: ToolUiSectionModel[] = [];

  const questionLines = previewQuestions(questions, options.expanded ? 8 : 3, theme);
  if (questionLines.length > 0) sections.push(section("Questions", questionLines));

  if (failed) {
    sections.push(section("Error", [theme.fg("error", truncatePlain(text || "ask_me failed", 500))]));
  } else if (rejected) {
    sections.push(section("Result", [
      theme.fg("warning", stringValue(details.message) || "User declined the ask_me prompt."),
    ]));
    if (answers.length > 0) {
      sections.push(section("Answers", previewAnswers(answers, options.expanded ? 8 : 3, theme)));
    }
  } else if (answers.length > 0) {
    sections.push(section("Answers", previewAnswers(answers, options.expanded ? 8 : 3, theme)));
  } else if (text) {
    sections.push(section("Result", [theme.fg("muted", truncatePlain(text, 500))]));
  }

  const duration = durationLabel(context.state);
  return {
    title: `${statusIcon(theme, tone)} ${toolName(theme, "Ask Me")}`,
    status: joinTitleParts([status, answerMeta(answers, questions), duration]),
    tone,
    body,
    sections,
  };
}

function askMeTone(input: { pending: boolean; failed: boolean; rejected: boolean; hasFreeform: boolean }): ToolUiTone {
  if (input.failed) return "error";
  if (input.pending) return "pending";
  if (input.rejected || input.hasFreeform) return "warning";
  return "success";
}

function firstArray(primary: unknown, fallback: unknown): unknown[] {
  if (Array.isArray(primary)) return primary;
  if (Array.isArray(fallback)) return fallback;
  return [];
}

function normalizeQuestions(raw: unknown[]): NormalizedQuestion[] {
  return raw.map((item, index) => {
    const q = asRecord(item) as AskMeQuestion;
    const rawOptions = Array.isArray(q.options) ? q.options as AskMeOption[] : [];
    const header = stringValue(q.header) || `Q${index + 1}`;
    return {
      header,
      question: stringValue(q.question) || "Untitled question",
      optionCount: rawOptions.length,
      allowFreeform: q.allowFreeform !== false,
    };
  });
}

function normalizeAnswers(raw: unknown): AskMeAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => asRecord(item) as AskMeAnswer).filter((answer) => stringValue(answer.question));
}

function previewQuestions(questions: NormalizedQuestion[], limit: number, theme: any): string[] {
  const visible = questions.slice(0, limit);
  const lines = visible.map((q, index) => {
    const meta = joinTitleParts([
      q.optionCount > 0 ? plural(q.optionCount, "option") : "freeform",
      q.allowFreeform && q.optionCount > 0 ? "custom allowed" : undefined,
    ]);
    return `${theme.fg("accent", q.header || `Q${index + 1}`)} ${theme.fg("muted", "—")} ${theme.fg("text", truncatePlain(q.question, 180))}${meta ? theme.fg("dim", ` · ${meta}`) : ""}`;
  });
  if (questions.length > visible.length) lines.push(theme.fg("dim", `… ${questions.length - visible.length} more questions`));
  return lines;
}

function previewAnswers(answers: AskMeAnswer[], limit: number, theme: any): string[] {
  const visible = answers.slice(0, limit);
  const lines = visible.map((answer) => {
    const label = stringValue(answer.id) || stringValue(answer.question) || "answer";
    const value = answer.kind === "freeform"
      ? `custom: ${stringValue(answer.text)}`
      : answer.optionIndex
        ? `${answer.optionIndex}. ${stringValue(answer.selection)}`
        : stringValue(answer.selection);
    const tone = answer.kind === "freeform" ? "warning" : "success";
    return `${theme.fg("muted", `${truncatePlain(label, 80)}:`)} ${theme.fg(tone, truncatePlain(value, 180))}`;
  });
  if (answers.length > visible.length) lines.push(theme.fg("dim", `… ${answers.length - visible.length} more answers`));
  return lines;
}

function answerMeta(answers: AskMeAnswer[], questions: NormalizedQuestion[]): string | undefined {
  if (answers.length === 0) return undefined;
  if (questions.length === 0) return plural(answers.length, "answer");
  return `${answers.length}/${questions.length} answered`;
}

function countRawQuestions(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
