import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hcEndpoint, isHc } from "../pi-herdr/core.ts";
import { isCephTerminal } from "../pi-herdr/herdra-work.ts";
import { NSTAR_INBOX } from "../pi-agency/nstar-note.ts";
import { classify, failureGroups, FAILURE_BINDING, FAILURE_CALL, FAILURE_GROUPS_EVENT, FAILURE_MEMORY_EVENT, FAILURE_SCOPE, isCephRequest, resultText, sessionScope, type FailureGroupsRequest, type FailureRecord } from "./failure-summary";

type FailedCall = { toolName: string; detail: string };

function errorDetail(result: unknown): string {
	const content = (result as { content?: unknown } | null)?.content;
	const text = Array.isArray(content)
		? content
				.filter(
					(part): part is { type: "text"; text: string } =>
						typeof part === "object" &&
						part !== null &&
						"text" in part &&
						typeof part.text === "string",
				)
				.map((part) => part.text)
				.join("\n")
		: "";
	const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	if (!firstLine) return "error";
	return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
}

export function registerFailedCallContext(pi: ExtensionAPI): void {
	let failedCalls: FailedCall[] = [];
	// In-process record of the failed calls (nested included) of the CURRENT turn only: its tool results are
	// not persisted until turn_end (documented), so a completion snapshot reads them here, and the session
	// branch holds everything earlier. Cleared at turn_end, at a scope marker and at every session start, so
	// nothing outlives its persistence and a resumed or replaced session starts empty.
	let records = new Map<string, FailureRecord>();
	let context: ExtensionContext | undefined;
	let sessionId: string | undefined;
	// Ceph assignment (task-852). `scope` is the delivered request the Ceph is working on, or null. It is bound only
	// by the run start (before_agent_start) of a request delivered to this Ceph, cleared by anything that could redirect it and by
	// settling, and every call captures it BEFORE it executes, so a later change never moves a running call.
	let ceph: { core: string; terminal: string } | undefined;
	let scope: string | null = null;
	const scopes = new Map<string, string | null>();
	const known = () => new Set(pi.getAllTools().map((tool) => tool.name));
	const lastBinding = (entries: readonly any[], session: string): string | null =>
		entries.findLast((entry) => entry.type === "custom" && entry.customType === FAILURE_BINDING && entry.data?.session === session)?.data?.scope ?? null;
	function bind(next: string | null): void {
		scope = next;
		pi.appendEntry(FAILURE_BINDING, { session: sessionId, scope: next });
	}

	pi.events.on(FAILURE_MEMORY_EVENT, (request: { op: "reset" | "read"; records?: FailureRecord[] }) => {
		if (request.op === "reset") { records = new Map(); return; }
		request.records = [...records.values()];
	});
	pi.events.on(FAILURE_GROUPS_EVENT, (request: FailureGroupsRequest) => {
		if (!context || !sessionId || request?.session !== sessionId) return;
		const answer = failureGroups(context.sessionManager.getBranch() as any, sessionId, [...records.values()], known());
		if (answer) { request.groups = answer.groups; request.complete = answer.complete; }
	});

	pi.on("turn_start", async () => {
		failedCalls = [];
	});

	pi.on("session_start", async (event, ctx) => {
		records = new Map();
		scopes.clear();
		ceph = undefined;
		scope = null;
		context = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getBranch() as any[];
		// The session's own history starts at the first marker naming its id; a fork copies its parent's entries, markers included.
		if (!entries.some((entry) => entry.type === "custom" && entry.customType === FAILURE_SCOPE && entry.data?.session === sessionId)) pi.appendEntry(FAILURE_SCOPE, { id: sessionScope(sessionId), session: sessionId });
		// Only a reload keeps the same running assignment; startup, resume, new and fork start unbound.
		const previous = lastBinding(entries, sessionId);
		if (event.reason === "reload") scope = previous;
		else if (previous !== null) bind(null);
		if (!isHc()) return;
		try {
			const { terminal, core, record } = await hcEndpoint(process.env.HC_TERMINAL_ID!);
			if (sessionId === ctx.sessionManager.getSessionId() && isCephTerminal({ core, terminal, record })) ceph = { core, terminal };
		} catch (error) {
			console.error(`[pi-tandem] Could not identify this terminal; no Ceph assignment is bound: ${error}`);
		}
	});

	pi.on("session_shutdown", async () => {
		context = undefined;
		sessionId = undefined;
		ceph = undefined;
	});

	// The only binding edge: Pi's own run start. `before_agent_start` says what started this run; a custom start is the
	// delivered message itself (event.message), so the exact delivery is read, never the last entry. A send that failed or
	// was queued but never delivered starts no run, so nothing binds. Requests only: no control, no reply, addressed to
	// this Ceph. Anything else that starts a run (typed input, another agent message) leaves the run unattributed.
	pi.on("before_agent_start", async (event) => {
		const env = event.messageType === "custom" && event.message?.customType === "pi-agent-message" ? (event.message as any).details : undefined;
		const request = ceph && isCephRequest(env, ceph) ? env.id : null;
		if (request !== scope) bind(request);
	});

	// Fail-closed invalidation, as early as Pi lets this extension see anything that could redirect the work: typed input
	// and an inbox delivery ATTEMPT (before pi.sendMessage can queue it), then the message's own message_end, then settling.
	// Calls that already started keep the scope they captured; calls that start afterwards are unattributed until the
	// next run start binds again. Unbinding on an attempt that never lands only loses attribution, never misattributes.
	const unbind = () => { if (scope !== null) bind(null); };
	pi.on("input", async () => { unbind(); });
	pi.events.on(NSTAR_INBOX, unbind);
	pi.on("message_end", async (event) => {
		const message = event.message as any;
		// The STARTING request's own message_end must not clear the scope it just bound: only that exact delivery is exempt, never a steer.
		if (message.role === "custom" && message.customType === "pi-agent-message" && scope !== null && message.details?.id === scope) return;
		if (message.role === "user" || (message.role === "custom" && message.customType === "pi-agent-message")) unbind();
	});
	pi.on("agent_settled", async () => { unbind(); });

	pi.on("tool_execution_start", async (event) => {
		// Nested calls inherit their parent's captured scope; a nested call with no known parent is unattributed.
		scopes.set(event.toolCallId, event.parentToolCallId !== undefined ? scopes.get(event.parentToolCallId) ?? null : ceph ? scope : null);
	});

	pi.on("tool_execution_end", async (event) => {
		const captured = scopes.get(event.toolCallId) ?? null;
		scopes.delete(event.toolCallId);
		if (event.isError) records.set(event.toolCallId, { id: event.toolCallId, tool: event.toolName, code: classify(resultText(event.result), event.toolName), scope: captured });
		if (!event.isError || event.parentToolCallId !== undefined) return;
		failedCalls.push({
			toolName: event.toolName,
			detail: errorDetail(event.result),
		});
	});

	pi.on("turn_end", async (event) => {
		// Failures that ran under a Ceph request are the one durable ledger; each carries the scope captured before it ran.
		const ledger = [...records.values()].filter((record) => record.scope && sessionId).map((record) => ({
			type: "custom" as const, customType: FAILURE_CALL, data: { session: sessionId, id: record.id, tool: record.tool, code: record.code, scope: record.scope },
		}));
		records = new Map();
		scopes.clear();
		const entries = [...event.entries, ...ledger];
		if (!failedCalls.length) return ledger.length ? { entries } : undefined;
		const calls = failedCalls
			.map(({ toolName, detail }) => `${toolName} (${detail})`)
			.join(", ");
		const line = `Failed tool calls this turn: ${calls}. Papercut only if the contract is brittle or the friction recurs; recover first.`;
		failedCalls = [];
		return {
			entries: [
				...entries,
				{
					type: "custom_message",
					customType: "failed-tool-calls",
					content: line,
					display: false,
				},
			],
		};
	});
}
