import type { BashToolDetails, BashToolInput } from "@earendil-works/pi-coding-agent";
import { renderUniversalBash } from "../bash-renderers";
import { createBoxedToolRenderer } from "../core/card";
import {
  durationLabel,
  fieldLine,
  joinTitleParts,
  paint,
  plainTextLines,
  section,
  statusIcon,
  statusTone,
  stripBashDisplayStatus,
  toolName,
  truncatePlain,
  truncationLines,
} from "../core/text";

const COMMAND_PREVIEW_WIDTH = 112;

function extractExitCode(text: string): number | undefined {
  const match = text.match(/Command exited with code\s+(-?\d+)/i) ?? text.match(/exit code:?\s*(-?\d+)/i);
  return match ? Number(match[1]) : undefined;
}

export function createBashRenderer() {
  return createBoxedToolRenderer<BashToolInput, BashToolDetails | undefined>(({ args, result, options, theme, text, pending, error, context }) => {
    const details = result?.details as BashToolDetails | undefined;
    const exitCode = extractExitCode(text);
    const timedOut = /Command timed out after/i.test(text);
    const aborted = /Command aborted/i.test(text);
    const baseFailed = error || timedOut || aborted || (exitCode !== undefined && exitCode !== 0);
    const outputText = stripBashDisplayStatus(text, details);
    const hasOutput = outputText.trim().length > 0;
    const subRender = renderUniversalBash({
      command: args.command,
      outputText,
      cwd: context.cwd,
      expanded: options.expanded,
      failed: baseFailed,
      pending,
      theme,
      details,
      exitCode,
      timedOut,
      aborted,
    });
    const failed = baseFailed && !subRender.treatAsSuccess;
    const tone = statusTone({ pending, error: failed });
    const subRenderHasContent = Boolean(subRender.body?.length || subRender.sections?.some((item) => item.lines.length > 0));
    const title = joinTitleParts([
      `${statusIcon(theme, tone)} ${toolName(theme, subRender.toolName ?? "Bash")}`,
      subRender.label,
      !pending && failed && !subRender.suppressFailureStatus ? (exitCode !== undefined ? `exit ${exitCode}` : timedOut ? "timeout" : "failed") : undefined,
      !pending && !failed && !hasOutput && !subRenderHasContent ? "no output" : undefined,
      durationLabel(context.state),
    ]);
    const showRawOutput = hasOutput && (!subRender.suppressRawOutput || options.expanded || (failed && !subRender.suppressRawOutputOnError));
    const outputLines = showRawOutput
      ? plainTextLines(theme, outputText, options.expanded, {
          collapsed: 5,
          expanded: 24,
          tail: true,
          empty: "No stdout/stderr",
          totalLines: details?.truncation?.totalLines,
        })
      : [];
    const rawOutputTitle = subRender.suppressRawOutput ? "Raw output" : "Output";
    const detailsCommand = !options.expanded ? (subRender.commandSummary ?? args.command) : args.command;
    const detailsLines = [
      options.expanded || failed ? fieldLine(theme, "command", detailsCommand, "toolOutput") : undefined,
      options.expanded || failed ? fieldLine(theme, "cwd", context.cwd, "muted") : undefined,
      args.timeout && (options.expanded || failed || timedOut) ? fieldLine(theme, "timeout", `${args.timeout}s`, "muted") : undefined,
      options.expanded && !failed && !pending ? fieldLine(theme, "exit", 0, "success") : undefined,
      ...(options.expanded ? truncationLines(theme, details) : []),
    ];

    return {
      title,
      tone: !pending && !failed && subRender.tone ? subRender.tone : tone,
      body: subRender.body ?? [paint(theme, "toolOutput", truncatePlain(args.command, COMMAND_PREVIEW_WIDTH))],
      sections: [
        ...(subRender.sections ?? []),
        ...(outputLines.length > 0 ? [section(rawOutputTitle, outputLines)] : []),
        ...(detailsLines.length > 0 ? [section("Details", detailsLines)] : []),
      ],
    };
  });
}
