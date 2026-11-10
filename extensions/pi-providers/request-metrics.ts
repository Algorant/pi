import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequestMetricsRenderer } from "../pi-ui/request-metrics.ts";
import { payloadImage } from "../lib/image-payload.ts";

const ENTRY = "pi-request-metrics";

function imagesInPayload(payload: unknown): { imageCount: number; base64Bytes: number; decodedBytes: number } {
  let imageCount = 0;
  let base64Bytes = 0;
  let decodedBytes = 0;
  const add = (data: unknown) => {
    imageCount++;
    if (typeof data !== "string") return; // URL references have no local base64 body.
    const bytes = Buffer.byteLength(data, "utf8");
    base64Bytes += bytes;
    decodedBytes += Math.floor(bytes * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  };
  const walk = (value: any): void => {
    if (!value || typeof value !== "object") return;
    const image = payloadImage(value);
    if (image) { add(image.base64); return; }
    for (const item of Array.isArray(value) ? value : Object.values(value)) walk(item);
  };
  walk(payload);
  return { imageCount, base64Bytes, decodedBytes };
}

/** Read-only numeric observations. Never retain payloads, headers or image data. */
export function registerRequestMetrics(pi: ExtensionAPI): void {
  const preferencesPath = join(getAgentDir(), "request-metrics.json");
  const readVisible = (): boolean => {
    try {
      const value = JSON.parse(readFileSync(preferencesPath, "utf8")).visible;
      if (value !== undefined && typeof value !== "boolean") throw new Error(`${preferencesPath}: visible must be boolean`);
      return value === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  let visible = false;
  pi.registerEntryRenderer(ENTRY, createRequestMetricsRenderer(() => visible));
  pi.registerCommand("request-metrics", {
    description: "Toggle recorded Request/Response lines (hidden by default); optional on/off",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode && mode !== "on" && mode !== "off") {
        ctx.ui.notify("Usage: /request-metrics [on|off]", "warning");
        return;
      }
      const next = mode ? mode === "on" : !visible;
      const temporaryPath = `${preferencesPath}.${process.pid}.tmp`;
      try {
        writeFileSync(temporaryPath, JSON.stringify({ visible: next }) + "\n", { mode: 0o600 });
        renameSync(temporaryPath, preferencesPath);
      } finally { rmSync(temporaryPath, { force: true }); }
      visible = next;
      ctx.ui.notify(`Request metrics ${visible ? "on" : "off"}; recording unchanged.`, "info");
    },
  });
  let sequence = 0;
  let pending: { sequence: number; start: number; headersMs?: number } | undefined;
  let timingAmbiguous = false;
  const reset = () => { pending = undefined; timingAmbiguous = false; };
  pi.on("session_start", (_event, ctx) => {
    sequence = ctx.sessionManager.getBranch().reduce((n, entry: any) => entry.type === "custom" && entry.customType === ENTRY &&
      entry.data?.stage === "request" && typeof entry.data.sequence === "number" ? Math.max(n, entry.data.sequence) : n, 0);
    reset();
    visible = readVisible();
  });
  pi.on("session_shutdown", reset);
  pi.on("agent_settled", reset);
  pi.on("before_provider_request", (event, ctx) => {
    sequence++;
    // Hooks expose no transport request identity. Do not attribute overlapping timings.
    if (pending) { timingAmbiguous = true; pending = undefined; }
    if (!timingAmbiguous) pending = { sequence, start: performance.now() };
    const jsonBytes = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
    const images = imagesInPayload(event.payload);
    const payload = event.payload as { model?: unknown };
    pi.appendEntry(ENTRY, {
      stage: "request", sequence, at: Date.now(), contextProvider: ctx.model?.provider ?? "unknown",
      model: typeof payload?.model === "string" ? payload.model : ctx.model?.id ?? "unknown",
      jsonBytes, ...images, otherJsonBytes: jsonBytes - images.base64Bytes,
    });
  });
  pi.on("after_provider_response", () => {
    if (pending) pending.headersMs = Math.round(performance.now() - pending.start);
  });
  pi.on("provider_stream_event", () => {
    if (!pending) return;
    pi.appendEntry(ENTRY, { stage: "timing", sequence: pending.sequence, headersMs: pending.headersMs,
      firstEventMs: Math.round(performance.now() - pending.start) });
    pending = undefined;
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && event.message.stopReason === "error" && pending) {
      pi.appendEntry(ENTRY, { stage: "timing", sequence: pending.sequence, headersMs: pending.headersMs });
      reset();
    }
  });
}
