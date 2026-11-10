// One memory operation's configuration and the whole-note write paths. The memory_write and
// memory_edit tools and the /mem command all go through here, so they share the backend choice,
// path confinement and OKF check.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createObsidianClient } from "../lib/obsidian-cli.ts";
import { DiskStore, type MemoryStore } from "./disk";
import { projectName, safeProjectId } from "./identity";
import { okfReasons } from "./okf";
import { globalRoot, projectRoot, resolveNotePath, scopeRoot, type NoteScope } from "./paths";
import { loadMemoryConfig } from "./settings";

export type MemorySession = ReturnType<typeof openSession>;

/** One operation: fresh config, fresh store (so the vault identity is verified once per call). `project` targets another project's memory. */
export function openSession(pi: ExtensionAPI, cwd: string, project?: string) {
	const config = loadMemoryConfig(cwd);
	const projectId = project === undefined ? projectName(cwd, config.projectId) : safeProjectId(project);
	const client: MemoryStore = config.vaultPath
		? new DiskStore(config.vaultPath)
		: createObsidianClient({ exec: (command, args, options) => pi.exec(command, args, options), vault: config.vault });
	const backend = config.vaultPath ? `disk (${config.vaultPath})` : "obsidian-cli";
	return { vault: config.vault, backend, projectId, client, project: projectRoot(projectId), global: globalRoot() };
}

/** Create a note (fails if it exists) or overwrite one (fails if it is missing). `okf` lists why the text is not a valid OKF concept. */
export async function writeNote(s: MemorySession, scope: NoteScope, relativePath: string, content: string, mode: "create" | "overwrite", signal?: AbortSignal) {
	const vaultPath = resolveNotePath(scopeRoot(scope, s.projectId), relativePath);
	if (mode === "create") await s.client.create(vaultPath, content, signal);
	else await s.client.overwrite(vaultPath, content, signal);
	return { vaultPath, okf: okfReasons(relativePath, content) };
}

/** Replace one exact, unique occurrence of oldText. Returns the vault path. */
export async function editNote(s: MemorySession, scope: NoteScope, relativePath: string, oldText: string, newText: string, signal?: AbortSignal): Promise<string> {
	const vaultPath = resolveNotePath(scopeRoot(scope, s.projectId), relativePath);
	await s.client.replaceOnce(vaultPath, oldText, newText, signal);
	return vaultPath;
}
