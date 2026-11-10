import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClearScreen } from "./clear-screen";
import { registerCodemodeTempCleanup } from "./codemode-temp";
import { registerPastedImages } from "./pasted-images";
import { registerImagePolicy } from "./image-policy";
import { registerStartupHeader } from "./startup-header";
import { registerLimits } from "./limits";
import { registerPowerbar } from "./powerbar";
import { registerToolUi } from "./tool-ui";
import { registerUserMessageUi } from "./user-message";
import { registerWorkingMessage } from "./working-message";
import { clearWidgetLayoutForReload } from "./widget-layout";

/**
 * Personal UI polish and bounded image intake.
 *
 * Themes remain first-class Pi resources under ~/.pi/agent/themes. This extension
 * owns small interactive/UI behaviors: the custom startup header, pasted-image
 * path attachment helper, custom user-message rails, a fixed native working
 * message, Ctrl+L clear-screen behavior, the powerbar, and the namespaced
 * tool-call UI subsystem.
 */
export default function piUi(pi: ExtensionAPI) {
	registerCodemodeTempCleanup(pi);
  // Reset the process-global layout registry before a reload or session
  // replacement can install a new runtime. Individual widgets still own their
  // own cleanup; this clears only the shared registry and slot guards.
  pi.on("session_shutdown", async () => clearWidgetLayoutForReload());
  registerStartupHeader(pi);
  registerPastedImages(pi);
  registerImagePolicy(pi);
  registerClearScreen(pi);
  registerUserMessageUi(pi);
  registerToolUi(pi);
  registerPowerbar(pi);
  registerLimits(pi);
  registerWorkingMessage(pi);
}
