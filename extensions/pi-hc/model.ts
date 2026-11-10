import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hcJson } from "./core.ts";

/** Pi owns this fact; HC owns the label storage and terminal identity. */
export function registerHcModelLabel(pi: ExtensionAPI): void {
  const publish = async (ctx: ExtensionContext) => {
    if (!ctx.model) throw new Error("Cannot publish pi.model: Pi has no current model.");
    await hcJson(["label", process.env.HC_TERMINAL_ID!, `pi.model=${ctx.model.provider}/${ctx.model.id}`]);
  };
  pi.on("session_start", async (_event, ctx) => publish(ctx));
  pi.on("model_select", async (_event, ctx) => publish(ctx));
  pi.on("session_shutdown", async () => {
    await hcJson(["label", process.env.HC_TERMINAL_ID!, "pi.model="]);
  });
}
