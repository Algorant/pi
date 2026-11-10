import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Cross-frame render memoization for pi-ui tool cards.
 *
 * Pi calls `render(width)` on every transcript component on every frame, so an
 * uncached card rebuilds its borders, title, dividers and truncation on every
 * keystroke, once per card in the whole transcript. These helpers keep a
 * settled card's rendered lines and return them again while the render inputs
 * stay the same.
 *
 * Cached lines are never handed out directly. `read()` and `write()` return a
 * copy, so a caller that mutates the returned array cannot corrupt the cache.
 * The copy is one shallow array clone per card per frame, which is negligible
 * next to a full rebuild.
 */

/**
 * Theme entries a pi-ui card can use. Probing all of them keeps one shared
 * signature for every card type; over-invalidation is safe, stale colors are not.
 */
const SIGNATURE_COLORS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "dim",
  "error",
  "muted",
  "success",
  "text",
  "toolTitle",
  "toolOutput",
  "userMessageText",
  "warning",
] as const;

/** Zero-width-free probe text that no card content can contain. */
const PROBE = "\u0001";

/**
 * Build a cheap fingerprint of the active theme.
 *
 * Pi hands extensions a proxy whose identity never changes when the theme
 * changes, so a reference check cannot detect a new theme. Pi does call
 * `invalidate()` on a theme change, and pi-ui cards also rebuild their model
 * through `setModel`, but this signature makes cached lines correct even if a
 * theme swap ever reaches `render()` without either signal.
 */
export function themeSignature(theme: Theme): string {
  let signature = theme.bold(PROBE);
  for (const color of SIGNATURE_COLORS) {
    signature += `\u0002${theme.fg(color, PROBE)}`;
  }
  return signature;
}

function sameInputs(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

/** One component's memoized render output. */
export class RenderCache {
  private width: number | undefined;
  private signature: string | undefined;
  private inputs: readonly unknown[] | undefined;
  private lines: string[] | undefined;

  /** Cached lines for these render inputs, or `undefined` on a miss. */
  read(width: number, signature: string, inputs?: readonly unknown[]): string[] | undefined {
    if (this.lines === undefined) return undefined;
    if (this.width !== width || this.signature !== signature) return undefined;
    if (!sameInputs(this.inputs, inputs)) return undefined;
    return this.lines.slice();
  }

  /** Store freshly built lines and return a copy for the caller. */
  write(width: number, signature: string, lines: string[], inputs?: readonly unknown[]): string[] {
    this.width = width;
    this.signature = signature;
    this.inputs = inputs === undefined ? undefined : [...inputs];
    this.lines = lines;
    return lines.slice();
  }

  /** Drop cached lines. Called from `invalidate()` and from model updates. */
  clear(): void {
    this.width = undefined;
    this.signature = undefined;
    this.inputs = undefined;
    this.lines = undefined;
  }
}

/** Escape sequences (CSI first, then OSC/DCS/APC/PM/SOS strings, then two-byte) and C0 controls except tab. */
const TERMINAL_CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[ -~]?|[\x00-\x08\x0a-\x1f\x7f]/g;
const SGR = /^\x1b\[[0-9;:]*m$/;

/**
 * Keep only SGR styling in a rendered card line. Raw tool output (a script's
 * OSC 7501 program status, a title, a cursor move) would otherwise reach the
 * calling Pi's own terminal, which then reports it as its own: a bash card that
 * printed `app=scriptify` made the caller Pi's hc status.app `scriptify`.
 * Stock Pi strips tool output the same way before rendering it.
 */
export function terminalSafeLine(line: string): string {
  return line.replace(TERMINAL_CONTROL, (match) => (SGR.test(match) ? match : ""));
}

/**
 * Return memoized lines for `width`, rebuilding through `build` only when the
 * width, the theme, or one of the identity-compared `inputs` changed. Every
 * built line passes `terminalSafeLine`, the one output boundary of pi-ui cards.
 */
export function renderCached(
  cache: RenderCache,
  width: number,
  theme: Theme,
  build: (width: number) => string[],
  inputs?: readonly unknown[],
): string[] {
  const signature = themeSignature(theme);
  const cached = cache.read(width, signature, inputs);
  if (cached !== undefined) return cached;
  return cache.write(width, signature, build(width).map(terminalSafeLine), inputs);
}
