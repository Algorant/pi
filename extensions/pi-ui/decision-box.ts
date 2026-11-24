import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Quiet Decision box (task-826).
 *
 * A standalone `## Decision` section is drawn as a thin outlined box. Display
 * only: the stored reply and the model context are unchanged, and the authoring
 * form reads as ordinary Markdown on every other surface:
 *
 *   ## Decision
 *
 *   How do you want to try the quiet style?
 *
 *   - **A. One temporary sample tab** (recommended) — Close it to undo.
 *   - **B. Turn it on for all desktop Pis** — One revert undoes it.
 *
 * The parser is strict and recognises only that form: a line that is exactly
 * `## Decision` outside a code fence, a plain-text question, then 2 to 5 bullets
 * lettered A, B, ... in order, each with a title, an em-dash consequence and
 * exactly one carrying `(recommended)`. The question, titles and consequences may
 * hold only plain text, `**bold**` and `code`; a link, image, pill, HTML,
 * emphasis or any other construct means no box. Anything that does not fit is
 * left alone and keeps its ordinary meaning (the quiet `## Decision` heading).
 *
 * Box rows are exactly `width` cells (non-breaking spaces plus Markdown hard
 * breaks, the same method as the `## Word` rule), so Pi never re-wraps them.
 */

const HEADING_RE = /^##[ \t]+Decision[ \t]*$/;
const ANY_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const FENCE_RE = /^\s*(```|~~~)/;
const BULLET_RE = /^[-*+][ \t]/;
const OPTION_RE = /^[-*+] \*\*([A-E])\. ([^*\n]+?)\*\*( \(recommended\))? — (\S.*)$/;
const CONTINUATION_RE = /^[ \t]{2,}\S/;
// Starts some other block, or could turn the question into one (indent, heading, quote, ordered list, setext rule, table).
const NOT_PLAIN_QUESTION_RE = /^(?:\s|#|>|\d+[.)](?:\s|$)|[-=+*_]+\s*$)/;
const INLINE_RE = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
// What is left once bold and code are removed must be plain: no brackets, HTML, emphasis, escapes, entities, tables or bare URLs.
const UNRECOGNIZED_RE = /[\[\]<>*~|\\&`]|(?<!\w)_|_(?!\w)|https?:|www\./i;
const MIN_WIDTH = 24;
const NBSP = "\u00A0";
const MD_SPECIAL_RE = /[\\`*_\[\]<>&~]/g;
const MAX_OPTIONS = 5;

interface Option {
  letter: string;
  title: string;
  recommended: boolean;
  consequence: string;
}

interface Block {
  start: number;
  end: number; // exclusive
  question: string;
  options: Option[];
}

/** True when `text` holds nothing but plain words, `**bold**` and `code`. */
function isPlain(text: string): boolean {
  const residue = text.replace(INLINE_RE, " ");
  return !UNRECOGNIZED_RE.test(residue);
}

/** Parse the Decision block that starts at lines[start], or undefined when it does not fit the form. */
function parseBlock(lines: string[], start: number): Block | undefined {
  let i = start + 1;
  const question: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line) || ANY_HEADING_RE.test(line)) return undefined;
    if (BULLET_RE.test(line)) break;
    if (!line.trim()) continue;
    if (NOT_PLAIN_QUESTION_RE.test(line) || !isPlain(line)) return undefined;
    question.push(line.trim());
  }
  if (question.length === 0) return undefined;

  const options: Option[] = [];
  let end = i;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (!BULLET_RE.test(line)) break;
    const match = OPTION_RE.exec(line);
    if (!match) return undefined; // a bullet that is not a lettered option with a consequence
    let consequence = match[4];
    i++;
    while (i < lines.length && CONTINUATION_RE.test(lines[i])) consequence += ` ${lines[i++].trim()}`;
    if (!isPlain(match[2]) || !isPlain(consequence)) return undefined;
    options.push({ letter: match[1], title: match[2].trim(), recommended: match[3] !== undefined, consequence: consequence.trim() });
    end = i;
  }
  if (options.length < 2 || options.length > MAX_OPTIONS) return undefined;
  if (!options.every((option, at) => option.letter === String.fromCharCode(65 + at))) return undefined;
  if (options.filter((option) => option.recommended).length !== 1) return undefined;
  // Text glued to or indented under the last option would continue it in Markdown, so it is no box.
  const next = lines.findIndex((candidate, at) => at >= end && candidate.trim() !== "");
  if (next === end && !ANY_HEADING_RE.test(lines[next]) && !FENCE_RE.test(lines[next])) return undefined;
  if (next > end && /^[ \t]/.test(lines[next])) return undefined;
  return { start, end, question: question.join(" "), options };
}

function findBlock(lines: string[]): Block | undefined {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE_RE.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !HEADING_RE.test(lines[i])) continue;
    const block = parseBlock(lines, i);
    if (block) return block;
  }
  return undefined;
}

// ---- drawing -------------------------------------------------------------

interface Token {
  text: string;
  kind: "plain" | "bold" | "code";
  space: boolean; // whitespace before this token
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pendingSpace = false;
  const push = (chunk: string, kind: Token["kind"]) => {
    if (/^\s/.test(chunk)) pendingSpace = true;
    chunk
      .split(/\s+/)
      .filter(Boolean)
      .forEach((word, at) => {
        tokens.push({ text: word, kind, space: at > 0 || pendingSpace });
        pendingSpace = false;
      });
    if (/\s$/.test(chunk)) pendingSpace = true;
  };
  let last = 0;
  INLINE_RE.lastIndex = 0;
  for (let m = INLINE_RE.exec(text); m; m = INLINE_RE.exec(text)) {
    if (m.index > last) push(text.slice(last, m.index), "plain");
    push(m[1] ?? m[2], m[1] !== undefined ? "bold" : "code");
    last = m.index + m[0].length;
  }
  if (last < text.length) push(text.slice(last), "plain");
  return tokens;
}

/** Greedy word wrap of styled tokens to `width` cells; each row is [visible width, painted text]. */
function wrap(theme: Theme, text: string, width: number, base: (s: string) => string): [number, string][] {
  const rows: [number, string][] = [];
  let cur = "";
  let curW = 0;
  const flush = () => {
    if (curW > 0) rows.push([curW, cur]);
    cur = "";
    curW = 0;
  };
  const esc = (s: string) => s.replace(MD_SPECIAL_RE, (c) => `\\${c}`);
  for (const token of tokenize(text)) {
    const paint = (s: string) => (token.kind === "code" ? theme.fg("mdCode", s) : token.kind === "bold" ? theme.bold(base(s)) : base(s));
    let word = token.text;
    let gap = token.space && curW > 0 ? 1 : 0;
    while (visibleWidth(word) + gap > width - curW) {
      if (curW > 0 && visibleWidth(word) <= width) {
        flush();
        gap = 0;
        continue;
      }
      // Longer than a whole row: break it by characters.
      let take = "";
      for (const ch of Array.from(word)) {
        if (visibleWidth(take + ch) + gap > width - curW) break;
        take += ch;
      }
      if (take === "") {
        flush();
        gap = 0;
        continue;
      }
      cur += (gap ? " " : "") + paint(esc(take));
      curW += gap + visibleWidth(take);
      flush();
      gap = 0;
      word = word.slice(take.length);
    }
    cur += (gap ? " " : "") + paint(esc(word));
    curW += gap + visibleWidth(word);
  }
  flush();
  return rows;
}

function renderBox(theme: Theme, block: Block, width: number, edge: (text: string) => string): string {
  const text = (s: string) => theme.fg("text", s);
  const inner = width - 4;
  const hang = 3;
  const out: string[] = [];
  const emit = (painted: string, w: number) =>
    out.push(`${edge("│")}${NBSP}${painted.replaceAll(" ", NBSP)}${NBSP.repeat(Math.max(0, inner - w))}${NBSP}${edge("│")}`);

  const label = "Decision";
  out.push(`${edge("╭─")}${NBSP}${theme.bold(theme.fg("warning", label))}${NBSP}${edge(`${"─".repeat(width - 5 - label.length)}╮`)}`);
  for (const [w, painted] of wrap(theme, block.question, inner, (s) => theme.bold(text(s)))) emit(painted, w);
  emit("", 0);
  for (const option of block.options) {
    const lead = `${theme.bold(theme.fg("warning", `${option.letter}.`))} `;
    const titleRows = wrap(theme, option.title, inner - hang, (s) => theme.bold(text(s)));
    if (option.recommended) {
      // The label stays on the last title row when it fits; otherwise it gets its own row.
      const tag = "(recommended)";
      const last = titleRows.length - 1;
      const [w, painted] = titleRows[last];
      if (w + 1 + tag.length <= inner - hang) titleRows[last] = [w + 1 + tag.length, `${painted} ${theme.fg("accent", tag)}`];
      else titleRows.push([tag.length, theme.fg("accent", tag)]);
    }
    titleRows.forEach(([w, painted], at) => emit(at === 0 ? `${lead}${painted}` : `${" ".repeat(hang)}${painted}`, hang + w));
    for (const [w, painted] of wrap(theme, option.consequence, inner - hang, (s) => theme.fg("muted", s))) emit(`${" ".repeat(hang)}${painted}`, hang + w);
  }
  out.push(edge(`╰${"─".repeat(width - 2)}╯`));
  return out.join("  \n");
}

/**
 * Replace each well-formed Decision block with its box, running `decorate` on the
 * Markdown before and after it. A streaming message, a missing width or one under
 * MIN_WIDTH draws no box; the whole text goes through `decorate` unchanged.
 */
export function decorateDecisionBoxes(
  markdown: string,
  theme: Theme,
  width: number,
  isStreaming: boolean,
  edge: (text: string) => string,
  decorate: (text: string) => string,
): string {
  if (isStreaming || width < MIN_WIDTH) return decorate(markdown);
  let lines = markdown.split("\n");
  const parts: string[] = [];
  for (let block = findBlock(lines); block; block = findBlock(lines)) {
    const before = lines.slice(0, block.start).join("\n");
    if (before.trim()) parts.push(decorate(before));
    parts.push(renderBox(theme, block, width, edge));
    lines = lines.slice(block.end);
  }
  if (parts.length === 0) return decorate(markdown);
  const rest = lines.join("\n");
  if (rest.trim()) parts.push(decorate(rest));
  return parts.join("\n\n");
}
