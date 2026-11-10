import type { ReadToolDetails, ReadToolInput } from "@earendil-works/pi-coding-agent";
import { createBoxedToolRenderer } from "../core/card";
import {
  countLines,
  fieldLine,
  formatSize,
  joinTitleParts,
  plainTextLines,
  section,
  statusIcon,
  statusTone,
  stripReadContinuationFooters,
  toolName,
  truncationLines,
} from "../core/text";

function lineRange(args: Pick<ReadToolInput, "offset" | "limit">): string | undefined {
  if (args.offset === undefined && args.limit === undefined) return undefined;
  const start = args.offset ?? 1;
  const end = args.limit !== undefined ? start + args.limit - 1 : undefined;
  return `${start}${end ? `-${end}` : ""}`;
}

export function createReadRenderer() {
  return createBoxedToolRenderer<ReadToolInput, ReadToolDetails | undefined>(({ args, result, options, theme, text, pending, error }) => {
    const details = result?.details as ReadToolDetails | undefined;
    const imageCount = result?.content?.filter((part) => part.type === "image").length ?? 0;
    const displayText = stripReadContinuationFooters(text);
    const lineCount = countLines(displayText);
    const byteCount = Buffer.byteLength(displayText, "utf8");
    const range = lineRange(args);
    const pathLabel = args.path ? `${args.path}${range ? `:${range}` : ""}` : undefined;
    const warning = Boolean(details?.truncation?.truncated);
    const tone = statusTone({ pending, error, warning });
    const lineSummary = pending
      ? undefined
      : imageCount > 0
        ? `${imageCount} image attachment${imageCount === 1 ? "" : "s"}`
        : details?.truncation?.truncated && details.truncation.outputLines !== undefined && details.truncation.totalLines !== undefined
          ? `${details.truncation.outputLines}/${details.truncation.totalLines} lines`
          : `${lineCount} line${lineCount === 1 ? "" : "s"}`;
    const title = joinTitleParts([
      `${statusIcon(theme, tone)} ${toolName(theme, "Read")}`,
      pathLabel,
      lineSummary,
      !pending && imageCount === 0 ? formatSize(byteCount) : undefined,
    ]);
    const preview = pending
      ? [theme.fg("muted", "Reading file…")]
      : imageCount > 0
        ? [theme.fg(error ? "error" : "success", `${imageCount} image attachment${imageCount === 1 ? "" : "s"}`)]
        : plainTextLines(theme, displayText, options.expanded, {
            collapsed: 3,
            expanded: 12,
            empty: "No text content",
            totalLines: details?.truncation?.totalLines,
          });
    const detailsLines = [
      range ? fieldLine(theme, "requested range", range, "muted") : undefined,
      ...truncationLines(theme, details),
    ];

    return {
      title,
      tone,
      body: options.expanded ? undefined : preview,
      sections: options.expanded
        ? [
            section("Preview", preview),
            section("Details", detailsLines),
          ]
        : [],
    };
  });
}
