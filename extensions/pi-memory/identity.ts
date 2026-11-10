import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function realpathIfExists(filePath: string): string | null {
  try { return fs.realpathSync(filePath); } catch { return null; }
}

function isWithinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function piConfigProjectName(cwd: string): string | null {
  const cwdReal = realpathIfExists(cwd) || path.resolve(cwd);
  const root = realpathIfExists(path.join(os.homedir(), ".pi"));
  return root && isWithinPath(root, cwdReal) ? "pi" : null;
}

// Obsidian cannot see dot-prefixed folders, so leading dots are stripped (".pi" → "pi", ".dotfiles" → "dotfiles").
export function safeProjectId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");
  if (!id) throw new Error(`Project ID ${JSON.stringify(value)} is empty after normalization; set pi-memory.projectId in project settings.`);
  return id;
}

export function projectName(cwd: string, configuredId?: string): string {
  if (configuredId) return safeProjectId(configuredId);
  const piProject = piConfigProjectName(cwd);
  if (piProject) return piProject;
  let dir = cwd;
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return safeProjectId(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return safeProjectId(path.basename(cwd) || "project");
    dir = parent;
  }
}
