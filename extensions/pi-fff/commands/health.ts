import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NativeFffFinder } from "../native/finder";

export function registerHealthCommand(pi: ExtensionAPI, finder: NativeFffFinder, isActive: () => boolean = () => true) {
  pi.registerCommand("fff-health", { description: "Show @ff-labs/fff-bun and index health.", handler: async (_args: string, ctx: ExtensionCommandContext) => {
    if (!isActive()) return;
    const [health, progress] = await Promise.all([finder.health(), finder.progress()]);
    if (!isActive()) return;
    const body = [`# FFF health`, ``, `- Engine: @ff-labs/fff-bun`, ``, `## Scan`, progress.ok ? JSON.stringify(progress.value,null,2) : `Error: ${progress.error}`, ``, `## Native health`, health.ok ? JSON.stringify(health.value, null, 2) : `Error: ${health.error}`];
    await ctx.ui.editor("FFF health", body.join("\n"));
  }});
}
