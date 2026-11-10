import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable } from "@earendil-works/pi-tui";

/**
 * `/inbox` overlay (task-395, option A): Open, Recent and Thread tabs over the
 * transcript. The pi-agency inbox owns the data and the close action; this file
 * only draws and handles keys, so nothing lands in the transcript.
 */
export type InboxRow = {
  id: string;
  kind: string;
  at: string;
  from: string;
  to: string;
  headline: string;
  body: string;
  replyTo: string | null;
  replies: string[];
  closed?: { at: string; note: string };
  failed?: string;
};

export type InboxSource = {
  open(): InboxRow[];
  recent(): InboxRow[];
  thread(id: string): InboxRow[];
  close(id: string, note: string): void;
  age(iso: string): string;
};

type Tab = "open" | "recent" | "thread";
const TABS: Tab[] = ["open", "recent", "thread"];

export class InboxOverlay implements Focusable {
  focused = false;
  private tab: Tab = "open";
  private selected: Record<"open" | "recent", number> = { open: 0, recent: 0 };
  private threadId?: string;
  private threadScroll = 0;
  private closing?: { id: string; note: string };
  private notice?: string;

  constructor(
    private readonly theme: Theme,
    private readonly source: InboxSource,
    private readonly rows: () => number,
    private readonly requestRender: () => void,
    private readonly done: () => void,
  ) {}

  handleInput(data: string): void {
    if (this.closing) return this.closeInput(data);
    this.notice = undefined;
    if (matchesKey(data, "escape")) {
      if (this.tab === "thread") this.tab = this.threadOrigin;
      else return this.done();
    } else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.switchTab(1);
    } else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.switchTab(-1);
    } else if (matchesKey(data, "up")) {
      this.move(-1);
    } else if (matchesKey(data, "down")) {
      this.move(1);
    } else if (matchesKey(data, "return")) {
      const row = this.current();
      if (row && this.tab !== "thread") this.openThread(row.id);
    } else if (data === "c") {
      const id = this.tab === "thread" ? this.threadId : this.current()?.id;
      if (id) this.closing = { id, note: "" };
    } else if (data === "q") {
      return this.done();
    }
    this.requestRender();
  }

  private threadOrigin: "open" | "recent" = "open";

  private openThread(id: string): void {
    this.threadOrigin = this.tab === "recent" ? "recent" : "open";
    this.threadId = id;
    this.threadScroll = 0;
    this.tab = "thread";
  }

  private switchTab(step: number): void {
    const tabs = this.threadId ? TABS : TABS.slice(0, 2);
    const index = (tabs.indexOf(this.tab) + step + tabs.length) % tabs.length;
    this.tab = tabs[index]!;
  }

  private list(): InboxRow[] {
    return this.tab === "recent" ? this.source.recent() : this.source.open();
  }

  private current(): InboxRow | undefined {
    if (this.tab === "thread") return undefined;
    const list = this.list();
    return list[Math.min(this.selected[this.tab], list.length - 1)];
  }

  private move(step: number): void {
    if (this.tab === "thread") {
      this.threadScroll = Math.max(0, this.threadScroll + step);
      return;
    }
    const length = this.list().length;
    this.selected[this.tab] = Math.max(0, Math.min(length - 1, this.selected[this.tab] + step));
  }

  private closeInput(data: string): void {
    const closing = this.closing!;
    if (matchesKey(data, "escape")) {
      this.closing = undefined;
    } else if (matchesKey(data, "return")) {
      if (closing.note.trim()) {
        this.source.close(closing.id, closing.note.trim());
        this.notice = `Closed ${closing.id}.`;
        this.closing = undefined;
      }
    } else if (matchesKey(data, "backspace")) {
      closing.note = closing.note.slice(0, -1);
    } else if (data.length >= 1 && !data.startsWith("\x1b") && [...data].every((ch) => ch >= " ")) {
      closing.note += data;
    }
    this.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.theme;
    const inner = Math.max(20, width - 4);
    const height = Math.max(8, Math.floor(this.rows() * 0.8) - 4);
    const open = this.source.open();
    const body = this.tab === "thread" ? this.threadLines(inner) : this.listLines(this.list(), inner, height);
    const visible = this.tab === "thread" ? this.scrollWindow(body, height) : body;

    const tabs = TABS.filter((t) => t !== "thread" || this.threadId).map((t) => {
      const label = t === "open" ? `Open ${open.length}` : t === "recent" ? "Recent" : "Thread";
      return t === this.tab ? th.bold(th.fg("accent", ` ${label} `)) : th.fg("muted", ` ${label} `);
    }).join(th.fg("muted", "│"));
    const title = `${th.bold(th.fg("accent", "✉ Inbox"))}${this.tab === "thread" && this.threadId ? th.fg("muted", ` · thread ${this.threadId}`) : ""}`;
    const footer = this.closing
      ? `${th.fg("warning", `Close ${this.closing.id} — note:`)} ${this.closing.note}${th.fg("accent", "▏")}  ${th.fg("dim", "enter confirm · esc cancel")}`
      : this.notice
        ? th.fg("success", this.notice)
        : th.fg("dim", this.tab === "thread"
          ? "↑↓ scroll · c close · tab switch · esc back"
          : "↑↓ select · enter thread · c close · tab switch · esc exit");

    const border = (s: string) => th.fg("muted", s);
    const row = (content: string) => `${border("│ ")}${pad(truncateToWidth(content, inner, "…"), inner)}${border(" │")}`;
    const top = `╭─ ${title} `;
    const right = ` ${tabs} ─╮`;
    const fill = Math.max(0, width - visibleWidth(top) - visibleWidth(right));
    return [
      `${border("╭─ ")}${title} ${border("─".repeat(fill))}${border(" ")}${tabs}${border(" ─╮")}`,
      row(""),
      ...visible.map(row),
      row(""),
      row(footer),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }

  private kind(kind: string): string {
    const tone = kind === "blocked" ? "warning" : kind === "result" ? "accent" : "dim";
    return this.theme.fg(tone as any, pad(kind, 7));
  }

  private listLines(list: InboxRow[], inner: number, height: number): string[] {
    const th = this.theme;
    if (list.length === 0) return [th.fg("muted", this.tab === "open" ? "No unanswered requests." : "No messages in the local log.")];
    const selected = Math.min(this.selected[this.tab as "open" | "recent"], list.length - 1);
    const start = Math.max(0, Math.min(selected - Math.floor(height / 2), list.length - height));
    return list.slice(start, start + height).map((m, i) => {
      const isSelected = start + i === selected;
      const dot = th.fg(m.kind === "blocked" ? "warning" : "accent", m.closed || m.failed ? "○" : "●");
      const state = m.failed ? th.fg("error", " ✗ not delivered") : m.closed ? th.fg("muted", " · closed") : m.replies.length ? th.fg("success", " ✓") : "";
      const reply = m.replyTo ? th.fg("mdLink", ` ↩ ${m.replyTo}`) : "";
      const line = `${isSelected ? th.fg("accent", "▶") : " "} ${dot} ${th.fg("dim", m.id)}  ${this.kind(m.kind)} ${th.fg("text", m.from)} ${th.fg("muted", "→")} ${th.fg("text", pad(m.to, 14))} ${th.fg("muted", pad(this.source.age(m.at), 4))} ${isSelected ? th.fg("text", m.headline) : th.fg("muted", m.headline)}${reply}${state}`;
      return truncateToWidth(line, inner, "…");
    });
  }

  private threadLines(inner: number): string[] {
    const th = this.theme;
    const messages = this.threadId ? this.source.thread(this.threadId) : [];
    if (messages.length === 0) return [th.fg("muted", `No thread for ${this.threadId}.`)];
    const out: string[] = [];
    for (const m of messages) {
      const time = new Date(m.at).toTimeString().slice(0, 5);
      const reply = m.replyTo ? th.fg("mdLink", `  ↩ ${m.replyTo}`) : "";
      const state = m.failed ? th.fg("error", `  ✗ not delivered: ${m.failed}`) : m.closed ? th.fg("muted", `  closed: ${m.closed.note}`) : m.replies.length ? th.fg("success", "  ✓ answered") : "";
      out.push(`${th.fg("muted", time)}  ${th.fg("dim", m.id)}  ${this.kind(m.kind)} ${th.fg("text", m.from)} ${th.fg("muted", "→")} ${th.fg("text", m.to)}${reply}${state}`);
      for (const line of m.body.split("\n")) out.push(...wrapTextWithAnsi(th.fg("text", line), inner - 7).map((w) => `       ${w}`));
      out.push("");
    }
    return out;
  }

  private scrollWindow(lines: string[], height: number): string[] {
    this.threadScroll = Math.min(this.threadScroll, Math.max(0, lines.length - height));
    return lines.slice(this.threadScroll, this.threadScroll + height);
  }
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
