import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerInbox from "../pi-agency/inbox/index.ts";
import { isHc } from "./core.ts";
import { registerHcIdleCompaction } from "./compaction.ts";
import { registerAgencyProfile } from "./profile.ts";
import { registerHcModelLabel } from "./model.ts";
import { registerHcReport } from "./report.ts";
import { registerScriptify } from "./scriptify.ts";
import { registerHcWorkers } from "./workers.ts";
import { registerDispatch } from "./dispatch.ts";
import { registerPiReload } from "./reload.ts";
import { registerHcTurnLabels } from "./turn-label.ts";

/** HC owns terminal identity/lifetime/status; Pi already emits OSC 7501. */
export default function piHc(pi: ExtensionAPI): void {
  if (!isHc()) return;
  // A nested Pi inherits the same terminal. It must not consume its parent's mail.
  const prefix = `${process.env.HC_TERMINAL_SOCKET}:${process.env.HC_TERMINAL_ID}:`;
  const owner = `${prefix}${process.pid}`;
  const inherited = process.env.PI_HC_INBOX_OWNER;
  if (inherited?.startsWith(prefix) && inherited !== owner) return;
  process.env.PI_HC_INBOX_OWNER = owner;
  const child = registerHcReport(pi);
  registerAgencyProfile(pi, child.startupFailed);
  registerHcModelLabel(pi);
  registerHcTurnLabels(pi);
  registerScriptify(pi);
  const workers = registerHcWorkers(pi);
  registerDispatch(pi, workers.startWorker);
  const reload = registerPiReload(pi);
  registerInbox(pi, async (env, ctx) => {
    if (await reload(env, ctx) === null) return null;
    return workers.readyNotice(env, ctx);
  });
  // Inbox settlement scanning is registered first, preserving the existing gate.
  registerHcIdleCompaction(pi);
}
