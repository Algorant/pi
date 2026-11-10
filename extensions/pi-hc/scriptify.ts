import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHcScriptifyRenderer } from "../pi-ui/tool-ui/custom-tools/hc-scriptify.ts";
import { hcProfileRequested } from "../pi-agency/subagents/profile.ts";
import { WORKER_CONTEXT_FLAG } from "../pi-agency/workers/context.ts";
import { coreId, hcJson, hcText } from "./core.ts";
import { appCommand, appView, resolveAppSpace, type AppHost } from "./app-host.ts";
import { KIND_KEY, LABEL_KEY, labelFrom } from "../../scripts/whois.ts";

const job = fileURLToPath(new URL("./scriptify-job.sh", import.meta.url));

async function app(host: AppHost, command: string, args?: Record<string, unknown>): Promise<any> {
  const argv = args ? ["do", command, JSON.stringify(args)] : [command];
  const value = JSON.parse(await appCommand(host, argv));
  if (value.error) throw new Error(value.error);
  return value;
}

type Placement = { space: string; tab: string; pane: string; machine: string | null; host: AppHost };

/** Native ancestry locates a child's work pane; inbox routing still names the invoking Pi. */
async function workPane(self: any, localCore: string): Promise<Placement> {
  let owner = self;
  while (!owner.labels?.["herdr.space"]) {
    if (owner.labels?.["herdr.tab"] || !owner.parent) {
      throw new Error(`Scriptify cannot resolve ${self.address}'s work tab: missing herdr.space metadata. Nothing was started.`);
    }
    owner = await hcJson(["get", owner.parent]);
  }
  if (owner.state !== "live") throw new Error("Scriptify's work-tab owner is not live. Nothing was started.");
  const membership = await resolveAppSpace(owner.labels["herdr.space"], owner.labels["herdr.tab"], localCore, owner.address);
  const { host, space, tab } = membership;
  const panes = tab.terminals?.filter((p: any) => coreId(space.machine, p.terminal) === owner.address) ?? [];
  const pane = panes[0]?.pane;
  if (panes.length !== 1 || typeof tab.id !== "string" || typeof pane !== "string") {
    throw new Error(`Scriptify cannot resolve ${owner.address}'s actual work-pane membership in herdr-app ls. Nothing was started.`);
  }
  return { space: space.id, tab: tab.id, pane, machine: space.machine ?? null, host };
}

/** Fixed native actions restore the work tab and the previously selected space/tab. No polling. */
async function restoreView(placement: Placement, before: any, active: any): Promise<void> {
  const doApp = (name: string, args: Record<string, unknown>) => app(placement.host, name, args);
  const work = before.tabs[placement.tab];
  await doApp("pane.focus", { pane: work.focused });
  const currentZoom = (await appView(placement.host)).tabs[placement.tab]?.zoomed;
  if (currentZoom !== work.zoomed) {
    if (currentZoom) await doApp("pane.zoom", { pane: currentZoom });
    if (work.zoomed) await doApp("pane.zoom", { pane: work.zoomed });
  }
  const selected = before.spaces[placement.space];
  if (selected !== placement.tab) await doApp("tab.select", { id: selected });
  if (active.tab !== placement.tab || active.focused_pane !== work.focused) {
    await doApp("pane.focus", { pane: active.focused_pane });
  }
}

/** One app-created terminal, below the caller. Its brief focus/zoom jump is explicitly approved. */
export function registerScriptify(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "scriptify", label: "Scriptify", exposure: "model-only",
    description: "Run a reviewed user-run script as ONE native app-created runner below the caller's work pane (agent top two-thirds, runner bottom third). Native pane.split briefly changes pane focus/zoom; original focus/zoom and selected space/tab are immediately restored. The script starts immediately; its own first confirmation before any change is the presence boundary. Sudo requires an actual non-elevated permission failure and prior approval. Credentials stay in the runner. The invoking Pi's existing inbox receives succeeded (exit 0), FAILED or CANCELLED; pane close cancels. The runner is app-owned: caller ending alone does NOT kill it. Hard runner/host loss may prevent a result: never infer success or rerun automatically. Missing work-tab metadata fails before launch. Read-only helpers and managed Workers ask their owner (a Worker through worker_ask); remote steps run from their owning agent's tab on that host. Run ordinary authorized work directly.",
    parameters: Type.Object({
      script_path: Type.String({ description: "Absolute path of the reviewed executable script on this host. No secrets." }),
      reason: Type.String({ minLength: 1, description: "Established user-run boundary for this handoff." }),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "2-5 plain words naming the job for Algorant, stored as its native hc label. Default: the reason's first line." })),
    }, { additionalProperties: false }),
    ...createHcScriptifyRenderer(),
    async execute(_id, args, signal, _update, ctx) {
      if (hcProfileRequested()) throw new Error("Read-only helpers must ask their owner for a Scriptify handoff. Nothing was started.");
      // The outcome goes to the caller's inbox, and a Worker invocation ends at
      // worker_ask/worker_report: the long-lived owner runs the human step instead.
      if (pi.getFlag(WORKER_CONTEXT_FLAG) === true) {
        throw new Error("Managed Workers do not launch Scriptify: the outcome would reach this Worker's inbox after its invocation ended. Write and review the script, then worker_ask your owner to run it with scriptify (script_path, reason, label); the owner verifies the outcome and its answer continues this session. Nothing was started.");
      }
      if (!isAbsolute(args.script_path) || /[\r\n]/.test(args.script_path)) throw new Error("Use a single-line absolute reviewed script path.");
      if (args.label !== undefined && /[\r\n]/.test(args.label.trim())) throw new Error("label must be one line of 2-5 plain words.");
      const label = labelFrom(args.label ?? args.reason);
      if (!label) throw new Error("No label: pass label (2-5 plain words).");
      const id = process.env.HC_TERMINAL_ID;
      if (!id) throw new Error("Scriptify requires HC_TERMINAL_ID. Nothing was started.");
      const [self, server] = await Promise.all([hcJson(["get", id]), hcJson(["server", "status"])]);
      if (self.state !== "live" || typeof self.address !== "string") throw new Error("Scriptify requires a live native caller. Nothing was started.");
      if (typeof server.core?.id !== "string") throw new Error("Scriptify cannot identify the invoking native core. Nothing was started.");
      const placement = await workPane(self, server.core.id);
      const before = await appView(placement.host);
      const active = await app(placement.host, "status");
      const work = before.tabs?.[placement.tab];
      const activeTab = before.tabs?.[active.tab];
      if (!work?.focused || !before.spaces?.[placement.space] || before.active !== active.space || before.spaces?.[active.space] !== active.tab || activeTab?.focused !== active.focused_pane) {
        throw new Error("Scriptify cannot snapshot native pane focus/zoom for restoration (including layout-block focus). Nothing was started.");
      }
      await hcText(["exec", "test", "-x", args.script_path]);
      signal?.throwIfAborted();
      let created: any;
      try {
        try {
          created = await app(placement.host, "pane.split", { direction: "down", pane: placement.pane,
            argv: ["bash", job, args.script_path, self.address, join(getAgentDir(), "scripts", "inbox"), ctx.cwd] });
          if (typeof created?.terminal !== "string" || typeof created?.pane !== "string") throw new Error("pane.split returned no runner terminal/pane.");
        } finally {
          // Even an ambiguous launch reply must not leave the authorized focus jump behind.
          await restoreView(placement, before, active);
        }
        await app(placement.host, "layout.resize", { id: placement.pane, weight: 2 });
        await app(placement.host, "layout.resize", { id: created.pane, weight: 1 });
        const terminal = coreId(placement.machine, created.terminal) as string;
        await hcText(["label", terminal, `${LABEL_KEY}=${label}`, `${KIND_KEY}=scriptify`]);
        await hcText(["keep", "--off", terminal]);
      } catch (error) {
        throw new Error(`Scriptify launch/placement was not fully confirmed${created?.terminal ? ` for ${created.terminal}` : ""}. Inspect the work tab and your inbox; do not rerun or cancel an already running script automatically. ${String(error)}`);
      }
      const details = { label, terminal: created.terminal, script: args.script_path, recipient: self.address, space: placement.space, tab: placement.tab, pane: created.pane };
      return { content: [{ type: "text", text: `Scriptify ${label} (${details.terminal}) launched ONE app-owned runner below the caller's work pane: agent top two-thirds, runner bottom third. Original pane focus/zoom and selected space/tab were restored after the approved brief jump. Algorant answers the script's prompts there. Its outcome returns to your existing inbox; pane close cancels, but caller ending alone does not kill it. Launch is not completion; no observed outcome means no confirmed success.` }], details };
    },
  });
}
