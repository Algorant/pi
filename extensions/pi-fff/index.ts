import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFindTool } from "./tools/find";
import { registerGrepTool } from "./tools/grep";
import { registerHealthCommand } from "./commands/health";
import { registerRescanCommand } from "./commands/rescan";
import { registerMentionAutocomplete } from "./autocomplete/mention";
import { NativeFffFinder } from "./native/finder";
import { AuxFinderPool, ExternalCursorStore } from "./native/external";
import type { FffSessionResources } from "./session.ts";

export default function nativeFff(pi: ExtensionAPI) {
  let generation = 0;
  let active: FffSessionResources | undefined;

  registerFindTool(pi, process.cwd(), () => active);
  registerGrepTool(pi, process.cwd(), () => active);

  function disposeActive(): void {
    generation += 1;
    const previous = active;
    active = undefined;
    previous?.externalFinders.destroy();
    previous?.externalCursors.clear();
    previous?.finder.destroy();
  }

  pi.on("session_start", (_event, ctx) => {
    disposeActive();
    const sessionGeneration = generation;
    const cwd = ctx.cwd;
    const finder = new NativeFffFinder(cwd);
    const resources: FffSessionResources = {
      finder,
      externalFinders: new AuxFinderPool(),
      externalCursors: new ExternalCursorStore(),
      isActive: () => active === resources && generation === sessionGeneration,
    };
    active = resources;
    registerHealthCommand(pi, finder, resources.isActive);
    registerRescanCommand(pi, finder, resources.isActive);
    if (ctx.hasUI) registerMentionAutocomplete(ctx, finder, resources.isActive);
    void finder.ensure().then(
      (result) => {
        if (resources.isActive() && !result.ok && ctx.hasUI) ctx.ui.notify(`pi-fff: ${result.error}`, "warning");
      },
      (error) => {
        if (resources.isActive() && ctx.hasUI) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`pi-fff: ${message}`, "warning");
        }
      },
    );
  });
  pi.on("session_shutdown", async () => {
    disposeActive();
  });
}
