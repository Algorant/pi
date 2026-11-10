import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createNstarHistoryRenderer } from "../pi-ui/tool-ui/custom-tools/nstar-history.ts";

const execFile = promisify(execFileCallback);
const MESSAGE_QUERY = 'reduce inputs as $entry ([]; if length >= 5 then . else . + [($entry | select(.type == "message" and .message.role == "user") | (.message.content | if type == "string" then . else map(select(.type == "text") | .text) | join("") end) | select(contains($phrase)) | .[0:1200])] end) | map(select(type == "string")) | .[]';
const LOCAL_ROOTS = '"$HOME/.pi/agent/sessions" "$HOME/.pi/sessions" "$HOME/.pi/sessions_archive" "${PI_CODING_AGENT_SESSION_DIR:-}"';
const ARCHBOX_LOCAL_NAME = "homelab-server";
const REMOTE_ROOT = "/srv/data/BIGNAS/agentic/sessions";
const MAX_OUTPUT = 65_536;
const MAX_PHRASE = 300;

type HistoryInput = { phrase: string; otherMachine?: boolean };
type HistoryDetails = { source: "local" | "homelab-server"; messages: number; excerpts: string[] };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function searchScript(phrase: string, roots: string): string {
  return `phrase=${shellQuote(phrase)}; q=${shellQuote(MESSAGE_QUERY)}; set +e; rg --hidden --no-ignore --max-filesize 10M --null -l -F -m 1 -- "$phrase" ${roots} | awk 'BEGIN { RS = "\\0"; ORS = "\\0" } NR <= 5' | xargs -0 -r cat | jq -nc --arg phrase "$phrase" "$q"; statuses=("\${PIPESTATUS[@]}"); if [ "\${statuses[0]}" -gt 1 ]; then exit "\${statuses[0]}"; fi; for status in "\${statuses[@]:1}"; do [ "$status" -eq 0 ] || exit "$status"; done`;
}

function localScript(phrase: string, synced = false): string {
  const roots = synced ? shellQuote(REMOTE_ROOT) : LOCAL_ROOTS;
  return `roots=(); for d in ${roots}; do [ -n "$d" ] && [ -d "$d" ] && roots+=("$d"); done; if [ "\${#roots[@]}" -eq 0 ]; then printf '%s\\n' 'No readable Pi session roots found.' >&2; exit 2; fi; ${searchScript(phrase, '"\${roots[@]}"')}`;
}

function remoteScript(phrase: string): string {
  return searchScript(phrase, shellQuote(REMOTE_ROOT));
}

async function recover(phrase: string, otherMachine: boolean, signal?: AbortSignal): Promise<{ text: string; details: HistoryDetails }> {
  if (!phrase.trim() || phrase.length > MAX_PHRASE) throw new Error(`phrase must contain 1–${MAX_PHRASE} characters.`);
  const source = otherMachine ? "homelab-server" : "local";
  const onArchbox = otherMachine && hostname().split(".")[0] === ARCHBOX_LOCAL_NAME;
  const command = otherMachine && !onArchbox ? "ssh" : "bash";
  const args = command === "ssh"
    ? ["homelab-server", `bash -lc ${shellQuote(remoteScript(phrase))}`]
    : ["-lc", localScript(phrase, onArchbox)];
  let stdout: string;
  try {
    ({ stdout } = await execFile(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: MAX_OUTPUT, signal }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${source === "local" ? "Local" : "Archbox"} conversation search failed: ${message.slice(0, 500)}`);
  }
  let excerpts: string[];
  try {
    excerpts = stdout.trim() ? stdout.trimEnd().split("\n").slice(0, 5).map((line) => {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "string") throw new Error("Search returned a non-text user message.");
      return value.slice(0, 1200);
    }) : [];
  } catch (error) {
    throw new Error(`Could not parse bounded ${source} conversation results: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    text: excerpts.length ? excerpts.join("\n\n") : `No matching user messages found in ${source} session roots.`,
    details: { source, messages: excerpts.length, excerpts },
  };
}

export function registerNstarHistory(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "history",
    label: "Conversation History",
    description: "Recover up to five user messages (each clipped to 1200 characters) containing a known literal phrase from this machine's Pi session folders. Set otherMachine only when the requested conversation happened on another machine; that searches homelab-server's synced session store over SSH, or directly on homelab-server itself. Read-only; never returns assistant or tool transcript entries. User-role is a transcript role, not proof of Algorant authorship or approval.",
    promptSnippet: "Recover bounded user-message excerpts from Pi sessions using a distinctive known phrase",
    promptGuidelines: ["Use history only for recovering a known conversation by a literal distinctive phrase; set otherMachine only when that conversation happened on another machine."],
    parameters: Type.Object({
      phrase: Type.String({ minLength: 1, maxLength: MAX_PHRASE, description: "Distinctive literal phrase from the conversation, not a regex or path." }),
      otherMachine: Type.Optional(Type.Boolean({ description: "Set true only when the requested conversation happened on another machine; searches homelab-server over SSH, or locally when already on homelab-server." })),
    }),
    ...createNstarHistoryRenderer(),
    async execute(_toolCallId, params: HistoryInput, signal) {
      const result = await recover(params.phrase, params.otherMachine === true, signal);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
