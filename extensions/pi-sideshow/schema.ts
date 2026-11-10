import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const SurfaceKind = StringEnum(["html", "markdown", "mermaid", "diff", "terminal", "image", "json", "code", "trace"] as const);
const DiffLayout = StringEnum(["unified", "split"] as const);
const AssetKind = StringEnum(["image", "file"] as const);
const TargetSchema = Type.Union([
	Type.String({ minLength: 1, description: "Stable surface id." }),
	Type.Integer({ minimum: 0, description: "Zero-based surface index." }),
]);

export const DiffFileSchema = Type.Object({
	filename: Type.String({ minLength: 1 }),
	before: Type.String(),
	after: Type.String(),
	language: Type.Optional(Type.String()),
});

export const TraceStepSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "Step label." }),
	kind: Type.Optional(Type.String({ description: "Step kind, e.g. prompt, tool, result." })),
	detail: Type.Optional(Type.String({ description: "Step detail text." })),
	ts: Type.Optional(Type.String({ description: "ISO timestamp." })),
});

// Pi tool schemas must remain provider-compatible, so the public schema uses one
// enum-backed object. Each field names the kinds that accept it; validation.ts
// applies the per-kind rules before HTTP.
export const SurfaceSchema = Type.Object({
	kind: SurfaceKind,
	html: Type.Optional(Type.String({ description: "html only: body fragment; no doctype/html/head/body." })),
	kits: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "html only: kit names (issues, slides)." })),
	markdown: Type.Optional(Type.String({ description: "markdown only: prose rendered by the viewer." })),
	mermaid: Type.Optional(Type.String({ description: "mermaid only: diagram source, rendered with Pele and posted as an image plus a source code surface (accepts no other field, not even title)." })),
	patch: Type.Optional(Type.String({ description: "diff only: unified/git diff patch." })),
	files: Type.Optional(Type.Array(DiffFileSchema, { minItems: 1, description: "diff only: before/after file pairs; prefer patch." })),
	layout: Type.Optional(DiffLayout),
	assetId: Type.Optional(Type.String({ minLength: 1, description: "image (required) or trace: assetId from sideshow_upload_asset." })),
	alt: Type.Optional(Type.String({ description: "image only: alt text." })),
	caption: Type.Optional(Type.String({ description: "image only: caption." })),
	title: Type.Optional(Type.String({ description: "terminal, code, or trace only: surface title." })),
	text: Type.Optional(Type.String({ description: "terminal only: raw output; ANSI SGR supported." })),
	cols: Type.Optional(Type.Integer({ minimum: 1, description: "terminal only: width hint." })),
	data: Type.Optional(Type.Unknown({ description: "json only: JSON-serializable value." })),
	code: Type.Optional(Type.String({ description: "code only: source text." })),
	language: Type.Optional(Type.String({ description: "code only: highlighting language." })),
	lineStart: Type.Optional(Type.Integer({ minimum: 1, description: "code only: display starting line." })),
	steps: Type.Optional(Type.Array(TraceStepSchema, { minItems: 1, description: "trace only: ordered steps rendered as a timeline." })),
});

export const SurfacesSchema = Type.Array(SurfaceSchema, {
	minItems: 1,
	description: "Ordered surfaces; kinds: html, markdown, mermaid, diff, terminal, image, json, code, trace.",
});

export const GetPostSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Post id returned by sideshow_publish_post or sideshow_list_posts." }),
});

export const AddSurfaceSchema = Type.Object({
	postId: Type.String({ minLength: 1, description: "Post id." }),
	surface: SurfaceSchema,
	before: Type.Optional(TargetSchema),
	after: Type.Optional(TargetSchema),
});

export const EditSurfaceSchema = Type.Object({
	postId: Type.String({ minLength: 1, description: "Post id." }),
	target: TargetSchema,
	surface: Type.Optional(SurfaceSchema),
	content: Type.Optional(Type.String({ description: "Content-only replacement for the existing surface." })),
	kits: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

export const PublishPostSchema = Type.Object({
	title: Type.String({ minLength: 1, description: "Post title." }),
	surfaces: SurfacesSchema,
	session: Type.Optional(Type.String({ minLength: 1, description: "Existing session id; defaults to remembered session." })),
	sessionTitle: Type.Optional(Type.String({ minLength: 1, description: "Task name for a new session; defaults to the post title." })),
	agent: Type.Optional(Type.String({ minLength: 1, description: "Agent name for a new session; defaults to SIDESHOW_AGENT or pi" })),
	newSession: Type.Optional(Type.Boolean({ description: "Create a fresh session instead of reusing one." })),
});

export const UpdatePostSchema = Type.Object({
	id: Type.String({ minLength: 1, description: "Post id returned by sideshow_publish_post" }),
	title: Type.Optional(Type.String({ minLength: 1, description: "Optional replacement title" })),
	surfaces: Type.Optional(SurfacesSchema),
});

export const WaitForFeedbackSchema = Type.Object({
	session: Type.Optional(Type.String({ minLength: 1, description: "Session id; defaults to remembered session" })),
	timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 300, description: "Omit (or 0) to drain without waiting; set 1-300 only when Algorant asks you to wait for browser comments" })),
	afterSeq: Type.Optional(Type.Integer({ minimum: 0, description: "Explicit cursor override; usually omit" })),
});

export const ReplyToUserSchema = Type.Object({
	postId: Type.String({ minLength: 1, description: "Post thread to reply under" }),
	message: Type.String({ minLength: 1, description: "Plain-text reply" }),
});

export const ListPostsSchema = Type.Object({
	session: Type.Optional(Type.String({ minLength: 1, description: "Session id; defaults to remembered session unless all is true" })),
	all: Type.Optional(Type.Boolean({ description: "List posts from every session" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum posts to include in the text summary; default 50" })),
});

export const UploadAssetSchema = Type.Object({
	path: Type.Optional(Type.String({ minLength: 1, description: "Local file path to upload" })),
	data: Type.Optional(Type.String({ minLength: 1, description: "Base64 bytes to upload when path is not provided" })),
	contentType: Type.Optional(Type.String({ minLength: 1, description: "MIME type; inferred from path when omitted" })),
	filename: Type.Optional(Type.String({ minLength: 1, description: "Original filename shown for downloads" })),
	kind: Type.Optional(AssetKind),
	session: Type.Optional(Type.String({ minLength: 1, description: "Session id; defaults to remembered session or creates one" })),
	sessionTitle: Type.Optional(Type.String({ minLength: 1, description: "Task name when this upload needs to create a session before the first publish; defaults to the upload filename." })),
	newSession: Type.Optional(Type.Boolean({ description: "Force a fresh Sideshow session for this upload" })),
});

export type PublishPostInput = Static<typeof PublishPostSchema>;
export type UpdatePostInput = Static<typeof UpdatePostSchema>;
export type WaitForFeedbackInput = Static<typeof WaitForFeedbackSchema>;
export type ReplyToUserInput = Static<typeof ReplyToUserSchema>;
export type ListPostsInput = Static<typeof ListPostsSchema>;
export type UploadAssetInput = Static<typeof UploadAssetSchema>;
export type GetPostInput = Static<typeof GetPostSchema>;
export type AddSurfaceInput = Static<typeof AddSurfaceSchema>;
export type EditSurfaceInput = Static<typeof EditSurfaceSchema>;
