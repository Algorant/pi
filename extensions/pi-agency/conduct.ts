import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SLEEP = /\bsleep\s+(infinity|[\d.]+)\s*([smhd])?\b/i;
const SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** A managed Pi never sleeps to wait: end the turn, and the inbox brings the news. */
export default function registerNoSleep(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown })?.command;
    if (typeof command !== "string") return;
    const match = SLEEP.exec(command);
    if (!match) return;
    const amount = match[1].toLowerCase() === "infinity"
      ? Infinity
      : Number(match[1]) * (SECONDS[match[2] ?? "s"] ?? 1);
    if (amount < 2) return;
    throw new Error("Refused: a managed Pi does not sleep. End the turn; the inbox delivers when work finishes.");
  });
}
