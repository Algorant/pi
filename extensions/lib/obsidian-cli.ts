// Shared Obsidian CLI client. It is the only way Pi tools reach an Obsidian vault.
//
// Observed CLI contract (Obsidian 1.13.7):
// - The exit code is 0 on failure; a failure prints a line starting with `Error:`.
// - `vault=<unknown>` silently targets the active vault, so the vault identity is verified first.
// - `content=` rewrites every backslash-n and backslash-t. Note text never travels through it:
//   writes go through `eval` with a base64 payload that is decoded inside the app.
// - `eval code=` rewrites those sequences too, so the evaluated code below contains no backslashes.
// - A single argument tops out near 128 KiB, so payloads are bounded and oversize content is rejected.
//
// - With Obsidian closed, an `obsidian` call starts the whole app inside itself and never returns.
//   The client therefore probes readiness first and, when the app is down, starts it as an
//   independent desktop app (`uwsm-app -- obsidian`) before the first operation.
//
// - The CLI crashes (Trace/breakpoint trap) without the graphical session environment, notably
//   DISPLAY, as in a bare SSH shell. When DISPLAY is unset the client takes the session variables
//   from the systemd user manager and runs the CLI through `env`; with none available it fails
//   naming DISPLAY.
// - Concurrent CLI invocations, including from other Pi processes, return each other's output, so
//   every call holds an exclusive per-user flock on a lock file in XDG_RUNTIME_DIR.
// - (Obsidian 1.14.4) The CLI returns as soon as its stdin reaches EOF, without waiting for a pending
//   async eval: with a closed stdin (as `pi.exec` gives) any eval slower than a tick prints nothing.
//   The client therefore spawns the CLI itself and keeps its stdin open until it exits (task-462).
//   The injected exec is used only for `systemctl`.
// - (Obsidian 1.14.4) A CLI call made with another HOME/config but the same XDG_RUNTIME_DIR unlinks the
//   running app's socket; the app keeps running unreachable. With the app running and no socket the
//   client fails asking for a restart instead of launching Obsidian again (task-461).
//
// The client is path-agnostic: callers own the vault-relative paths they pass.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type ObsidianExecResult = { stdout: string; stderr: string; code: number; killed?: boolean };

export type ObsidianExec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<ObsidianExecResult>;

export type ObsidianClientOptions = {
	exec: ObsidianExec;
	vault: string;
	timeoutMs?: number;
};

export type VaultFile = { path: string; text: string };

export type SearchMatch = { file: string; matches: Array<{ line: number; text: string }> };

export const OBSIDIAN_COMMAND = "obsidian";
export const DEFAULT_TIMEOUT_MS = 10_000;
// Base64 payload bound: leaves headroom under the ~128 KiB argument limit for the wrapper code.
export const MAX_PAYLOAD_BASE64_CHARS = 120_000;
export const PROBE_TIMEOUT_MS = 3_000;
export const LAUNCH_TIMEOUT_MS = 30_000;
export const LAUNCH_POLL_MS = 500;

export class ObsidianCliError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObsidianCliError";
	}
}

// Concurrent CLI invocations were observed to return corrupted output (a "Received CLI
// command [...]" echo in front of a truncated result). Calls run one at a time per process
// (the queue) and one at a time per user across processes (the flock).
export const LOCK_FILE = "pi-obsidian-cli.lock";
export const LOCK_WAIT_SECONDS = 60;
let queue: Promise<unknown> = Promise.resolve();

// The lock is held by a short-lived `flock` child that prints "locked" once it owns the file and
// then waits on stdin; closing stdin (or this process dying) releases it, so a lock is never stale.
function acquireLock(signal?: AbortSignal): Promise<() => void> {
	const dir = process.env.XDG_RUNTIME_DIR;
	if (!dir) throw new ObsidianCliError("XDG_RUNTIME_DIR is not set, so the cross-process Obsidian CLI lock file cannot be created. Run Pi inside the user's login session.");
	const file = join(dir, LOCK_FILE);
	if (signal?.aborted) throw new ObsidianCliError("Obsidian command aborted.");
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn("flock", ["-x", "-w", String(LOCK_WAIT_SECONDS), file, "sh", "-c", "echo locked; exec cat"], { stdio: ["pipe", "pipe", "pipe"] });
		let settled = false;
		let stderr = "";
		const release = () => { child.stdin?.end(); };
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			action();
		};
		const onAbort = () => finish(() => { child.kill(); reject(new ObsidianCliError("Obsidian command aborted.")); });
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		child.stdout?.on("data", (chunk) => { if (String(chunk).includes("locked")) finish(() => resolve(release)); });
		child.on("error", (error: NodeJS.ErrnoException) => finish(() => reject(new ObsidianCliError(error.code === "ENOENT" ? "`flock` (util-linux) is not available, so Obsidian CLI calls cannot be serialized across Pi processes." : `Could not take the Obsidian CLI lock: ${error.message}`))));
		child.on("exit", (code) => finish(() => reject(new ObsidianCliError(code === 1 && !stderr.trim()
			? `Another process held the Obsidian CLI lock (${file}) for more than ${LOCK_WAIT_SECONDS} s.`
			: `Could not take the Obsidian CLI lock (${file}, flock exit ${code}): ${stderr.trim()}`))));
	});
}

function serialized<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
	const locked = async () => {
		const release = await acquireLock(signal);
		try {
			return await task();
		} finally {
			release();
		}
	};
	const next = queue.then(locked, locked);
	queue = next.catch(() => undefined);
	return next;
}

const SESSION_VARIABLES = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DBUS_SESSION_BUS_ADDRESS"];

// Session variables to inject, read once per process. Empty when this process already has DISPLAY.
let sessionEnvironment: Promise<string[]> | undefined;

function sessionEnv(exec: ObsidianExec): Promise<string[]> {
	if (process.env.DISPLAY) return Promise.resolve([]);
	sessionEnvironment ??= readSessionEnv(exec);
	sessionEnvironment.catch(() => { sessionEnvironment = undefined; });
	return sessionEnvironment;
}

const NO_DISPLAY = "The Obsidian CLI needs the graphical session environment, but DISPLAY is not set in this process";

async function readSessionEnv(exec: ObsidianExec): Promise<string[]> {
	let result: ObsidianExecResult;
	try {
		result = await exec("systemctl", ["--user", "show-environment"], { timeout: PROBE_TIMEOUT_MS });
	} catch (error) {
		throw new ObsidianCliError(`${NO_DISPLAY} and the systemd user session could not be read (\`systemctl --user show-environment\`: ${String((error as Error)?.message ?? error)}). Run Pi from the desktop session, or export DISPLAY.`);
	}
	if (result.code !== 0) {
		throw new ObsidianCliError(`${NO_DISPLAY} and \`systemctl --user show-environment\` failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}. Run Pi from the desktop session, or export DISPLAY.`);
	}
	const found = new Map<string, string>();
	for (const line of result.stdout.split("\n")) {
		const at = line.indexOf("=");
		if (at > 0 && SESSION_VARIABLES.includes(line.slice(0, at))) found.set(line.slice(0, at), line.slice(at + 1));
	}
	if (!found.get("DISPLAY")) {
		throw new ObsidianCliError(`${NO_DISPLAY}, and the systemd user manager has none either. Obsidian runs in the desktop session: log in to it (or start it) and try again, or export DISPLAY.`);
	}
	return SESSION_VARIABLES.filter((name) => !process.env[name] && found.has(name)).map((name) => `${name}=${found.get(name)}`);
}

/** An eval that produced no output at all. The CLI does this for some calls that nevertheless ran (renameFile always does). */
export class ObsidianEmptyOutputError extends ObsidianCliError {
	constructor() {
		super("Unexpected Obsidian eval output: ");
		this.name = "ObsidianEmptyOutputError";
	}
}

/** Read-only check run after a mutating call returned empty output. `body` returns a JSON value; `check` returns undefined when the postcondition holds, else what is wrong. */
type Postcondition<V> = { body: string; payload?: unknown; check: (value: V) => string | undefined };

const NOT_AVAILABLE = `Obsidian CLI is not available. Install Obsidian with its CLI enabled (Settings → General → Command line interface), and keep the \`${OBSIDIAN_COMMAND}\` command on PATH.`;
const TIMEOUT_HINT = "Obsidian is not running or not responding. Start Obsidian with the vault open and try again.";

const LAUNCHER = "uwsm-app";

// One launch per process: concurrent callers join it, and Obsidian's own single-instance lock covers other processes.
let launching: Promise<void> | undefined;

// The CLI socket exists while Obsidian runs (a crash can leave it stale, so it is a necessary, not sufficient, signal).
// Calling the CLI with no socket would start the whole app inside the CLI process, so probes are skipped then.
function cliSocketAbsent(): boolean {
	const dir = process.env.XDG_RUNTIME_DIR;
	return Boolean(dir) && !existsSync(join(dir as string, ".obsidian-cli.sock"));
}

const SOCKET_MISSING = "Obsidian is running but its CLI socket is missing; restart Obsidian. (If it was started a moment ago, wait for it to finish starting and try again.)";

// Whether this user's Obsidian main process runs: Electron with an `…/obsidian/…app.asar` argument and no `--type=`
// (helpers carry `--type=`).
function obsidianAppRunning(): boolean {
	const uid = process.getuid?.();
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		let args: string[];
		try {
			if (uid !== undefined && statSync(`/proc/${entry}`).uid !== uid) continue;
			args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
		} catch {
			continue; // the process exited while being read
		}
		if (args.some((arg) => /\/obsidian\/.*app\.asar$/i.test(arg)) && !args.some((arg) => arg.startsWith("--type="))) return true;
	}
	return false;
}

// Start Obsidian as its own systemd scope, fully detached so it outlives this process. Resolves once spawned;
// `failure()` reports a launcher that failed to start or exited nonzero.
async function startObsidian(env: string[]): Promise<{ failure: () => string | undefined }> {
	if (!(process.env.PATH ?? "").split(":").some((dir) => dir && existsSync(join(dir, OBSIDIAN_COMMAND)))) throw new ObsidianCliError(NOT_AVAILABLE);
	let failure: string | undefined;
	const child = spawn(LAUNCHER, ["--", OBSIDIAN_COMMAND], { detached: true, stdio: "ignore", env: { ...process.env, ...Object.fromEntries(env.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])) } });
	child.on("exit", (code) => {
		if (code) failure = `\`${LAUNCHER} -- ${OBSIDIAN_COMMAND}\` exited with code ${code}.`;
	});
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	}).catch((error: NodeJS.ErrnoException) => {
		if (error?.code === "ENOENT") throw new ObsidianCliError(`\`${LAUNCHER}\` is not available, so Obsidian cannot be started automatically. Start Obsidian manually and try again.`);
		throw new ObsidianCliError(`Could not start Obsidian with \`${LAUNCHER}\`: ${String(error?.message ?? error)}`);
	});
	child.on("error", (error) => { failure = `\`${LAUNCHER}\` failed: ${error.message}`; });
	child.unref();
	return { failure: () => failure };
}

// Run one CLI process with stdin held open until it exits (see header: closing it makes the CLI skip pending evals).
// Resolves like an exec result; `killed` marks a timeout. A missing executable rejects with code ENOENT.
function spawnCli(command: string, args: string[], options: { signal?: AbortSignal; timeout: number }): Promise<ObsidianExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const stop = () => { killed = true; child.kill(); };
		const timer = options.timeout > 0 ? setTimeout(stop, options.timeout) : undefined;
		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
		const done = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); child.stdin?.destroy(); };
		child.once("error", (error) => { done(); reject(error); });
		child.once("close", (code) => { done(); resolve({ stdout, stderr, code: code ?? 1, killed }); });
	});
}

const CREATE_GUARD = "if(app.vault.getAbstractFileByPath(p.path))throw new Error('File already exists: '+p.path);";
function makeParents(target: string): string {
	return [
		`const parts=${target}.split('/');parts.pop();let dir='';`,
		"for(const part of parts){dir=dir?dir+'/'+part:part;if(!app.vault.getAbstractFileByPath(dir))await app.vault.createFolder(dir);}",
	].join("");
}
const MAKE_PARENTS = makeParents("p.path");

function utf8Base64(value: unknown): string {
	return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

// Wrapper evaluated inside Obsidian. It must not contain backslashes (see header).
// `p` is the decoded payload; the result is always one JSON object so strings,
// multiline text, and `undefined` stay unambiguous.
function evalProgram(body: string, payload: unknown): string {
	const encoded = utf8Base64(payload ?? null);
	if (encoded.length > MAX_PAYLOAD_BASE64_CHARS) {
		throw new ObsidianCliError(
			`Content is too large for the Obsidian CLI (${encoded.length} encoded characters; limit ${MAX_PAYLOAD_BASE64_CHARS}, about ${Math.floor((MAX_PAYLOAD_BASE64_CHARS * 3) / 4 / 1000)} KB of text). Split it into smaller notes.`,
		);
	}
	return [
		"(async()=>{try{",
		`const p=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob("${encoded}"),c=>c.charCodeAt(0))));`,
		`const v=await(async()=>{${body}})();`,
		"return JSON.stringify({ok:true,v});",
		"}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)})}})()",
	].join("");
}

/** Postcondition: the file's text is exactly `text`. The payload carries the expected text, so only a boolean comes back. */
function textEquals(path: string, text: string): Postcondition<boolean> {
	return {
		body: "const f=app.vault.getFileByPath(p.path);return f?(await app.vault.read(f))===p.text:false;",
		payload: { path, text },
		check: (equal) => (equal ? undefined : `${path} does not hold the intended text`),
	};
}

export class ObsidianClient {
	private verified: Promise<void> | undefined;

	constructor(private readonly options: ObsidianClientOptions) {
		if (!options.vault || !options.vault.trim()) throw new ObsidianCliError("Obsidian vault name is not configured.");
	}

	get vault(): string {
		return this.options.vault;
	}

	/** One serialized CLI invocation, run through `env` with the session variables when this process lacks DISPLAY. */
	private async cli(args: string[], options: { signal?: AbortSignal; timeout: number }): Promise<ObsidianExecResult> {
		const env = await sessionEnv(this.options.exec);
		const result = await serialized(options.signal, () => (env.length
			? spawnCli("env", [...env, OBSIDIAN_COMMAND, ...args], options)
			: spawnCli(OBSIDIAN_COMMAND, args, options)));
		if (env.length && result.code === 127 && (result.stderr ?? "").includes(OBSIDIAN_COMMAND)) throw new ObsidianCliError(NOT_AVAILABLE);
		return result;
	}

	/** Run one CLI command against the configured vault; returns stdout. Throws on any failure. */
	async run(args: string[], signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw new ObsidianCliError("Obsidian command aborted.");
		const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		let result: ObsidianExecResult;
		try {
			result = await this.cli([...args, `vault=${this.options.vault}`], { signal, timeout });
		} catch (error) {
			if (signal?.aborted) throw new ObsidianCliError("Obsidian command aborted.");
			const err = error as { code?: unknown; message?: unknown };
			if (err?.code === "ENOENT") throw new ObsidianCliError(NOT_AVAILABLE);
			throw new ObsidianCliError(`Obsidian CLI failed: ${String(err?.message ?? error)}`);
		}
		if (signal?.aborted) throw new ObsidianCliError("Obsidian command aborted.");
		if (result.killed) throw new ObsidianCliError(`Obsidian CLI timed out after ${timeout} ms. ${TIMEOUT_HINT}`);
		const stdout = result.stdout ?? "";
		if (result.code !== 0) {
			const detail = (result.stderr || stdout).trim();
			throw new ObsidianCliError(detail ? `Obsidian CLI failed (exit ${result.code}): ${detail}` : `Obsidian CLI failed (exit ${result.code}). ${NOT_AVAILABLE}`);
		}
		if (stdout.startsWith("Error:")) throw new ObsidianCliError(`Obsidian CLI ${stdout.trim()}`);
		return stdout;
	}

	/** Whether Obsidian answers the CLI within the probe timeout. Never calls the CLI when its socket is absent. */
	private async probe(signal?: AbortSignal): Promise<boolean> {
		if (cliSocketAbsent()) return false;
		try {
			const result = await this.cli(["vault", "info=name"], { signal, timeout: PROBE_TIMEOUT_MS });
			return !result.killed;
		} catch (error) {
			if ((error as { code?: unknown })?.code === "ENOENT") throw new ObsidianCliError(NOT_AVAILABLE);
			throw error;
		}
	}

	/** Make sure Obsidian is running, starting it detached in a graphical session when it is not. */
	private async ensureRunning(signal?: AbortSignal): Promise<void> {
		if (await this.probe(signal)) return;
		// While this process is launching Obsidian the app runs before its socket exists: join that launch.
		if (!launching && cliSocketAbsent() && obsidianAppRunning()) throw new ObsidianCliError(SOCKET_MISSING);
		launching ??= this.launch().finally(() => { launching = undefined; });
		await launching;
	}

	private async launch(): Promise<void> {
		if (await this.probe()) return; // another caller's launch finished after our probe
		const started = await startObsidian(await sessionEnv(this.options.exec));
		const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, LAUNCH_POLL_MS));
			const failure = started.failure();
			if (failure) throw new ObsidianCliError(`Obsidian could not be started: ${failure}`);
			if (await this.probe()) return;
		}
		throw new ObsidianCliError(`Obsidian was started but the CLI was not ready within ${LAUNCH_TIMEOUT_MS / 1000} s. Check that its command line interface is enabled and try again.`);
	}

	/**
	 * Confirm the CLI resolves the configured vault. An unknown name silently targets the active
	 * vault, so this must pass before any other operation. Cached for the life of this client;
	 * create one client per tool call.
	 */
	verifyVault(signal?: AbortSignal): Promise<void> {
		this.verified ??= this.ensureRunning(signal).then(() => this.run(["vault", "info=name"], signal)).then(
			(out) => {
				const name = out.replace(/\r?\n$/, "");
				if (name !== this.options.vault) {
					throw new ObsidianCliError(`Obsidian vault "${this.options.vault}" was not found (the CLI resolved "${name}"). Check pi-memory.vault in settings and that the vault is open in Obsidian.`);
				}
			},
		);
		this.verified.catch(() => { this.verified = undefined; });
		return this.verified;
	}

	/** Evaluate `body` inside Obsidian (it may use `app` and the decoded payload `p`); returns its JSON-serializable value. */
	async evalJson<T = unknown>(body: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
		await this.verifyVault(signal);
		const out = await this.run(["eval", `code=${evalProgram(body, payload)}`], signal);
		const text = out.trim();
		if (!text) throw new ObsidianEmptyOutputError();
		if (!text.startsWith("=> ")) throw new ObsidianCliError(`Unexpected Obsidian eval output: ${text.slice(0, 200)}`);
		let parsed: { ok: boolean; v?: T; error?: string };
		try {
			parsed = JSON.parse(text.slice(3));
		} catch {
			throw new ObsidianCliError(`Unparseable Obsidian eval output: ${text.slice(0, 200)}`);
		}
		if (!parsed.ok) throw new ObsidianCliError(parsed.error || "Obsidian eval failed.");
		return parsed.v as T;
	}

	/**
	 * Run a mutating eval. When it returns empty output the call may still have run, so the postcondition is
	 * checked with one read-only eval: the call succeeds only if it holds. Any other failure is unchanged.
	 */
	private async mutate<V>(operation: string, body: string, payload: unknown, post: Postcondition<V>, signal?: AbortSignal): Promise<void> {
		try {
			await this.evalJson(body, payload, signal);
			return;
		} catch (error) {
			if (!(error instanceof ObsidianEmptyOutputError)) throw error;
		}
		let problem: string | undefined;
		try {
			problem = post.check(await this.evalJson<V>(post.body, post.payload, signal));
		} catch (error) {
			throw new ObsidianCliError(`Obsidian ${operation} returned empty output and its result could not be verified: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (problem) throw new ObsidianCliError(`Obsidian ${operation} returned empty output and did not take effect: ${problem}`);
	}

	/** Entry type at a vault-relative path. */
	stat(path: string, signal?: AbortSignal): Promise<"file" | "folder" | null> {
		return this.evalJson<"file" | "folder" | null>(
			"const f=app.vault.getAbstractFileByPath(p.path);return f?(f.children?'folder':'file'):null;",
			{ path },
			signal,
		);
	}

	/** Exact text of a vault file. Throws if it does not exist. */
	read(path: string, signal?: AbortSignal): Promise<string> {
		return this.evalJson<string>(
			"const f=app.vault.getFileByPath(p.path);if(!f)throw new Error('File not found: '+p.path);return await app.vault.read(f);",
			{ path },
			signal,
		);
	}

	/** Create a new file, creating missing parent folders. Throws if the path exists. */
	async create(path: string, text: string, signal?: AbortSignal): Promise<void> {
		await this.mutate(
			`create ${path}`,
			`${CREATE_GUARD}${MAKE_PARENTS}await app.vault.create(p.path,p.text);`,
			{ path, text },
			{ body: "return app.vault.getFileByPath(p.path)!==null;", payload: { path }, check: (exists: boolean) => (exists ? undefined : `${path} does not exist`) },
			signal,
		);
	}

	/** Create a new binary file (for example a PNG), creating missing parent folders. Throws if the path exists. */
	async createBinary(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
		await this.mutate(
			`createBinary ${path}`,
			`${CREATE_GUARD}${MAKE_PARENTS}const bin=Uint8Array.from(atob(p.data),c=>c.charCodeAt(0));await app.vault.createBinary(p.path,bin.buffer);`,
			{ path, data: Buffer.from(bytes).toString("base64") },
			{ body: "return app.vault.getFileByPath(p.path)!==null;", payload: { path }, check: (exists: boolean) => (exists ? undefined : `${path} does not exist`) },
			signal,
		);
	}

	/** Rename or move a file with app.fileManager.renameFile, which keeps links to it intact. Creates missing parent folders of the target. Throws if the target exists. */
	async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
		await this.mutate(
			`rename ${from} → ${to}`,
			[
				"const f=app.vault.getFileByPath(p.from);if(!f)throw new Error('File not found: '+p.from);",
				"if(app.vault.getAbstractFileByPath(p.to))throw new Error('File already exists: '+p.to);",
				makeParents("p.to"),
				"await app.fileManager.renameFile(f,p.to);",
			].join(""),
			{ from, to },
			{
				body: "return {to:app.vault.getFileByPath(p.to)!==null,from:app.vault.getAbstractFileByPath(p.from)!==null};",
				payload: { from, to },
				check: (v: { to: boolean; from: boolean }) => (v.to && !v.from ? undefined : !v.to ? `${to} does not exist` : `${from} still exists`),
			},
			signal,
		);
	}

	/** Remove a file with app.fileManager.trashFile, which follows Obsidian's "Deleted files" setting (system trash by default). Throws if it does not exist. */
	async trash(path: string, signal?: AbortSignal): Promise<void> {
		await this.mutate(
			`trash ${path}`,
			"const f=app.vault.getFileByPath(p.path);if(!f)throw new Error('File not found: '+p.path);await app.fileManager.trashFile(f);",
			{ path },
			{ body: "return app.vault.getAbstractFileByPath(p.path)!==null;", payload: { path }, check: (exists: boolean) => (exists ? `${path} still exists` : undefined) },
			signal,
		);
	}

	/** Replace the whole text of a file atomically (app.vault.process), only if it still equals `expected`. */
	async replaceIfUnchanged(path: string, expected: string, next: string, signal?: AbortSignal): Promise<void> {
		await this.mutate(
			`replace ${path}`,
			"const f=app.vault.getFileByPath(p.path);if(!f)throw new Error('File not found: '+p.path);await app.vault.process(f,d=>{if(d!==p.expected)throw new Error('Note changed since it was read: '+p.path);return p.next;});",
			{ path, expected, next },
			textEquals(path, next),
			signal,
		);
	}

	/** Raw value of a top-level frontmatter key (null when absent) for every markdown file directly inside `folder`. Reads file text, not the metadata cache. */
	frontmatterValues(folder: string, key: string, signal?: AbortSignal): Promise<Array<{ path: string; value: string | null }>> {
		return this.evalJson(
			[
				"const prefix=p.folder+'/';const out=[];",
				"for(const f of app.vault.getMarkdownFiles()){if(!f.path.startsWith(prefix)||f.path.indexOf('/',prefix.length)>=0)continue;",
				"const lines=(await app.vault.read(f)).split(String.fromCharCode(10));let value=null;",
				"if(lines[0]==='---'){for(let i=1;i<lines.length&&lines[i]!=='---';i++){if(lines[i].startsWith(p.key+':')){value=lines[i].slice(p.key.length+1).trim();break;}}}",
				"out.push({path:f.path,value});}return out;",
			].join(""),
			{ folder, key },
			signal,
		);
	}

	/** Replace the whole text of an existing file. Throws if it is missing. */
	async overwrite(path: string, text: string, signal?: AbortSignal): Promise<void> {
		await this.mutate(
			`overwrite ${path}`,
			"const f=app.vault.getFileByPath(p.path);if(!f)throw new Error('File not found: '+p.path);await app.vault.modify(f,p.text);",
			{ path, text },
			textEquals(path, text),
			signal,
		);
	}

	/** Replace exactly one occurrence of `oldText` atomically (app.vault.process). Throws on zero or several matches. */
	async replaceOnce(path: string, oldText: string, newText: string, signal?: AbortSignal): Promise<void> {
		await this.evalJson(
			[
				"const f=app.vault.getFileByPath(p.path);if(!f)throw new Error('File not found: '+p.path);",
				"if(!p.oldText)throw new Error('oldText must not be empty');",
				"await app.vault.process(f,d=>{let n=0,i=d.indexOf(p.oldText);let at=-1;",
				"while(i>=0){n++;at=i;i=d.indexOf(p.oldText,i+p.oldText.length);}",
				"if(n===0)throw new Error('oldText was not found in '+p.path);",
				"if(n>1)throw new Error('oldText matches '+n+' places in '+p.path+'; make it unique');",
				"return d.slice(0,at)+p.newText+d.slice(at+p.oldText.length);});",
			].join(""),
			{ path, oldText, newText },
			signal,
		);
	}

	/** Markdown files under a vault folder (recursive), sorted by path, with their text when requested. */
	async listMarkdown(folder: string, withText: boolean, signal?: AbortSignal): Promise<VaultFile[]> {
		return this.evalJson<VaultFile[]>(
			[
				"const prefix=p.folder+'/';",
				"const files=app.vault.getMarkdownFiles().filter(f=>f.path.startsWith(prefix)).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);",
				"const out=[];for(const f of files)out.push({path:f.path,text:p.withText?await app.vault.read(f):''});return out;",
			].join(""),
			{ folder, withText },
			signal,
		);
	}

	/** `search:context` (Obsidian query syntax) limited to a vault folder. */
	async searchContext(query: string, folder: string, limit: number, signal?: AbortSignal): Promise<SearchMatch[]> {
		await this.verifyVault(signal);
		const out = await this.run(["search:context", `query=${query}`, `path=${folder}`, "format=json", `limit=${limit}`], signal);
		const text = out.trim();
		if (!text || text === "No matches found.") return [];
		try {
			return JSON.parse(text) as SearchMatch[];
		} catch {
			throw new ObsidianCliError(`Unparseable Obsidian search output: ${text.slice(0, 200)}`);
		}
	}
}

export function createObsidianClient(options: ObsidianClientOptions): ObsidianClient {
	return new ObsidianClient(options);
}
