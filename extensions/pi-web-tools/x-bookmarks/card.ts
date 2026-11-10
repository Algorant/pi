import { spawn } from "node:child_process";

// Generated cover for a genuinely text-only post: an SVG laid out like a compact post (author line, text clamped
// to four lines, date), rendered to PNG locally with rsvg-convert. Dark, theme-neutral colours. rsvg-convert does
// not wrap text, so lines are wrapped here with a deliberately conservative per-character width estimate: a word
// pushed to the next line, or a "…" that comes early, is better than clipped text.

export const CARD_WIDTH = 800;
export const CARD_HEIGHT = 500;
const PADDING = 48;
const TEXT_SIZE = 34;
const TEXT_LEADING = 46;
const MAX_LINES = 4;
const FONT = "'Liberation Sans', 'Noto Sans', sans-serif";

const NARROW = new Set("iljtfIr.,;:'!|()[]/ ".split(""));
const WIDE = new Set("mwMW@%".split(""));

/** Width of one character in em, rounded up. Wide scripts, emoji, and symbols count a full em. */
function charEm(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	if (code >= 0x2e80 || (code >= 0x1f000 && code <= 0x1faff) || (code >= 0x2600 && code <= 0x27bf) || (code >= 0x0400 && code <= 0x04ff)) return 1.05;
	if (NARROW.has(ch)) return 0.38;
	if (WIDE.has(ch)) return 0.95;
	if (ch >= "A" && ch <= "Z") return 0.8;
	return 0.64;
}

function textEm(text: string): number {
	let em = 0;
	for (const ch of text) em += charEm(ch);
	return em;
}

export function wrapLines(text: string, maxWidth: number, size: number, maxLines: number): string[] {
	const fits = (value: string) => textEm(value) * size <= maxWidth;
	// A word wider than a whole line is split into chunks that each fit.
	const words: string[] = [];
	for (const word of text.split(/\s+/).filter(Boolean)) {
		let chunk = "";
		for (const ch of word) {
			if (chunk && !fits(chunk + ch)) {
				words.push(chunk);
				chunk = "";
			}
			chunk += ch;
		}
		words.push(chunk);
	}
	const lines: string[] = [];
	let line = "";
	let truncated = false;
	for (const word of words) {
		const next = line ? `${line} ${word}` : word;
		if (fits(next)) {
			line = next;
			continue;
		}
		lines.push(line);
		if (lines.length === maxLines) {
			truncated = true;
			break;
		}
		line = word;
	}
	if (!truncated && line) lines.push(line);
	if (truncated) {
		// Text was cut: end the last line with an ellipsis that is guaranteed to fit.
		let last = lines.pop() ?? "";
		while (last && !fits(`${last}…`)) last = Array.from(last).slice(0, -1).join("").trimEnd();
		lines.push(`${last}…`);
	}
	return lines;
}

function xml(text: string): string {
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type CardInput = { name: string; handle: string; text: string; date: string };

export function cardSvg({ name, handle, text, date }: CardInput): string {
	const maxWidth = CARD_WIDTH - PADDING * 2;
	const lines = wrapLines(text, maxWidth, TEXT_SIZE, MAX_LINES);
	const displayName = wrapLines(name, maxWidth - 240, 30, 1)[0] ?? "";
	const body = lines.map((line, i) => `<text x="${PADDING}" y="${190 + i * TEXT_LEADING}" font-size="${TEXT_SIZE}" fill="#e6e6e9">${xml(line)}</text>`).join("");
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="${FONT}">`,
		`<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="#232428"/>`,
		`<circle cx="${PADDING + 28}" cy="${PADDING + 36}" r="28" fill="#3a3b40"/>`,
		`<text x="${PADDING + 76}" y="${PADDING + 32}" font-size="30" font-weight="bold" fill="#e6e6e9">${xml(displayName)}</text>`,
		`<text x="${PADDING + 76}" y="${PADDING + 66}" font-size="24" fill="#8d8d94">@${xml(handle)}</text>`,
		body,
		`<text x="${PADDING}" y="${CARD_HEIGHT - PADDING + 6}" font-size="22" fill="#8d8d94">x.com · ${xml(date)}</text>`,
		"</svg>",
	].join("");
}

/** Render an SVG to PNG bytes with rsvg-convert (stdin to stdout). Fails clearly when the tool is missing or errors. */
export function renderPng(svg: string, signal?: AbortSignal): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const child = spawn("rsvg-convert", ["--format", "png", "--width", String(CARD_WIDTH)], { stdio: ["pipe", "pipe", "pipe"], signal, timeout: 15_000 });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code === "ENOENT" ? "rsvg-convert is not installed" : `rsvg-convert failed: ${error.message}`)));
		child.on("close", (code) => {
			const png = Buffer.concat(out);
			if (code === 0 && png.length > 8) resolve(new Uint8Array(png));
			else reject(new Error(`rsvg-convert exited with ${code}${err.length ? `: ${Buffer.concat(err).toString("utf8").trim().slice(0, 150)}` : ""}`));
		});
		child.stdin.on("error", () => undefined);
		child.stdin.end(svg);
	});
}
