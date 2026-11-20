import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Assistant-side emphasis drawing (task-750).
 *
 * Drawing only. `user-message.ts` still owns pi-ui's single Markdown
 * transformer and hands assistant text here; Pi parses Markdown after the
 * transformer, so the ANSI inserted inside existing syntax survives. The stored
 * message, the model context, the user rails and every non-assistant surface are
 * untouched.
 *
 * Rules kept deliberately small:
 * - `[[Word]]` becomes a pill only for the approved vocabulary; anything else
 *   stays literal, so an unknown label is never destroyed.
 * - `**bold**` keeps its asterisks and gets an existing Verdigris foreground
 *   role; the fixed house labels also get a Nerd Font icon.
 * - Inline marks and tree lines are colored.
 * - Inline code, fenced code, indented code and links are never rewritten.
 *
 * Every color is an existing theme role. Pill body text is always the theme's
 * `text` role on a theme panel background (>= 10.5:1 in Verdigris); the tone
 * lives in the cap and icon, so no pill falls to 3:1 unreadability.
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
  "Needs you": { icon: "\u{F007}", tone: WARN },
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
  "Your move": { icon: "\u{F061}", tone: INFO },
  TLDR: { icon: "\u{F02B}", tone: PLAIN },
  "Up next": { icon: "\u{F148}", tone: INFO },
  Delivered: { icon: "\u{F0D1}", tone: GOOD },
  Now: { icon: "\u{F111}", tone: PLAIN },
  "Git state": { icon: "\u{E702}", tone: PLAIN },
};

/** House labels Herdra writes as a bold lead-in, with their own tone. */
const LABELS: Record<string, { icon: string; tone: FgRole }> = {
  "Your move": { icon: PILL_WORDS["Your move"].icon, tone: "warning" },
  TLDR: { icon: PILL_WORDS.TLDR.icon, tone: "mdCodeBlockBorder" },
  "Up next": { icon: PILL_WORDS["Up next"].icon, tone: "mdCodeBlockBorder" },
  Delivered: { icon: PILL_WORDS.Delivered.icon, tone: "accent" },
  Now: { icon: PILL_WORDS.Now.icon, tone: "muted" },
  "Git state": { icon: PILL_WORDS["Git state"].icon, tone: "muted" },
};

/** Pill words doubled as bold lead-ins (`**At risk:**`) keep their icon and tone. */
const BOLD_LABELS: Record<string, { icon: string; tone: FgRole }> = {
  ...Object.fromEntries(
    Object.entries(PILL_WORDS).map(([word, pill]) => [word, { icon: pill.icon, tone: pill.tone.accent }]),
  ),
  ...LABELS,
};

const BOLD_TONE: FgRole = "mdCodeBlockBorder";
const TREE_TONE: FgRole = "muted";

const FENCE_RE = /^\s*(```|~~~)/;
const INDENTED_CODE_RE = /^(?: {4,}|\t)/;
const LEADING_TREE_RE = /^(\s*(?:[│├└][─ ]*)+)/;
const LEADING_ARROW_RE = /^(\s*)(→)/;
const PROTECTED_RE = /`[^`\n]*`|\[[^\]\n]*\]\([^)\n]*\)/g;
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

function renderPill(theme: Theme, word: PillWord, label: string): string {
  const left = cap(theme, word.tone.bg, "\u{E0B6}");
  const right = cap(theme, word.tone.bg, "\u{E0B4}");
  const body = `${theme.fg(word.tone.accent, `${PAD}${word.icon}${PAD}`)}${theme.bold(theme.fg("text", `${label.replaceAll(" ", PAD)}${PAD}`))}`;
  return `${left}${theme.bg(word.tone.bg, body)}${right}`;
}

function decorateText(theme: Theme, text: string): string {
  let out = text.replace(BOLD_RE, (_match, inner: string) => {
    const key = inner.replace(/:$/, "").trim();
    const label = BOLD_LABELS[key];
    const icon = label ? theme.fg(label.tone, label.icon) : "";
    return label ? `${icon} **${theme.fg(BOLD_TONE, inner)}**` : `**${theme.fg(BOLD_TONE, inner)}**`;
  });

  out = out.replace(PILL_RE, (match, name: string) => {
    const word = PILL_WORDS[name];
    return word ? renderPill(theme, word, name) : match;
  });

  return out.replace(/✓|✗/g, (mark) => theme.fg(mark === "✓" ? "accent" : "error", mark));
}

function decorateLine(theme: Theme, line: string): string {
  // Split around spans that must stay byte-identical: inline code and links.
  const parts: string[] = [];
  let last = 0;
  PROTECTED_RE.lastIndex = 0;
  for (let match = PROTECTED_RE.exec(line); match; match = PROTECTED_RE.exec(line)) {
    parts.push(decorateText(theme, line.slice(last, match.index)));
    parts.push(match[0]);
    last = match.index + match[0].length;
  }
  parts.push(decorateText(theme, line.slice(last)));
  let out = parts.join("");

  out = out.replace(LEADING_TREE_RE, (run) => theme.fg(TREE_TONE, run));
  out = out.replace(LEADING_ARROW_RE, (_match, space: string, arrow: string) => `${space}${theme.fg("mdCodeBlockBorder", arrow)}`);
  return out;
}

/** Display-only assistant Markdown: pills, label icons, colored bold, marks and tree lines. */
export function decorateAssistantMarkdown(markdown: string, theme: Theme): string {
  let inFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || INDENTED_CODE_RE.test(line)) return line;
      return decorateLine(theme, line);
    })
    .join("\n");
}
