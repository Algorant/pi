import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IMAGE_PROJECTION_EVENT, projectPayloadImages, type ImageProjection } from "../lib/image-payload.ts";

export type ProjectImages = (payload: unknown, ctx: ExtensionContext) => any;
export function observeImageProjection(pi: ExtensionAPI): ProjectImages {
  let projection: ImageProjection | undefined;
  pi.events.on(IMAGE_PROJECTION_EVENT, (value: unknown) => {
    const candidate = value as ImageProjection | undefined;
    projection = candidate && typeof candidate.sessionId === "string" && typeof candidate.project === "function" ? candidate : undefined;
  });
  return (payload, ctx) => {
    try {
      return projection?.sessionId === ctx.sessionManager.getSessionId()
        ? projection.project(payload) : projectPayloadImages(payload, new Map());
    } catch {
      // Native hook errors otherwise pass the original payload through.
      ctx.abort();
      ctx.ui.notify("Image request guard failed; request cancelled.", "error");
      return {};
    }
  };
}
