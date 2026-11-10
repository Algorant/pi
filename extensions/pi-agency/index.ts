import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNstarHistory } from "./nstar-history.ts";
import { registerNstar } from "./nstar.ts";
import { registerOrchestratorModel } from "./model-roles-session.ts";

/**
 * pi-agency's own registrations: shared model and usage policy. Native HC
 * integration (inbox, helper profiles, Workers, idle compaction) is registered
 * by pi-hc, which reuses this extension's shared modules.
 */
export default function piAgency(pi: ExtensionAPI): void {
  registerNstar(pi);
  registerNstarHistory(pi);
  registerOrchestratorModel(pi);
}
