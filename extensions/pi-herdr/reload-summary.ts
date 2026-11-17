import type { CutoverOperation, CutoverTarget, ModelAck, ReloadAck } from "../pi-agency/inbox/envelope.ts";

/** One /pi-reload sweep, as recorded on the caller, and the live summary text derived from it plus the recorded acknowledgements. */
export type Row = {
  label: string;
  machine: string;
  /** The ~/.pi HEAD this target was asked to load; null when it was skipped before a revision was known. */
  revision: string | null;
  state: "requested" | "current" | "skipped" | "failed";
  /** Inbox request id the acknowledgement answers (`requested` only). */
  request?: string;
  busy?: boolean;
  /** Short reason for skipped/failed rows. */
  why?: string;
  /** Expanded-view line. */
  note: string;
};
export type Sweep = {
  /** Identifies the sweep for its one failure message. */
  id: string;
  /** The loaded revision of the caller runtime that ran this sweep. */
  ranFrom: string | null;
  expected: string;
  rows: Row[];
  down: Array<{ name: string; why: string }>;
  history: Array<{ machine: string; text: string; /** A successful pull: informational, not a warning. */ ok?: true }>;
  note?: string;
};
export type Ack = Pick<ReloadAck, "outcome" | "previous" | "loaded" | "expected" | "dirty"> & { request: string; label: string; machine: string };

export const isSuccess = (outcome: ReloadAck["outcome"]) => outcome === "verified" || outcome === "current";
const short = (value: string | null) => value?.slice(0, 8) ?? "unknown";
const ackWhy = (ack: Ack) => ({
  "not-verified": `not verified (observed ${short(ack.loaded)})`,
  "not-applied": "not reached: still deferred when its bound expired; rerun explicitly",
  "not-foreground": "not reloaded: Pi is a background job of its shell and would stop on tty input; restart it",
})[ack.outcome as string] ?? "not reloaded (repository HEAD changed)";

type Status = "done" | "pending" | "failed" | "skipped";
const statusOf = (row: Row, acks: Map<string, Ack>): { status: Status; why?: string } => {
  if (row.state === "current") return { status: "done" };
  if (row.state === "skipped") return { status: "skipped", why: row.why };
  if (row.state === "failed") return { status: "failed", why: row.why };
  const ack = row.request ? acks.get(row.request) : undefined;
  if (!ack) return { status: "pending", why: row.busy ? "busy: applies at its own idle boundary" : "awaiting its acknowledgement" };
  return isSuccess(ack.outcome) ? { status: "done" } : { status: "failed", why: ackWhy(ack) };
};

/** Whether every request of a sweep is answered, and whether any attempted one failed. Skipped rows are not failures. */
export function settleOf(sweep: Sweep, acks: Map<string, Ack>): { pending: number; failed: number } {
  const rows = sweep.rows.map((row) => statusOf(row, acks).status);
  return { pending: rows.filter((r) => r === "pending").length, failed: rows.filter((r) => r === "failed").length };
}

/** Compact segments (tone marks the one that needs attention), the per-Pi rows, and the expanded detail lines (rows plus boilerplate). */
export function summarySweep(sweep: Sweep, acks: Map<string, Ack>): { compact: Array<{ text: string; tone?: "error" | "warning" }>; rows: string[]; detail: string[] } {
  const rows = sweep.rows.map((row) => ({ row, ...statusOf(row, acks) }));
  const counted = rows.filter((r) => r.status !== "skipped" && r.row.revision === sweep.expected);
  const own = rows.filter((r) => r.status !== "skipped" && r.row.revision !== sweep.expected);
  const list = (items: typeof rows, sep = " ") => items.map((r) => r.why ? (sep === " " ? `${r.row.label} (${r.why})` : `${r.row.label}: ${r.why}`) : r.row.label).join(", ");
  const done = counted.filter((r) => r.status === "done").length;
  const pending = counted.concat(own).filter((r) => r.status === "pending");
  const failed = rows.filter((r) => r.status === "failed");
  const skipped = rows.filter((r) => r.status === "skipped");
  const compact: Array<{ text: string; tone?: "error" | "warning" }> = [{ text: counted.length || own.length ? `Reloaded ${done}/${counted.length} to ${short(sweep.expected)}` : `Nothing to reload (${short(sweep.expected)})` }];
  if (failed.length) compact.push({ text: `FAILED: ${list(failed, ": ")}`, tone: "error" });
  // Every Pi this sweep did not reach is named with its reason, never folded into the count: a busy target still
  // holds the delivered request and applies it at its own idle boundary; a skipped or offline one is said so.
  const unreached = [...pending.map((r) => `${r.row.label} (${r.why ?? "awaiting acknowledgement"})`), ...skipped.map((r) => `${r.row.label} (${r.why})`), ...sweep.down.map((m) => `${m.name} (${m.why}: no Pi reachable there)`)];
  if (unreached.length) compact.push({ text: `not reached: ${unreached.join(", ")}`, tone: pending.length ? "warning" : undefined });
  const byMachine = new Map<string, typeof rows>();
  for (const r of own) byMachine.set(`${r.row.machine}\u0000${r.row.revision}`, [...byMachine.get(`${r.row.machine}\u0000${r.row.revision}`) ?? [], r]);
  for (const group of byMachine.values()) compact.push({ text: `${group[0]!.row.machine} on its own checkout (${short(group[0]!.row.revision)}) ${group.filter((r) => r.status === "done").length}/${group.length}` });
  for (const h of sweep.history) compact.push({ text: `${h.machine}: ${h.text}`, ...(h.ok ? {} : { tone: "warning" as const }) });
  if (sweep.note) compact.push({ text: sweep.note, tone: "warning" });

  const lines = rows.map((r) => {
    const ack = r.row.request ? acks.get(r.row.request) : undefined;
    const seen = ack ? `observed ${short(ack.loaded)}${ack.dirty ? "; local changes present (informational)" : ""}` : "";
    return `${r.row.label}@${r.row.machine}: ${r.status}${r.why ? ` (${r.why})` : ""}${r.row.note ? ` · ${r.row.note}` : ""}${seen ? ` · ${seen}` : ""}`;
  });
  for (const m of sweep.down) lines.push(`${m.name}: ${m.why}`);
  const detail = [...lines];
  // Cards written by older callers have no ranFrom.
  if (sweep.ranFrom !== undefined) detail.push(`This sweep ran from the caller's own loaded resources (${short(sweep.ranFrom)}): a caller behind HEAD reloads itself first.`);
  detail.push(
    "Verified = repository HEAD observed at the target's session_start, not byte attestation or command acceptance.",
    "No terminal keys, polling or timers: a not-reached target updates this card when its acknowledgement arrives, and applies the request at its own idle boundary.",
    "an open dialog on a target closes when it reloads",
  );
  return { compact, rows: lines, detail };
}

/** One planned target as the cutover card shows it: its acknowledgement (if any) and derived status. */
export type CutoverRow = { target: CutoverTarget; ack?: ModelAck };
const onOff = (fast: boolean | null) => fast === null ? "unknown" : fast ? "on" : "off";
const choiceText = (choice: { model: string | null; thinking: string | null; fast: boolean | null }) => `${choice.model ?? "unknown model"} · thinking ${choice.thinking ?? "unknown"} · Fast ${onOff(choice.fast)}`;
/** Confirmed only when the observed model, thinking and Fast all equal the planned request; "applied" alone is not equality. */
export function cutoverStatus(ack: ModelAck): { status: "confirmed" | "failed"; why?: string } {
  if (ack.outcome !== "applied" || ack.problems.length) return { status: "failed", why: ack.problems.join("; ") || "request failed" };
  const { requested } = ack.target;
  if (!ack.actual) return { status: "failed", why: "no observed state after the switch" };
  const mismatch = ack.actual.model !== requested.model ? `actual model ${ack.actual.model ?? "unobserved"}, requested ${requested.model}`
    : ack.actual.thinking !== requested.thinking ? `actual thinking ${ack.actual.thinking ?? "unobserved"}, requested ${requested.thinking}`
      : ack.actual.fast !== requested.fast ? `actual Fast ${onOff(ack.actual.fast)}, requested ${onOff(requested.fast)}`
        : undefined;
  return mismatch ? { status: "failed", why: `did not verify: ${mismatch}` } : { status: "confirmed" };
}
/** The card's rows for one operation: every planned target, in plan order, with its own outcome. */
export const cutoverRows = (operation: CutoverOperation, acks: Map<string, ModelAck>): CutoverRow[] =>
  operation.targets.map((target) => ({ target, ack: acks.get(target.terminal) }));
/** Planned targets still pending, failed, confirmed, and whether every one is acknowledged. */
export const settleCutover = (operation: CutoverOperation, acks: Map<string, ModelAck>) => {
  const rows = cutoverRows(operation, acks);
  const statuses = rows.map((row) => (row.ack ? cutoverStatus(row.ack).status : "pending"));
  return { rows, pending: statuses.filter((s) => s === "pending").length, failed: statuses.filter((s) => s === "failed").length, confirmed: statuses.filter((s) => s === "confirmed").length, settled: rows.every((row) => row.ack) };
};
/** Compact segments, the per-target proof lines, and the expanded detail lines for one cutover card. */
export function summaryCutover(operation: CutoverOperation, acks: Map<string, ModelAck>): { compact: Array<{ text: string; tone?: "error" | "warning" }>; rows: string[]; detail: string[] } {
  const { rows, pending, failed, confirmed, settled } = settleCutover(operation, acks);
  const failedRows = rows.flatMap((row) => row.ack && cutoverStatus(row.ack).status === "failed" ? [{ row, why: cutoverStatus(row.ack).why! }] : []);
  const pendingRows = rows.filter((row) => !row.ack);
  const compact: Array<{ text: string; tone?: "error" | "warning" }> = [
    { text: `${confirmed} confirmed` },
    { text: `${pending} pending`, ...(pending ? { tone: "warning" as const } : {}) },
    { text: `${failed} failed`, ...(failed ? { tone: "error" as const } : {}) },
    ...failedRows.map(({ row, why }) => ({ text: `FAILED: ${row.target.label} (${why})`, tone: "error" as const })),
    ...pendingRows.map((row) => ({ text: `pending: ${row.target.label} (no acknowledgement yet)`, tone: "warning" as const })),
  ];
  const lines = rows.map((row) => {
    const requested = `requested ${choiceText(row.target.requested)}`;
    if (!row.ack) return `${row.target.label}: pending · ${requested} · no acknowledgement yet`;
    const { status, why } = cutoverStatus(row.ack);
    const actual = row.ack.actual ? `actual ${choiceText(row.ack.actual)}` : "actual not observed";
    return `${row.target.label}: ${status}${why ? ` (${why})` : ""} · ${requested} · ${actual}${row.ack.request ? ` · request ${row.ack.request}` : ""}`;
  });
  const detail = [...lines,
    `Requested is the caller's exact control; actual is what the target reported running afterwards. They are never folded together, and only an equal actual is confirmed.`,
    `Successes are consumed silently; the first failure of this operation sends one ordinary alert, and every later acknowledgement only updates this card. No polling or timers.`,
    settled ? `Every planned target is acknowledged${operation.completion === "requested" ? " (one settled message was requested)" : ""}.` : `${pending} of ${rows.length} planned target${rows.length === 1 ? "" : "s"} still pending; this card updates when each acknowledgement arrives.`,
  ];
  return { compact, rows: lines, detail };
}
