const TEXT = "[Image omitted: not admitted in the current run's image budget. Use a bounded analysis child with the original path.]";
const dataUrl = (url: unknown): string | undefined => typeof url === "string" && url.startsWith("data:image/") && url.includes(";base64,")
  ? url.slice(url.indexOf(";base64,") + 8) : undefined;

export function payloadImage(value: any): { base64?: string; replacement: unknown } | undefined {
  if (value?.type === "image" && value.source?.type === "base64") return { base64: value.source.data, replacement: { type: "text", text: TEXT } };
  if (value?.type === "input_image") return { base64: dataUrl(value.image_url), replacement: { type: "input_text", text: TEXT } };
  if (value?.type === "image_url") return { base64: dataUrl(value.image_url?.url), replacement: { type: "text", text: TEXT } };
  if (value?.inlineData?.mimeType?.startsWith("image/")) return { base64: value.inlineData.data, replacement: { text: TEXT } };
  return undefined;
}

/** Recheck after provider-owned replay transforms, which can bypass native context. */
export function projectPayloadImages(payload: unknown, admitted: ReadonlyMap<string, number>): any {
  const remaining = new Map(admitted);
  const walk = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    const image = payloadImage(value);
    if (image) {
      const count = typeof image.base64 === "string" ? remaining.get(image.base64) ?? 0 : 0;
      if (!count) return image.replacement;
      remaining.set(image.base64!, count - 1);
      return value;
    }
    if (Array.isArray(value)) {
      const result = [...value];
      for (let i = result.length - 1; i >= 0; i--) result[i] = walk(result[i]);
      return result;
    }
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, walk(item)]).reverse());
  };
  return walk(payload);
}

export const IMAGE_PROJECTION_EVENT = "pi-ui:image-projection";
export type ImageProjection = { sessionId: string; project(payload: unknown): unknown };
