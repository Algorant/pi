import type { WriteToolInput } from "@earendil-works/pi-coding-agent";
import { createBoxedToolRenderer } from "../core/card";
import {
  countLines,
  formatSize,
  joinTitleParts,
  plainTextLines,
  section,
  statusIcon,
  statusTone,
  toolName,
} from "../core/text";

export function createWriteRenderer() {
  return createBoxedToolRenderer<WriteToolInput, undefined>(({ args, options, theme, text, pending, error }) => {
    const lineCount = countLines(args.content ?? "");
    const byteCount = Buffer.byteLength(args.content ?? "", "utf8");
    const tone = statusTone({ pending, error });
    const title = joinTitleParts([
      `${statusIcon(theme, tone)} ${toolName(theme, "Write")}`,
      args.path,
      !pending && !error ? "written" : undefined,
      `${lineCount} line${lineCount === 1 ? "" : "s"}`,
      formatSize(byteCount),
    ]);
    const preview = plainTextLines(theme, args.content ?? "", options.expanded, {
      collapsed: 3,
      expanded: 12,
      totalLines: lineCount,
      empty: "Empty file",
    });
    const bodyLines = error
      ? plainTextLines(theme, text, options.expanded, { collapsed: 5, expanded: 16, empty: "Write failed" })
      : preview;

    return {
      title,
      tone,
      body: options.expanded ? undefined : bodyLines,
      sections: options.expanded ? [section(error ? "Output" : "Preview", bodyLines)] : [],
    };
  });
}
