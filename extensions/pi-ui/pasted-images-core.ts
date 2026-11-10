import { readFile, stat } from "node:fs/promises";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
// A pasted path is a standalone whitespace-delimited token, optionally with an
// `@` prefix and matching quotes. Paths embedded in code such as
// `read({path:"/tmp/a.png"})` are not tokens of their own and stay literal.
const IMAGE_PATH_RE =
  /(?<=^|\s)@?(["']?)(\/[^\n\r\t "'`<>()\[\]{}]+\.(?:bmp|dib|png|jpe?g|webp|gif))\1(?=$|[\s"'`<>()\[\]{}.,;:!?])/gi;
// Markdown code; paths inside it are literal. Delimiters match as CommonMark
// runs: a fence of 3+ backticks/tildes at line start closes only at a line
// with a run of the same character at least as long (or end of input), and an
// inline span opened by N backticks closes only at exactly N backticks, on
// the same or a later line of the same paragraph (no blank line between).
const MARKDOWN_CODE_RE =
  /^ {0,3}((`|~)\2{2,})[^`\n]*$[\s\S]*?(?:\n {0,3}\1\2*[ \t]*$|(?![\s\S]))|(?<!`)(`+)(?!`)(?:[^\n]|\n(?![ \t]*\n))*?(?<!`)\3(?!`)/gm;

type ImageAttachment = {
  type: "image";
  mimeType: string;
  data: string;
};

type PreparedImage = {
  path: string;
  // Base64 of the file as read, before conversion or resizing.
  sourceData: string;
  attachment: ImageAttachment;
};

type ImagePathToken = {
  path: string;
  start: number;
  end: number;
};

type ImagePreparationResult =
  | { ok: true; image: PreparedImage }
  | { ok: false; path: string; reason: string };

type ConvertedImage = {
  mimeType: string;
  data: string;
};

type ResizedImage = ConvertedImage & {
  width?: number;
  height?: number;
  originalWidth?: number;
  originalHeight?: number;
  wasResized?: boolean;
};

export type PastedImageDependencies = {
  convertToPng(data: string, mimeType: string): Promise<ConvertedImage | null>;
  resizeImage(bytes: Uint8Array, mimeType: string): Promise<ResizedImage | null>;
};

type PastedImageInputEvent = {
  source?: string;
  text: string;
  images?: ImageAttachment[];
};

type PastedImageInputContext = {
  hasUI?: boolean;
  ui: {
    notify(message: string, level: "info" | "warning"): void;
  };
};

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function detectImageMimeType(bytes: Uint8Array, filePath: string): string | undefined {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWithAscii(bytes, 0, "GIF")) return "image/gif";
  if (startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")) return "image/webp";
  if (startsWithAscii(bytes, 0, "BM")) return "image/bmp";

  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".bmp") || lowerPath.endsWith(".dib")) return "image/bmp";
  return undefined;
}

function findImagePathTokens(text: string): ImagePathToken[] {
  const codeRanges = [...text.matchAll(MARKDOWN_CODE_RE)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
  const tokens: ImagePathToken[] = [];
  for (const match of text.matchAll(IMAGE_PATH_RE)) {
    const start = match.index;
    if (codeRanges.some(([codeStart, codeEnd]) => start >= codeStart && start < codeEnd)) continue;
    tokens.push({ path: match[2]!, start, end: start + match[0].length });
  }
  return tokens;
}

function uniqueImagePaths(tokens: readonly ImagePathToken[]): string[] {
  const paths: string[] = [];
  for (const token of tokens) {
    if (paths.includes(token.path)) continue;
    paths.push(token.path);
  }
  return paths;
}

function replaceImagePathsWithMarkers(
  text: string,
  tokens: readonly ImagePathToken[],
  paths: ReadonlySet<string>,
): string {
  let result = text;
  for (const token of [...tokens].reverse()) {
    if (!paths.has(token.path)) continue;
    result = `${result.slice(0, token.end)} [pasted image attached]${result.slice(token.end)}`;
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

function preparationFailure(path: string, reason: string): ImagePreparationResult {
  return { ok: false, path, reason };
}

async function prepareImage(
  filePath: string,
  dependencies: PastedImageDependencies,
): Promise<ImagePreparationResult> {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return preparationFailure(filePath, "file is missing or unreadable");
  }

  if (!fileStat.isFile()) return preparationFailure(filePath, "path is not a regular file");
  if (fileStat.size <= 0) return preparationFailure(filePath, "file is empty");
  if (fileStat.size > MAX_IMAGE_BYTES) return preparationFailure(filePath, "file exceeds the 25 MiB attachment limit");

  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch {
    return preparationFailure(filePath, "file could not be read");
  }

  let mimeType = detectImageMimeType(bytes, filePath);
  if (!mimeType) return preparationFailure(filePath, "file content is not a supported image format");
  const sourceData = bytes.toString("base64");

  if (mimeType === "image/bmp") {
    try {
      const converted = await dependencies.convertToPng(sourceData, mimeType);
      if (!converted) return preparationFailure(filePath, "BMP conversion failed");
      mimeType = converted.mimeType;
      bytes = Buffer.from(converted.data, "base64");
    } catch {
      return preparationFailure(filePath, "BMP conversion failed");
    }
  }

  try {
    const resized = await dependencies.resizeImage(bytes, mimeType);
    if (!resized) return preparationFailure(filePath, "image resizing failed");

    return {
      ok: true,
      image: {
        path: filePath,
        sourceData,
        attachment: {
          type: "image",
          mimeType: resized.mimeType,
          data: resized.data,
        },
      },
    };
  } catch {
    return preparationFailure(filePath, "image resizing failed");
  }
}

function imageLabel(count: number): string {
  return count === 1 ? "pasted image" : `${count} pasted images`;
}

function notifyPreparationOutcome(
  ctx: PastedImageInputContext,
  prepared: readonly PreparedImage[],
  failures: readonly Extract<ImagePreparationResult, { ok: false }>[],
): void {
  if (ctx.hasUI === false) return;

  if (failures.length === 0) {
    ctx.ui.notify(`Attached ${imageLabel(prepared.length)}`, "info");
    return;
  }

  const first = failures[0]!;
  const failure = `${first.path}: ${first.reason}`;
  if (prepared.length === 0) {
    ctx.ui.notify(`Could not attach ${imageLabel(failures.length)} — ${failure}`, "warning");
    return;
  }

  ctx.ui.notify(
    `Attached ${imageLabel(prepared.length)}; could not attach ${imageLabel(failures.length)} — ${failure}`,
    "warning",
  );
}

export function createPastedImageInputHandler(dependencies: PastedImageDependencies) {
  return async (event: PastedImageInputEvent, ctx: PastedImageInputContext) => {
    if (event.source === "extension") return { action: "continue" as const };

    const tokens = findImagePathTokens(event.text);
    const paths = uniqueImagePaths(tokens);
    if (paths.length === 0) return { action: "continue" as const };

    const prepared: PreparedImage[] = [];
    const failures: Extract<ImagePreparationResult, { ok: false }>[] = [];
    for (const path of paths) {
      const result = await prepareImage(path, dependencies);
      if (result.ok) prepared.push(result.image);
      else failures.push(result);
    }

    notifyPreparationOutcome(ctx, prepared, failures);
    if (prepared.length === 0) return { action: "continue" as const };

    // An image already supplied with the prompt (for example an RPC image of
    // the same file) is attached once: its path stays visible beside the marker.
    const existingImages = Array.isArray(event.images) ? event.images : [];
    const suppliedData = new Set(existingImages.map((image) => image.data));
    const added = prepared.filter(
      (image) => !suppliedData.has(image.sourceData) && !suppliedData.has(image.attachment.data),
    );
    return {
      action: "transform" as const,
      text: replaceImagePathsWithMarkers(event.text, tokens, new Set(prepared.map((image) => image.path))),
      images: [...existingImages, ...added.map((image) => image.attachment)],
    };
  };
}
