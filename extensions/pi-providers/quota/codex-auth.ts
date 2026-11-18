import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";

/**
 * The Codex-plan meter's one credential owner.
 *
 * A fresh sign-in is stored only in this limits-owned file, apart from Pi's
 * own `agent/auth.json`: `ModelRuntime.create({ authPath })` gives the public
 * SDK one store for its whole runtime, so the login writes here, refreshes here
 * and is read here. Pi's stored `openai-codex` credential is neither copied nor
 * read as a fallback: no sign-in, no meter.
 *
 * The meter is the ChatGPT/Codex plan usage that OpenAI's `wham/usage` reports
 * for the official OpenAI Codex OAuth grant. Publishing it as provider `openai`
 * is the approved mapping for the one OpenAI inference route; it is not a
 * verified claim that this is the new direct inference grant's own meter.
 */
export const LIMITS_AUTH_PATH = join(homedir(), ".local", "state", "pi-limits", "codex-auth.json");
export const LIMITS_LOGIN_PROVIDER = "openai-codex";
export const LIMITS_LOGIN_HINT = "OpenAI usage: login needed, run `limits login`";

const LOGIN_CANCELLED = "Login cancelled";

/** No usable limits-owned sign-in: the meter is unknown, never borrowed from Pi or ambient auth. */
export class MissingCodexLoginError extends Error {
  constructor() {
    super("no limits OpenAI sign-in");
    this.name = "MissingCodexLoginError";
  }
}

export function isCodexLoginNeeded(error: unknown): boolean {
  return error instanceof MissingCodexLoginError;
}

/** The operator cancelled the limits sign-in; the CLI reports it as exit 130. */
export class CodexLoginCancelledError extends Error {
  constructor() {
    super("sign-in cancelled");
    this.name = "CodexLoginCancelledError";
  }
}

export function isCodexLoginCancelled(error: unknown): boolean {
  return error instanceof CodexLoginCancelledError;
}

/**
 * Whether the limits file exists at all, so a read never creates an empty store.
 * Only the SDK decides whether it holds a stored credential.
 */
function limitsStoreExists(): boolean {
  return existsSync(LIMITS_AUTH_PATH);
}

let limitsRuntimePromise: Promise<ModelRuntime> | undefined;

function limitsRuntime(): Promise<ModelRuntime> {
  limitsRuntimePromise ??= ModelRuntime.create({ authPath: LIMITS_AUTH_PATH });
  return limitsRuntimePromise;
}

/** The SDK's own configured check: a credential actually stored in the limits file. */
export async function hasCodexLimitsLogin(): Promise<boolean> {
  if (!limitsStoreExists()) return false;
  try {
    const runtime = await limitsRuntime();
    return runtime.getProviderAuthStatus(LIMITS_LOGIN_PROVIDER).source === "stored";
  } catch {
    return false;
  }
}

/**
 * The current access token from the limits store. The SDK resolves it and runs
 * its locked, double-checked OAuth refresh; a credential that is not stored
 * there (none, or an environment token) is not a limits sign-in. A refresh or
 * sync rejection is an expected auth failure and becomes login-needed without
 * carrying the SDK's error text anywhere.
 */
export async function resolveCodexUsageToken(): Promise<string> {
  if (!limitsStoreExists()) throw new MissingCodexLoginError();
  try {
    const runtime = await limitsRuntime();
    if (runtime.getProviderAuthStatus(LIMITS_LOGIN_PROVIDER).source !== "stored") throw new MissingCodexLoginError();
    const resolved = await runtime.getAuth(LIMITS_LOGIN_PROVIDER);
    const accessToken = resolved?.auth.apiKey;
    if (!accessToken) throw new MissingCodexLoginError();
    return accessToken;
  } catch (error) {
    if (error instanceof MissingCodexLoginError) throw error;
    throw new MissingCodexLoginError();
  }
}

/**
 * One line from the operator TTY. Raw mode is deliberate: the OAuth code or
 * redirect URL pasted at the sign-in prompt is credential material, so text
 * input is never echoed (select answers are, since they are just choices).
 * Ctrl+C and EOF cancel; the caller's terminal mode is restored on every exit.
 */
function readLine(secret: boolean, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(new Error(LOGIN_CANCELLED));
      return;
    }
    if (signal?.aborted) {
      reject(new Error(LOGIN_CANCELLED));
      return;
    }
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      signal?.removeEventListener("abort", onAbort);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdout.write("\n");
      settle();
    };
    const onAbort = () => finish(() => reject(new Error(LOGIN_CANCELLED)));
    const onEnd = () => finish(() => reject(new Error(LOGIN_CANCELLED)));
    const onData = (chunk: Buffer) => {
      // Pasted text can carry bracketed-paste/CSI markers around the value.
      const text = chunk.toString("utf8").replace(/\u001b\[[0-9;]*[A-Za-z~]/g, "");
      for (const character of text) {
        if (character === "\u0003" || character === "\u0004") {
          finish(() => reject(new Error(LOGIN_CANCELLED)));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish(() => resolve(value.trim()));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value) {
            value = value.slice(0, -1);
            if (!secret) stdout.write("\b \b");
          }
          continue;
        }
        if (character === "\u001b" || character < " " || character === "\u007f") continue;
        value += character;
        if (!secret) stdout.write(character);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/** SDK UI events only, as their own bounded instructions; no raw error text. */
function notify(event: AuthEvent): void {
  switch (event.type) {
    case "auth_url":
      console.log(`Open this URL to sign in:\n  ${event.url}`);
      if (event.instructions) console.log(event.instructions);
      return;
    case "device_code":
      console.log(`Open ${event.verificationUri} and enter code: ${event.userCode}`);
      console.log("Waiting for authentication...");
      return;
    case "info":
      console.log(event.message.slice(0, 500));
      for (const link of event.links ?? []) console.log(`  ${link.label ? `${link.label}: ` : ""}${link.url}`);
      return;
    case "progress":
      console.log("Waiting for authentication...");
      return;
    default:
      return;
  }
}

async function prompt(request: AuthPrompt, signal: AbortSignal): Promise<string> {
  const promptSignal = combinedSignal(signal, request.signal);
  if (request.type === "select") {
    console.log(request.message);
    request.options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
    });
    for (;;) {
      const answer = await readLine(false, promptSignal);
      const option = /^\d+$/.test(answer) ? request.options[Number(answer) - 1] : request.options.find((candidate) => candidate.id === answer);
      if (option) return option.id;
      console.log(`Enter a number from 1 to ${request.options.length}.`);
    }
  }
  const placeholder = request.placeholder ? ` (${request.placeholder})` : "";
  console.log(`${request.message}${placeholder}`);
  return readLine(true, promptSignal);
}

/**
 * Interactive `limits login`: the official OpenAI Codex OAuth flow through the
 * public SDK, writing only the limits-owned store. Browser sign-in is offered
 * as a URL for the operator to open (nothing is launched here); device code is
 * the headless choice. Prompts stay in this TTY, text input is not echoed, and
 * failures are reported as fixed messages, never the SDK's raw error text.
 */
export async function loginCodexLimits(): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("sign-in needs an interactive terminal; run `limits login` in your own terminal");
  mkdirSync(dirname(LIMITS_AUTH_PATH), { recursive: true, mode: 0o700 });
  chmodSync(dirname(LIMITS_AUTH_PATH), 0o700);
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  const interaction: AuthInteraction = {
    signal: controller.signal,
    prompt: (request) => prompt(request, controller.signal),
    notify,
  };
  let failure: unknown;
  try {
    const runtime = await limitsRuntime();
    await runtime.login(LIMITS_LOGIN_PROVIDER, "oauth", interaction);
    await runtime.settleCredentialWrites();
  } catch (error) {
    failure = error;
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (failure !== undefined) {
    // Every SDK abort variant counts as the operator cancelling the sign-in.
    const cancelled = controller.signal.aborted || (failure instanceof Error && failure.message === LOGIN_CANCELLED);
    throw cancelled ? new CodexLoginCancelledError() : new Error("sign-in failed");
  }
  chmodSync(LIMITS_AUTH_PATH, 0o600);
}
