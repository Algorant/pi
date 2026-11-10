import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { VaultFile } from "../lib/obsidian-cli.ts";
import { registerMemoryCommand } from "./capture";
import { analyzeOkf, type RootNote } from "./okf";
import { relativeToRoot, resolveFolderPath, resolveNotePath, scopeRoot, type NoteScope } from "./paths";
import { editNote, openSession, writeNote } from "./session";

// Obsidian-vault memory: Markdown notes reached through the Obsidian CLI, or, only on hosts whose
// global settings set pi-memory.vaultPath, directly on disk (Obsidian Headless Sync keeps it current).
// The backend is fixed by configuration; Obsidian Sync owns synchronization; there is no fallback path.

type SearchScope = NoteScope | "all";

const SEARCH_FILE_LIMIT = 50;
const SEARCH_LINE_LIMIT = 80;
const LIST_LIMIT = 80;
const OKF_ISSUE_LIMIT = 20;

const scopeSchema = Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "Memory scope. Defaults to project." });
const projectSchema = Type.Optional(Type.String({ description: "Project ID whose memory to use instead of the current project's (normalized like pi-memory.projectId, for example 'homelab-server'). Applies to the project scope." }));

/** The `project` parameter, or undefined for the current project. An empty value is an error, not "current". */
function projectParam(params: { project?: unknown }): string | undefined {
	return params.project === undefined || params.project === null ? undefined : String(params.project);
}

function relativeNotes(root: string, files: VaultFile[]): RootNote[] {
	return files.flatMap((file) => {
		const relative = relativeToRoot(root, file.path);
		return relative === null ? [] : [{ path: relative, text: file.text }];
	});
}

function text(value: string, details: Record<string, unknown>) {
	return { content: [{ type: "text" as const, text: value }], details };
}

export default function piMemory(pi: ExtensionAPI) {
	registerMemoryCommand(pi);

	pi.registerTool({
		name: "memory_check",
		exposure: "codemode",
		label: "Memory Check",
		description: "Check vault configuration and report the vault, backend, project ID and the vault-relative global and project memory roots, then list the markdown notes in project and global memory with an OKF frontmatter conformance report. Use this before reading when the user asks what memories exist.",
		parameters: Type.Object({ directory: Type.Optional(Type.String({ description: "Optional project subdirectory to list (for example, 'research')" })), project: projectSchema }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const s = openSession(pi, ctx.cwd, projectParam(params));
			const directory = params.directory ? String(params.directory) : undefined;
			const listRoot = directory ? resolveFolderPath(s.project, directory) : s.project;
			await s.client.verifyVault(signal);
			const [projectEntry, globalEntry, projectFiles, globalFiles] = await Promise.all([
				s.client.stat(s.project, signal),
				s.client.stat(s.global, signal),
				s.client.listMarkdown(s.project, true, signal),
				s.client.listMarkdown(s.global, true, signal),
			]);
			const projectNotes = relativeNotes(s.project, projectFiles);
			const globalNotes = relativeNotes(s.global, globalFiles);
			const okfProject = analyzeOkf(projectNotes);
			const okfGlobal = analyzeOkf(globalNotes);
			const listed = directory ? projectFiles.filter((file) => file.path.startsWith(`${listRoot}/`)) : projectFiles;
			const okfIssues = [
				...okfProject.nonconforming.map((issue) => ({ ...issue, scope: "project" })),
				...okfGlobal.nonconforming.map((issue) => ({ ...issue, scope: "global" })),
			];
			const projectList = relativeNotes(s.project, listed).map((note) => note.path);
			const globalList = globalNotes.map((note) => note.path);
			const out = [
				`Vault: ${s.vault} ✓`,
				`Backend: ${s.backend}`,
				`Project ID: ${s.projectId}`,
				`Project: ${s.project} ${projectEntry ? "" : "(missing)"}`.trimEnd(),
				`Global: ${s.global} ${globalEntry ? "" : "(missing)"}`.trimEnd(),
				`Project markdown files: ${projectList.length}${directory ? ` (in ${directory})` : ""}`,
				`Global markdown files: ${globalList.length}`,
				`OKF: ${okfIssues.length ? "⚠" : "✓"} project ${okfProject.concepts}, global ${okfGlobal.concepts}, nonconforming ${okfIssues.length}`,
				...okfIssues.slice(0, OKF_ISSUE_LIMIT).map((issue) => `  - ${issue.scope}:${issue.file}: ${issue.reasons.join(", ")}`),
				okfIssues.length > OKF_ISSUE_LIMIT ? `  ... ${okfIssues.length - OKF_ISSUE_LIMIT} more` : "",
				"",
				"Project files:",
				...projectList.slice(0, LIST_LIMIT).map((file) => `  ${file}`),
				projectList.length > LIST_LIMIT ? `  ... ${projectList.length - LIST_LIMIT} more` : "",
				"Global files:",
				...globalList.slice(0, LIST_LIMIT).map((file) => `  ${file}`),
				globalList.length > LIST_LIMIT ? `  ... ${globalList.length - LIST_LIMIT} more` : "",
			].filter(Boolean).join("\n");
			return text(out, {
				vault: s.vault,
				backend: s.backend,
				projectId: s.projectId,
				project: s.project,
				global: s.global,
				projectExists: Boolean(projectEntry),
				globalExists: Boolean(globalEntry),
				projectFileCount: projectList.length,
				globalFileCount: globalList.length,
				okf: { project: okfProject, global: okfGlobal },
			});
		},
	});

	pi.registerTool({
		name: "memory_search",
		exposure: "codemode",
		label: "Memory Search",
		description: "Search memory notes with Obsidian search syntax (plain words, \"exact phrase\", tag:name, /regex/, path: and property filters). On hosts using the disk backend only plain words, \"phrases\", /regex/ and tag:name are supported; other operators fail. Defaults to project memory. Use memory_read to inspect a matched note before detailed summaries.",
		promptSnippet: "Use memory_search directly for ordinary retrieval.",
		parameters: Type.Object({
			query: Type.String({ description: "Obsidian search query" }),
			scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("all")], { description: "Memory scope to search. Defaults to project." })),
			project: projectSchema,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const query = String(params.query ?? "").trim();
			if (!query) throw new Error("Provide a query to search memory notes.");
			const scope = (params.scope || "project") as SearchScope;
			const s = openSession(pi, ctx.cwd, projectParam(params));
			const roots: Array<{ label: NoteScope; root: string }> = [];
			if (scope === "project" || scope === "all") roots.push({ label: "project", root: s.project });
			if (scope === "global" || scope === "all") roots.push({ label: "global", root: s.global });
			await s.client.verifyVault(signal);
			const sections: string[] = [];
			const files: string[] = [];
			for (const { label, root } of roots) {
				const matches = await s.client.searchContext(query, root, SEARCH_FILE_LIMIT, signal);
				const lines: string[] = [];
				for (const match of matches) {
					const relative = relativeToRoot(root, match.file);
					if (relative === null) continue;
					files.push(`${label}:${relative}`);
					// Property, tag, and path filters match a file without any matching line.
					if (!match.matches.length) lines.push(relative);
					for (const hit of match.matches) lines.push(`${relative}:${hit.line}: ${hit.text}`);
				}
				if (lines.length) sections.push(`## ${label} matches`, ...lines.slice(0, SEARCH_LINE_LIMIT));
			}
			if (!sections.length) return text(`No results found for "${query}".`, { files: [], count: 0, scope, query });
			return text(`Found ${files.length} file(s) matching "${query}":\n\n${sections.join("\n")}\n\nUse memory_read to view full content.`, { files, count: files.length, scope, projectId: s.projectId, query });
		},
	});

	pi.registerTool({
		name: "memory_read",
		exposure: "codemode",
		label: "Memory Read",
		description: "Read one memory note by its path relative to the scope root (for example 'research/topic.md'). Returns the exact note text.",
		parameters: Type.Object({
			path: Type.String({ description: "Markdown note path relative to the scope root" }),
			scope: Type.Optional(scopeSchema),
			project: projectSchema,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope = (params.scope || "project") as NoteScope;
			const s = openSession(pi, ctx.cwd, projectParam(params));
			const vaultPath = resolveNotePath(scopeRoot(scope, s.projectId), String(params.path));
			const content = await s.client.read(vaultPath, signal);
			return text(content, { scope, projectId: s.projectId, path: String(params.path), vaultPath, chars: content.length });
		},
	});

	pi.registerTool({
		name: "memory_write",
		exposure: "codemode",
		label: "Memory Write",
		description: "Write one whole memory note. mode 'create' fails if the note exists; mode 'overwrite' fails if it is missing. Content must be an OKF concept document: YAML frontmatter with a non-empty type.",
		parameters: Type.Object({
			path: Type.String({ description: "Markdown note path relative to the scope root, ending in .md" }),
			content: Type.String({ description: "Complete note text, including frontmatter" }),
			mode: Type.Union([Type.Literal("create"), Type.Literal("overwrite")], { description: "create: new note only. overwrite: replace an existing note." }),
			scope: Type.Optional(scopeSchema),
			project: projectSchema,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope = (params.scope || "project") as NoteScope;
			const mode = String(params.mode) as "create" | "overwrite";
			if (mode !== "create" && mode !== "overwrite") throw new Error('mode must be "create" or "overwrite".');
			const content = String(params.content);
			const s = openSession(pi, ctx.cwd, projectParam(params));
			const { vaultPath, okf } = await writeNote(s, scope, String(params.path), content, mode, signal);
			const verb = mode === "create" ? "Created" : "Overwrote";
			const warning = okf.length ? `\nWarning: not a valid OKF concept (${okf.join(", ")}).` : "";
			return text(`${verb} ${scope}:${params.path} (${content.length} chars).${warning}`, { scope, projectId: s.projectId, path: String(params.path), vaultPath, mode, chars: content.length, bytes: Buffer.byteLength(content, "utf8"), okf: okf.length ? okf : undefined });
		},
	});

	pi.registerTool({
		name: "memory_edit",
		exposure: "codemode",
		label: "Memory Edit",
		description: "Replace one exact, unique occurrence of oldText with newText in an existing memory note. Fails if oldText is missing or matches more than once. Refresh the frontmatter updated/timestamp fields when the change is substantive.",
		parameters: Type.Object({
			path: Type.String({ description: "Markdown note path relative to the scope root" }),
			oldText: Type.String({ description: "Exact text to replace; must occur exactly once" }),
			newText: Type.String({ description: "Replacement text" }),
			scope: Type.Optional(scopeSchema),
			project: projectSchema,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope = (params.scope || "project") as NoteScope;
			const s = openSession(pi, ctx.cwd, projectParam(params));
			const oldText = String(params.oldText);
			const newText = String(params.newText);
			const vaultPath = await editNote(s, scope, String(params.path), oldText, newText, signal);
			return text(`Edited ${scope}:${params.path} (1 replacement).`, { scope, projectId: s.projectId, path: String(params.path), vaultPath, oldChars: oldText.length, newChars: newText.length });
		},
	});

	pi.registerTool({
		name: "memory_trash",
		exposure: "codemode",
		label: "Memory Trash",
		description: "Move one memory note to Obsidian's trash (the vault's Deleted files setting, system trash by default). Fails if the note does not exist. Needs the Obsidian CLI backend. Ask Algorant first when the note may still be useful.",
		parameters: Type.Object({
			path: Type.String({ description: "Markdown note path relative to the scope root" }),
			scope: Type.Optional(scopeSchema),
			project: projectSchema,
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const scope = (params.scope || "project") as NoteScope;
			const s = openSession(pi, ctx.cwd, projectParam(params));
			const vaultPath = resolveNotePath(scopeRoot(scope, s.projectId), String(params.path));
			await s.client.trash(vaultPath, signal);
			return text(`Trashed ${scope}:${params.path}.`, { scope, projectId: s.projectId, path: String(params.path), vaultPath });
		},
	});
}
