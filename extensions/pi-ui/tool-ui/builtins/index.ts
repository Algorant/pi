import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashRenderer } from "./bash";
import { createCodemodeRenderer } from "./codemode";
import { createEditRenderer } from "./edit";
import { createReadRenderer } from "./read";
import { createWriteRenderer } from "./write";

/**
 * Install one load-time resolver that draws Pi's own read, bash, edit, write,
 * and codemode calls with the pi-ui cards. Pi keeps the tool definitions
 * (execution, schemas, prompt metadata); this only chooses their renderers.
 */
export function registerBuiltinToolRenderers(pi: ExtensionAPI): void {
  const renderers = new Map([
    ["read", createReadRenderer()],
    ["bash", createBashRenderer()],
    ["edit", createEditRenderer()],
    ["write", createWriteRenderer()],
    ["codemode", createCodemodeRenderer()],
  ]);
  pi.registerToolRenderer((toolName, next) => renderers.get(toolName) ?? next());
}

export { createBashRenderer } from "./bash";
export { createCodemodeRenderer } from "./codemode";
export { createEditRenderer } from "./edit";
export { createReadRenderer } from "./read";
export { createWriteRenderer } from "./write";
