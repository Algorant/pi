import { createBoxedToolRenderer } from "../core/card";
import { durationLabel, fieldLine, joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import { labelFrom } from "../../../../scripts/whois.ts";

type Args = { script_path?: string; reason?: string; label?: string };
export type HcScriptifyDetails = { label: string; terminal: string; script: string; recipient: string; space: string; tab: string; pane: string };

export function createHcScriptifyRenderer() {
  return createBoxedToolRenderer<Args, HcScriptifyDetails | undefined>(({ args, result, options, theme, text, pending, error, context }) => {
    const d = result?.details;
    const tone = pending ? "pending" : error ? "error" : "warning";
    // Its whois label: the started label, or before the result the label given or the reason's first line.
    const label = d?.label || args.label?.trim() || labelFrom(args.reason ?? "") || "reviewed script";
    return {
      title: `${statusIcon(theme, tone)} ${toolName(theme, "Scriptify")}`,
      status: joinTitleParts([pending ? "launching work-tab split" : error ? "failed" : "launched · await inbox outcome", durationLabel(context.state)]), tone,
      body: [theme.fg("muted", truncatePlain(`${label} · ${d?.script ?? args.script_path ?? "reviewed script"}`, options.expanded ? 260 : 120))],
      sections: error ? [section("Error", [theme.fg("error", truncatePlain(text, options.expanded ? 1000 : 300))])] : [section("Bottom-third runner", [
        fieldLine(theme, "label", label, "accent"),
        fieldLine(theme, "terminal", d?.terminal, "muted"),
        fieldLine(theme, "input", "Algorant answers the script's prompts in the runner", "muted"),
        fieldLine(theme, "outcome", "inbox: succeeded, FAILED or CANCELLED · pane close cancels", "muted"),
        options.expanded ? fieldLine(theme, "placement", "below caller · agent 2/3, runner 1/3", "muted") : undefined,
        options.expanded ? fieldLine(theme, "restore", "approved brief jump · focus/zoom and selection restored", "muted") : undefined,
        options.expanded ? fieldLine(theme, "lifetime", "app-owned · caller ending alone does not kill it", "muted") : undefined,
        options.expanded ? fieldLine(theme, "tab", d ? `${d.space} / ${d.tab}` : undefined, "dim") : undefined,
        options.expanded ? fieldLine(theme, "loss", "no observed result is not success · never auto-rerun", "muted") : undefined,
        options.expanded ? fieldLine(theme, "recipient", d?.recipient, "dim") : undefined,
        options.expanded ? fieldLine(theme, "reason", args.reason, "muted") : undefined,
      ])],
    };
  });
}
