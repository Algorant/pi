// Vault-relative memory locations. Pure functions; nothing here touches the vault.

export const MEMORY_ROOT = "Agentic/memory";

export type NoteScope = "project" | "global";

export function globalRoot(): string {
	return `${MEMORY_ROOT}/global`;
}

export function projectRoot(projectId: string): string {
	return `${MEMORY_ROOT}/projects/${projectId}`;
}

export function scopeRoot(scope: NoteScope, projectId: string): string {
	return scope === "global" ? globalRoot() : projectRoot(projectId);
}

function segments(relative: string, what: string): string[] {
	if (typeof relative !== "string" || !relative.trim()) throw new Error(`${what} must not be empty.`);
	if (relative.includes("\\") || relative.includes("\0")) throw new Error(`${what} must use "/" separators and no control characters: ${JSON.stringify(relative)}`);
	if (relative.startsWith("/")) throw new Error(`${what} must be relative to the memory scope: ${relative}`);
	const parts = relative.split("/");
	if (parts.some((part) => part === "" || part.startsWith("."))) {
		throw new Error(`${what} must stay inside the memory scope: no empty segments and no segment starting with "." (".." included; Obsidian cannot see dot-prefixed files): ${relative}`);
	}
	return parts;
}

/** Vault path of a Markdown note inside a scope root. Throws unless it is a relative `.md` path confined to the root. */
export function resolveNotePath(root: string, relative: string): string {
	const parts = segments(relative, "Path");
	const name = parts[parts.length - 1];
	if (!name.endsWith(".md") || name === ".md") throw new Error(`Path must be a Markdown file ending in ".md": ${relative}`);
	return `${root}/${parts.join("/")}`;
}

/** Vault path of a subfolder inside a scope root. */
export function resolveFolderPath(root: string, relative: string): string {
	return `${root}/${segments(relative, "Directory").join("/")}`;
}

/** Path relative to a scope root; null when the vault path is outside it. */
export function relativeToRoot(root: string, vaultPath: string): string | null {
	return vaultPath.startsWith(`${root}/`) ? vaultPath.slice(root.length + 1) : null;
}
