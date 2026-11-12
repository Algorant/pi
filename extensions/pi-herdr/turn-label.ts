import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { NSTAR_INBOX } from "../pi-agency/nstar-note.ts";
import { ageText, openMessages } from "../pi-agency/inbox/envelope.ts";
import { hcJson } from "./core.ts";

const MAX_LABEL_LENGTH = 160;
/** Most owed message ids one label lists; the rest are counted. */
const MAX_OWED = 6;
/** One reload, said once: emitted by `reload.ts` after a self-reload (or when it had to stay pending). */
export const SELF_RELOAD_EVENT = "pi-herdr:self-reload";
export type SelfReloadState = { from: string; to: string; pending?: string };

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

/**
 * `m074351c8 1h m0751b2c3 4m`: the requests and blocked messages delivered to this terminal that are
 * still unanswered, oldest first, ids and ages only (task dropped-request). One mtime-cached journal
 * read, no extra process beyond the label write that already happens; empty when nothing is owed.
 */
export function owedLabel(terminal: string): string {
  const owed = openMessages().filter((view) => !!view.delivered && view.to.terminal === terminal);
  if (owed.length === 0) return "";
  const shown = owed.slice(0, MAX_OWED).map((view) => `${view.id} ${ageText(view.at)}`);
  return `${shown.join(" ")}${owed.length > MAX_OWED ? ` +${owed.length - MAX_OWED}` : ""}`;
}

/** Publish the completed turn's origin and visible reply through HC's native label path. */
export function registerHcTurnLabels(pi: ExtensionAPI): void {
  let inboxStarted = false;
  let turnOrigin: "person" | "agent" = "person";
  // Set by a self-reload and consumed by the very next turn: the note never outlives the code change it names.
  let reload: { say: string; field: string } | undefined;
  pi.events.on(SELF_RELOAD_EVENT, (state) => {
    const { to, pending } = state as SelfReloadState;
    reload = pending ? { say: `reload pending: ${pending}`, field: "pending" } : { say: `reloaded to ${to}`, field: to };
  });
  pi.events.on(NSTAR_INBOX, () => { inboxStarted = true; });
  pi.on("input", (event) => {
    if (event.text.startsWith("<hc from=")) inboxStarted = true;
  });
  pi.on("agent_start", async () => {
    turnOrigin = inboxStarted ? "agent" : "person";
    inboxStarted = false;
    // The turn starts with what is owed: a request delivered to this Pi and not yet answered.
    await hcJson(["label", process.env.HC_TERMINAL_ID!, `pi.turn=${turnOrigin}`, `pi.say=${reload?.say ?? ""}`,
      `pi.reloaded=${reload?.field ?? ""}`, `pi.owed=${owedLabel(process.env.HC_TERMINAL_ID!)}`]);
    reload = undefined;
  });
  pi.on("agent_end", async (event) => {
    // Refreshed here too, so the label between turns never claims a request this turn answered.
    await hcJson(["label", process.env.HC_TERMINAL_ID!, `pi.turn=${turnOrigin}`, `pi.say=${labelLine(replyText(event))}`,
      "pi.reloaded=", `pi.owed=${owedLabel(process.env.HC_TERMINAL_ID!)}`]);
    reload = undefined;
  });
}
