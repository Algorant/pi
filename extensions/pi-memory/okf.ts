// OKF frontmatter checks over note text (the contract itself is unchanged).

export type ParsedFrontmatter = {
	hasFrontmatter: boolean;
	valid: boolean;
	fields: Record<string, string>;
	tags: string[];
	error?: string;
};

export type OkfIssue = { file: string; conceptId?: string; reasons: string[] };

export type OkfReport = { concepts: number; nonconforming: OkfIssue[] };

export type RootNote = { path: string; text: string };

function isReservedOkfFile(filePath: string): boolean {
	const name = (filePath.split("/").pop() ?? "").toLowerCase();
	return name === "index.md" || name === "log.md";
}

function conceptId(relativePath: string): string {
	return relativePath.endsWith(".md") ? relativePath.slice(0, -3) : relativePath;
}

function unquoteYamlScalar(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseInlineTags(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
	return trimmed.slice(1, -1).split(",").map((part) => unquoteYamlScalar(part)).filter(Boolean);
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	const normalized = content.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	if (lines[0] !== "---") return { hasFrontmatter: false, valid: false, fields: {}, tags: [], error: "missing frontmatter" };
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end < 0) return { hasFrontmatter: true, valid: false, fields: {}, tags: [], error: "invalid/unterminated frontmatter" };

	const fields: Record<string, string> = {};
	const tags: string[] = [];
	const frontmatter = lines.slice(1, end);
	for (let i = 0; i < frontmatter.length; i++) {
		const match = frontmatter[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const [, key, rawValue] = match;
		if (key === "tags") {
			if (rawValue.trim()) tags.push(...parseInlineTags(rawValue));
			else {
				while (i + 1 < frontmatter.length) {
					const item = frontmatter[i + 1].match(/^\s*-\s*(.*)$/);
					if (!item) break;
					tags.push(unquoteYamlScalar(item[1]));
					i++;
				}
			}
		} else if (["type", "title", "description", "created", "updated", "timestamp", "resource"].includes(key)) {
			fields[key] = unquoteYamlScalar(rawValue);
		}
	}
	return { hasFrontmatter: true, valid: true, fields, tags };
}

/** Reasons a note does not conform to the OKF contract; empty when it conforms. Paths are relative to the scope root. */
export function okfReasons(relativePath: string, text: string): string[] {
	const parsed = parseFrontmatter(text);
	if (isReservedOkfFile(relativePath)) {
		return parsed.valid && parsed.fields.type?.trim() ? ["reserved filename has normal concept frontmatter"] : [];
	}
	if (!parsed.hasFrontmatter) return ["missing frontmatter"];
	if (!parsed.valid) return [parsed.error || "invalid/unterminated frontmatter"];
	if (!parsed.fields.type?.trim()) return ["missing type"];
	return [];
}

/** Analyze notes whose paths are relative to one scope root. */
export function analyzeOkf(notes: RootNote[]): OkfReport {
	const report: OkfReport = { concepts: 0, nonconforming: [] };
	for (const note of notes) {
		const reasons = okfReasons(note.path, note.text);
		const reserved = isReservedOkfFile(note.path);
		if (reasons.length) report.nonconforming.push(reserved ? { file: note.path, reasons } : { file: note.path, conceptId: conceptId(note.path), reasons });
		else if (!reserved) report.concepts++;
	}
	return report;
}
