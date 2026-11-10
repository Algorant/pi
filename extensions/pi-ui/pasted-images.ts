/**
 * Pasted image path helper for Pi.
 *
 * Herdr/Windows Terminal image paste may insert a temporary image file path
 * (often a BMP under /tmp/herdr-clipboard-images-*). Pi/model image inputs
 * work best with PNG/JPEG/WebP/GIF attachments, so this module detects image
 * paths in submitted prompts, converts BMPs to PNG, resizes like Pi's built-in
 * image handling, and attaches the image to the user message.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import { createPastedImageInputHandler } from "./pasted-images-core";

export function registerPastedImages(pi: ExtensionAPI): void {
  pi.on("input", createPastedImageInputHandler({ convertToPng, resizeImage }));
}
