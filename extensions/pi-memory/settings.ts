import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Layered Pi settings, project over global. Only these keys exist; anything else
// under `pi-memory` is ignored.
//   global settings.json  → "pi-memory": { "vault": "<Obsidian vault name>" }   (per machine, untracked)
//   global settings.json  → "pi-memory": { "vaultPath": "~/vaults/<vault>" }   (disk-backend hosts only)
//   project .pi/settings.json → "pi-memory": { "projectId": "<stable id>" }     (optional override)
// vaultPath is read only from the global file, so a repository cannot switch the backend.

export type MemoryConfig = { vault: string; vaultPath?: string; projectId?: string };

function readJson(filePath: string): Record<string, unknown> {
	let text: string;
	try {
		text = fs.readFileSync(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(`Cannot read ${filePath}: ${(error as Error).message}`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
	}
}

function memorySection(settings: Record<string, unknown>): { vault?: unknown; vaultPath?: unknown; projectId?: unknown } {
	const section = settings["pi-memory"];
	return section && typeof section === "object" && !Array.isArray(section) ? section as Record<string, unknown> : {};
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function loadMemoryConfig(cwd: string): MemoryConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const global = memorySection(readJson(path.join(agentDir, "settings.json")));
	const project = memorySection(readJson(path.join(cwd, ".pi", "settings.json")));
	const vault = nonEmptyString(project.vault) ?? nonEmptyString(global.vault);
	if (!vault) {
		throw new Error('pi-memory is not configured: set "pi-memory": { "vault": "<Obsidian vault name>" } in the global Pi settings.json.');
	}
	const projectId = nonEmptyString(project.projectId) ?? nonEmptyString(global.projectId);
	const configuredPath = nonEmptyString(global.vaultPath);
	if (!configuredPath) return { vault, projectId };
	const vaultPath = configuredPath === "~" || configuredPath.startsWith("~/") ? path.join(os.homedir(), configuredPath.slice(1)) : configuredPath;
	if (!path.isAbsolute(vaultPath)) throw new Error(`pi-memory.vaultPath must be an absolute path or start with "~/": ${configuredPath}`);
	return { vault, vaultPath: path.normalize(vaultPath), projectId };
}
