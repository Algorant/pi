import { readFileSync } from "node:fs";
import { parseColor, visibleWidth, type Color } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { decorateDecisionBoxes } from "./decision-box";

/**
 * Assistant-side emphasis drawing (task-750).
 *
 * Drawing only. `user-message.ts` still owns pi-ui's single Markdown
 * transformer and hands assistant text here; Pi parses Markdown after the
 * transformer, so the ANSI inserted inside existing syntax survives. The stored
 * message, the model context, the user rails and every non-assistant surface are
 * untouched.
 *
 * Quiet reply emphasis (task-821, option A of task-819). Rules kept small:
 * - `[[Word]]` becomes a bold word in its meaning's tint plus a muted dot, with
 *   no fill and no icon, only for the approved vocabulary (the ask-me table minus
 *   `Needs You`); anything else stays literal. `[[TLDR]]` is such a word too, and
 *   the closing TLDR paragraph of a settled reply sits under one faint rule.
 * - Ordinary `**bold**` keeps its asterisks and is drawn in the theme text
 *   color; on a line that leads with `[[Decision]]` it is ochre at normal weight.
 *   Approved-word lead-ins (`**Git state:**`) are muted and not bold.
 * - A line that is exactly `## Word` (approved word) is drawn as the bold tinted
 *   word and a faint rule to the available width, as its own paragraph, bound to
 *   a list or prose beneath it; see `decorateAssistantMarkdown`.
 * - Inline marks and tree lines are colored.
 * - Inline code, fenced code, indented code and links are never rewritten.
 * - A well-formed standalone `## Decision` section (task-826) is drawn as a thin
 *   muted-ochre box once the message settles; see ./decision-box.ts. Anything
 *   that does not fit its strict form keeps the rules above.
 *
 * The ask-me context keeps the older pills through `decorateStatePills`. Pill
 * fills and icons there use theme roles; labels use the theme's `text` color,
 * except the TLDR pill, whose optional foreground is read once from the loaded
 * theme's `recapTeal` variable and otherwise falls back to `text`.
 */

type FgRole = Parameters<Theme["fg"]>[0];
type BgRole = Parameters<Theme["bg"]>[0];

interface PillTone {
  bg: BgRole;
  accent: FgRole;
}

interface PillWord {
  icon: string;
  tone: PillTone;
  labelColor?: "recapTeal";
}

const GOOD: PillTone = { bg: "toolSuccessBg", accent: "accent" };
const BAD: PillTone = { bg: "toolErrorBg", accent: "error" };
const WARN: PillTone = { bg: "selectedBg", accent: "warning" };
// Verdigris resolves mdCodeBlockBorder to its accentDark var (patina); the
// theme exposes vars only through roles, so this is the patina role.
const INFO: PillTone = { bg: "selectedBg", accent: "mdCodeBlockBorder" };
const PLAIN: PillTone = { bg: "selectedBg", accent: "muted" };

// Nerd Font private-use code points already shipped by JetBrainsMono NF on this
// machine (checked with `ghostty +show-face`); no emoji presentation, one cell.
const PILL_WORDS: Record<string, PillWord> = {
  "Needs You": { icon: "\u{F007}", tone: WARN },
  Decision: { icon: "\u{F0EB}", tone: INFO },
  Blocked: { icon: "\u{F023}", tone: BAD },
  Failed: { icon: "\u{F00D}", tone: BAD },
  "At risk": { icon: "\u{F071}", tone: WARN },
  Unverified: { icon: "\u{F059}", tone: WARN },
  Observed: { icon: "\u{F06E}", tone: PLAIN },
  Inferred: { icon: "\u{F126}", tone: PLAIN },
  Done: { icon: "\u{F00C}", tone: GOOD },
  Passed: { icon: "\u{F00C}", tone: GOOD },
  Live: { icon: "\u{F0E7}", tone: GOOD },
  Recommended: { icon: "\u{F164}", tone: INFO },
  "In progress": { icon: "\u{F110}", tone: WARN },
  Pending: { icon: "\u{F017}", tone: WARN },
  Partial: { icon: "\u{F0C8}", tone: WARN },
  Skipped: { icon: "\u{F068}", tone: WARN },
  "Costs money": { icon: "\u{F155}", tone: WARN },
  Destructive: { icon: "\u{F071}", tone: BAD },
  TLDR: { icon: "", tone: PLAIN, labelColor: "recapTeal" },
  "Up next": { icon: "\u{F148}", tone: INFO },
  Delivered: { icon: "\u{F0D1}", tone: GOOD },
  Now: { icon: "\u{F111}", tone: PLAIN },
  "Git state": { icon: "\u{E702}", tone: PLAIN },
};

/**
 * Assistant vocabulary: every legacy pill word except `Needs You`. Words default
 * to a muted tint; these groups name the ones that carry a meaning colour.
 */
const ASSISTANT_EXCLUDED = "Needs You";
const TINTS: Record<string, FgRole> = Object.fromEntries(
  (
    [
      ["warning", ["Decision", "At risk", "Unverified", "Costs money"]],
      ["mdLink", ["Up next", "In progress", "Now", "Pending"]],
      ["mdCodeBlockBorder", ["Done", "Passed", "Live", "Delivered"]],
      ["error", ["Blocked", "Failed", "Destructive"]],
    ] as [FgRole, string[]][]
  ).flatMap(([role, words]) => words.map((word) => [word, role])),
);

const isAssistantWord = (word: string): boolean => Object.hasOwn(PILL_WORDS, word) && word !== ASSISTANT_EXCLUDED;
const tintOf = (word: string): FgRole => (Object.hasOwn(TINTS, word) ? TINTS[word] : "muted");

const TREE_TONE: FgRole = "muted";
const PILL_CONTEXT_PROTECTED_RE = /`[^`\n]*`|\[(?:[^\[\]\n]|\[\[[^\]\n]*\]\])*\]\([^\)\n]*\)/g;

const FENCE_RE = /^\s*(```|~~~)/;
const INDENTED_CODE_RE = /^(?: {4,}|\t)/;
const LEADING_TREE_RE = /^(\s*(?:[│├└][─ ]*)+)/;
const LEADING_ARROW_RE = /^(\s*)(→)/;
const PILL_RE = /\[\[([^[\]\n]{1,40})\]\]/g;
const BOLD_RE = /(?<!\\)\*\*(?=\S)([^*\n]+?)\*\*/g;

/**
 * A pill cap has to be drawn in the panel's own color on the terminal
 * background, and Pi's Theme only exposes background roles through getBgAnsi.
 * Shift that one SGR parameter, so the cap still comes from the theme token.
 */
function fgFromBg(theme: Theme, role: BgRole): string {
  return theme.getBgAnsi(role).replace("[48", "[38");
}

function cap(theme: Theme, role: BgRole, glyph: string): string {
  return `${fgFromBg(theme, role)}${glyph}\x1b[39m`;
}

/**
 * Non-breaking spaces keep a pill one unbreakable token, so a wrapped line
 * never leaves the left cap on one line and the right cap on the next.
 */
const PAD = "\u00A0";
const recapTealCache = new WeakMap<Theme, Color | undefined>();

/** Read an optional color once per Theme object; absent vars use normal text. */
function recapTeal(theme: Theme): Color | undefined {
  if (recapTealCache.has(theme)) return recapTealCache.get(theme);
  let color: Color | undefined;
  if (theme.sourcePath) {
    try {
      const source = readFileSync(theme.sourcePath, "utf8");
      const json = JSON.parse(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source) as { vars?: Record<string, unknown> };
      const value = json.vars?.recapTeal;
      if (typeof value === "string") color = parseColor(value);
    } catch {
      // This optional variable never blocks the ordinary theme-text fallback.
    }
  }
  recapTealCache.set(theme, color);
  return color;
}

function renderPill(theme: Theme, word: PillWord, label: string): string {
  const left = cap(theme, word.tone.bg, "\u{E0B6}");
  const right = cap(theme, word.tone.bg, "\u{E0B4}");
  const paddedLabel = `${label.replaceAll(" ", PAD)}${PAD}`;
  const customLabelColor = word.labelColor === "recapTeal" ? recapTeal(theme) : undefined;
  const labelText = customLabelColor
    ? theme.style(paddedLabel, { fg: customLabelColor, bold: true })
    : theme.bold(theme.fg("text", paddedLabel));
  const body = `${theme.fg(word.tone.accent, `${PAD}${word.icon}${PAD}`)}${labelText}`;
  return `${left}${theme.bg(word.tone.bg, body)}${right}`;
}

function replaceStatePills(theme: Theme, text: string): string {
  return text.replace(PILL_RE, (match, name: string) => {
    const word = PILL_WORDS[name];
    return word ? renderPill(theme, word, name) : match;
  });
}

/** Quiet assistant word: bold tinted word and a muted dot; a non-breaking space keeps the dot on the word's row. */
function quietWord(theme: Theme, word: string): string {
  return `${theme.bold(theme.fg(tintOf(word), word))}${PAD}${theme.fg("muted", "·")}`;
}

function replaceAssistantPills(theme: Theme, text: string): string {
  return text.replace(PILL_RE, (match, name: string) => {
    return isAssistantWord(name) ? quietWord(theme, name) : match;
  });
}

function decorateText(theme: Theme, text: string, decisionLine: boolean): string {
  const out = text.replace(BOLD_RE, (_match, inner: string) => {
    if (isAssistantWord(inner.replace(/:$/, "").trim())) return theme.fg("muted", inner);
    if (decisionLine) return theme.fg("warning", inner);
    return `**${theme.fg("text", inner)}**`;
  });
  return replaceAssistantPills(theme, out).replace(/✓|✗/g, (mark) => theme.fg(mark === "✓" ? "accent" : "error", mark));
}

function decorateProtectedLine(line: string, decorate: (text: string) => string, protectedRe: RegExp): string {
  const parts: string[] = [];
  let last = 0;
  protectedRe.lastIndex = 0;
  for (let match = protectedRe.exec(line); match; match = protectedRe.exec(line)) {
    parts.push(decorate(line.slice(last, match.index)));
    parts.push(match[0]);
    last = match.index + match[0].length;
  }
  parts.push(decorate(line.slice(last)));
  return parts.join("");
}

function decoratePillsLine(theme: Theme, line: string): string {
  return decorateProtectedLine(line, (text) => replaceStatePills(theme, text), PILL_CONTEXT_PROTECTED_RE);
}

function decorateLines(markdown: string, decorate: (line: string) => string): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || INDENTED_CODE_RE.test(line)) return line;
      return decorate(line);
    })
    .join("\n");
}

/** Display-only approved state pills; unlike assistant decoration, changes no bold or marks. */
export function decorateStatePills(markdown: string, theme: Theme): string {
  return decorateLines(markdown, (line) => decoratePillsLine(theme, line));
}

function decorateLine(theme: Theme, line: string): string {
  const decisionLine = line.trimStart().startsWith("[[Decision]]");
  let out = decorateProtectedLine(line, (text) => decorateText(theme, text, decisionLine), PILL_CONTEXT_PROTECTED_RE);

  out = out.replace(LEADING_TREE_RE, (run) => theme.fg(TREE_TONE, run));
  out = out.replace(LEADING_ARROW_RE, (_match, space: string, arrow: string) => `${space}${theme.fg("mdCodeBlockBorder", arrow)}`);
  return out;
}

const TLDR_RE = /^ {0,3}\[\[TLDR\]\]/;
const HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/;
const MIN_RULE = 3;
const RULE_FALLBACK: FgRole = "borderMuted";
const BIND_LIST_RE = /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
// A line that starts some other block, or could turn the heading into a table, setext heading or code.
const BLOCK_START_RE = /^(?: {4,}|\t|\s*(?:```|~~~|>|#|<|\[[^\]]+\]:|[-+*][ \t]|\d+[.)][ \t]|[-*_=]{3,}))|\|/;

function headingWord(line: string): string | undefined {
  const word = HEADING_RE.exec(line)?.[1];
  return word && isAssistantWord(word) ? word : undefined;
}

/** True when the next content line may sit directly under the heading without changing either block. */
function bindsToHeading(lines: string[], index: number): boolean {
  const line = lines[index];
  if (HR_RE.test(line)) return false;
  if (BIND_LIST_RE.test(line)) return true;
  if (BLOCK_START_RE.test(line)) return false;
  return !SETEXT_RE.test(lines[index + 1] ?? "");
}

type Rgb = [number, number, number];

function rgbOf(ansi: string): Rgb | undefined {
  const match = /\x1b\[[34]8;2;(\d+);(\d+);(\d+)m/.exec(ansi);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** The tint role blended `amount` of the way over the pill panel background; undefined unless both are 24-bit. */
function blendInto(theme: Theme, role: FgRole, amount: number): Rgb | undefined {
  const fg = rgbOf(theme.getFgAnsi(role));
  const bg = rgbOf(theme.getBgAnsi("selectedBg"));
  if (!fg || !bg) return undefined;
  return fg.map((c, i) => Math.round(bg[i] + (c - bg[i]) * amount)) as Rgb;
}

/** True when the standalone paragraph starting at `index` is the last content of the text. */
function closesText(lines: string[], index: number): boolean {
  let last = lines.length - 1;
  while (last > index && lines[last].trim() === "") last--;
  return lines.slice(index + 1, last + 1).every((line) => line.trim() !== "");
}

function paintRule(theme: Theme, tint: FgRole, fill: string): string {
  const blended = tint === "muted" ? undefined : blendInto(theme, tint, tint === "mdLink" ? 0.45 : 0.3);
  return blended ? `\x1b[38;2;${blended.join(";")}m${fill}\x1b[39m` : theme.fg(RULE_FALLBACK, fill);
}

/** Bold tinted word and a faint rule filling the line; the rule is left out when under MIN_RULE cells remain, so it can never wrap. */
function renderHeading(theme: Theme, word: string, availableWidth: number): string {
  const tint = tintOf(word);
  const label = theme.bold(theme.fg(tint, word));
  const fillWidth = availableWidth - visibleWidth(label) - 1;
  return fillWidth < MIN_RULE ? label : `${label} ${paintRule(theme, tint, "─".repeat(fillWidth))}`;
}

/**
 * Display-only assistant Markdown: quiet words, colored bold, marks, tree lines
 * and `## Word` headings. The closing `[[TLDR]]` paragraph of the reply gets one
 * rule above it, with a Markdown hard break so the sentence starts on the next
 * row. Rules and headings need `availableWidth` and a settled message;
 * while streaming (or without a width) they stay plain Markdown.
 *
 * A heading becomes its own paragraph (a blank line is added before it when text
 * precedes it). When a list item or prose follows, the blank lines beneath are
 * dropped and the heading ends in a Markdown hard break, so the content starts on
 * the next row; before any other block the normal gap stays.
 */
function decorateSections(markdown: string, theme: Theme, availableWidth: number, isStreaming: boolean, atTail: boolean): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence || INDENTED_CODE_RE.test(line)) {
      out.push(line);
      continue;
    }
    const settled = availableWidth > 0 && !isStreaming;
    if (settled && atTail && availableWidth >= MIN_RULE && TLDR_RE.test(line) && (out.length === 0 || out[out.length - 1].trim() === "") && closesText(lines, i)) {
      out.push(`${theme.fg(RULE_FALLBACK, "─".repeat(availableWidth))}  `);
      out.push(decorateLine(theme, line));
      continue;
    }
    const word = settled ? headingWord(line) : undefined;
    if (!word) {
      out.push(decorateLine(theme, line));
      continue;
    }
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    const heading = renderHeading(theme, word, availableWidth);
    const next = lines.findIndex((candidate, at) => at > i && candidate.trim() !== "");
    if (next >= 0 && bindsToHeading(lines, next)) {
      out.push(`${heading}  `);
      i = next - 1;
    } else {
      out.push(heading);
      if (i + 1 < lines.length && lines[i + 1].trim() !== "") out.push("");
    }
  }
  return out.join("\n");
}

/** Display-only assistant Markdown: Decision boxes, and everything else through decorateSections. */
export function decorateAssistantMarkdown(markdown: string, theme: Theme, availableWidth = 0, isStreaming = false): string {
  const edge = (text: string): string => {
    const blended = blendInto(theme, "warning", 0.5);
    return blended ? `\x1b[38;2;${blended.join(";")}m${text}\x1b[39m` : theme.fg("muted", text);
  };
  // A segment is the reply's tail when it ends the whole Markdown; segments before a Decision box do not.
  const tail = markdown.trimEnd();
  return decorateDecisionBoxes(markdown, theme, availableWidth, isStreaming, edge, (text) =>
    decorateSections(text, theme, availableWidth, isStreaming, tail.endsWith(text.trimEnd())),
  );
}
