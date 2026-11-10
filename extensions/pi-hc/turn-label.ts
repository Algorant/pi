import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NSTAR_INBOX } from "../pi-agency/nstar-note.ts";
import { hcJson } from "./core.ts";

const MAX_LABEL_LENGTH = 160;

function replyText(event: unknown): string {
  const messages = (event as { messages?: unknown[] } | undefined)?.messages;
  const assistant = messages?.filter((message) => (message as { role?: string })?.role === "assistant").at(-1) as
    { content?: unknown } | undefined;
  if (typeof assistant?.content === "string") return assistant.content;
  if (!Array.isArray(assistant?.content)) return "";
  return assistant.content
    .filter((part): part is { type?: string; text?: string } => !!part && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function labelLine(reply: string): string {
  const lines = reply.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tldr = lines.findLast((line) => /^TLDR\b/i.test(line));
  return (tldr ?? lines[0] ?? "").replace(/[\r\n]+/g, " ").slice(0, MAX_LABEL_LENGTH);
}

/** Publish the completed turn's origin and visible reply through HC's native label path. */
export function registerHcTurnLabels(pi: ExtensionAPI): void {
  let inboxStarted = false;
  let turnOrigin: "person" | "agent" = "person";
  pi.events.on(NSTAR_INBOX, () => { inboxStarted = true; });
  pi.on("input", (event) => {
    if (event.text.startsWith("<hc from=")) inboxStarted = true;
  });
  pi.on("agent_start", async () => {
    turnOrigin = inboxStarted ? "agent" : "person";
    inboxStarted = false;
    await hcJson(["label", process.env.HC_TERMINAL_ID!, `pi.turn=${turnOrigin}`, "pi.say="]);
  });
  pi.on("agent_end", async (event) => {
    await hcJson(["label", process.env.HC_TERMINAL_ID!, `pi.turn=${turnOrigin}`, `pi.say=${labelLine(replyText(event))}`]);
  });
}
