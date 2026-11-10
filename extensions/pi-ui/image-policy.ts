import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { hcProfileRequested } from "../pi-agency/subagents/profile.ts";
import { workerContextRequested } from "../pi-agency/workers/context.ts";
import { IMAGE_PROJECTION_EVENT, projectPayloadImages } from "../lib/image-payload.ts";

type ImageBlock = { type: "image"; data: string; mimeType: string; [key: string]: unknown };
type TextBlock = { type: "text"; text: string };
type Limits = { edge: number; imageBytes: number; totalBytes: number };
const THUMBNAILS: Limits = { edge: 1024, imageBytes: 300 * 1024, totalBytes: 1024 * 1024 };
// Task-scoped children may inspect originals, but never have an unlimited image history.
const ANALYSIS: Limits = { edge: 4096, imageBytes: 4.5 * 1024 * 1024, totalBytes: 12 * 1024 * 1024 };
const omitted = (reason: string): TextBlock => ({ type: "text", text: `[Image omitted: ${reason}. Use a bounded analysis child with the original path; return text findings.]` });
const isImage = (block: any): block is ImageBlock => block?.type === "image";
const messageKey = (message: any): string => JSON.stringify([message.role, message.timestamp, message.toolCallId, message.customType]);

async function boundedImage(image: ImageBlock, limits: Limits): Promise<ImageBlock | TextBlock> {
  try {
    if (typeof image.data !== "string" || typeof image.mimeType !== "string") return omitted("invalid image block");
    const resized = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
      maxWidth: limits.edge, maxHeight: limits.edge, maxBytes: limits.imageBytes,
    });
    if (!resized || resized.data.length > limits.imageBytes || resized.width > limits.edge || resized.height > limits.edge) {
      return omitted("could not meet image size limits");
    }
    return { ...image, data: resized.data, mimeType: resized.mimeType,
      ...("note" in image ? { note: `Bounded image: ${resized.width}×${resized.height}; ${resized.data.length} base64 bytes.` } : {}) };
  } catch {
    // Native tool normalization can retain its original on resize failure. Never do that here.
    return omitted("image decoding or resizing failed");
  }
}

async function boundedBlocks(blocks: any[], limits: Limits): Promise<any[]> {
  let bytes = 0;
  const result = [];
  for (const block of blocks) {
    if (!isImage(block)) { result.push(block); continue; }
    const next = await boundedImage(block, limits);
    if (isImage(next) && bytes + next.data.length > limits.totalBytes) {
      result.push(omitted("current aggregate image byte budget exceeded"));
    } else {
      result.push(next);
      if (isImage(next)) bytes += next.data.length;
    }
  }
  return result;
}

// Structured tool output reaches codemode separately from content (notably native read).
// Preserve its other data while replacing any actual image objects, including MCP nesting.
async function boundedStructured(value: any, limits: Limits): Promise<any> {
  if (isImage(value)) return boundedImage(value, limits);
  if (Array.isArray(value)) return Promise.all(value.map((item) => boundedStructured(item, limits)));
  if (value && typeof value === "object") {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await boundedStructured(item, limits)])));
  }
  return value;
}

export function registerImagePolicy(pi: ExtensionAPI): void {
  let activeRun = false;
  let priorImages = new Set<string>();
  let admitted = new Map<string, number>();
  const limits = (): Limits => workerContextRequested() || hcProfileRequested() ? ANALYSIS : THUMBNAILS;
  const reset = () => { activeRun = false; priorImages.clear(); admitted.clear(); };
  pi.on("session_start", (_event, ctx) => {
    reset();
    pi.events.emit(IMAGE_PROJECTION_EVENT, { sessionId: ctx.sessionManager.getSessionId(),
      project: (payload: unknown) => projectPayloadImages(payload, activeRun ? admitted : new Map()),
    });
  });
  pi.on("session_shutdown", reset);
  pi.on("agent_settled", reset);
  pi.on("before_agent_start", (_event, ctx) => {
    if (activeRun) return; // queued inputs/steers and native retries remain in this run
    priorImages = new Set(ctx.sessionManager.getBranch().flatMap((entry: any) => {
      if (entry.type === "message" && Array.isArray(entry.message.content) && entry.message.content.some(isImage)) {
        return [messageKey(entry.message)];
      }
      if (entry.type === "custom_message" && Array.isArray(entry.content) && entry.content.some(isImage)) {
        return [messageKey({ role: "custom", timestamp: Date.parse(entry.timestamp), customType: entry.customType })];
      }
      return [];
    }));
    // Native before_agent_start precedes persistence of the new user/custom message.
    activeRun = true;
  });
  pi.on("input", async (event, ctx) => {
    if (!event.images?.length) return { action: "continue" };
    const blocks = await boundedBlocks(event.images, limits());
    return {
      action: "transform", text: [event.text, ...blocks.filter((block) => block.type === "text").map((block) => block.text)].join("\n"),
      images: blocks.filter(isImage),
    };
  });
  pi.on("tool_result", async (event, ctx) => {
    const policy = limits();
    return {
      content: await boundedBlocks(event.content, policy),
      ...(event.structuredContent !== undefined ? { structuredContent: await boundedStructured(event.structuredContent, policy) } : {}),
    };
  });
  pi.on("context", async (event, ctx) => {
    try {
      const messages = event.messages.map((message: any) => ({ ...message,
        ...(Array.isArray(message.content) ? { content: [...message.content] } : {}),
      }));
      const policy = limits();
      let bytes = 0;
      // Prioritize the newest current-run images. Explicit markers explain every omission.
      for (let m = messages.length - 1; m >= 0; m--) {
        const message = messages[m];
        if (!Array.isArray(message.content)) continue;
        for (let b = message.content.length - 1; b >= 0; b--) {
          const block = message.content[b];
          if (!isImage(block)) continue;
          if (!activeRun || priorImages.has(messageKey(message))) {
            message.content[b] = omitted("image belongs to a completed run");
            continue;
          }
          const next = await boundedImage(block, policy);
          if (isImage(next) && bytes + next.data.length > policy.totalBytes) {
            message.content[b] = omitted("current request aggregate image byte budget exceeded");
          } else {
            message.content[b] = next;
            if (isImage(next)) bytes += next.data.length;
          }
        }
      }
      admitted = new Map();
      for (const message of messages) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (isImage(block)) admitted.set(block.data, (admitted.get(block.data) ?? 0) + 1);
      }
      return { messages };
    } catch {
      admitted.clear();
      // Pi catches hook exceptions and continues: explicitly cancel, and supply image-free context.
      ctx.abort();
      return { messages: event.messages.map((message: any) => ({ ...message,
        ...(Array.isArray(message.content) ? { content: message.content.map((block: any) => isImage(block) ? omitted("image policy failed") : block) } : {}),
      })) };
    }
  });
}
