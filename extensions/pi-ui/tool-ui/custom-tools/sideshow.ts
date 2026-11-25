import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncatePlain } from "../core/text";
import { codePointLength, EXPLANATION_FIELD_LIMIT, hasLineBreak, EXPLANATION_FIELDS, EXPLANATION_REFUSAL_PREFIX } from "../../../pi-sideshow/explanation";

/**
 * Narrow helper for the codemode card's nested-call row. pi-sideshow tools are
 * codemode-only, so a script's call to one appears as a row in that card and
 * has no card of its own. This recognises the four surface writers and, when
 * their bounded arguments parse and carry an explanation surface, summarises
 * the three field lengths and surfaces the one known refusal diagnostic. Any
 * other call, unparseable argument text or call without an explanation returns
 * undefined, and the caller keeps its existing row.
 */
const SURFACE_WRITERS = new Set(["sideshow_publish_post", "sideshow_update_post", "sideshow_add_surface", "sideshow_edit_surface"]);
const SHOWN_EXPLANATIONS = 3;

type NestedCallLike = { name: string; args?: string; status?: string; error?: string };
export type SideshowExplanationRow = { summary: string; diagnostic: string[] };

function explanationSurfaces(args: unknown): Array<Record<string, unknown>> {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const candidates = [...(Array.isArray(record.surfaces) ? record.surfaces : []), record.surface];
  return candidates.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && (item as { kind?: unknown }).kind === "explanation");
}

function fieldCount(theme: Theme, key: string, value: unknown): string {
  if (value === undefined) return theme.fg("error", `${key} missing`);
  if (typeof value !== "string") return theme.fg("error", `${key} invalid`);
  const length = codePointLength(value.trim());
  if (length === 0) return theme.fg("error", `${key} blank`);
  if (hasLineBreak(value)) return theme.fg("error", `${key} line break`);
  return length > EXPLANATION_FIELD_LIMIT ? theme.fg("error", `${key} ${length}/${EXPLANATION_FIELD_LIMIT}`) : `${key} ${length}`;
}

export function sideshowExplanationRow(theme: Theme, call: NestedCallLike, expanded: boolean): SideshowExplanationRow | undefined {
  if (!SURFACE_WRITERS.has(call.name) || !call.args) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.args);
  } catch {
    return undefined;
  }
  const surfaces = explanationSurfaces(parsed);
  if (surfaces.length === 0) return undefined;

  const groups = surfaces.slice(0, SHOWN_EXPLANATIONS).map((surface) => EXPLANATION_FIELDS.map(({ key }) => fieldCount(theme, key, surface[key])).join(" · "));
  const more = surfaces.length > SHOWN_EXPLANATIONS ? ` +${surfaces.length - SHOWN_EXPLANATIONS} more` : "";
  const summary = `${theme.fg("muted", surfaces.length > 1 ? `${surfaces.length} explanations` : "explanation")} ${groups.join(theme.fg("muted", " | "))}${more}`;

  const refusal = call.status === "error" ? /Explanation refused[^\n]*/.exec(call.error ?? "")?.[0] : undefined;
  // Only the known validation diagnostic is shown without expanding; other failures keep the existing presentation.
  const diagnostic = refusal && refusal.startsWith(EXPLANATION_REFUSAL_PREFIX.trimEnd())
    ? [`  ${theme.fg("error", truncatePlain(refusal, expanded ? 700 : 240))}`]
    : [];
  return { summary, diagnostic };
}
