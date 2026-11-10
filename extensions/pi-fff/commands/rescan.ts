import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { NativeFffFinder } from "../native/finder";
export function registerRescanCommand(pi: ExtensionAPI, finder: NativeFffFinder, isActive: () => boolean = () => true) {
  pi.registerCommand("fff-rescan", { description: "Trigger a native FFF workspace rescan.", handler: async (_args: string, ctx: ExtensionCommandContext) => {
    if (!isActive()) return;
    const r=await finder.rescan();
    if (!isActive()) return;
    ctx.ui.notify(r.ok ? "FFF rescan triggered" : `FFF rescan failed: ${r.error}`, r.ok ? "info" : "error");
  }});
}
