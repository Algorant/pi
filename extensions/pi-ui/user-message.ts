import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Patch-free user-message treatment (decision-23).
 *
 * Both rails are display-only Markdown produced by the single pi-ui Markdown
 * transformer. The stored user message and the model context are unchanged, and
 * nothing is written to the session, so reload and session-tree navigation
 * redraw the rails from the message itself.
 *
 * Pi wraps user messages in a Box with one line of vertical padding and adds a
 * Spacer(1) before them. Keeping both rails inside the same Markdown block is
 * what makes their spacing symmetric; a separate transcript entry would inherit
 * that spacer and pad on one side only.
 */

/**
 * A pasted image's path, immediately followed by the marker the pasted-image
 * handler appends (Herdr's herdr-paste-* or Pi's pi-clipboard-*). The display
 * hides the path; the stored message keeps it, so the model and helpers can
 * still open the file (task-652, task-561).
 */
const ATTACHED_IMAGE_PATH_RE =
  /(?<=^|[\s(["'`])@?["'`]?\/[^\n\r\t "'`<>()[\]{}]+\.(?:bmp|dib|png|jpe?g|webp|gif)["'`]?[ \t]+\[pasted image attached\]/gim;

const USER_GLYPH = "\u{F0004}";
const USER_LABEL = "User";
const RAIL_GLYPH = "─";
const RAIL_ROLE = "borderMuted";
// Pi's ThemeColor set is fixed and has no user-label role. `userMessageText` is
// the body color and is intentionally blank so user text renders as normal text,
// so the label borrows `mdLink`, which resolves to the theme's `secondary` var
// (verdigris blue #83a598).
const LABEL_ROLE = "mdLink";

export function renderTopRail(theme: Theme, availableWidth: number): string {
  const label = theme.bold(theme.fg(LABEL_ROLE, `${USER_GLYPH} ${USER_LABEL}`));
  const fill = RAIL_GLYPH.repeat(Math.max(1, availableWidth - visibleWidth(label) - 1));
  return `${label}${theme.fg(RAIL_ROLE, ` ${fill}`)}`;
}

export function renderBottomRail(theme: Theme, availableWidth: number): string {
  return theme.fg(RAIL_ROLE, RAIL_GLYPH.repeat(Math.max(1, availableWidth)));
}

export function addRails(markdown: string, theme: Theme, availableWidth: number): string {
  const top = renderTopRail(theme, availableWidth);
  const bottom = renderBottomRail(theme, availableWidth);
  return `${top}\n\n${markdown}\n\n${bottom}`;
}

export function registerUserMessageUi(pi: ExtensionAPI): void {
  let currentCtx: ExtensionContext | undefined;

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on("session_tree", async (_event, ctx) => {
    currentCtx = ctx;
  });

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
  });

  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== "user") return markdown;
    const ctx = currentCtx;
    if (!ctx?.hasUI) return markdown;
    const displayed = markdown.replace(ATTACHED_IMAGE_PATH_RE, "[pasted image attached]");
    return addRails(displayed, ctx.ui.theme, context.availableWidth);
  });
}
