import { commandLabel } from "./labels";

export type CommandSummary = {
  displayName: string;
  displayArgs?: string;
  label?: string;
  primarySegment: string;
  segments: string[];
  cwdChange?: string;
  isShellBuiltin?: boolean;
  confidence: "high" | "medium" | "low";
};

const SHELL_BUILTINS = new Set(["cd", "pwd", "export", "source", ".", "alias", "unalias", "set", "shopt", "unset", "read", "test", "[", "echo", "printf"]);
const SETUP_BUILTINS = new Set(["set", "shopt", "export", "alias", "unalias"]);
const LOW_SIGNAL_PREFIX_BUILTINS = new Set(["cd", "pwd", "printf", "echo"]);
const COMMAND_SUMMARY_WIDTH = 112;
const ARG_SUMMARY_WIDTH = 88;

export function summarizeCommand(command: string, cwd: string): CommandSummary {
  void cwd;
  return summarizeCommandInner(command, 0, undefined);
}

function summarizeCommandInner(command: string, depth: number, inheritedCwdChange: string | undefined): CommandSummary {
  const segments = splitShellSegments(command);
  const cwdChange = inheritedCwdChange ?? leadingCwdChange(segments);
  const primarySegment = choosePrimarySegment(segments);
  const tokens = tokenizeShellSegment(primarySegment);

  if (depth < 3) {
    const shellScript = extractShellScript(tokens);
    if (shellScript) {
      const nested = summarizeCommandInner(shellScript, depth + 1, cwdChange);
      return {
        ...nested,
        segments: [...segments, ...nested.segments],
        cwdChange: cwdChange ?? nested.cwdChange,
        confidence: nested.confidence === "low" ? "medium" : nested.confidence,
      };
    }
  }

  const executableIndex = findExecutableIndex(tokens);
  const executable = executableName(tokens[executableIndex]);
  if (!executable) {
    const displayName = compactCommand(primarySegment) || "shell";
    return {
      displayName,
      primarySegment,
      segments,
      cwdChange,
      confidence: "low",
    };
  }

  const displayArgs = compactArgs(tokens.slice(executableIndex + 1).join(" "));
  return {
    displayName: executable,
    displayArgs,
    label: commandLabel(executable),
    primarySegment,
    segments,
    cwdChange,
    isShellBuiltin: SHELL_BUILTINS.has(executable),
    confidence: executableIndex === 0 ? "high" : "medium",
  };
}

export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";" || char === "\n" || (char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushSegment(segments, current);
      current = "";
      if ((char === "&" && next === "&") || (char === "|" && next === "|")) index++;
      continue;
    }

    current += char;
  }

  pushSegment(segments, current);
  return segments.length > 0 ? segments : [command.trim()].filter(Boolean);
}

export function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < segment.length; index++) {
    const char = segment[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) tokens.push(current);
  return tokens;
}

function pushSegment(segments: string[], segment: string): void {
  const trimmed = segment.trim();
  if (trimmed.length > 0) segments.push(trimmed);
}

function choosePrimarySegment(segments: string[]): string {
  const meaningful = segments.find((segment) => {
    const tokens = tokenizeShellSegment(segment);
    const executable = executableName(tokens[findExecutableIndex(tokens)]);
    return !isAssignmentOnlySegment(segment, tokens, executable) && !LOW_SIGNAL_PREFIX_BUILTINS.has(executable ?? "") && !isShellSetupSegment(segment);
  });
  return meaningful ?? segments.find((segment) => executableName(tokenizeShellSegment(segment)[findExecutableIndex(tokenizeShellSegment(segment))]) !== "cd") ?? segments[0] ?? "";
}

export function isShellSetupSegment(segment: string): boolean {
  const tokens = tokenizeShellSegment(segment);
  const executable = executableName(tokens[findExecutableIndex(tokens)]);
  if (!executable || !SETUP_BUILTINS.has(executable)) return false;
  if (executable === "set") return true;
  if (executable === "shopt") return true;
  if (executable === "export") return tokens.slice(1).every((token) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
  return true;
}

function isAssignmentOnlySegment(segment: string, tokens: string[], executable: string | undefined): boolean {
  if (tokens.length > 0 && tokens.every(isEnvAssignment)) return true;
  const startsWithAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.trim());
  return startsWithAssignment && (!executable || executable.startsWith("-"));
}

function leadingCwdChange(segments: string[]): string | undefined {
  if (segments.length < 2) return undefined;
  const tokens = tokenizeShellSegment(segments[0] ?? "");
  const executableIndex = findExecutableIndex(tokens);
  if (executableName(tokens[executableIndex]) !== "cd") return undefined;
  return tokens[executableIndex + 1] || "~";
}

function extractShellScript(tokens: string[]): string | undefined {
  const shellIndex = findExecutableIndex(tokens);
  if (!isShellExecutable(tokens[shellIndex])) return undefined;

  for (let index = shellIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token === "--") return tokens[index + 1];
    if (!token.startsWith("-")) return undefined;
    if (token.includes("c")) return tokens[index + 1];
  }

  return undefined;
}

function findExecutableIndex(tokens: string[]): number {
  let index = 0;

  while (index < tokens.length) {
    while (isEnvAssignment(tokens[index])) index++;

    const executable = executableName(tokens[index]);
    if (executable === "command" || executable === "builtin" || executable === "exec") {
      index++;
      continue;
    }

    if (executable === "sudo") {
      index = skipSudoOptions(tokens, index + 1);
      continue;
    }

    if (executable === "env") {
      index = skipEnvOptionsAndAssignments(tokens, index + 1);
      continue;
    }

    if (executable === "timeout") {
      index = skipTimeoutOptions(tokens, index + 1);
      continue;
    }

    break;
  }

  return index;
}

function skipSudoOptions(tokens: string[], index: number): number {
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++];
    if (option === "--") break;
    if (sudoOptionTakesValue(option)) index++;
  }
  return index;
}

function skipEnvOptionsAndAssignments(tokens: string[], index: number): number {
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++];
    if (option === "--") break;
    if (envOptionTakesValue(option)) index++;
  }
  while (isEnvAssignment(tokens[index])) index++;
  return index;
}

function skipTimeoutOptions(tokens: string[], index: number): number {
  while (tokens[index]?.startsWith("-")) {
    const option = tokens[index++];
    if (option === "--") break;
    if (timeoutOptionTakesValue(option)) index++;
  }
  if (tokens[index] && /^\d+(?:\.\d+)?[smhd]?$/.test(tokens[index])) index++;
  return index;
}

function sudoOptionTakesValue(option: string | undefined): boolean {
  return ["-A", "-a", "-C", "-c", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u"].includes(option ?? "")
    || ["--askpass", "--auth-type", "--chdir", "--close-from", "--group", "--host", "--login-class", "--prompt", "--role", "--type", "--user"].includes(option ?? "");
}

function envOptionTakesValue(option: string | undefined): boolean {
  return ["-C", "-u", "-S", "--chdir", "--unset", "--split-string"].includes(option ?? "");
}

function timeoutOptionTakesValue(option: string | undefined): boolean {
  return ["-k", "--kill-after", "-s", "--signal"].includes(option ?? "");
}

function isShellExecutable(token: string | undefined): boolean {
  const name = executableName(token);
  return name === "sh" || name === "bash" || name === "zsh" || name === "fish";
}

function executableName(token: string | undefined): string | undefined {
  return token?.split("/").pop();
}

function isEnvAssignment(token: string | undefined): boolean {
  return Boolean(token && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
}

function compactArgs(args: string): string | undefined {
  const compact = compactCommand(args);
  if (compact.length === 0) return undefined;
  return truncatePlain(compact, ARG_SUMMARY_WIDTH);
}

function compactCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function truncatePlain(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function compactCommandSummary(command: string): string {
  return truncatePlain(compactCommand(command), COMMAND_SUMMARY_WIDTH);
}
