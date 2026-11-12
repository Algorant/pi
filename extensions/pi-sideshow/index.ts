import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
	agentName,
	assetAvailable,
	baseUrl,
	baseUrlDisplay,
	clampLimit,
	clampWait,
	contentTypeFor,
	redact,
	requestJson,
	ensureSideshowAvailable,
	postUrl,
	sessionUrl,
	probeServer,
	truncateText,
} from "./http";
import {
	AddSurfaceSchema,
	EditSurfaceSchema,
	GetPostSchema,
	ListPostsSchema,
	PublishPostSchema,
	ReplyToUserSchema,
	UpdatePostSchema,
	UploadAssetSchema,
	WaitForFeedbackSchema,
	type AddSurfaceInput,
	type EditSurfaceInput,
	type GetPostInput,
	type ListPostsInput,
	type PublishPostInput,
	type ReplyToUserInput,
	type UpdatePostInput,
	type UploadAssetInput,
	type WaitForFeedbackInput,
} from "./schema";
import {
	validateAddSurfaceInput,
	validateEditSurfaceInput,
	validateListInput,
	validatePublishInput,
	validateReplyInput,
	validateUpdateInput,
	validateUploadInput,
} from "./validation";
import { forgetSession, reconstructSession, rememberSession, type SideshowState } from "./state";
import { syncPiTrace } from "./trace";
import { FEEDBACK_GUIDELINE, POST_URL_GUIDELINE } from "./guidance";
import { expandMermaidSurfaces, hasMermaid, imageSurface, renderMermaidSurfaces, sourceSurface, type RenderedMermaid } from "./mermaid";
const MAX_ASSET_BYTES = 5 * 1024 * 1024;

type TextResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type SideshowComment = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(asRecord) : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function jsonText(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function textResult(text: string, details: Record<string, unknown> = {}): TextResult {
	return { content: [{ type: "text", text: truncateText(text) }], details };
}

function feedbackText(item: Record<string, unknown>): string {
	const postTitle = stringValue(item.postTitle) || stringValue(item.title);
	const text = stringValue(item.text) || stringValue(item.message) || stringValue(item.content) || jsonText(item);
	return postTitle ? `${postTitle}: ${text}` : text;
}

function normalizeFeedback(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value.map(asRecord);
	if (value && typeof value === "object") return [asRecord(value)];
	return [];
}

function feedbackSummary(value: unknown): string {
	const feedback = normalizeFeedback(value);
	if (!feedback.length) return "";
	return `\n\nUser feedback delivered with this result:\n${feedback.map((item) => `- ${feedbackText(item)}`).join("\n")}`;
}

async function requestFeedback(sessionId: string, waitSeconds: number, signal?: AbortSignal, afterSeq?: number): Promise<{ result: Record<string, unknown>; comments: SideshowComment[] }> {
	const query = new URLSearchParams({ session: sessionId, author: "user", wait: String(clampWait(waitSeconds, 0)) });
	if (afterSeq !== undefined) query.set("after", String(afterSeq));
	const result = asRecord(await requestJson(`/api/comments?${query}`, {}, signal));
	const comments = Array.isArray(result.comments) ? result.comments.map(asRecord) : [];
	return { result, comments };
}

/**
 * Every comment on one post, any author, read without moving the server's
 * delivery cursor (only author=user reads advance it). Recovers comments the
 * server attributed to the session agent, e.g. browser comments sent from a
 * non-same-origin viewer.
 */
async function readPostComments(sessionId: string, postId: string, signal?: AbortSignal): Promise<SideshowComment[]> {
	const query = new URLSearchParams({ session: sessionId, surface: postId, after: "0" });
	const result = asRecord(await requestJson(`/api/comments?${query}`, {}, signal));
	return Array.isArray(result.comments) ? result.comments.map(asRecord) : [];
}

function commentsSummary(comments: SideshowComment[]): string {
	if (!comments.length) return "\n\nComments on this post: none.";
	const lines = comments.map((item) => `- #${String(item.seq ?? "?")} [${stringValue(item.author) ?? "unknown"}] ${feedbackText(item)}`);
	return `\n\nComments on this post (all authors, read-only; the author is server-assigned, so a browser comment may appear as the agent):\n${lines.join("\n")}`;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
	const value = stringValue(record[key]);
	if (!value) throw new Error(`Sideshow response was missing ${label}.`);
	return value;
}

function formatPostLine(surface: Record<string, unknown>, sessionId?: string): string {
	const id = stringValue(surface.id) || "<missing-id>";
	const title = stringValue(surface.title) || "Untitled";
	const version = surface.version === undefined ? "?" : String(surface.version);
	const resolvedSessionId = sessionId ?? stringValue(surface.sessionId);
	const session = resolvedSessionId ? ` [${resolvedSessionId}]` : "";
	const created = stringValue(surface.createdAt) ? ` ${surface.createdAt}` : "";
	// Default handoff is the session workspace; the direct post page stays a
	// recovery detail and is not what the agent repeats to the user.
	const url = resolvedSessionId ? ` ${sessionUrl(resolvedSessionId)}` : "";
	return `${id}${session} ${title} v${version}${created}${url}`;
}

function revisionHandoff(postId: string, sessionId: string | undefined): { suffix: string; sessionUrl?: string; postUrl: string } {
	const postLink = postUrl(postId);
	const sessionLink = sessionId ? sessionUrl(sessionId) : undefined;
	return {
		suffix: sessionLink ? ` Session workspace: ${sessionLink}` : ` Post artifact: ${postLink}`,
		sessionUrl: sessionLink,
		postUrl: postLink,
	};
}

const MERMAID_NOTE = (count: number) => `\nRendered ${count} mermaid surface(s) with Pele: each is posted as an image surface with its source in a code surface (language mermaid) right below it.`;

/**
 * The one session resolver: an existing session as-is (never renamed), or a new one created
 * explicitly here with a non-empty title. Callers always pass the title a new session gets, so
 * no tool path can leave session creation to the server, which would make an untitled session.
 */
async function ensureSession(state: SideshowState, opts: { session?: string; newSession?: boolean; title: string; agent?: string; cwd: string }, signal?: AbortSignal): Promise<string> {
	const existing = opts.newSession ? undefined : (opts.session ?? state.sessionId);
	if (existing) return existing;
	const title = opts.title.trim();
	if (!title) throw new Error("A new Sideshow session needs a non-empty title; pass a post title, a filename, or sessionTitle.");
	const created = asRecord(await requestJson("/api/sessions", {
		method: "POST",
		body: JSON.stringify({ agent: opts.agent ?? agentName(), title, cwd: opts.cwd }),
	}, signal));
	const session = requireString(created, "id", "created session id");
	rememberSession(state, session);
	return session;
}

/** The one asset upload path, shared by sideshow_upload_asset and the Pele mermaid conversion. */
async function uploadBytes(state: SideshowState, args: { bytes: Uint8Array; filename?: string; contentType?: string; kind?: string; session?: string }, signal?: AbortSignal) {
	if (args.bytes.byteLength > MAX_ASSET_BYTES) {
		throw new Error(`Sideshow assets must not exceed 5 MiB; received ${args.bytes.byteLength} bytes.`);
	}
	const query = new URLSearchParams();
	if (args.filename) query.set("filename", args.filename);
	if (args.kind) query.set("kind", args.kind);
	if (args.session) query.set("session", args.session);
	query.set("agent", agentName());
	const asset = asRecord(await requestJson(`/api/assets?${query}`, {
		method: "POST",
		headers: { "content-type": args.contentType ?? "application/octet-stream" },
		body: args.bytes as BodyInit,
	}, signal));
	const assetId = requireString(asset, "id", "asset id");
	const sessionId = stringValue(asset.sessionId) || args.session;
	rememberSession(state, sessionId);
	return { asset, assetId, sessionId };
}

function pngUploader(state: SideshowState, session: string | undefined, signal?: AbortSignal) {
	return async (png: Uint8Array, filename: string) => (await uploadBytes(state, { bytes: png, filename, contentType: "image/png", kind: "image", session }, signal)).assetId;
}

async function readPostRef(postId: string, signal?: AbortSignal): Promise<{ sessionId: string; surfaceIds: string[] }> {
	const post = asRecord(await requestJson(`/api/posts/${encodeURIComponent(postId)}`, {}, signal));
	return { sessionId: requireString(post, "sessionId", "session id"), surfaceIds: asArray(post.surfaces).map((s) => stringValue(s.id) ?? "") };
}

/**
 * Refuse an image or trace surface whose assetId is not an asset on this server before anything is
 * written. A shortened id passes schema validation and only fails in the browser, as "Image
 * unavailable", which is invisible to the agent publishing it.
 */
async function requireKnownAssets(surfaces: Array<Record<string, unknown>>, where: string, signal?: AbortSignal): Promise<void> {
	const ids = new Set<string>();
	for (const surface of surfaces) {
		const kind = typeof surface?.kind === "string" ? surface.kind : "";
		if (kind !== "image" && kind !== "trace") continue;
		const assetId = typeof surface.assetId === "string" ? surface.assetId : "";
		if (assetId) ids.add(assetId);
	}
	for (const assetId of ids) {
		if (await assetAvailable(assetId, signal)) continue;
		throw new Error(`Nothing sent: ${where} references assetId "${assetId}", which is not an asset on ${baseUrlDisplay()} (/a/${assetId} is not found). Use the full asset id printed by sideshow_upload_asset — a shortened prefix or another server's id renders as "Image unavailable".`);
	}
}

function partialMermaidError(postId: string, imageId: string, cause: unknown): Error {
	return new Error(`PARTIAL STATE: Sideshow post ${postId} now has the Pele image surface ${imageId}, but its mermaid source code surface was NOT added (${redact(cause)}). Add it with sideshow_add_surface (kind code, language "mermaid", title "Mermaid source", after "${imageId}") or remove the image surface.`);
}

/** Two calls: the Pele image first, then its source code surface right after it. */
async function postMermaidPair(postId: string, item: RenderedMermaid, signal: AbortSignal | undefined, first: () => Promise<Record<string, unknown>>, imageIdFrom: (post: Record<string, unknown>) => string | undefined): Promise<Record<string, unknown>> {
	const afterImage = asRecord(await first());
	const imageId = imageIdFrom(afterImage);
	if (!imageId) throw new Error(`Sideshow post ${postId} received the Pele image surface but the response did not identify it, so the mermaid source code surface was NOT added. Inspect the post with sideshow_get_post.`);
	try {
		return asRecord(await requestJson(`/api/posts/${encodeURIComponent(postId)}/surfaces`, {
			method: "POST",
			body: JSON.stringify({ surface: sourceSurface(item), after: imageId }),
		}, signal));
	} catch (error) {
		throw partialMermaidError(postId, imageId, error);
	}
}

function registerCommands(pi: ExtensionAPI, state: SideshowState): void {
	pi.registerCommand("sideshow", {
		description: "Sideshow: /sideshow [status|start|reset]",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const command = args.trim().toLowerCase() || "status";
			if (command === "status") {
				const probe = await probeServer();
				ctx.ui.notify(probe.reachable
					? `Sideshow is reachable at ${baseUrl()}`
					: `Sideshow is not reachable at ${baseUrl()}. Run /sideshow start or sideshow serve.`);
				return;
			}
			if (command === "start") {
				try {
					await ensureSideshowAvailable();
					ctx.ui.notify(`Sideshow is ready at ${baseUrl()}`);
				} catch (error) {
					ctx.ui.notify(redact(error), "error");
				}
				return;
			}
			if (command === "reset") {
				forgetSession(state);
				ctx.ui.notify("Reset remembered Sideshow session");
				return;
			}
			ctx.ui.notify("Usage: /sideshow [status|start|reset]", "warning");
		},
	});
}

function registerTools(pi: ExtensionAPI, state: SideshowState): void {
	pi.registerTool({
		name: "sideshow_add_surface",
		exposure: "codemode",
		label: "Sideshow Add Surface",
		description: "Add one surface to a Sideshow post, optionally before or after a target.",
		promptSnippet: "Add a surface to compose an existing Sideshow card.",
		parameters: AddSurfaceSchema,
		async execute(_toolCallId, params: AddSurfaceInput, signal, _onUpdate, ctx) {
			validateAddSurfaceInput(params);
			await requireKnownAssets([params.surface as unknown as Record<string, unknown>], `adding a surface to post ${params.postId}`, signal);
			let post: Record<string, unknown>;
			let note = "";
			if (params.surface.kind === "mermaid") {
				const item = (await renderMermaidSurfaces([params.surface], "surface", signal)).get(0)!;
				const ref = await readPostRef(params.postId, signal);
				const assetId = await pngUploader(state, ref.sessionId, signal)(item.png, "mermaid-0.png");
				post = await postMermaidPair(params.postId, item, signal, () => requestJson(`/api/posts/${encodeURIComponent(params.postId)}/surfaces`, {
					method: "POST",
					body: JSON.stringify({ surface: imageSurface(item, assetId), before: params.before, after: params.after }),
				}, signal), (added) => asArray(added.surfaces).map((s) => stringValue(s.id)).find((id) => id && !ref.surfaceIds.includes(id)));
				note = MERMAID_NOTE(1);
			} else {
				post = asRecord(await requestJson(`/api/posts/${encodeURIComponent(params.postId)}/surfaces`, {
					method: "POST",
					body: JSON.stringify({ surface: params.surface, before: params.before, after: params.after }),
				}, signal));
			}
			const sessionId = requireString(post, "sessionId", "session id");
			rememberSession(state, sessionId);
			const handoff = revisionHandoff(params.postId, sessionId);
			return textResult(`Added a surface to Sideshow post ${params.postId}.${handoff.suffix}${note}${feedbackSummary(post.userFeedback)}`, { ...post, post, postId: params.postId, sessionId, sessionUrl: handoff.sessionUrl, postUrl: handoff.postUrl, baseUrl: baseUrl() });
		},
	});

	pi.registerTool({
		name: "sideshow_edit_surface",
		exposure: "codemode",
		label: "Sideshow Edit Surface",
		description: "Edit one post surface by stable id or index, replacing its payload or content.",
		promptSnippet: "Edit one surface inside an existing Sideshow post.",
		promptGuidelines: [
			"Use sideshow_edit_surface for one-surface changes; use sideshow_update_post to replace the title or the complete ordered surface list, which is also how surfaces are removed or reordered (sideshow_get_post first for current content).",
		],
		parameters: EditSurfaceSchema,
		async execute(_toolCallId, params: EditSurfaceInput, signal, _onUpdate, ctx) {
			validateEditSurfaceInput(params);
			if (params.surface) await requireKnownAssets([params.surface as unknown as Record<string, unknown>], `editing surface ${String(params.target)} of post ${params.postId}`, signal);
			let post: Record<string, unknown>;
			let note = "";
			const editPath = `/api/posts/${encodeURIComponent(params.postId)}/surfaces/${encodeURIComponent(String(params.target))}`;
			if (params.surface?.kind === "mermaid") {
				const item = (await renderMermaidSurfaces([params.surface], "surface", signal)).get(0)!;
				const ref = await readPostRef(params.postId, signal);
				const assetId = await pngUploader(state, ref.sessionId, signal)(item.png, "mermaid-0.png");
				post = await postMermaidPair(params.postId, item, signal, () => requestJson(editPath, {
					method: "PATCH",
					body: JSON.stringify({ surface: imageSurface(item, assetId) }),
				}, signal), (edited) => typeof params.target === "number" ? stringValue(asArray(edited.surfaces)[params.target]?.id) : params.target);
				note = `${MERMAID_NOTE(1)} The source surface was inserted after the edited surface; an older source surface from an earlier render is not removed.`;
			} else {
				post = asRecord(await requestJson(editPath, {
					method: "PATCH",
					body: JSON.stringify({ surface: params.surface, content: params.content, kits: params.kits }),
				}, signal));
			}
			const sessionId = requireString(post, "sessionId", "session id");
			rememberSession(state, sessionId);
			const handoff = revisionHandoff(params.postId, sessionId);
			return textResult(`Edited surface ${String(params.target)} in Sideshow post ${params.postId}.${handoff.suffix}${note}${feedbackSummary(post.userFeedback)}`, { ...post, post, postId: params.postId, sessionId, sessionUrl: handoff.sessionUrl, postUrl: handoff.postUrl, baseUrl: baseUrl() });
		},
	});

	pi.registerTool({
		name: "sideshow_publish_post",
		exposure: "codemode",
		label: "Sideshow Publish",
		description: "Publish a new Sideshow post in a session. Returns postId, sessionId, URL, and any userFeedback.",
		promptSnippet: "Publish diagrams, UI sketches, markdown, diffs, terminal output, images, JSON, or code to Sideshow.",
		promptGuidelines: [FEEDBACK_GUIDELINE, POST_URL_GUIDELINE],
		parameters: PublishPostSchema,
		async execute(_toolCallId, params: PublishPostInput, signal, _onUpdate, ctx) {
			validatePublishInput(params);
			let surfaces = params.surfaces;
			let note = "";
			const session = await ensureSession(state, { session: params.session, newSession: params.newSession, title: params.sessionTitle ?? params.title, agent: params.agent, cwd: ctx.cwd }, signal);
			if (hasMermaid(surfaces)) {
				const rendered = await renderMermaidSurfaces(surfaces, "surfaces", signal);
				surfaces = await expandMermaidSurfaces(surfaces, rendered, pngUploader(state, session, signal));
				note = MERMAID_NOTE(rendered.size);
			}
			await requireKnownAssets(surfaces as unknown as Array<Record<string, unknown>>, `the post "${params.title}"`, signal);
			const body = {
				title: params.title,
				surfaces,
				session,
				agent: params.agent ?? agentName(),
				cwd: ctx.cwd,
			};
			const surface = asRecord(await requestJson("/api/posts", { method: "POST", body: JSON.stringify(body) }, signal));
			const postId = requireString(surface, "id", "post id");
			const sessionId = requireString(surface, "sessionId", "session id");
			rememberSession(state, sessionId);
			const url = sessionUrl(sessionId);
			const postLink = postUrl(postId);
			const title = stringValue(surface.title) || params.title;
			return textResult(
				`Published Sideshow post "${title}" at ${url}\npostId: ${postId}\nsessionId: ${sessionId}\npost-artifact (explicit single-artifact share): ${postLink}${note}${feedbackSummary(surface.userFeedback)}`,
				{ ...surface, post: surface, postId, sessionId, url, sessionUrl: url, postUrl: postLink, baseUrl: baseUrl() },
			);
		},
	});

	pi.registerTool({
		name: "sideshow_update_post",
		exposure: "codemode",
		label: "Sideshow Update",
		description: "Update a Sideshow post by replacing its title and/or complete surface list while retaining its id and version history. Remove or reorder surfaces by sending the new complete list.",
		promptSnippet: "Update an existing Sideshow post with revised surfaces or title.",
		parameters: UpdatePostSchema,
		async execute(_toolCallId, params: UpdatePostInput, signal, _onUpdate, ctx) {
			validateUpdateInput(params);
			let surfaces = params.surfaces;
			let note = "";
			if (surfaces && hasMermaid(surfaces)) {
				const rendered = await renderMermaidSurfaces(surfaces, "surfaces", signal);
				const ref = await readPostRef(params.id, signal);
				surfaces = await expandMermaidSurfaces(surfaces, rendered, pngUploader(state, ref.sessionId, signal));
				note = MERMAID_NOTE(rendered.size);
			}
			if (surfaces) await requireKnownAssets(surfaces as unknown as Array<Record<string, unknown>>, `post ${params.id}`, signal);
			const body = { title: params.title, surfaces };
			const surface = asRecord(await requestJson(`/api/posts/${encodeURIComponent(params.id)}`, { method: "PUT", body: JSON.stringify(body) }, signal));
			const postId = requireString(surface, "id", "post id");
			const sessionId = requireString(surface, "sessionId", "session id");
			rememberSession(state, sessionId);
			const url = sessionUrl(sessionId);
			const postLink = postUrl(postId);
			const title = stringValue(surface.title) || params.title || postId;
			const version = surface.version === undefined ? "?" : String(surface.version);
			return textResult(
				`Updated Sideshow post "${title}" to version ${version} at ${url}\npostId: ${postId}\nsessionId: ${sessionId}\npost-artifact (explicit single-artifact share): ${postLink}${note}${feedbackSummary(surface.userFeedback)}`,
				{ ...surface, post: surface, postId, sessionId, url, sessionUrl: url, postUrl: postLink, baseUrl: baseUrl() },
			);
		},
	});

	pi.registerTool({
		name: "sideshow_wait_for_feedback",
		label: "Sideshow Wait",
		exposure: "codemode",
		description: "Drain browser comments for the current or specified session that have not yet been delivered to the agent. Returns immediately by default; waits only when timeoutSeconds is set.",
		promptSnippet: "Drain undelivered Sideshow browser comments; never wait unless Algorant asks.",

		parameters: WaitForFeedbackSchema,
		async execute(_toolCallId, params: WaitForFeedbackInput, signal, _onUpdate, ctx) {
			const session = params.session ?? state.sessionId;
			if (!session) throw new Error("No Sideshow session yet. Publish first or pass session.");
			// Browser comments are a backup channel: drain by default, wait only on request.
			const wait = clampWait(params.timeoutSeconds, 0);
			const { result, comments } = await requestFeedback(session, wait, signal, params.afterSeq);
			return textResult(
				comments.length
					? `Received ${comments.length} Sideshow comment(s):\n${jsonText(comments)}`
					: "No new Sideshow feedback.",
				{ ...result, comments, userFeedback: comments, sessionId: session, baseUrl: baseUrl() },
			);
		},
	});

	pi.registerTool({
		name: "sideshow_reply_to_user",
		exposure: "codemode",
		label: "Sideshow Reply",
		description: "Post a short agent reply into a Sideshow post thread. Use it to acknowledge browser feedback.",
		promptSnippet: "Reply to the user in a Sideshow post comment thread.",

		parameters: ReplyToUserSchema,
		async execute(_toolCallId, params: ReplyToUserInput, signal, _onUpdate, ctx) {
			validateReplyInput(params);
			// The canonical REST comment endpoint keeps the historical `surface`
			// wire field while the server derives authorship from the session agent.
			const body = {
				text: params.message,
				surface: params.postId,
			};
			const comment = asRecord(await requestJson("/api/comments", { method: "POST", body: JSON.stringify(body) }, signal));
			const sessionId = stringValue(comment.sessionId);
			rememberSession(state, sessionId);
			return textResult(
				`Posted Sideshow reply${comment.postId ? ` on post ${comment.postId}` : ` on post ${params.postId}`}.${feedbackSummary(comment.userFeedback)}`,
				{ ...comment, comment, postId: stringValue(comment.postId) ?? params.postId, sessionId, baseUrl: baseUrl() },
			);
		},
	});

	pi.registerTool({
		name: "sideshow_list_posts",
		exposure: "codemode",
		label: "Sideshow List",
		description: "List Sideshow posts in the remembered or specified session, or across all sessions. Use it to recover post ids after restart or context compaction.",
		promptSnippet: "List Sideshow posts and ids for updates, recovery, or replies.",

		parameters: ListPostsSchema,
		async execute(_toolCallId, params: ListPostsInput, signal, _onUpdate, ctx) {
			validateListInput(params);
			const limit = clampLimit(params.limit, 50);
			if (params.all) {
				const sessions = asArray(await requestJson("/api/sessions", {}, signal));
				const groups: Array<{ session: Record<string, unknown>; posts: Array<Record<string, unknown>> }> = [];
				const lines: string[] = [];
				for (const session of sessions) {
					const sessionId = stringValue(session.id);
					if (!sessionId) continue;
					const posts = asArray(await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}/posts`, {}, signal));
					groups.push({ session, posts });
					for (const surface of posts) {
						if (lines.length >= limit) break;
						lines.push(formatPostLine(surface, sessionId));
					}
					if (lines.length >= limit) break;
				}
				return textResult(lines.length ? lines.join("\n") : "No Sideshow posts found.", { sessions: groups, baseUrl: baseUrl() });
			}

			const session = params.session ?? state.sessionId;
			if (!session) throw new Error("No Sideshow session yet. Publish first, pass session, or set all=true.");
			const posts = asArray(await requestJson(`/api/sessions/${encodeURIComponent(session)}/posts`, {}, signal));
			const lines = posts.slice(0, limit).map((surface) => formatPostLine(surface));
			return textResult(lines.length ? lines.join("\n") : "No Sideshow posts in this session.", { sessionId: session, posts, baseUrl: baseUrl() });
		},
	});

	pi.registerTool({
		name: "sideshow_get_post",
		exposure: "codemode",
		label: "Sideshow Get Post",
		description: "Get one complete Sideshow post through GET /api/posts/:id. Returns current surfaces with stable ids and zero-based indexes, the current version, the full bounded retained history, and every comment on the post (all authors, read without consuming feedback).",
		promptSnippet: "Inspect one full Sideshow post and its retained versions.",
		promptGuidelines: [
			"Use sideshow_get_post before a targeted surface edit when ids or current content are uncertain, and after sideshow_list_posts during restart or compaction recovery.",
		],
		parameters: GetPostSchema,
		async execute(_toolCallId, params: GetPostInput, signal, _onUpdate, ctx) {
			const post = asRecord(await requestJson(`/api/posts/${encodeURIComponent(params.id)}`, {}, signal));
			const postId = requireString(post, "id", "post id");
			const sessionId = requireString(post, "sessionId", "session id");
			rememberSession(state, sessionId);
			const comments = await readPostComments(sessionId, postId, signal);
			return textResult(`${jsonText(post)}${commentsSummary(comments)}`, { ...post, post, postId, sessionId, comments, url: sessionUrl(sessionId), sessionUrl: sessionUrl(sessionId), postUrl: postUrl(postId), baseUrl: baseUrl() });
		},
	});

	pi.registerTool({
		name: "sideshow_upload_asset",
		exposure: "codemode",
		label: "Sideshow Upload",
		description: "Upload a local asset to Sideshow and get an assetId/URL. Maximum size is 5 MiB. Pass the assetId verbatim: only the full 64-character id resolves, and publish/edit refuse anything else.",
		promptSnippet: "Upload an image or file asset for use in Sideshow surfaces.",
		promptGuidelines: [
			"Use sideshow_upload_asset before referencing local images or files in sideshow_publish_post.",
		],
		parameters: UploadAssetSchema,
		async execute(_toolCallId, params: UploadAssetInput, signal, _onUpdate, ctx) {
			validateUploadInput(params);
			let bytes = new Uint8Array();
			let filename = params.filename;
			let contentType = params.contentType;

			if (params.path) {
				const cleanPath = params.path.replace(/^@/, "");
				const filePath = resolve(ctx.cwd, cleanPath);
				bytes = await readFile(filePath);
				filename ??= basename(cleanPath);
				contentType ??= contentTypeFor(cleanPath);
			} else if (params.data) {
				bytes = Buffer.from(params.data, "base64");
				filename ??= "upload";
				contentType ??= "application/octet-stream";
			}

			if (bytes.byteLength > MAX_ASSET_BYTES) {
				throw new Error(`Sideshow assets must not exceed 5 MiB; received ${bytes.byteLength} bytes.`);
			}

			const session = await ensureSession(state, { session: params.session, newSession: params.newSession, title: params.sessionTitle ?? filename ?? "upload", cwd: ctx.cwd }, signal);
			const { asset, assetId, sessionId } = await uploadBytes(state, { bytes, filename, contentType, kind: params.kind, session }, signal);
			return textResult(
				`Uploaded Sideshow asset ${assetId} (${asset.contentType ?? contentType ?? "application/octet-stream"}, ${asset.byteLength ?? bytes.byteLength} bytes)\nurl: ${asset.url ?? ""}\nsessionId: ${sessionId ?? "none"}`,
				{ asset, assetId, sessionId, url: asset.url, baseUrl: baseUrl() },
			);
		},
	});
}

export default function piSideshow(pi: ExtensionAPI) {
	const state: SideshowState = { sessionId: process.env.SIDESHOW_SESSION || undefined };

	const refreshSession = (ctx: ExtensionContext) => {
		state.sessionId = reconstructSession(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		refreshSession(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!state.sessionId) return;
		try {
			await syncPiTrace(state, ctx);
		} catch {
			// Trace synchronization is observational and must never interrupt a turn.
		}
	});

	registerCommands(pi, state);
	registerTools(pi, state);
}
