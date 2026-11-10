export type SurfacePayload = {
	kind: "html" | "markdown" | "mermaid" | "diff" | "terminal" | "image" | "json" | "code" | "trace";
	html?: string;
	kits?: string[];
	markdown?: string;
	mermaid?: string;
	patch?: string;
	files?: Array<{ filename: string; before: string; after: string; language?: string }>;
	layout?: "unified" | "split";
	assetId?: string;
	alt?: string;
	caption?: string;
	title?: string;
	text?: string;
	cols?: number;
	data?: unknown;
	code?: string;
	language?: string;
	lineStart?: number;
	steps?: Array<{ label: string; kind?: string; detail?: string; ts?: string }>;
};

type Target = string | number;
type PublishInput = { surfaces: SurfacePayload[]; session?: string; newSession?: boolean };
type UpdateInput = { title?: string; surfaces?: SurfacePayload[] };
type AddInput = { surface: SurfacePayload; before?: Target; after?: Target };
type EditInput = { target: Target; surface?: SurfacePayload; content?: string; kits?: string[] };
type UploadInput = { path?: string; data?: string; session?: string; newSession?: boolean };
type ReplyInput = { postId: string };
type ListInput = { all?: boolean; session?: string };

const ALLOWED_SURFACE_FIELDS: Record<SurfacePayload["kind"], ReadonlySet<string>> = {
	html: new Set(["kind", "html", "kits"]),
	markdown: new Set(["kind", "markdown"]),
	mermaid: new Set(["kind", "mermaid"]),
	diff: new Set(["kind", "patch", "files", "layout"]),
	terminal: new Set(["kind", "text", "cols", "title"]),
	image: new Set(["kind", "assetId", "alt", "caption"]),
	json: new Set(["kind", "data"]),
	code: new Set(["kind", "code", "language", "title", "lineStart"]),
	trace: new Set(["kind", "steps", "assetId", "title"]),
};

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function requireString(surface: SurfacePayload, key: keyof SurfacePayload, path: string, nonEmpty = false): void {
	const value = surface[key];
	if (typeof value !== "string") throw new Error(`${path}.${String(key)} must be a string for surface kind "${surface.kind}".`);
	if (nonEmpty && !value.trim()) throw new Error(`${path}.${String(key)} must not be empty for surface kind "${surface.kind}".`);
}

export function validateSurfacePayload(surface: SurfacePayload, path = "surface"): void {
	const allowed = ALLOWED_SURFACE_FIELDS[surface.kind];
	if (!allowed) throw new Error(`${path}.kind is not a supported Sideshow surface kind.`);
	const conflicting = Object.keys(surface).filter((key) => surface[key as keyof SurfacePayload] !== undefined && !allowed.has(key));
	if (conflicting.length) throw new Error(`${path} kind "${surface.kind}" does not accept field(s): ${conflicting.join(", ")}.`);

	switch (surface.kind) {
		case "html":
			requireString(surface, "html", path);
			if (/<\/?(?:html|head|body)\b|<!doctype\b/i.test(surface.html ?? "")) throw new Error(`${path}.html must be a body fragment without doctype/html/head/body tags.`);
			break;
		case "markdown":
			requireString(surface, "markdown", path, true);
			break;
		case "mermaid":
			requireString(surface, "mermaid", path, true);
			break;
		case "diff":
			if (!(typeof surface.patch === "string" && surface.patch.trim()) && !(Array.isArray(surface.files) && surface.files.length)) {
				throw new Error(`${path} kind "diff" requires a non-empty patch or files array.`);
			}
			break;
		case "terminal":
			requireString(surface, "text", path);
			break;
		case "image":
			requireString(surface, "assetId", path, true);
			break;
		case "json":
			if (!hasOwn(surface, "data") || surface.data === undefined) throw new Error(`${path} kind "json" requires data; null is valid.`);
			try {
				JSON.stringify(surface.data);
			} catch {
				throw new Error(`${path}.data must be JSON-serializable.`);
			}
			break;
		case "code":
			requireString(surface, "code", path);
			break;
		case "trace":
			if (!(typeof surface.assetId === "string" && surface.assetId.trim()) && !(Array.isArray(surface.steps) && surface.steps.length)) {
				throw new Error(`${path} kind "trace" requires non-empty steps or an assetId.`);
			}
			surface.steps?.forEach((step, index) => {
				if (typeof step?.label !== "string" || !step.label.trim()) throw new Error(`${path}.steps[${index}].label must be a non-empty string.`);
			});
			break;
	}
}

export function validateSurfacesPayload(surfaces: SurfacePayload[], path = "surfaces"): void {
	if (!surfaces.length) throw new Error(`${path} must contain at least one surface.`);
	surfaces.forEach((surface, index) => validateSurfacePayload(surface, `${path}[${index}]`));
}

export function validateTarget(target: Target, path = "target"): void {
	if (typeof target === "string") {
		if (!target.trim()) throw new Error(`${path} must be a non-empty stable surface id or zero-based index.`);
		return;
	}
	if (!Number.isInteger(target) || target < 0) throw new Error(`${path} must be a non-empty stable surface id or non-negative integer index.`);
}

export function validatePublishInput(params: PublishInput): void {
	if (params.newSession && params.session) throw new Error("newSession=true conflicts with session. Remove session to create a new Sideshow session.");
	validateSurfacesPayload(params.surfaces);
}

export function validateUpdateInput(params: UpdateInput): void {
	if (params.title === undefined && params.surfaces === undefined) throw new Error("Provide title or surfaces for a full-post update.");
	if (params.surfaces) validateSurfacesPayload(params.surfaces);
}

export function validateAddSurfaceInput(params: AddInput): void {
	if (params.before !== undefined && params.after !== undefined) throw new Error("before and after conflict. Provide only one insertion target.");
	if (params.before !== undefined) validateTarget(params.before, "before");
	if (params.after !== undefined) validateTarget(params.after, "after");
	validateSurfacePayload(params.surface);
}

export function validateEditSurfaceInput(params: EditInput): void {
	validateTarget(params.target);
	if ((params.surface === undefined) === (params.content === undefined)) throw new Error("Provide exactly one of surface or content for a targeted surface edit.");
	if (params.surface !== undefined) {
		if (params.kits !== undefined) throw new Error("kits can accompany content-only edits only; include kits inside an html surface replacement.");
		validateSurfacePayload(params.surface);
	}
}

export function validateUploadInput(params: UploadInput): void {
	if ((params.path === undefined) === (params.data === undefined)) throw new Error("Provide exactly one of path or base64 data.");
	if (params.newSession && params.session) throw new Error("newSession=true conflicts with session. Remove session to create a new Sideshow session.");
}

export function validateReplyInput(params: ReplyInput): void {
	if (!params.postId.trim()) throw new Error("postId must identify the Sideshow post thread to reply under.");
}

export function validateListInput(params: ListInput): void {
	if (params.all && params.session) throw new Error("all=true conflicts with session. Remove one scope argument.");
}
