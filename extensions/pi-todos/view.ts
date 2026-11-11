import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { TodoItem, TodoStatus } from "./state";

/**
 * One glyph per status, and the only status signal beside an item: no status
 * words appear next to a row. The widget and the tool card both render through
 * this module so they cannot drift apart.
 */
export const TODO_GLYPHS: Record<TodoStatus, string> = {
  "in-progress": "●",
  "not-started": "○",
  completed: "✓",
  waiting: "◌",
};

type TodoCounts = {
  total: number;
  inProgress: number;
  next: number;
  waiting: number;
  done: number;
};

export function todoCounts(todos: TodoItem[]): TodoCounts {
  const counts: TodoCounts = { total: todos.length, inProgress: 0, next: 0, waiting: 0, done: 0 };
  for (const todo of todos) {
    if (todo.status === "in-progress") counts.inProgress += 1;
    else if (todo.status === "completed") counts.done += 1;
    else if (todo.status === "waiting") counts.waiting += 1;
    else counts.next += 1;
  }
  return counts;
}

/** `2 in progress · 1 next · 1 waiting · 1 done`, with zero counts left out. */
export function todoSummary(todos: TodoItem[]): string {
  const counts = todoCounts(todos);
  if (counts.total === 0) return "no todos";
  return [
    counts.inProgress > 0 ? `${counts.inProgress} in progress` : undefined,
    counts.next > 0 ? `${counts.next} next` : undefined,
    counts.waiting > 0 ? `${counts.waiting} waiting` : undefined,
    counts.done > 0 ? `${counts.done} done` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function glyph(theme: Theme, status: TodoStatus): string {
  const mark = TODO_GLYPHS[status] ?? "○";
  if (status === "in-progress") return theme.fg("accent", mark);
  if (status === "completed") return theme.fg("dim", mark);
  if (status === "waiting") return theme.fg("muted", mark);
  return mark;
}

function title(theme: Theme, todo: TodoItem): string {
  return todo.status === "completed" ? theme.fg("dim", theme.strikethrough(todo.title)) : todo.title;
}

export function todoItemLines(todos: TodoItem[], theme: Theme, options: { width?: number; indent?: string } = {}): string[] {
  const indent = options.indent ?? "  ";
  const lines = todos.map((todo) => `${indent}${glyph(theme, todo.status)} ${title(theme, todo)}`);
  if (options.width === undefined) return lines;
  const width = options.width;
  return lines.map((line) => truncateToWidth(line, width));
}

/** The list's header line: an accent `todos` label and the status counts. */
export function todoHeaderLine(todos: TodoItem[], theme: Theme, width?: number): string {
  const line = `${theme.bold(theme.fg("accent", "todos"))}${theme.fg("muted", ` · ${todoSummary(todos)}`)}`;
  return width === undefined ? line : truncateToWidth(line, width);
}

/**
 * `● 2  ○ 1  ◌ 1  ✓ 1`, the same glyph vocabulary as the rows with zero counts
 * left out: the one body line of the card, the way the Bash card carries its
 * command.
 */
export function todoGlyphCountsRow(todos: TodoItem[], theme: Theme): string {
  const counts = todoCounts(todos);
  return [
    counts.inProgress > 0 ? `${theme.fg("accent", TODO_GLYPHS["in-progress"])} ${counts.inProgress}` : undefined,
    counts.next > 0 ? `${TODO_GLYPHS["not-started"]} ${counts.next}` : undefined,
    counts.waiting > 0 ? `${theme.fg("muted", TODO_GLYPHS.waiting)} ${counts.waiting}` : undefined,
    counts.done > 0 ? `${theme.fg("dim", TODO_GLYPHS.completed)} ${counts.done}` : undefined,
  ].filter((part): part is string => Boolean(part)).join("  ");
}
