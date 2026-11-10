import type { EditToolDetails, EditToolInput } from "@earendil-works/pi-coding-agent";
import { createBoxedToolRenderer } from "../core/card";
import {
  fieldLine,
  joinTitleParts,
  plainTextLines,
  section,
  statusIcon,
  statusTone,
  toolName,
} from "../core/text";
import { diffStats, diffStatsTitle, renderDiffLines } from "../core/diff";

export function createEditRenderer() {
  return createBoxedToolRenderer<EditToolInput, EditToolDetails | undefined>(({ args, result, options, theme, text, pending, error }) => {
    const details = result?.details as EditToolDetails | undefined;
    const stats = diffStats(details?.diff ?? "");
    const replacements = args.edits?.length ?? 0;
    const tone = statusTone({ pending, error });
    const title = joinTitleParts([
      `${statusIcon(theme, tone)} ${toolName(theme, "Edit")}`,
      args.path,
      !pending && !error ? diffStatsTitle(theme, stats) : undefined,
      `${replacements} replacement${replacements === 1 ? "" : "s"}`,
    ]);
    const diffLines = (details?.diff ?? "").split("\n").filter(Boolean);
    const bodyLines = pending
      ? [theme.fg("muted", "Preparing/applying exact replacements…")]
      : error
        ? plainTextLines(theme, text, options.expanded, { collapsed: 5, expanded: 16, empty: "Edit failed" })
        : diffLines.length > 0
          ? renderDiffLines(theme, diffLines, options.expanded, { collapsed: 4, expanded: 18 })
          : [];
    const detailsLines = [
      details?.firstChangedLine ? fieldLine(theme, "first changed line", details.firstChangedLine, "muted") : undefined,
    ];

    return {
      title,
      tone,
      body: options.expanded ? undefined : bodyLines,
      sections: options.expanded
        ? [
            section(error ? "Output" : "Diff", bodyLines),
            section("Details", detailsLines),
          ]
        : [],
    };
  });
}
