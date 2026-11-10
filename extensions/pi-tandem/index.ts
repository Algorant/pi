import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, type TObject, Type } from "typebox";
import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { closeTaskRequests } from "../pi-agency/inbox/envelope.ts";
import { createTandemToolRenderer } from "../pi-ui/tool-ui/custom-tools/tandem.ts";
import {
	promptMentionsDurableCoordination,
	tandemPromptGuidance,
} from "./guidance";
import { registerTaskCommand } from "./task/index";

export { tandemPromptGuidance } from "./guidance";
type Cwd = { cwd?: string; timeoutMs?: number };
type Result = {
	ok: boolean;
	code: number | null;
	stdout: string;
	stderr: string;
	args: string[];
	cwd: string;
	command: string;
	error?: string;
	aborted?: boolean;
	timedOut?: boolean;
};
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;
export const EPIC_COMPLETED_EVENT = "pi-tandem:epic-completed";
export const TANDEM_COMMAND = "tandem";
export function tandemCommand(_env: NodeJS.ProcessEnv = process.env): string {
	return TANDEM_COMMAND;
}
const required = (v: unknown, message: string) => {
	if (typeof v !== "string" || !v.trim()) throw new Error(message);
	return v;
};
const optional = (a: string[], flag: string, v: unknown) => {
	if (typeof v === "string" && v.trim()) a.push(flag, v);
};
const repeated = (a: string[], flag: string, v: unknown) => {
	if (Array.isArray(v))
		for (const x of v) if (typeof x === "string" && x.trim()) a.push(flag, x);
};
/**
 * StringEnum's provider-safe `{ type: "string", enum }` schema, typed for
 * TypeBox's Static, which ToolDefinition uses for tool arguments. The published
 * pi-ai StringEnum is typed as a pi-schema Schema, which TypeBox reads as unknown.
 */
const stringEnum = <const T extends readonly string[]>(values: T) =>
	Type.Unsafe<T[number]>(StringEnum(values));
const positive = (v: unknown, message: string) => {
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0) throw new Error(message);
	return n;
};
/**
 * Direct tool calls may pass null for an omitted optional argument; treat it
 * as omitted so it never becomes a literal "null" flag value or cwd.
 */
function withoutNulls<T extends object>(p: T): T {
	return Object.fromEntries(Object.entries(p ?? {}).filter(([, v]) => v !== null)) as T;
}
function cwdOf(base: string, cwd?: string) {
	const c = cwd?.trim();
	if (!c) return base;
	const at = c.startsWith("@") ? c.slice(1) : c;
	const p = at === "~" ? homedir() : at.startsWith("~/") ? join(homedir(), at.slice(2)) : at;
	const dir = isAbsolute(p) ? p : resolve(base, p);
	let isDir = false;
	try {
		isDir = statSync(dir).isDirectory();
	} catch {}
	if (!isDir) throw new Error(`cwd folder does not exist: ${dir}`);
	return dir;
}
function timeout(v: unknown) {
	const n = Number(v ?? DEFAULT_TIMEOUT);
	return Number.isFinite(n)
		? Math.max(1000, Math.min(MAX_TIMEOUT, Math.floor(n)))
		: DEFAULT_TIMEOUT;
}
function run(
	args: string[],
	cwd: string,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<Result> {
	return new Promise((done) => {
		let settled = false;
		const command = tandemCommand();
		const child = execFile(
			command,
			args,
			{ cwd, timeout: timeout(timeoutMs), maxBuffer: MAX_BUFFER },
			(err, stdout, stderr) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				const e = err as (Error & { code?: number; killed?: boolean }) | null;
				done({
					ok: !err,
					code: typeof e?.code === "number" ? e.code : err ? 1 : 0,
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					args,
					cwd,
					command,
					error: e?.message,
					timedOut: Boolean(e?.killed && /timed out/i.test(e.message)),
				});
			},
		);
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill("SIGTERM");
			signal?.removeEventListener("abort", abort);
			done({
				ok: false,
				code: null,
				stdout: "",
				stderr: "",
				args,
				cwd,
				command,
				error: "tandem command aborted",
				aborted: true,
			});
		};
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}
function parse(text: string): any {
	const t = text.trim();
	if (!t) return undefined;
	try {
		return JSON.parse(t);
	} catch {
		return undefined;
	}
}
function failure(r: Result) {
	if (/ENOENT/i.test(r.error ?? ""))
		return `Missing tandem CLI: could not execute ${JSON.stringify(r.command)}.`;
	if (r.timedOut) return "tandem command timed out before it completed.";
	if (r.aborted) return "tandem command was aborted before it completed.";
	return "tandem command failed.";
}
function readableFailureText(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	if (/^[\[{]/.test(trimmed)) {
		try {
			return structuredFailureMessage(JSON.parse(trimmed));
		} catch {
			return "CLI returned malformed structured error output.";
		}
	}
	return trimmed.replace(/\s+/g, " ");
}
function structuredFailureMessage(parsed: unknown): string {
	if (!parsed || typeof parsed !== "object") return "CLI returned a structured error response.";
	const error = (parsed as any).error;
	if (error && typeof error === "object" && typeof error.message === "string") return error.message;
	if (typeof error === "string") return error;
	if (typeof (parsed as any).message === "string") return (parsed as any).message;
	return "CLI returned a structured error response.";
}
async function saveFailureOutput(r: Result): Promise<string | undefined> {
	if (!r.stdout.trim() && !r.stderr.trim()) return undefined;
	const d = await mkdtemp(join(tmpdir(), "pi-tandem-error-"));
	const path = join(d, "tandem-error.txt");
	await writeFile(path, [`stdout:\n${r.stdout}`, `stderr:\n${r.stderr}`].join("\n\n"));
	return path;
}
async function output(text: string) {
	const t = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!t.truncated) return { text: t.content };
	const d = await mkdtemp(join(tmpdir(), "pi-tandem-"));
	const path = join(d, "tandem-output.txt");
	await writeFile(path, text);
	return {
		text: `${t.content}\n\n[Output truncated: showing ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). Full output saved to: ${path}]`,
		truncation: t,
		fullOutputPath: path,
	};
}
export async function formatTandemResult(label: string, r: Result): Promise<any> {
	if (!r.ok) {
		const rawOutputPath = await saveFailureOutput(r);
		const stdoutMessage = readableFailureText(r.stdout);
		const stderrMessage = readableFailureText(r.stderr);
		const errorMessage = !stdoutMessage && !stderrMessage && r.error ? readableFailureText(r.error) : "";
		const primaryMessage = stdoutMessage || stderrMessage || errorMessage;
		const body = [
			`${label} failed.`,
			failure(r),
			primaryMessage && `reason: ${primaryMessage}`,
			`cwd: ${r.cwd}`,
			`command: ${r.command} ${r.args.join(" ")}`,
			`exit: ${r.code ?? "unknown"}`,
			stdoutMessage && stdoutMessage !== primaryMessage && `CLI message: ${stdoutMessage}`,
			stderrMessage && stderrMessage !== primaryMessage && `CLI stderr: ${stderrMessage}`,
			errorMessage && errorMessage !== primaryMessage && `error: ${errorMessage}`,
			rawOutputPath && `Raw CLI output saved to: ${rawOutputPath}`,
		]
			.filter(Boolean)
			.join("\n\n");
		if (r.aborted)
			return {
				content: [{ type: "text", text: `${label} cancelled.\n${failure(r)}` }],
				details: { ...r, cancelled: true },
				cancelled: true,
			};
		throw new Error((await output(body)).text);
	}
	const parsed = parse(r.stdout);
	const body = r.stdout.trim() || r.stderr.trim() || "OK";
	const shown = await output(
		`${label}\n\n${parsed === undefined ? body : JSON.stringify(parsed, null, 2)}${r.stderr.trim() ? `\n\nstderr:\n${r.stderr.trim()}` : ""}`,
	);
	return {
		content: [{ type: "text", text: shown.text }],
		details: {
			...r,
			parsedJson: parsed,
			truncation: shown.truncation,
			fullOutputPath: shown.fullOutputPath,
		},
	};
}
/**
 * One tandem call for other code in this extension (for example /task): the CLI's
 * `data`, or an Error carrying the CLI's own message.
 */
export async function tandemJson(args: string[], cwd: string, signal?: AbortSignal): Promise<any> {
	const r = await run(args, cwd, signal);
	const parsed = parse(r.stdout);
	if (parsed?.ok === true) return parsed.data;
	if (parsed?.ok === false) throw new Error(structuredFailureMessage(parsed));
	const reason = readableFailureText(r.stderr);
	throw new Error(r.ok ? "tandem returned no JSON." : `${failure(r)}${reason ? ` ${reason}` : ""}`);
}
function execute(
	label: string,
	args: string[],
	base: string,
	p: Cwd,
	signal?: AbortSignal,
	update?: (x: any) => void,
	afterSuccess?: (cwd: string) => Promise<string | void>,
) {
	const cwd = cwdOf(base, p.cwd);
	update?.({
		content: [{ type: "text", text: `tandem ${args.join(" ")}` }],
		details: { cwd, args },
	});
	return run(args, cwd, signal, p.timeoutMs).then(async (result) => {
		const note = result.ok ? await afterSuccess?.(cwd) : undefined;
		const formatted = await formatTandemResult(label, result);
		if (note) formatted.content = [...formatted.content, { type: "text", text: note }];
		return formatted;
	});
}

export type ReadParams = Cwd & {
	action: "show" | "list" | "search";
	id?: string;
	query?: string;
	scope?: "active" | "archived" | "all";
	type?: string;
	state?: string;
	priority?: string;
	effort?: string;
	tag?: string;
	kind?: string;
	assignee?: string;
	parent?: string;
	accord?: string;
	decisionStatus?: string;
	resolution?: string;
	limit?: number;
};
export function buildReadArgs(p: ReadParams): string[] {
	if (p.action === "show")
		return ["show", required(p.id, "tandem_read show requires id"), "--json"];
	const a = [
		p.action,
		...(p.action === "search"
			? [required(p.query, "tandem_read search requires query")]
			: []),
	];
	optional(a, "--scope", p.scope);
	optional(a, "--type", p.type);
	optional(a, "--state", p.state);
	optional(a, "--priority", p.priority);
	optional(a, "--effort", p.effort);
	optional(a, "--tag", p.tag);
	optional(a, "--kind", p.kind);
	optional(a, "--assignee", p.assignee);
	optional(a, "--parent", p.parent);
	if (p.action === "list") {
		optional(a, "--accord", p.accord);
		optional(a, "--decision-status", p.decisionStatus);
		optional(a, "--resolution", p.resolution);
	}
	if (p.limit !== undefined)
		a.push(
			"--limit",
			String(positive(p.limit, "tandem_read limit must be a positive integer")),
		);
	a.push("--json");
	return a;
}
export const tandemReadParameters = Type.Object(
	{
		...{
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
		},
		action: stringEnum(["show", "list", "search"] as const),
		id: Type.Optional(Type.String()),
		query: Type.Optional(Type.String()),
		scope: Type.Optional(stringEnum(["active", "archived", "all"] as const)),
		type: Type.Optional(Type.String()),
		state: Type.Optional(Type.String()),
		priority: Type.Optional(Type.String()),
		effort: Type.Optional(Type.String()),
		tag: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		assignee: Type.Optional(Type.String()),
		parent: Type.Optional(Type.String()),
		accord: Type.Optional(Type.String()),
		decisionStatus: Type.Optional(Type.String()),
		resolution: Type.Optional(Type.String()),
		limit: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export type AddParams = Cwd & {
	action: "task" | "decision";
	title: string;
	body?: string;
	tags?: string[];
	references?: string[];
	acceptance?: string[];
	kind?: string;
	priority?: string;
	effort?: string;
	dueDate?: string;
	parent?: string;
	blockers?: string[];
	relatedFiles?: string[];
	constraints?: string[];
	validations?: string[];
	deciders?: string[];
	supersedes?: string[];
};
export function buildAddArgs(p: AddParams): string[] {
	const title = required(p.title, `tandem_add ${p.action} requires title`);
	const a = ["add", p.action];
	if (p.action === "task") {
		if (p.deciders !== undefined || p.supersedes !== undefined)
			throw new Error("tandem_add task rejects decision-only fields");
		if (
			!Array.isArray(p.acceptance) ||
			!p.acceptance.length ||
			p.acceptance.some((x) => typeof x !== "string" || !x.trim())
		)
			throw new Error("tandem_add task requires non-empty acceptance");
		repeated(a, "--acceptance", p.acceptance);
		optional(a, "--body", p.body);
		optional(a, "--kind", p.kind);
		optional(a, "--priority", p.priority);
		optional(a, "--effort", p.effort);
		repeated(a, "--tag", p.tags);
		optional(a, "--due-date", p.dueDate);
		optional(a, "--parent", p.parent);
		repeated(a, "--blocker", p.blockers);
		repeated(a, "--reference", p.references);
		repeated(a, "--related-file", p.relatedFiles);
		repeated(a, "--constraint", p.constraints);
		repeated(a, "--validation", p.validations);
	} else {
		if (
			p.acceptance !== undefined ||
			p.kind ||
			p.priority ||
			p.effort ||
			p.dueDate ||
			p.parent ||
			p.blockers ||
			p.relatedFiles ||
			p.constraints ||
			p.validations
		)
			throw new Error("tandem_add decision rejects task-only fields");
		optional(a, "--body", p.body);
		repeated(a, "--tag", p.tags);
		repeated(a, "--reference", p.references);
		repeated(a, "--decider", p.deciders);
		repeated(a, "--supersedes", p.supersedes);
	}
	// The title goes last, after `--`, so a title that starts with "-" is not read as a flag.
	a.push("--json", "--", title);
	return a;
}
export const tandemAddParameters = Type.Object(
	{
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		action: stringEnum(["task", "decision"] as const),
		title: Type.String(),
		body: Type.Optional(Type.String()),
		tags: Type.Optional(Type.Array(Type.String())),
		references: Type.Optional(Type.Array(Type.String())),
		acceptance: Type.Optional(Type.Array(Type.String())),
		kind: Type.Optional(Type.String()),
		priority: Type.Optional(Type.String()),
		effort: Type.Optional(Type.String()),
		dueDate: Type.Optional(Type.String()),
		parent: Type.Optional(Type.String()),
		blockers: Type.Optional(Type.Array(Type.String())),
		relatedFiles: Type.Optional(Type.Array(Type.String())),
		constraints: Type.Optional(Type.Array(Type.String())),
		validations: Type.Optional(Type.Array(Type.String())),
		deciders: Type.Optional(Type.Array(Type.String())),
		supersedes: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export type UpdateParams = Cwd & {
	id: string;
	title?: string;
	body?: string;
	kind?: string;
	priority?: string;
	effort?: string;
	dueDate?: string;
	parent?: string;
	tags?: string[];
	references?: string[];
	blockers?: string[];
	relatedFiles?: string[];
	acceptance?: string[];
	constraints?: string[];
	validations?: string[];
	status?: string;
	deciders?: string[];
	supersedes?: string[];
	clear?: string[];
};
export function buildUpdateArgs(p: UpdateParams): string[] {
	const a = ["update", required(p.id, "tandem_update requires id")];
	optional(a, "--title", p.title);
	if (p.body !== undefined) {
		if (typeof p.body !== "string")
			throw new Error("tandem_update body must be a string");
		a.push("--body", p.body);
	}
	for (const [flag, value] of [
		["--kind", p.kind],
		["--priority", p.priority],
		["--effort", p.effort],
		["--due-date", p.dueDate],
		["--parent", p.parent],
		["--status", p.status],
	] as const)
		optional(a, flag, value);
	repeated(a, "--tag", p.tags);
	repeated(a, "--reference", p.references);
	repeated(a, "--blocker", p.blockers);
	repeated(a, "--related-file", p.relatedFiles);
	repeated(a, "--acceptance", p.acceptance);
	repeated(a, "--constraint", p.constraints);
	repeated(a, "--validation", p.validations);
	repeated(a, "--decider", p.deciders);
	repeated(a, "--supersedes", p.supersedes);
	repeated(a, "--clear", p.clear);
	a.push("--json");
	return a;
}
export const tandemUpdateParameters = Type.Object(
	{
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		id: Type.String(),
		title: Type.Optional(Type.String()),
		body: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		priority: Type.Optional(Type.String()),
		effort: Type.Optional(Type.String()),
		dueDate: Type.Optional(Type.String()),
		parent: Type.Optional(Type.String()),
		tags: Type.Optional(Type.Array(Type.String())),
		references: Type.Optional(Type.Array(Type.String())),
		blockers: Type.Optional(Type.Array(Type.String())),
		relatedFiles: Type.Optional(Type.Array(Type.String())),
		acceptance: Type.Optional(Type.Array(Type.String())),
		constraints: Type.Optional(Type.Array(Type.String())),
		validations: Type.Optional(Type.Array(Type.String())),
		status: Type.Optional(Type.String()),
		deciders: Type.Optional(Type.Array(Type.String())),
		supersedes: Type.Optional(Type.Array(Type.String())),
		clear: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export type AccordParams = Cwd & {
	action:
		"claim" | "deliver" | "rework" | "block" | "resume" | "release" | "fail";
	id: string;
	assignee?: string;
	summary?: string;
	evidence?: string[];
	filesChanged?: string[];
	note?: string;
};
export function buildAccordArgs(p: AccordParams): string[] {
	const a = ["accord", p.action, required(p.id, "tandem_accord requires id")];
	if (p.action === "claim")
		optional(
			a,
			"--assignee",
			required(p.assignee, "tandem_accord claim requires assignee"),
		);
	else if (p.action === "deliver") {
		optional(
			a,
			"--summary",
			required(p.summary, "tandem_accord deliver requires summary"),
		);
		repeated(a, "--evidence", p.evidence);
		repeated(a, "--file-changed", p.filesChanged);
	} else if (["rework", "block", "release", "fail"].includes(p.action))
		optional(
			a,
			"--note",
			required(p.note, `tandem_accord ${p.action} requires note`),
		);
	a.push("--json");
	return a;
}
export const tandemAccordParameters = Type.Object(
	{
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		action: stringEnum([
			"claim",
			"deliver",
			"rework",
			"block",
			"resume",
			"release",
			"fail",
		] as const),
		id: Type.String(),
		assignee: Type.Optional(Type.String()),
		summary: Type.Optional(Type.String()),
		evidence: Type.Optional(Type.Array(Type.String())),
		filesChanged: Type.Optional(Type.Array(Type.String())),
		note: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type ReviewParams = Cwd & {
	id: string;
	criterion: string;
	note: string;
	reviewer?: string;
};
export function buildReviewArgs(p: ReviewParams) {
	const a = [
		"review",
		required(p.id, "tandem_review requires id"),
		"--criterion",
		required(p.criterion, "tandem_review requires criterion"),
		"--note",
		required(p.note, "tandem_review requires note"),
	];
	optional(a, "--reviewer", p.reviewer);
	a.push("--json");
	return a;
}
export type CloseParams = Cwd & {
	action: "complete" | "cancel";
	id: string;
	note?: string;
	reviewer?: string;
};
export function buildCloseArgs(p: CloseParams) {
	const a = [p.action, required(p.id, "tandem_close requires id")];
	if (p.action === "cancel")
		optional(
			a,
			"--note",
			required(p.note, "tandem_close cancel requires note"),
		);
	else {
		optional(a, "--note", p.note);
		optional(a, "--reviewer", p.reviewer);
	}
	a.push("--json");
	return a;
}
export type SyncParams = Cwd & {
	action: "sync" | "status" | "resolve";
	id?: string;
	keep?: "local" | "remote" | "edited";
};
export function buildSyncArgs(p: SyncParams): string[] {
	if (p.action === "sync") return ["sync", "--json"];
	if (p.action === "status") return ["sync", "status", "--json"];
	return [
		"sync", "resolve",
		required(p.id, "tandem_sync resolve requires id"),
		"--keep", required(p.keep, "tandem_sync resolve requires keep"),
		"--json",
	];
}
export const tandemSyncParameters = Type.Object(
	{
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		action: stringEnum(["sync", "status", "resolve"] as const),
		id: Type.Optional(Type.String()),
		keep: Type.Optional(stringEnum(["local", "remote", "edited"] as const)),
	},
	{ additionalProperties: false },
);

export type RulesParams = Cwd & {
	action: "list" | "add" | "edit" | "delete";
	category?: "always" | "never" | "prefer" | "context";
	id?: string;
	rule?: string;
};
export function buildRulesArgs(p: RulesParams) {
	if (p.action === "list") {
		const a = ["rules", "list"];
		if (p.category) a.push(p.category);
		a.push("--json");
		return a;
	}
	if (p.action === "add")
		return [
			"rules",
			"add",
			required(p.category, "tandem_rules add requires category"),
			required(p.rule, "tandem_rules add requires rule"),
			"--json",
		];
	if (p.action === "edit")
		return [
			"rules",
			"edit",
			required(p.id, "tandem_rules edit requires id"),
			required(p.rule, "tandem_rules edit requires rule"),
			"--json",
		];
	return [
		"rules",
		"delete",
		required(p.id, "tandem_rules delete requires id"),
		"--json",
	];
}
export const tandemRulesParameters = Type.Object(
	{
		cwd: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number()),
		action: stringEnum(["list", "add", "edit", "delete"] as const),
		category: Type.Optional(
			stringEnum(["always", "never", "prefer", "context"] as const),
		),
		id: Type.Optional(Type.String()),
		rule: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** `error` is the CLI's own message when a board exists but cannot be read (e.g. it needs `tandem migrate`). */
type WorkspaceDetection = { detected: boolean; root?: string; error?: string };
async function gitCommonDirectory(cwd: string, signal?: AbortSignal, timeoutMs?: number): Promise<{ ok: boolean; path: string; error?: string }> {
	return new Promise((done) => {
		execFile(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd, timeout: timeout(timeoutMs), maxBuffer: MAX_BUFFER, signal },
			(error, stdout, stderr) => {
				const path = String(stdout ?? "").trim();
				done({ ok: !error && Boolean(path), path, error: error?.message || String(stderr ?? "").trim() || undefined });
			},
		);
	});
}

async function workspace(start: string, signal?: AbortSignal, timeoutMs?: number): Promise<WorkspaceDetection> {
	const cwd = resolve(start);
	const status = await run(["sync", "status", "--json"], cwd, signal, timeoutMs);
	const parsed = parse(status.stdout);
	if (parsed?.ok !== true || !parsed.data || typeof parsed.data !== "object") {
		const message = typeof parsed?.error?.message === "string" ? parsed.error.message : readableFailureText(status.stderr) || undefined;
		// Only "no workspace" means not found; any other failure is a board the CLI cannot read.
		if (!message || /No Tandem workspace found/i.test(message)) return { detected: false };
		return { detected: false, error: message };
	}
	if (parsed.data.git === false) return { detected: true };
	if (parsed.data.git !== true) throw new Error("tandem sync status returned no Git-workspace status.");
	const common = await gitCommonDirectory(cwd, signal, timeoutMs);
	if (!common.ok) throw new Error(`Tandem detected a Git board, but git could not resolve its common directory from ${cwd}: ${common.error ?? "no Git directory returned"}`);
	return { detected: true, root: dirname(common.path) };
}

export async function emitCloseEvents(
	pi: ExtensionAPI,
	action: CloseParams["action"],
	id: string,
	cwd: string,
	signal?: AbortSignal,
	runCommand: typeof run = run,
) {
	if (action !== "complete") return;
	const shown = await runCommand(["show", id, "--json"], cwd, signal);
	if (!shown.ok) return;
	const parsed = parse(shown.stdout);
	const record = parsed?.data;
	if (!record || record.location !== "logs" || record.kind !== "epic") return;
	pi.events.emit(EPIC_COMPLETED_EVENT, {
		epicId: record.id,
		epicTitle: record.title,
		resolvedChildCount: Array.isArray(record.children)
			? record.children.length
			: 0,
	});
}
/** A Task this tool completed or cancelled closes the open inbox requests linked to it (task-556); its project is its Git checkout's name, as in a manus's `task=` label. */
async function closeLinkedInboxRequests(action: CloseParams["action"], id: string, cwd: string): Promise<string | undefined> {
	const board = await workspace(cwd);
	return closeTaskRequests({ ...(board.root ? { project: basename(board.root) } : {}), id }, action === "complete" ? "completed" : "cancelled");
}
const TOOL_GUIDANCE: Record<string, { snippet: string; guidelines: string[] }> =
	{
		tandem_read: {
			snippet:
				"Read active or archived Tandem records with server-side filters.",
			guidelines: [
				"Use location, not state or resolution, to distinguish active Board records from archived Logs.",
			],
		},
		tandem_add: {
			snippet: "Create a Task or Decision through the Tandem CLI.",
			guidelines: [],
		},
		tandem_update: {
			snippet: "Update supported Tandem record metadata.",
			guidelines: [
				"Repeated list flags replace the whole list and clear removes fields. Update cannot write state, assignee, or Accord status.",
			],
		},
		tandem_accord: {
			snippet: "Run a Tandem Accord lifecycle action.",
			guidelines: [
				"accord claim --assignee is the only write that sets an assignee.",
			],
		},
		tandem_review: {
			snippet: "Escalate a Tandem record for deliberate human review.",
			guidelines: [
				"Use review when correctness requires human judgment, product direction, or taste.",
				"tandem_review is root-only: a Subtask (task-N-M) fails with `Subtasks cannot be reviewed`; do not retry or emulate it, block the Subtask with tandem_accord and a note naming the pending decision instead.",
			],
		},
		tandem_close: {
			snippet: "Complete or cancel a Tandem record.",
			guidelines: [
				"Completion and cancellation archive records to Logs; cancel requires a note.",
			],
		},
		tandem_sync: {
			snippet: "Synchronize the Tandem board or inspect/resolve board sync state.",
			guidelines: [
				"Tandem syncs the board itself; pending means changes are saved locally. Surface conflicts and held edits to Algorant; resolve only with tandem sync resolve when authorized.",
			],
		},
		tandem_rules: {
			snippet: "Inspect or mutate project rules through Tandem.",
			guidelines: [],
		},
	};

export function resolveTandemBinaryPath(
	pathValue = process.env.PATH ?? "",
	isExecutable = (candidate: string) => {
		try {
			accessSync(candidate, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	},
): string {
	for (const directory of pathValue.split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, TANDEM_COMMAND);
		if (isExecutable(candidate)) return candidate;
	}
	return "unavailable";
}

async function statusReport(
	cwd: string,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<{ lines: string[]; details: Record<string, unknown> }> {
	const version = await run(["--version"], cwd, signal, timeoutMs);
	const resolved = resolveTandemBinaryPath();
	const versionStderr = readableFailureText(version.stderr);
	const versionError = version.ok ? undefined : [failure(version), versionStderr].filter(Boolean).join(" · ");
	const versionText = version.ok ? version.stdout.trim() : versionError || failure(version);
	const detectedWorkspace = await workspace(cwd, signal, timeoutMs);
	const details = {
		cwd,
		workspaceRoot: detectedWorkspace.root,
		workspaceDetected: detectedWorkspace.detected,
		workspaceError: detectedWorkspace.error,
		tandemBinary: "tandem",
		tandemResolved: resolved,
		tandemVersion: version.ok ? version.stdout.trim() : undefined,
		tandemVersionError: versionError,
		tandemVersionStderr: version.ok ? undefined : versionStderr || undefined,
		versionOk: version.ok,
		ok: version.ok,
		diagnostic: version.ok ? undefined : `Tandem version check failed: ${versionText}`,
	};
	return {
		lines: [
			"# pi-tandem status",
			"",
			`cwd: ${cwd}`,
			"tandem binary: tandem",
			`tandem resolved: ${resolved}`,
			`tandem version: ${versionText}`,
			`workspace: ${details.workspaceRoot ?? (details.workspaceDetected ? "detected (non-Git)" : details.workspaceError ? `error: ${details.workspaceError}` : "not found")}`,
		],
		details,
	};
}

export default function piTandem(pi: ExtensionAPI) {
	const tool = <TParams extends TObject>(
		name: string,
		label: string,
		description: string,
		parameters: TParams,
		builder: (p: Static<TParams>) => string[],
		afterSuccess?: (
			owner: ExtensionAPI,
			params: Static<TParams>,
			cwd: string,
		) => Promise<string | void>,
	) => {
		const guidance = TOOL_GUIDANCE[name];
		return pi.registerTool({
			name,
			label,
			...createTandemToolRenderer(name, label),
			description,
			promptSnippet: guidance.snippet,
			promptGuidelines: guidance.guidelines,
			parameters,
			async execute(_id, raw, signal, onUpdate, ctx) {
				const p = withoutNulls(raw);
				let args: string[];
				try {
					args = builder(p);
				} catch (error) {
					throw new Error(
						`${name} argument error: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return execute(
					name,
					args,
					ctx.cwd,
					p,
					signal,
					onUpdate,
					afterSuccess ? (cwd) => afterSuccess(pi, p, cwd) : undefined,
				);
			},
		});
	};
	pi.registerTool({
		name: "tandem_status",
		label: "Tandem Status",
		...createTandemToolRenderer("tandem_status", "Tandem Status"),
		description:
			"Diagnose the installed tandem CLI and nearest Tandem workspace.",
		promptSnippet:
			"Use tandem_status before durable coordination or workspace initialization.",
		promptGuidelines: [
			"If no workspace exists, ask before using tandem_init.",
			"Use location, not state or resolution, to distinguish active Board records from archived Logs.",
		],
		parameters: Type.Object({
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		async execute(_i, raw, signal, _u, ctx) {
			const p = withoutNulls(raw);
			const c = cwdOf(ctx.cwd, p.cwd);
			const report = await statusReport(c, signal, p.timeoutMs);
			return {
				content: [{ type: "text", text: report.lines.join("\n") }],
				details: report.details,
			};
		},
	});
	pi.registerTool({
		name: "tandem_init",
		label: "Tandem Init",
		...createTandemToolRenderer("tandem_init", "Tandem Init"),
		description: "Initialize a Tandem workspace with tandem init --title.",
		promptSnippet:
			"Use tandem_init only after the user confirms this directory should become a Tandem workspace.",
		promptGuidelines: [
			"Use tandem_status first and never initialize implicitly.",
		],
		parameters: Type.Object({
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
			title: Type.String(),
		}),
		async execute(_i, raw, s, u, c) {
			const p = withoutNulls(raw);
			const result = await execute(
				"tandem_init",
				[
					"init",
					"--title",
					required(p.title, "tandem_init requires title"),
					"--json",
				],
				c.cwd,
				p,
				s,
				u,
			);
			return result;
		},
	});
	tool(
		"tandem_read",
		"Tandem Read",
		"Read Tandem records with show, list, or search.",
		tandemReadParameters,
		buildReadArgs,
	);
	tool(
		"tandem_add",
		"Tandem Add",
		"Add a Task or Decision. All Tasks require at least one acceptance criterion; papercut capture has no separate tool — use action=task with priority low and kind papercut.",
		tandemAddParameters,
		buildAddArgs,
	);
	tool(
		"tandem_update",
		"Tandem Update",
		"Update Tandem record metadata through the installed CLI.",
		tandemUpdateParameters,
		buildUpdateArgs,
	);
	tool(
		"tandem_accord",
		"Tandem Accord",
		"Run Tandem Accord lifecycle actions.",
		tandemAccordParameters,
		buildAccordArgs,
	);
	tool(
		"tandem_review",
		"Tandem Review",
		"Escalate a record for review with a criterion and note.",
		Type.Object({
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
			id: Type.String(),
			criterion: Type.String(),
			note: Type.String(),
			reviewer: Type.Optional(Type.String()),
		}),
		buildReviewArgs,
	);
	tool(
		"tandem_close",
		"Tandem Close",
		"Complete or cancel a Tandem record.",
		Type.Object({
			cwd: Type.Optional(Type.String()),
			timeoutMs: Type.Optional(Type.Number()),
			action: stringEnum(["complete", "cancel"] as const),
			id: Type.String(),
			note: Type.Optional(Type.String()),
			reviewer: Type.Optional(Type.String()),
		}),
		buildCloseArgs,
		async (owner, params, cwd) => {
			await emitCloseEvents(owner, params.action, params.id, cwd);
			return closeLinkedInboxRequests(params.action, params.id, cwd);
		},
	);
	tool(
		"tandem_sync",
		"Tandem Sync",
		"Sync the board, show local sync status, or resolve a board conflict.",
		tandemSyncParameters,
		buildSyncArgs,
	);
	tool(
		"tandem_rules",
		"Tandem Rules",
		"List or mutate project rules through Tandem.",
		tandemRulesParameters,
		buildRulesArgs,
	);
	pi.registerCommand("tandem", {
		description: "Show pi-tandem help or status",
		handler: async (args, ctx) => {
			if (args.trim() === "help") {
				ctx.ui.setWidget("pi-tandem", [
					"pi-tandem commands:",
					"/tandem status  Diagnose tandem CLI and workspace.",
					"/tandem help    Show this help.",
					"",
					"LLM-callable tools: tandem_status, tandem_init, tandem_read, tandem_add, tandem_update, tandem_accord, tandem_review, tandem_close, tandem_sync, tandem_rules.",
					"Papercut capture uses tandem_add action=task with priority low, kind papercut, and at least one acceptance criterion.",
				]);
				ctx.ui.notify("pi-tandem help shown", "info");
				return;
			}
			if (args.trim() && args.trim() !== "status") {
				ctx.ui.notify(
					"Unknown /tandem subcommand. Use /tandem help or /tandem status.",
					"warning",
				);
				return;
			}
			const c = cwdOf(ctx.cwd);
			ctx.ui.setWidget("pi-tandem", (await statusReport(c, ctx.signal)).lines);
		},
	});
	registerTaskCommand(pi);
	pi.on("before_agent_start", async (e, ctx) => {
		const w = await workspace(ctx.cwd, ctx.signal);
		const mentioned =
			e.messageType === "user" && promptMentionsDurableCoordination(e.prompt);
		if (!w.detected && !mentioned) return;
		e.systemPromptOptions.sections.tandem = tandemPromptGuidance(w.root, w.detected).trim();
	});
}
