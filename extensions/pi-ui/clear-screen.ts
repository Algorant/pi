import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Container, CURSOR_MARKER } from "@earendil-works/pi-tui";

let currentTui: TUI | undefined;

// Regular mode only: the terminal owns scrollback there.
function clearTerminal() {
  // Clear the visible screen, move to the top-left, and preserve scrollback.
  // Do not ask Pi for a full redraw, because that redraws the transcript and
  // anchors back down.
  process.stdout.write("\x1b[H\x1b[2J");

  // Best-effort: draw only Pi's input area + footer at the top of the cleared
  // screen. We intentionally do not update Pi's internal render state here.
  if (!currentTui) return;

  const width = currentTui.terminal.columns;
  const children = ((currentTui as unknown as { children?: Component[] }).children ?? []);

  // Pi layout is: header, chat, pending, status, widgetAbove, editor,
  // widgetBelow, footer. Rendering only the tail avoids replaying chat history.
  const tail = children.slice(Math.max(0, children.length - 4));
  const lines = tail.flatMap((child) => child.render(width));

  let cursorRow = Math.max(0, lines.length - 1);
  let cursorCol = 0;
  for (let row = 0; row < lines.length; row++) {
    const index = lines[row].indexOf(CURSOR_MARKER);
    if (index !== -1) {
      cursorRow = row;
      cursorCol = visibleWidthApprox(lines[row].slice(0, index));
      lines[row] = lines[row].slice(0, index) + lines[row].slice(index + CURSOR_MARKER.length);
      break;
    }
  }

  process.stdout.write(lines.join("\r\n"));
  process.stdout.write(`\x1b[${cursorRow + 1};${cursorCol + 1}H`);
}

function visibleWidthApprox(text: string): number {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_pi:c\x07/g, "")
    .length;
}

export function registerClearScreen(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setWidget("pi-ui-clear-screen-tui-capture", (tui) => {
      currentTui = tui;
      return new Container();
    });
  });

  pi.on("session_shutdown", async () => {
    currentTui = undefined;
  });

  pi.registerShortcut("ctrl+l", {
    description: "Clear the screen (regular mode) or redraw it (fullscreen mode)",
    handler: () => {
      // Fullscreen Pi owns the whole viewport and repaints only rows it believes
      // changed, so writing a clear behind its back leaves its render state out
      // of sync (editor drawn at the top, typing repainted at the bottom).
      // There, Ctrl+L asks Pi for a full repaint from its own state instead.
      if (currentTui?.mode === "fullscreen") {
        currentTui.requestRender(true);
        return;
      }
      clearTerminal();
    },
  });
}
