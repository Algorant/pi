import { createBoxedToolRenderer } from "../core/card";
import { durationLabel, fieldLine, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";

export type HcReportArgs = { text?: string; question?: boolean };
export type HcReportDetails = { parent: string; terminal: string; session?: string; file?: string; message?: string; question: boolean; kept: boolean };

/** Native child outcome, queued as a labelled message in the parent's durable inbox. */
export function createHcReportRenderer() {
  return createBoxedToolRenderer<HcReportArgs, HcReportDetails | undefined>(({ args, result, options, theme, text, pending, error, context }) => {
    const d = result?.details;
    const tone = pending ? "pending" : error ? "error" : "success";
    const state = pending ? "queueing" : error ? "failed" : d?.kept ? "outcome queued · kept" : d?.question ? "question queued · closing" : "report queued · closing";
    return {
      title: `${statusIcon(theme, tone)} ${toolName(theme, "Report")}`,
      status: joinTitleParts([state, durationLabel(context.state)]), tone,
      body: [theme.fg("muted", `${args.question ? "question" : "final"}${d?.terminal && d?.parent ? ` · ${d.terminal} → ${d.parent} inbox` : " → native parent inbox"}${d?.message ? ` · ${d.message}` : ""}`)],
      sections: error ? [section("Error", [theme.fg("error", truncatePlain(text, 600))])] : [section("Report", [
        theme.fg("toolOutput", truncatePlain(args.text ?? "", options.expanded ? 3000 : 180)),
        d?.file ? fieldLine(theme, "file", d.file, "muted") : undefined,
        options.expanded && d?.session ? fieldLine(theme, "session", d.session, "dim") : undefined,
      ])],
    };
  });
}
