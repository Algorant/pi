import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerAnthropic from "./anthropic/index.ts";
import registerOpenAI from "./openai/index.ts";
import { registerRequestMetrics } from "./request-metrics.ts";
import { observeImageProjection } from "./image-projection.ts";

export default function piProviders(pi: ExtensionAPI): void {
  const projectImages = observeImageProjection(pi);
  registerAnthropic(pi);
  registerOpenAI(pi, projectImages);
  pi.on("before_provider_request", (event, ctx) => projectImages(event.payload, ctx));
  // Observe the payload after both owned provider transformations.
  registerRequestMetrics(pi);
}

export * from "./quota/index.ts";
