import { createBoxedToolRenderer } from "../core/card";
import { joinTitleParts, section, statusIcon, toolName, truncatePlain } from "../core/text";
import type { BoxedToolRenderInput, ToolUiBoxModel, ToolUiTone } from "../core/types";
import type { ManageTodoListInput, TodoDetails, TodoItem } from "../../../pi-todos/state";
import { todoGlyphCountsRow, todoItemLines, todoSummary } from "../../../pi-todos/view";

export type { ManageTodoListInput, TodoDetails, TodoItem } from "../../../pi-todos/state";

/**
 * `manage_todo_list` card: one summary line while collapsed
 * (`✓ todos · wrote 5 · 2 in progress · 1 next · 1 waiting · 1 done`), a glyph
 * count row as the body line the way the Bash card carries its command, the
 * same glyph list as the widget when expanded, and the write failure in an
 * error section through the usual renderer path.
 */
export function createManageTodoListRenderer() {
  return createBoxedToolRenderer<ManageTodoListInput, TodoDetails | undefined>(buildTodoBox);
}

function buildTodoBox({ args, result, options, theme, text, pending, error }: BoxedToolRenderInput<ManageTodoListInput, TodoDetails | undefined>): ToolUiBoxModel {
  const details = result?.details;
  const operation = details?.operation ?? args.operation ?? "write";
  const todos = todoList(details, args);
  const tone: ToolUiTone = error ? "error" : pending ? "pending" : "success";
  const title = `${statusIcon(theme, tone)} ${toolName(theme, "todos")}`;

  if (error) {
    const message = (details?.error || text || "Todo write failed.").trim();
    const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
    const shown = options.expanded ? lines : [truncatePlain(message, 240)];
    return {
      title,
      status: `${operation} failed`,
      tone,
      body: todos.length > 0 ? [theme.fg("muted", `current · ${todoSummary(todos)}`)] : undefined,
      sections: [{ title: "Error", lines: shown.map((line) => theme.fg("error", truncatePlain(line, options.expanded ? 1200 : 240))), wrap: options.expanded }],
    };
  }

  return {
    title,
    status: pending
      ? `${operation}…`
      : joinTitleParts([`${operation === "read" ? "read" : "wrote"} ${todos.length}`, todoSummary(todos)]),
    tone,
    body: [todoGlyphCountsRow(todos, theme) || theme.fg("muted", "no todos")],
    sections: options.expanded ? [section("todos", todoItemLines(todos, theme, { indent: "" }))] : [],
  };
}

function todoList(details: TodoDetails | undefined, args: ManageTodoListInput): TodoItem[] {
  if (Array.isArray(details?.todos)) return details.todos;
  return Array.isArray(args.todoList) ? args.todoList : [];
}
