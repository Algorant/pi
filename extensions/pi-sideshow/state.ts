import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SideshowState = {
	sessionId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

function sessionFromDetails(details: unknown): string | undefined {
	const root = asRecord(details);
	if (!root) return undefined;
	return stringField(root, "sessionId")
		?? stringField(asRecord(root.surface), "sessionId")
		?? stringField(asRecord(root.asset), "sessionId")
		?? stringField(asRecord(root.comment), "sessionId")
		?? stringField(asRecord(root.session), "id");
}

export function reconstructSession(ctx: ExtensionContext): string | undefined {
	let sessionId = process.env.SIDESHOW_SESSION || undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || !String(message.toolName ?? "").startsWith("sideshow_")) continue;
		const fromDetails = sessionFromDetails(message.details);
		if (fromDetails) sessionId = fromDetails;
	}
	return sessionId;
}

export function rememberSession(state: SideshowState, sessionId: unknown): void {
	if (typeof sessionId === "string" && sessionId.trim()) state.sessionId = sessionId;
}

export function forgetSession(state: SideshowState): void {
	state.sessionId = process.env.SIDESHOW_SESSION || undefined;
}
