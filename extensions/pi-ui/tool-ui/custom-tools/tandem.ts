import type { Theme } from "@earendil-works/pi-coding-agent";
import { createBoxedToolRenderer } from "../core/card";
import { durationLabel, fieldLine, hiddenHint, joinTitleParts, plainTextLines, section, statusIcon, statusTone, toolName as renderToolName, truncatePlain, truncationLines } from "../core/text";
import type { BoxedToolRenderInput, ToolUiBoxModel, ToolUiSectionModel } from "../core/types";

type TandemToolInput = Record<string, any>;
type TandemToolDetails = Record<string, any> & {
	ok?: boolean;
	args?: string[];
	cwd?: string;
	command?: string;
	stdout?: string;
	stderr?: string;
	diagnostic?: string;
	error?: string;
	workspaceRoot?: string;
	workspaceDetected?: boolean;
	parsedJson?: unknown;
	truncation?: { truncated?: boolean; outputLines?: number; totalLines?: number; outputBytes?: number; totalBytes?: number; maxBytes?: number; truncatedBy?: string | null };
	fullOutputPath?: string;
	assigneePersistence?: { ok?: boolean };
	partialState?: string;
	cancelled?: boolean;
};

type ParsedEnvelope = { ok?: unknown; data?: unknown; warnings?: unknown };

const TOOL_LABELS: Record<string, string> = {
	tandem_status: "Tandem Status",
	tandem_init: "Tandem Init",
	tandem_read: "Tandem Read",
	tandem_add: "Tandem Add",
	tandem_update: "Tandem Update",
	tandem_accord: "Tandem Accord",
	tandem_review: "Tandem Review",
	tandem_close: "Tandem Close",
	tandem_sync: "Tandem Sync",
	tandem_rules: "Tandem Rules",
};

export function createTandemToolRenderer(registeredName: string, label = TOOL_LABELS[registeredName] || "Tandem") {
	return createBoxedToolRenderer<TandemToolInput, TandemToolDetails>((input) => buildTandemBox(registeredName, label, input));
}

function buildTandemBox(
	registeredName: string,
	label: string,
	{ args, result, options, theme, text, pending, error, context }: BoxedToolRenderInput<TandemToolInput, TandemToolDetails>,
): ToolUiBoxModel {
	const details = asDetails(result?.details);
	const cancelled = details.cancelled === true || Boolean((result as any)?.cancelled);
	const parsed = asEnvelope(details.parsedJson);
	const failed = !cancelled && (error || details.ok === false || parsed?.ok === false);
	const warning = !failed && (cancelled || hasWarnings(details.parsedJson));
	const tone = statusTone({ pending, error: Boolean(failed), warning });
	const status = pending ? (context.executionStarted ? "running" : "queued") : failed ? "failed" : cancelled ? "cancelled" : warning ? "warning" : result ? "done" : "queued";
	const expanded = Boolean(options.expanded);
	const sections: ToolUiSectionModel[] = [];
	const summary = !pending && result && !cancelled ? domainSummary(registeredName, args, details, Boolean(failed), label) : undefined;
	const pendingAction = actionOf(args);

	if (!pending && result) {
		if (failed || cancelled || (expanded && registeredName !== "tandem_read") || !summary) {
			sections.push(section(failed ? "Error" : cancelled ? "Cancelled" : "Summary", resultLines(registeredName, args, details, text, theme, Boolean(failed), expanded, cancelled, label)));
		}
		if (!cancelled) {
			sections.push(...parsedSections(registeredName, args, details.parsedJson, theme, expanded, details, label));
			sections.push(warningsSection(details.parsedJson, theme, expanded));
		}
		if (failed) sections.push(diagnosticsSection(details, text, theme));
	}

	const body = pending
		? [theme.fg("muted", callSummary(registeredName, args, details))]
		: expanded
			? [theme.fg("muted", callSummary(registeredName, args, details))]
			: summary
				? []
				: [theme.fg("toolOutput", resultLines(registeredName, args, details, text, theme, Boolean(failed), expanded, cancelled, label)[0] || "")];

	return {
		title: `${statusIcon(theme, tone)} ${renderToolName(theme, label)}`,
		status: joinTitleParts([pending ? status : summary || status, pending ? pendingAction : undefined, pending ? headerMeta(registeredName, args, details, pending) : undefined, durationLabel(context.state)]),
		tone,
		body,
		sections: sections.filter((item) => item.lines.length > 0),
	};
}

function resultLines(registeredName: string, args: TandemToolInput, details: TandemToolDetails, text: string, theme: Theme, failed: boolean, expanded: boolean, cancelled = false, label = ""): string[] {
	const summary = cancelled
		? "Tandem command cancelled before completion."
		: failed
			? readableError(details.diagnostic || details.error || text) || "Tandem command failed."
			: domainSummary(registeredName, args, details, false, label) || responseMessage(registeredName, args, details);
	return [
		theme.fg(failed ? "error" : "toolOutput", truncatePlain(summary, expanded ? 700 : 260)),
		failed && details.cwd ? fieldLine(theme, "cwd", details.cwd, "muted") : undefined,
		registeredName === "tandem_status" ? fieldLine(theme, "workspace", workspaceDisplay(details), details.workspaceDetected ? "success" : "warning") : undefined,
	].filter((line): line is string => Boolean(line));
}

function parsedSections(registeredName: string, args: TandemToolInput, parsedJson: unknown, theme: Theme, expanded: boolean, details: TandemToolDetails, label = ""): ToolUiSectionModel[] {
	if (registeredName === "tandem_status") return statusSections(details, theme);
	const envelope = asEnvelope(parsedJson);
	if (registeredName === "tandem_init") {
		const sections = initSections(details, theme);
		const sync = asRecord(asRecord(envelope?.data)?.sync);
		if (sync) sections.push(syncSection(sync, theme));
		return sections;
	}
	if (!isStructuredResponse(registeredName, args, details)) return [responseNotice(parsedJson, theme, details)];
	const rawData = envelope!.data;
	const data = asRecord(rawData);
	if (registeredName === "tandem_sync") {
		const sections = syncResultSections(args, data, theme, expanded);
		return sections.length ? sections : [responseNotice(parsedJson, theme)];
	}
	let sections: ToolUiSectionModel[];
	if (registeredName === "tandem_accord") sections = accordSections(args, data, theme, expanded, details);
	else if (registeredName === "tandem_read") sections = readSections(args, rawData, theme, expanded);
	else if (registeredName === "tandem_rules") sections = rulesSections(rawData, theme, expanded);
	else if (registeredName === "tandem_add") sections = creationSections(args, data, theme, expanded, label);
	else if (registeredName === "tandem_review") sections = reviewSections(args, data, theme, expanded);
	else if (registeredName === "tandem_close") sections = closeSections(args, data, theme, expanded);
	else if (registeredName === "tandem_update") sections = data ? [objectSection("Updated", data, theme, expanded)] : [responseNotice(parsedJson, theme)];
	else sections = data ? [objectSection("Data", data, theme, expanded)] : [responseNotice(parsedJson, theme)];
	const sync = asRecord(data?.sync);
	if (sync) sections.push(syncSection(sync, theme));
	return sections;
}

function syncResultSections(args: TandemToolInput, data: Record<string, any> | undefined, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	if (!data) return [];
	if (args.action === "status") return [syncStatusSection(data, theme, expanded)];
	const sync = asRecord(data.sync);
	return sync ? [syncSection(sync, theme)] : [];
}

function syncStatusSection(data: Record<string, any>, theme: Theme, expanded: boolean): ToolUiSectionModel {
	const conflicts = asArray(data.conflicts);
	const held = asArray(data.held);
	return section("Sync status", [
		fieldLine(theme, "state", syncStatusLabel(data), data.pending === true || conflicts.length > 0 || held.length > 0 ? "warning" : "success"),
		valueLine(theme, "remote", data.remote, "muted"),
		valueLine(theme, "last fetch", data.lastFetch, "muted"),
		valueLine(theme, "last error", data.lastError, data.lastError ? "warning" : "muted"),
		...syncItems("conflict", conflicts, theme, expanded),
		...syncItems("held edit", held, theme, expanded),
	].filter((line): line is string => Boolean(line)));
}

function syncSection(sync: Record<string, any>, theme: Theme): ToolUiSectionModel {
	const pending = sync.status === "pending";
	return section("Board sync", [
		fieldLine(theme, "status", pending ? "pending · saved locally" : formatReadableValue(sync.status || "unknown"), pending ? "warning" : "success"),
		valueLine(theme, "message", sync.message, pending ? "warning" : "muted"),
		...renamedLines(sync.renamed, theme),
		...syncItems("conflict", asArray(sync.conflicts), theme, true),
		...syncItems("held edit", asArray(sync.held), theme, true),
	].filter((line): line is string => Boolean(line)));
}

function renamedLines(value: unknown, theme: Theme): string[] {
	const renamed = asRecord(value);
	return Object.entries(renamed || {}).map(([from, to]) => fieldLine(theme, "renamed", `${from} → ${formatReadableValue(to)}`, "muted"));
}

function syncItems(label: string, items: unknown[], theme: Theme, expanded: boolean): string[] {
	return items.map((item) => fieldLine(theme, label, truncatePlain(formatReadableValue(item), expanded ? 320 : 180), "warning"));
}

function syncSummary(sync: Record<string, any> | undefined): string {
	if (!sync) return "sync result unavailable";
	return sync.status === "pending" ? "pending · saved locally" : `${sync.status || "sync"}`;
}

function syncStatusSummary(data: Record<string, any> | undefined): string {
	return data ? syncStatusLabel(data) : "sync status unavailable";
}

function syncStatusLabel(data: Record<string, any>): string {
	if (data.pending === true) return "pending · saved locally";
	const conflicts = asArray(data.conflicts).length;
	const held = asArray(data.held).length;
	if (conflicts || held) return [conflicts ? `${conflicts} conflict${conflicts === 1 ? "" : "s"}` : undefined, held ? `${held} held edit${held === 1 ? "" : "s"}` : undefined].filter(Boolean).join(" · ");
	return data.published === true ? "synced" : "local-only";
}

function responseNotice(parsedJson: unknown, theme: Theme, details?: TandemToolDetails): ToolUiSectionModel {
	const missing = parsedJson === undefined && !details?.stdout?.trim();
	return section("Response", [theme.fg("warning", missing ? "Structured result unavailable." : "Structured result malformed: expected a valid operation result.")]);
}

function responseMessage(registeredName: string, args: TandemToolInput, details: TandemToolDetails): string {
	if (isStructuredResponse(registeredName, args, details)) return "Tandem operation completed.";
	return details.parsedJson === undefined && !details.stdout?.trim() ? "Structured result unavailable." : "Structured result malformed.";
}

function initSections(details: TandemToolDetails, theme: Theme): ToolUiSectionModel[] {
	return isStructuredResponse("tandem_init", {}, details) ? [] : [responseNotice(details.parsedJson, theme, details)];
}

function workspaceDisplay(details: TandemToolDetails): string {
	return details.workspaceRoot || (details.workspaceDetected ? "detected (non-Git)" : "not found");
}

function statusSections(details: TandemToolDetails, theme: Theme): ToolUiSectionModel[] {
	const cli = section("CLI", [
		valueLine(theme, "binary", details.tandemBinary, "muted"),
		valueLine(theme, "resolved", details.tandemResolved, details.tandemResolved === "unavailable" ? "warning" : "muted"),
		valueLine(theme, "version", details.tandemVersion, "success"),
		valueLine(theme, "version error", details.tandemVersionError, "error"),
		valueLine(theme, "stderr", details.tandemVersionStderr, "warning"),
	]);
	const workspace = section("Workspace", [valueLine(theme, "root", workspaceDisplay(details), details.workspaceDetected ? "success" : "warning")]);
	return [cli, workspace];
}

function isStructuredResponse(registeredName: string, args: TandemToolInput, details: TandemToolDetails): boolean {
	if (registeredName === "tandem_status") return true;
	const envelope = asEnvelope(details.parsedJson);
	if (registeredName === "tandem_init") {
		if (details.parsedJson === undefined) return !details.stdout?.trim();
		return Boolean(envelope && Object.prototype.hasOwnProperty.call(envelope, "data") && asRecord(envelope.data));
	}
	if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, "data")) return false;
	const data = envelope.data;
	if (registeredName === "tandem_read") return args.action === "show" ? Boolean(asRecord(data)) : Array.isArray(data);
	if (registeredName === "tandem_rules" && args.action === "list") return Array.isArray(data) || Boolean(asRecord(data));
	return Boolean(asRecord(data));
}

function readSections(args: TandemToolInput, rawData: unknown, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	if (args.action === "show") {
		const record = asRecord(rawData);
		return record ? showSections(record, theme, expanded) : [responseNotice(rawData, theme)];
	}
	if (args.action === "list") return rawRowsSection("Records", rawData, taskLine, theme, expanded);
	if (args.action === "search") return rawRowsSection("Results", rawData, searchLine, theme, expanded);
	return [responseNotice(rawData, theme)];
}

function rawRowsSection(title: string, rawData: unknown, render: (row: Record<string, any>, theme: Theme, expanded: boolean) => string, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	if (!Array.isArray(rawData)) return [responseNotice(rawData, theme)];
	const rows = rawData.filter((row): row is Record<string, any> => Boolean(asRecord(row)));
	return [rowsSection(title, rows, render, theme, expanded)];
}

function rulesSections(rawData: unknown, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	if (Array.isArray(rawData)) return [rowsSection("Rules", rawData.filter((row): row is Record<string, any> => Boolean(asRecord(row))), ruleLine, theme, expanded)];
	const data = asRecord(rawData);
	if (!data) return [responseNotice(rawData, theme)];
	return rowSections("Rules", data, ["items", "rules"], ruleLine, theme, expanded);
}

function showSections(record: Record<string, any>, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	const accord = asRecord(record.accord);
	const resolution = asRecord(record.resolution);
	const relations = relationFields(record, theme);
	const body = typeof record.body === "string" ? record.body : undefined;
	const taskLines = [
		valueLine(theme, "id", record.id, "accent"),
		record.title ? valueLine(theme, "title", truncatePlain(formatReadableValue(record.title), expanded ? 220 : 120), "toolOutput") : undefined,
		valueLine(theme, "type", joinTitleParts([record.type, record.location ? String(record.location) : undefined]), "muted"),
		valueLine(theme, "priority", joinTitleParts([record.priority, record.effort ? `effort ${record.effort}` : undefined]), record.priority ? priorityTone(record.priority) : "muted"),
		accord?.status || record.accordStatus ? valueLine(theme, "accord", joinTitleParts([accord?.status || record.accordStatus, accord?.assignee || record.assignee || "unassigned"]), statusToneForValue(accord?.status || record.accordStatus)) : undefined,
		record.tags?.length ? valueLine(theme, "tags", record.tags.join(", "), "muted") : undefined,
		resolution?.outcome ? valueLine(theme, "outcome", truncatePlain(joinTitleParts([resolution.outcome, resolution.note]), expanded ? 260 : 150), statusToneForValue(resolution.outcome)) : undefined,
	];
	const sections = [section("Task", taskLines)];
	if (accord && expanded) sections.push(section("Accord", orderedObjectLines(accord, ["status", "assignee", "reviewer", "acceptance", "constraints", "validations", "deliverables", "evidence", "filesChanged", "summary", "note", "reason", "claimedAt", "deliveredAt"], theme)));
	if (resolution && expanded) sections.push(section("Resolution", orderedObjectLines(resolution, ["outcome", "note", "reviewer", "filesChanged"], theme)));
	if (relations.length && expanded) sections.push(section("Relations", relations));
	if (body) {
		const bodyLines = expanded
			? plainTextLines(theme, body, true, { expanded: 18, noun: "line" })
			: [fieldLine(theme, "lines", body.split("\n").length, "muted"), record.relatedFiles?.length ? fieldLine(theme, "related files", record.relatedFiles.length, "muted") : undefined];
		sections.push(section("Body", bodyLines));
	}
	return sections;
}

function valueLine(theme: Theme, label: string, value: unknown, tone: any = "muted"): string | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	return fieldLine(theme, label, formatReadableValue(value), tone);
}

function orderedObjectLines(record: Record<string, any>, keys: string[], theme: Theme): string[] {
	return keys.flatMap((key) => {
		const value = record[key];
		if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (asRecord(value) && Object.keys(value).length === 0)) return [];
		return [fieldLine(theme, key, truncatePlain(formatReadableValue(value), 360), "muted")];
	});
}

function relationFields(record: Record<string, any>, theme: Theme): string[] {
	return ["parent", "parentId", "parentRelationship", "blockers", "references", "relatedFiles", "children"].flatMap((key) => {
		const value = record[key];
		if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0) || (asRecord(value) && Object.keys(value).length === 0)) return [];
		return [fieldLine(theme, key, formatReadableValue(value), "muted")];
	});
}

function creationSections(args: TandemToolInput, data: Record<string, any> | undefined, theme: Theme, expanded: boolean, label: string): ToolUiSectionModel[] {
	if (!data) return [responseNotice(data, theme)];
	const id = data.id;
	const title = data.title ?? args.title;
	const lines = [
		valueLine(theme, "id", id, "accent"),
		valueLine(theme, "title", title, "toolOutput"),
		valueLine(theme, "type", data.type ?? (isPapercut(args, label) ? "papercut task" : args.action), "muted"),
		...(expanded ? orderedObjectLines(data, ["state", "priority", "effort", "tags", "parent", "recordWritten"], theme) : []),
	];
	return [section(isPapercut(args, label) ? "Papercut" : "Created", lines)];
}

function reviewSections(args: TandemToolInput, data: Record<string, any> | undefined, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	return [section("Review", [
		fieldLine(theme, "task", args.id, "accent"),
		fieldLine(theme, "criterion", truncatePlain(args.criterion, expanded ? 280 : 150), "toolOutput"),
		fieldLine(theme, "note", truncatePlain(args.note, expanded ? 280 : 150), "toolOutput"),
		args.reviewer ? fieldLine(theme, "reviewer", args.reviewer, "muted") : undefined,
		...(data ? orderedObjectLines(data, ["status", "reviewer", "criterion", "note", "recordWritten"], theme) : []),
	])];
}

function closeSections(args: TandemToolInput, data: Record<string, any> | undefined, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	const completed = args.action === "complete";
	return [section(completed ? "Completion" : "Cancellation", [
		fieldLine(theme, "task", args.id, "accent"),
		fieldLine(theme, "action", completed ? "completed" : "canceled", completed ? "success" : "warning"),
		!completed ? fieldLine(theme, "archive", "moved to Logs", "warning") : undefined,
		args.note ? fieldLine(theme, "note", truncatePlain(args.note, expanded ? 280 : 150), "toolOutput") : undefined,
		args.reviewer ? fieldLine(theme, "reviewer", args.reviewer, "muted") : undefined,
		...(data ? orderedObjectLines(data, ["outcome", "location", "recordWritten"], theme) : []),
	])];
}

function isPapercut(args: TandemToolInput, label: string): boolean {
	return label === "Tandem Papercuts" || (args.action === "task" && args.kind === "papercut");
}

function accordSections(args: TandemToolInput, data: Record<string, any> | undefined, theme: Theme, expanded: boolean, details: TandemToolDetails): ToolUiSectionModel[] {
	const accord = asRecord(data?.accord) || data;
	const action = String(args.action || "accord");
	const id = args.id || accord?.id || accord?.taskId;
	const from = accord?.from || accord?.previousStatus || accord?.fromState;
	const to = accord?.to || accord?.status || accord?.toState;
	const transition = from && to ? `${from} → ${to}` : to ? `→ ${to}` : undefined;
	const lines = [
		fieldLine(theme, "task", id || "response ID unavailable", "accent"),
		fieldLine(theme, "action", action, "accent"),
		transition ? fieldLine(theme, "accord", transition, statusToneForValue(to)) : undefined,
		accord?.workflow ? fieldLine(theme, "workflow", formatReadableValue(accord.workflow), statusToneForValue(accord.workflow)) : undefined,
		args.assignee ? fieldLine(theme, "assignee", args.assignee, "muted") : undefined,
		details.assigneePersistence?.ok === true ? fieldLine(theme, "assignee", "persisted", "success") : undefined,
		args.summary ? fieldLine(theme, "summary", truncatePlain(args.summary, expanded ? 300 : 150), "toolOutput") : undefined,
		args.note ? fieldLine(theme, "note", truncatePlain(args.note, expanded ? 260 : 140), "toolOutput") : undefined,
		...(expanded && data ? orderedObjectLines(data, ["status", "from", "to", "state", "summary", "note", "recordWritten"], theme) : []),
	];
	const title = action === "deliver" ? "Delivery" : action === "accept" ? "Acceptance" : "Accord";
	return [section(title, lines)];
}

function rowSections(title: string, data: Record<string, any>, keys: string[], render: (row: Record<string, any>, theme: Theme, expanded: boolean) => string, theme: Theme, expanded: boolean): ToolUiSectionModel[] {
	const rows = keys.flatMap((key) => asArray<Record<string, any>>(data[key]));
	const sections: ToolUiSectionModel[] = [];
	const counts = asRecord(data.counts);
	if (counts) sections.push(countsSection(counts, theme));
	if (rows.length) sections.push(rowsSection(title, rows, render, theme, expanded));
	else if (Object.keys(data).length) sections.push(objectSection("Data", data, theme, expanded));
	return sections;
}

function rowsSection(title: string, rows: Record<string, any>[], render: (row: Record<string, any>, theme: Theme, expanded: boolean) => string, theme: Theme, expanded: boolean): ToolUiSectionModel {
	const limit = expanded ? 20 : 8;
	const lines = rows.slice(0, limit).map((row) => render(row, theme, expanded));
	if (rows.length > limit) lines.push(hiddenHint(theme, rows.length - limit, "item", expanded));
	return section(title, lines.length ? lines : [theme.fg("dim", "No items.")]);
}

function countsSection(counts: Record<string, any>, theme: Theme): ToolUiSectionModel {
	const byState = keyCounts(asRecord(counts.byState));
	const byType = keyCounts(asRecord(counts.byType));
	return section("Counts", [
		fieldLine(theme, "total", counts.total ?? counts.count ?? "—", "accent"),
		byState ? fieldLine(theme, "state", byState, "muted") : undefined,
		byType ? fieldLine(theme, "type", byType, "muted") : undefined,
	]);
}

function objectSection(title: string, record: Record<string, any>, theme: Theme, expanded: boolean): ToolUiSectionModel {
	const entries = Object.entries(record).filter(([key, value]) => key !== "warnings" && key !== "sync" && value !== undefined && value !== null && value !== "");
	const limit = expanded ? 14 : 7;
	const lines = entries.slice(0, limit).map(([key, value]) => fieldLine(theme, key, truncatePlain(formatReadableValue(value), expanded ? 280 : 110), key === "error" ? "error" : "muted"));
	if (entries.length > limit) lines.push(hiddenHint(theme, entries.length - limit, "field", expanded));
	return section(title, lines.length ? lines : [theme.fg("muted", "No structured fields returned.")]);
}

function diagnosticsSection(details: TandemToolDetails, text: string, theme: Theme): ToolUiSectionModel {
	const diagnostic = readableError(details.diagnostic || details.error || text);
	return section("Diagnostics", [
		diagnostic ? fieldLine(theme, "diagnostic", diagnostic, "error") : undefined,
		commandLineOf(details) ? fieldLine(theme, "command", commandLineOf(details), "muted") : undefined,
		details.cwd ? fieldLine(theme, "cwd", details.cwd, "muted") : undefined,
		details.args?.length ? fieldLine(theme, "arguments", details.args.join(" "), "muted") : undefined,
		details.stderr?.trim() ? fieldLine(theme, "stderr", truncatePlain(details.stderr, 300), "warning") : undefined,
		...truncationLines(theme, details),
	]);
}

function warningsSection(parsedJson: unknown, theme: Theme, expanded: boolean): ToolUiSectionModel {
	const envelope = asEnvelope(parsedJson);
	const warnings = asArray(envelope?.warnings);
	if (!warnings.length) return section("Warnings", []);
	const limit = expanded ? 12 : 3;
	const lines = warnings.slice(0, limit).map((warning) => `${theme.fg("warning", "!")} ${theme.fg("warning", truncatePlain(formatReadableValue(warning), expanded ? 360 : 180))}`);
	if (warnings.length > limit) lines.push(hiddenHint(theme, warnings.length - limit, "warning", expanded));
	return section("Warnings", lines);
}

function taskLine(item: Record<string, any>, theme: Theme): string {
	const id = truncatePlain(formatReadableValue(item.id || item.taskId || "task"), 34);
	const title = truncatePlain(formatReadableValue(item.title || item.summary || "(untitled)"), 120);
	const meta = joinTitleParts([
		item.state ? theme.fg(statusToneForValue(item.state), String(item.state)) : undefined,
		item.priority ? theme.fg(priorityTone(item.priority), String(item.priority)) : undefined,
		asRecord(item.accord)?.status ? theme.fg(statusToneForValue(asRecord(item.accord)?.status), `accord:${asRecord(item.accord)?.status}`) : undefined,
		item.assignee ? theme.fg("muted", `@${item.assignee}`) : undefined,
	]);
	return `${theme.fg("accent", "•")} ${theme.fg("accent", id)} ${theme.fg("text", title)}${meta ? ` ${theme.fg("dim", "[")}${meta}${theme.fg("dim", "]")}` : ""}`;
}

function ruleLine(item: Record<string, any>, theme: Theme): string {
	const id = `${formatReadableValue(item.category || "rule")}${item.id === undefined ? "" : `#${formatReadableValue(item.id)}`}`;
	return `${theme.fg("muted", id)} ${theme.fg("text", truncatePlain(formatReadableValue(item.rule || item.text || item.value || "(empty rule)"), 180))}`;
}

function searchLine(item: Record<string, any>, theme: Theme, expanded: boolean): string {
	const id = truncatePlain(formatReadableValue(item.id || item.path || item.type || "result"), 44);
	const title = truncatePlain(formatReadableValue(item.title || item.summary || item.text || "result"), expanded ? 180 : 130);
	const snippet = item.snippet ? truncatePlain(formatReadableValue(item.snippet), expanded ? 260 : 120) : undefined;
	const meta = joinTitleParts([
		item.type ? theme.fg("muted", String(item.type)) : undefined,
		item.state ? theme.fg(statusToneForValue(item.state), String(item.state)) : undefined,
	]);
	return `${theme.fg("accent", id)} ${theme.fg("text", title)}${meta ? theme.fg("dim", ` · ${meta}`) : ""}${snippet ? `\n${" ".repeat(11)}${theme.fg("muted", snippet)}` : ""}`;
}

function callSummary(registeredName: string, args: TandemToolInput, details: TandemToolDetails): string {
	if (registeredName === "tandem_status") return args.cwd ? `workspace check from ${args.cwd}` : "diagnose CLI and workspace";
	if (registeredName === "tandem_init") return args.title ? `create workspace ${quote(args.title)}` : "create workspace";
	const parts = compactArgParts(args).filter((part) => !part.startsWith("cwd "));
	return joinTitleParts([actionOf(args), ...parts]) || commandLineOf(details) || "No input.";
}

function compactArgParts(args: TandemToolInput): string[] {
	const order = ["id", "title", "query", "state", "type", "priority", "category", "assignee", "reviewer", "limit", "cwd"];
	return order.flatMap((key) => {
		const value = args?.[key];
		if (value === undefined || value === null || value === "") return [];
		return [`${key} ${Array.isArray(value) ? `[${value.length}]` : truncatePlain(value, 58)}`];
	}).slice(0, 6);
}

function headerMeta(registeredName: string, args: TandemToolInput, details: TandemToolDetails, pending: boolean): string | undefined {
	if (pending) return compactArgParts(args).slice(0, 2).join(" · ") || undefined;
	if (registeredName === "tandem_status") return details.workspaceDetected ? "workspace found" : "no workspace";
	const envelope = asEnvelope(details.parsedJson);
	const rawData = envelope?.data;
	if ((registeredName === "tandem_read" || registeredName === "tandem_rules") && Array.isArray(rawData)) return `${rawData.length} ${registeredName === "tandem_read" && args.action === "search" ? "result" : registeredName === "tandem_rules" ? "rule" : "item"}${rawData.length === 1 ? "" : "s"}`;
	const data = asRecord(rawData);
	const rows = asArray(data?.items ?? data?.results ?? data?.rules ?? data?.decisions ?? data?.logs);
	if (rows.length) return `${rows.length} item${rows.length === 1 ? "" : "s"}`;
	if (typeof data?.count === "number") return `${data.count} item${data.count === 1 ? "" : "s"}`;
	if (typeof data?.counts?.total === "number") return `${data.counts.total} total`;
	return args.id || args.query;
}

function domainSummary(registeredName: string, args: TandemToolInput, details: TandemToolDetails, failed: boolean, label = ""): string | undefined {
	if (failed) return readableError(details.diagnostic || details.error) || "failed";
	if (registeredName !== "tandem_status" && !isStructuredResponse(registeredName, args, details)) return undefined;
	const envelope = asEnvelope(details.parsedJson);
	const data = envelope?.data;
	if (registeredName === "tandem_status") return details.workspaceRoot ? `workspace found · ${details.workspaceRoot}` : details.workspaceDetected ? "workspace found · non-Git" : "no workspace found";
	if (registeredName === "tandem_init") return joinTitleParts(["initialized workspace", args.title ? quote(args.title) : undefined]);
	if (registeredName === "tandem_read") return readSummary(args, data);
	if (registeredName === "tandem_add") {
		const id = asRecord(data)?.id;
		const verb = isPapercut(args, label) ? "recorded" : "created";
		return `${verb} ${id || "ID unavailable"}${args.title ? ` · ${quote(args.title)}` : ""}`;
	}
	if (registeredName === "tandem_update") return `updated ${args.id || asRecord(data)?.id || "record"}`;
	if (registeredName === "tandem_accord") return accordSummary(args, asRecord(data));
	if (registeredName === "tandem_review") return `reviewed ${args.id || asRecord(data)?.id || "record"}`;
	if (registeredName === "tandem_close") return args.action === "cancel" ? `canceled ${args.id} · archived to Logs` : `completed ${args.id}`;
	if (registeredName === "tandem_sync") {
		const sync = asRecord(data)?.sync;
		if (args.action === "status") return syncStatusSummary(asRecord(data));
		return sync ? syncSummary(asRecord(sync)) : "sync result unavailable";
	}
	if (registeredName === "tandem_rules") return rulesSummary(args, data);
	return undefined;
}

function readSummary(args: TandemToolInput, rawData: unknown): string {
	if (args.action === "show") {
		const record = asRecord(rawData);
		return record ? joinTitleParts(["show", record.id || args.id, record.state]) : "show · structured result unavailable";
	}
	const rows = Array.isArray(rawData) ? rawData : [];
	const noun = args.action === "search" ? "result" : "record";
	return joinTitleParts([args.action, `${rows.length} ${noun}${rows.length === 1 ? "" : "s"}`, args.query ? quote(args.query) : undefined]);
}

function accordSummary(args: TandemToolInput, data: Record<string, any> | undefined): string {
	const accord = asRecord(data?.accord) || data;
	const status = accord?.status || accord?.to;
	return joinTitleParts([`${String(args.action || "accord")} ${args.id || accord?.taskId || accord?.id || "record"}`, status ? `→ ${status}` : undefined]);
}

function rulesSummary(args: TandemToolInput, rawData: unknown): string {
	if (args.action === "list") {
		const rows = Array.isArray(rawData) ? rawData : asArray(asRecord(rawData)?.items ?? asRecord(rawData)?.rules);
		return `${rows.length} rule${rows.length === 1 ? "" : "s"}`;
	}
	const verb = args.action === "add" ? "added" : args.action === "edit" ? "edited" : "deleted";
	const target = args.category ? `${args.category} rule` : "rule";
	return joinTitleParts([`${verb} ${target}`, args.id !== undefined ? `#${args.id}` : undefined]);
}

function quote(value: unknown): string {
	return `"${truncatePlain(value, 80)}"`;
}

function actionOf(args: TandemToolInput): string {
	return String(args?.action || "status");
}

function commandLineOf(details: TandemToolDetails): string | undefined {
	if (!details.command) return undefined;
	return `${details.command} ${asArray(details.args).join(" ")}`.trim();
}

function hasWarnings(parsedJson: unknown): boolean {
	const envelope = asEnvelope(parsedJson);
	return asArray(envelope?.warnings).length > 0;
}

function keyCounts(record: Record<string, any> | undefined): string | undefined {
	const text = Object.entries(record || {}).map(([key, value]) => `${key}:${formatReadableValue(value)}`).join(" ");
	return text || undefined;
}

function statusToneForValue(value: unknown): "success" | "warning" | "error" | "accent" | "muted" | "dim" {
	const text = String(value || "").toLowerCase();
	if (["done", "completed", "accepted", "healthy", "ok", "resolved"].includes(text)) return "success";
	if (["failed", "error", "blocked"].includes(text)) return "error";
	if (["validation", "delivered", "warning", "draft", "rework", "canceled", "cancelled"].includes(text)) return "warning";
	if (["in_progress", "in-progress", "active", "claimed", "todo", "ready"].includes(text)) return "accent";
	return "muted";
}

function priorityTone(value: unknown): "warning" | "muted" | "dim" {
	const text = String(value || "").toLowerCase();
	if (["high", "urgent", "p0", "p1"].includes(text)) return "warning";
	if (["low", "p3", "p4"].includes(text)) return "dim";
	return "muted";
}

function asDetails(value: unknown): TandemToolDetails {
	return asRecord(value) as TandemToolDetails || {};
}

function asRecord(value: unknown): Record<string, any> | undefined {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
	return undefined;
}

function asEnvelope(value: unknown): ParsedEnvelope | undefined {
	return asRecord(value) as ParsedEnvelope | undefined;
}

function asArray<T = any>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (value === undefined || value === null) return [];
	return [value as T];
}

function formatReadableValue(value: unknown, depth = 0): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (depth >= 3) return "…";
	if (Array.isArray(value)) return value.map((item) => formatReadableValue(item, depth + 1)).join(", ");
	const record = asRecord(value);
	if (!record) return String(value);
	return Object.entries(record).map(([key, item]) => `${key}=${formatReadableValue(item, depth + 1)}`).join("; ");
}

function readableError(text: unknown): string {
	if (typeof text !== "string") return text === undefined ? "" : formatReadableValue(text);
	const trimmed = text.trim();
	if (/^[{[]/.test(trimmed)) {
		try {
			const parsed = JSON.parse(trimmed);
			return formatReadableValue(parsed);
		} catch {
			return "Structured command failure.";
		}
	}
	const lines = text.replace(/\r/g, "").split("\n");
	const kept: string[] = [];
	let skippingStdout = false;
	for (const line of lines) {
		if (/^stdout:\s*$/i.test(line.trim())) {
			skippingStdout = true;
			continue;
		}
		if (skippingStdout && /^(stderr|error|cwd|command|exit):/i.test(line.trim())) skippingStdout = false;
		if (skippingStdout || !line.trim()) continue;
		kept.push(line.trim());
	}
	return kept.join(" ").replace(/\s+/g, " ").trim();
}
