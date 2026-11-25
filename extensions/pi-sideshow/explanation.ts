import type { SurfacePayload } from "./validation";

/**
 * The typed explanation surface: three required one-paragraph fields that the
 * extension lowers to ordinary Markdown before anything is sent, so Sideshow
 * itself needs no new surface kind. Pure module: validation.ts enforces it on
 * every surface write, index.ts lowers right after validating, and the pi-ui
 * codemode row reads the same field table.
 */
export const EXPLANATION_FIELDS = [
	{ key: "issue", heading: "Issue" },
	{ key: "how", heading: "How it happened" },
	{ key: "solution", heading: "Solution" },
] as const;

export type ExplanationKey = (typeof EXPLANATION_FIELDS)[number]["key"];

/** Characters per field, counted as Unicode code points. */
export const EXPLANATION_FIELD_LIMIT = 600;

/** Every refusal starts with this, so a card can recognise the diagnostic and nothing else. */
export const EXPLANATION_REFUSAL_PREFIX = "Explanation refused (nothing was sent): ";

// Any line or paragraph break: LF, VT, FF, CR, NEL, LS, PS.
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/** True when the raw (untrimmed) text holds any line or paragraph break, including a leading or trailing one. */
export function hasLineBreak(text: string): boolean {
	return LINE_BREAK.test(text);
}

export function codePointLength(text: string): number {
	return Array.from(text).length;
}

/** Problems with one explanation surface, one sentence each; empty when it is valid. */
export function explanationProblems(surface: object, path: string): string[] {
	const record = surface as Record<string, unknown>;
	const problems: string[] = [];
	for (const { key } of EXPLANATION_FIELDS) {
		const where = `${path}.${key}`;
		const value = record[key];
		if (value === undefined) problems.push(`${where} is required`);
		else if (typeof value !== "string") problems.push(`${where} must be a string`);
		else if (!value.trim()) problems.push(`${where} is blank`);
		else if (hasLineBreak(value)) problems.push(`${where} contains a line break (one short paragraph only)`);
		else {
			const length = codePointLength(value.trim());
			if (length > EXPLANATION_FIELD_LIMIT) problems.push(`${where} is ${length} characters, over the ${EXPLANATION_FIELD_LIMIT} limit`);
		}
	}
	return problems;
}

export function explanationRefusal(problems: string[]): Error {
	return new Error(`${EXPLANATION_REFUSAL_PREFIX}${problems.join("; ")}. Each field is one short paragraph of at most ${EXPLANATION_FIELD_LIMIT} characters.`);
}

/** Make one line of text read as a plain paragraph: no heading, list, quote, fence, rule, table or reference definition. */
export function plainParagraph(text: string): string {
	const line = text.trim();
	return line
		.replace(/^(\d{1,9})([.)])/, "$1\\$2")
		.replace(/^[\\`~#>+*_\-=|[<!:]/, (marker) => `\\${marker}`);
}

/** The one lowering path: explanations become Markdown surfaces, every other surface is returned unchanged. */
export function lowerExplanation(surface: SurfacePayload): SurfacePayload {
	return surface.kind === "explanation" ? { kind: "markdown", markdown: explanationMarkdown(surface) } : surface;
}

/** The Markdown an explanation is posted as: three `##` sections in order. Input must already be validated. */
export function explanationMarkdown(surface: object): string {
	const record = surface as Record<ExplanationKey, string>;
	return EXPLANATION_FIELDS.map(({ key, heading }) => `## ${heading}\n\n${plainParagraph(record[key])}`).join("\n\n");
}
