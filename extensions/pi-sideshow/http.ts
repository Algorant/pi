import { closeSync, mkdirSync, openSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "http://localhost:8228";
const MAX_TEXT_CHARS = 50_000;
const START_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 750;
const SIDESHOW_RUNTIME_REQUIREMENT = "Node >=22.18";
let launchInFlight: Promise<void> | undefined;
type StartupHooks = {
	findCli?: () => string | undefined;
	spawn?: typeof spawn;
	startTimeoutMs?: number;
	probeTimeoutMs?: number;
};
let startupHooks: StartupHooks = {};

/** Test seam for startup behavior; production callers should not set this. */
export function setStartupHooksForTests(hooks: StartupHooks = {}): void {
	startupHooks = hooks;
	launchInFlight = undefined;
}

const CONTENT_TYPES: Record<string, string> = {
	avif: "image/avif",
	csv: "text/csv",
	gif: "image/gif",
	html: "text/html",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "text/javascript",
	json: "application/json",
	jsonl: "application/x-ndjson",
	log: "text/plain",
	md: "text/markdown",
	mjs: "text/javascript",
	ndjson: "application/x-ndjson",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	ts: "text/typescript",
	tsx: "text/typescript",
	txt: "text/plain",
	webp: "image/webp",
};

export function baseUrl(): string {
	return (process.env.SIDESHOW_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function agentName(): string {
	return process.env.SIDESHOW_AGENT || "pi";
}

export function baseUrlDisplay(): string {
	return baseUrl().replace(/^https?:\/\//, "");
}

export function redact(value: unknown): string {
	let text = value instanceof Error ? value.message : String(value ?? "");
	const token = process.env.SIDESHOW_TOKEN;
	if (token) text = text.split(token).join("[redacted]");
	return text;
}

export function contentTypeFor(file: string): string {
	const ext = file.split(".").pop()?.toLowerCase() ?? "";
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function clampWait(value: unknown, fallback: number): number {
	const n = Number(value ?? fallback);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(300, Math.max(0, Math.floor(n)));
}

export function clampLimit(value: unknown, fallback: number): number {
	const n = Number(value ?? fallback);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(500, Math.max(1, Math.floor(n)));
}

export type ProbeResult = { reachable: boolean; status?: number; statusText?: string; error?: string };

function isLocalUrl(urlString = baseUrl()): boolean {
	try {
		const url = new URL(urlString);
		return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}

export async function probeServer(timeoutMs = startupHooks.probeTimeoutMs ?? PROBE_TIMEOUT_MS): Promise<ProbeResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${baseUrl()}/api/sessions`, { headers: authHeaders(), signal: controller.signal });
		return { reachable: true, status: response.status, statusText: response.statusText };
	} catch (error) {
		return { reachable: false, error: redact(error) };
	} finally {
		clearTimeout(timer);
	}
}

function logFile(): { path: string; fd: number } {
	const directory = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "logs");
	mkdirSync(directory, { recursive: true });
	const stamp = new Date().toISOString().replace(/[.:]/g, "-");
	const path = join(directory, `sideshow-serve-${stamp}.log`);
	return { path, fd: openSync(path, "a") };
}

function findCli(): string | undefined {
	const result = spawnSync("sh", ["-lc", "command -v sideshow"], { encoding: "utf8" });
	const path = result.status === 0 ? result.stdout.trim() : "";
	return path || undefined;
}

async function waitReady(): Promise<ProbeResult> {
	const timeoutMs = startupHooks.startTimeoutMs ?? START_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	let result = await probeServer();
	while (!result.reachable && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		result = await probeServer();
	}
	return result;
}

function bindHostForUrl(urlString: string): "0.0.0.0" | "::1" {
	const hostname = new URL(urlString).hostname.toLowerCase();
	// Local IPv4 auto-start must also serve MagicDNS/Tailscale clients. This binds
	// every IPv4 interface, not just the tailnet; MagicDNS adds no access control or TLS.
	return hostname === "[::1]" ? "::1" : "0.0.0.0";
}

async function launchLocalServer(): Promise<void> {
	const url = baseUrl();
	const cli = startupHooks.findCli?.() ?? findCli();
	if (!cli) throw new Error(`Sideshow is not reachable at ${url}. Required command: sideshow serve. The ordinary sideshow CLI was not found on PATH; install/configure it with ${SIDESHOW_RUNTIME_REQUIREMENT}, then retry.`);
	const log = logFile();
	let port: string | undefined;
	try {
		const parsed = new URL(url);
		if (parsed.port) port = parsed.port;
	} catch {
		// isLocalUrl already rejected malformed origins.
	}
	try {
		const child = (startupHooks.spawn ?? spawn)(cli, ["serve", "--host", bindHostForUrl(url), ...(port ? ["--port", port] : [])], { detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env });
		child.unref();
	} catch (error) {
		throw new Error(`Could not start Sideshow at ${url} with sideshow serve: ${redact(error)}. Log: ${log.path}`);
	} finally {
		closeSync(log.fd);
	}
	const ready = await waitReady();
	if (!ready.reachable) throw new Error(`Started sideshow serve, but ${url}/api/sessions was not ready within ${(startupHooks.startTimeoutMs ?? START_TIMEOUT_MS) / 1000}s. Required command: sideshow serve. Log: ${log.path}. Last error: ${ready.error ?? "unknown error"}`);
}

/** Ensure the configured origin is ready before the original request. */
export async function ensureSideshowAvailable(): Promise<void> {
	const first = await probeServer();
	if (first.reachable) return;
	const url = baseUrl();
	if (!isLocalUrl(url)) throw new Error(`Sideshow is not reachable at ${url} (${first.error ?? "unknown error"}). Remote origins are never started automatically; start or check the configured server manually.`);
	launchInFlight ??= launchLocalServer().finally(() => { launchInFlight = undefined; });
	await launchInFlight;
}

export function truncateText(text: string, maxChars = MAX_TEXT_CHARS): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n[truncated: ${text.length - maxChars} more characters omitted]`;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		...(process.env.SIDESHOW_TOKEN ? { authorization: `Bearer ${process.env.SIDESHOW_TOKEN}` } : {}),
		...extra,
	};
}

function isBinaryBody(body: unknown): boolean {
	return body instanceof Uint8Array || body instanceof ArrayBuffer;
}

export type SideshowValidationIssue = {
	requestPath?: string;
	message?: string;
	[key: string]: unknown;
};

export class SideshowHttpError extends Error {
	readonly path: string;
	readonly status: number;
	readonly responseBody: unknown;
	readonly code?: string;
	readonly issues?: SideshowValidationIssue[];

	constructor(path: string, response: Response, body: unknown) {
		super(responseErrorText(path, response, body));
		this.name = "SideshowHttpError";
		this.path = path;
		this.status = response.status;
		this.responseBody = body;
		const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
		this.code = typeof record.code === "string" ? record.code : undefined;
		this.issues = Array.isArray(record.issues) ? record.issues as SideshowValidationIssue[] : undefined;
	}
}

function responseErrorText(path: string, response: Response, body: unknown): string {
	let message = `${response.status} ${response.statusText}`.trim();
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		if (typeof record.error === "string") message = record.error;
		else if (typeof record.message === "string") message = record.message;
		else if (typeof record.text === "string") message = record.text;
		if (typeof record.code === "string") message += ` [${record.code}]`;
		if (Array.isArray(record.issues) && record.issues.length) {
			const issues = record.issues.map((issue) => {
				if (!issue || typeof issue !== "object") return String(issue);
				const item = issue as Record<string, unknown>;
				const location = typeof item.requestPath === "string" ? `${item.requestPath}: ` : "";
				const parser = typeof item.parserMessage === "string" ? ` (${item.parserMessage})` : "";
				const next = Array.isArray(item.nextSteps) && item.nextSteps.length ? ` Next: ${item.nextSteps.map(String).join("; ")}` : "";
				return `${location}${typeof item.message === "string" ? item.message : JSON.stringify(issue)}${parser}${next}`;
			});
			message += `\nValidation issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
		}
	} else if (typeof body === "string" && body.trim()) {
		message = body.trim();
	}
	return redact(`sideshow ${path} failed: ${message}`);
}

export async function requestJson<T = Record<string, unknown>>(path: string, init: RequestInit & { skipStartup?: boolean } = {}, signal?: AbortSignal): Promise<T> {
	const { skipStartup = false, ...requestInit } = init;
	if (!skipStartup) await ensureSideshowAvailable();
	let response: Response;
	try {
		const body = requestInit.body;
		const shouldDefaultJson = Boolean(body) && !isBinaryBody(body) && !(requestInit.headers && "content-type" in Object.fromEntries(new Headers(requestInit.headers).entries()));
		response = await fetch(`${baseUrl()}${path}`, {
			...requestInit,
			signal: signal ?? requestInit.signal,
			headers: authHeaders({
				...(shouldDefaultJson ? { "content-type": "application/json" } : {}),
				...Object.fromEntries(new Headers(requestInit.headers).entries()),
			}),
		});
	} catch (error) {
		throw new Error(redact(`sideshow server not reachable at ${baseUrl()} — start it with: sideshow serve (${redact(error)})`));
	}

	const text = await response.text();
	let body: unknown = {};
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = { text };
		}
	}

	if (!response.ok) throw new SideshowHttpError(path, response, body);
	return body as T;
}

/**
 * Is this a real asset on the server we are publishing to? The viewer fetches an image surface
 * from /a/<assetId>, so an unknown id (a shortened prefix, another server's asset) renders as
 * "Image unavailable" while the post is accepted. One HEAD request per distinct id.
 */
export async function assetAvailable(assetId: string, signal?: AbortSignal): Promise<boolean> {
	await ensureSideshowAvailable();
	let response: Response;
	try {
		response = await fetch(`${baseUrl()}/a/${encodeURIComponent(assetId)}`, { method: "HEAD", headers: authHeaders(), signal });
	} catch (error) {
		throw new Error(redact(`sideshow server not reachable at ${baseUrl()} — start it with: sideshow serve (${redact(error)})`));
	}
	return response.ok;
}

export function sessionUrl(sessionId: string): string {
	return `${baseUrl()}/session/${encodeURIComponent(sessionId)}`;
}

/** Direct single-artifact page; keep using the session workspace for the default handoff. */
export function postUrl(postId: string): string {
	return `${baseUrl()}/p/${encodeURIComponent(postId)}`;
}
