/**
 * Compact custom Pi startup header: extension, skill and tool names in one place.
 *
 * Skills and tools are this runtime's loaded set. Pi exposes no list of loaded
 * extensions, so extensions are the agent directory's folders, which are what a
 * normal session loads; a --no-extensions/-e helper or test loads fewer.
 */
import { getAgentDir, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

let cachedVersion: string | undefined;
let cachedExtensionNames: string[] | undefined;

function getPiVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = execFileSync("pi", ["-v"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    }).trim();
  } catch {
    cachedVersion = "";
  }
  return cachedVersion;
}

/** Folders of the agent directory that hold an extension entry point. */
function extensionNames(): string[] {
  if (cachedExtensionNames !== undefined) return cachedExtensionNames;
  const dir = join(getAgentDir(), "extensions");
  try {
    cachedExtensionNames = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ["index.ts", "index.js", "index.mts", "index.mjs", "index.cts", "index.cjs"].some((file) => existsSync(join(dir, entry.name, file))))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    cachedExtensionNames = [];
  }
  return cachedExtensionNames;
}

function buildHeader(theme: Theme, width: number, extensionList: string[], skillNames: string[], toolCount: number): string[] {
  const asciiArt = [
    "   ███████████████████████████╗  ",
    "   ╚══██████╔════════██████╔══╝  ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "      ██████║        ██████║     ",
    "   ████████████╗  ████████████╗  ",
    "   ╚═══════════╝  ╚═══════════╝  ",
  ].map((line) => theme.bold(theme.fg("warning", line)));
  const version = getPiVersion();
  const extensionLabel = theme.bold(theme.fg("accent", `Extensions (${extensionList.length})`));
  const extensions = extensionList.length ? extensionList.join(", ") : "None";
  const skillLabel = theme.bold(theme.fg("accent", `Skills (${skillNames.length})`));
  const skills = skillNames.length ? skillNames.join(", ") : "None";
  const toolLabel = theme.bold(theme.fg("accent", `Tools (${toolCount})`));
  const lines = ["", ...asciiArt, "", theme.bold(theme.fg("accent", "pi")) + (version ? theme.fg("dim", ` v${version}`) : ""),
    "", extensionLabel, ...wrap(extensions, width), "", skillLabel, ...wrap(skills, width), "", toolLabel];
  return lines.map((line) => truncateToWidth(line, Math.max(1, width), "", true));
}

function wrap(value: string, width: number): string[] {
  const maxWidth = Math.max(1, width);
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "  ".slice(0, Math.max(0, maxWidth - 1));
  for (const word of words) {
    const next = line.length > 0 ? `${line} ${word}` : word;
    if (next.length <= maxWidth) line = next;
    else {
      if (line.trim()) lines.push(line);
      line = `  ${word}`.slice(0, maxWidth);
    }
  }
  if (line.trim()) lines.push(line);
  return lines;
}

function getRuntimeSkillNames(pi: ExtensionAPI): string[] {
  const names = new Set<string>();
  for (const command of pi.getCommands()) {
    if (command.source !== "skill") continue;
    const path = command.sourceInfo.path;
    const name = path.endsWith("/SKILL.md") ? path.split("/").at(-2) : path.split("/").at(-1)?.replace(/\.[^.]+$/, "");
    if (name) names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function registerStartupHeader(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const extensions = extensionNames();
    const skills = getRuntimeSkillNames(pi);
    const toolCount = pi.getAllTools().length;
    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) => buildHeader(theme, width, extensions, skills, toolCount),
      invalidate() {},
    }));
  });
}
