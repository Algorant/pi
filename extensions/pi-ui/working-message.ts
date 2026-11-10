import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Whimsy words for Pi's native working indicator (Algorant picked this over a
 * fixed label): one at random each turn, no ticker, no widget section.
 */
const WORKING_MESSAGES = [
  "Pondering...",
  "Scheming...",
  "Noodling...",
  "Tinkering...",
  "Futzing...",
  "Musing...",
  "Cogitating...",
  "Percolating...",
  "Whirring...",
  "Untangling...",
  "Wrangling...",
  "Spelunking...",
  "Rummaging...",
  "Sleuthing...",
  "Foraging...",
  "Combing...",
  "Diffing...",
  "Grepping...",
  "Refactoring...",
  "Linting...",
  "Compiling...",
  "Debugging...",
  "Rebasing...",
  "Squinting...",
  "Listening...",
  "Sketching...",
  "Polishing...",
  "Stitching...",
  "Weaving...",
  "Soldering...",
  "Calibrating...",
  "Distilling...",
  "Synthesizing...",
  "Conjuring...",
  "Summoning...",
  "Enchanting...",
  "Bewitching...",
  "Hexing...",
  "Yodeling...",
  "Honking...",
  "Blorping...",
  "Zorping...",
  "Wibbling...",
  "Wobbling...",
  "Blooping...",
  "Booping...",
  "Scooting...",
  "Scampering...",
  "Skittering...",
  "Sashaying...",
  "Moseying...",
  "Snooping...",
  "Unhaunting...",
  "Demystifying...",
  "Recombobulating...",
];

function pickWorkingMessage(): string {
  return WORKING_MESSAGES[Math.floor(Math.random() * WORKING_MESSAGES.length)]!;
}

/** Use Pi's native loader, with a random word each turn. */
export function registerWorkingMessage(pi: ExtensionAPI): void {
  pi.on("turn_start", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage(pickWorkingMessage());
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
  });
}
