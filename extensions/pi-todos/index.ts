/**
 * Local clone of manage_todo_list.
 *
 * Based on manage_todo_list by tintinweb:
 * https://github.com/tintinweb/pi-manage-todo-list
 */

import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { registerWidgetSection, requestWidgetLayoutRender, unregisterWidgetSection } from "../pi-ui/widget-layout";
import { Type } from "typebox";
import {
  applyTodoEntry,
  type ManageTodoListInput,
  type TodoDetails,
  type TodoItem,
  type TodoStatus,
} from "./state";

const WIDGET_ID = "pi-todos";

const STATUS_ICONS: Record<TodoStatus, string> = {
  completed: "✓",
  "in-progress": "◉",
  "not-started": "○",
};

function stringEnum(values: readonly string[], options?: Record<string, unknown>) {
  return Type.Union(values.map((value) => Type.Literal(value)) as any, options);
}

const TodoItemSchema = Type.Object({
  id: Type.Number({ description: "Unique identifier for the todo. Use sequential numbers starting from 1." }),
  title: Type.String({ description: "Concise action-oriented todo label. Displayed in UI." }),
  description: Type.String({ description: "Detailed context, requirements, implementation notes, or acceptance criteria." }),
  status: stringEnum(["not-started", "in-progress", "completed"] as const, {
    description: "not-started: Not begun | in-progress: Currently working | completed: Fully finished",
  }),
});

const ManageTodoListParams = Type.Object({
  operation: stringEnum(["write", "read"] as const, {
    description: "write: Replace entire todo list. read: Retrieve current todo list. Always provide the complete list when writing.",
  }),
  todoList: Type.Optional(Type.Array(TodoItemSchema, {
    description: "Complete array of all todo items. Required for write; ignored for read.",
  })),
});

const TOOL_DESCRIPTION = "Read or replace the structured todo list.";

class TodoState {
  private todos: TodoItem[] = [];

  read(): TodoItem[] {
    return this.todos.map((todo) => ({ ...todo }));
  }

  write(todos: TodoItem[]): void {
    this.todos = todos.map((todo) => ({ ...todo }));
  }

  clear(): void {
    this.todos = [];
  }

  stats() {
    return {
      total: this.todos.length,
      completed: this.todos.filter((todo) => todo.status === "completed").length,
    };
  }

  validate(todos: TodoItem[]): string[] {
    const errors: string[] = [];
    const ids = new Set<number>();
    for (const [index, todo] of todos.entries()) {
      if (!Number.isFinite(todo.id)) errors.push(`Item ${index + 1}: id must be a number`);
      if (ids.has(todo.id)) errors.push(`Duplicate id: ${todo.id}`);
      ids.add(todo.id);
      if (!todo.title?.trim()) errors.push(`Item ${todo.id}: title is required`);
      if (!todo.description?.trim()) errors.push(`Item ${todo.id}: description is required`);
      if (!["not-started", "in-progress", "completed"].includes(todo.status)) {
        errors.push(`Item ${todo.id}: invalid status ${todo.status}`);
      }
    }
    return errors;
  }

  loadFromSession(ctx: ExtensionContext): void {
    let todos: TodoItem[] | undefined = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      todos = applyTodoEntry(todos, entry);
    }
    this.write(todos ?? []);
  }
}

function renderTodoWidgetLines(state: TodoState, theme: any, width: number): string[] {
  const todos = state.read();
  if (todos.length === 0) return [];

  const stats = state.stats();
  const lines = [
    theme.fg("accent", " Todo List ") + theme.fg("muted", `— ${stats.completed}/${stats.total} completed`),
  ];

  for (const todo of todos) {
    const icon = STATUS_ICONS[todo.status] ?? "○";
    const id = theme.fg("accent", `${todo.id}.`);
    const title = todo.status === "completed"
      ? theme.fg("dim", theme.strikethrough(todo.title))
      : todo.status === "in-progress"
        ? theme.fg("warning", todo.title)
        : todo.title;
    lines.push(`  ${icon} ${id} ${title}`);
  }

  return lines.map((line) => truncateToWidth(line, width));
}

function persistClearedState(ctx: ExtensionContext): void {
  const appendCustomEntry = (ctx.sessionManager as ExtensionContext["sessionManager"] & {
    appendCustomEntry?: (customType: string, data?: unknown) => unknown;
  }).appendCustomEntry;
  if (typeof appendCustomEntry !== "function") return;
  try {
    // A custom entry is not sent to the model as an orphaned tool result. The
    // marker remains in the branch so a reload reconstructs the explicit clear.
    appendCustomEntry.call(ctx.sessionManager, "pi-todos:clear", { operation: "write", todos: [] });
  } catch {
    // A read-only or legacy session manager may not accept extension entries.
    // The in-memory clear still takes effect for the current runtime.
  }
}

function updateWidget(state: TodoState, ctx: { ui: ExtensionContext["ui"] }): void {
  registerWidgetSection(ctx, {
    id: WIDGET_ID,
    order: 200,
    visible: () => state.read().length > 0,
    render: ({ theme, width }) => renderTodoWidgetLines(state, theme, width),
  });
  requestWidgetLayoutRender(ctx);
}

function createTool(state: TodoState, onUpdate: (ctx: ExtensionContext) => void) {
  return {
    name: "manage_todo_list",
    exposure: "codemode",
    label: "Todo List",
    description: TOOL_DESCRIPTION,
    parameters: ManageTodoListParams,

    async execute(
      _toolCallId: string,
      params: ManageTodoListInput,
      _signal: AbortSignal | undefined,
      _onStreamUpdate: AgentToolUpdateCallback<TodoDetails | undefined> | undefined,
      ctx: ExtensionContext,
    ) {
      if (params.operation === "read") {
        const todos = state.read();
        return {
          content: [{ type: "text" as const, text: todos.length ? JSON.stringify(todos, null, 2) : "No todos." }],
          details: { operation: "read", todos } satisfies TodoDetails,
        };
      }

      const todoList = params.todoList;
      if (!todoList || !Array.isArray(todoList)) {
        throw new Error("Error: todoList is required for write operation.");
      }

      const errors = state.validate(todoList as TodoItem[]);
      if (errors.length > 0) {
        throw new Error(`Validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}`);
      }

      state.write(todoList as TodoItem[]);
      onUpdate(ctx);

      const stats = state.stats();
      let message = `Todos have been modified successfully. ${stats.completed}/${stats.total} completed. Continue using the todo list to track progress.`;
      if (todoList.length < 3) message += "\n\nWarning: Small todo list (<3 items). This task might not need a todo list.";

      return {
        content: [{ type: "text" as const, text: message }],
        details: { operation: "write", todos: state.read() } satisfies TodoDetails,
      };
    },
  };
}

export default function piTodos(pi: ExtensionAPI) {
  const state = new TodoState();

  function scheduleUpdateWidget(ctx: { ui: ExtensionContext["ui"] }): void {
    const timer = setTimeout(() => {
      try {
        updateWidget(state, ctx);
      } catch {
        // The context may become stale during /reload or session replacement.
      }
    }, 0);
    (timer as { unref?: () => void }).unref?.();
  }

  function reconstruct(ctx: ExtensionContext) {
    state.loadFromSession(ctx);
    scheduleUpdateWidget(ctx);
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    unregisterWidgetSection(ctx, WIDGET_ID);
  });
  pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
  pi.on("turn_end", async (_event, ctx) => { scheduleUpdateWidget(ctx); });

  pi.registerTool(createTool(state, scheduleUpdateWidget));

  pi.registerCommand("todos", {
    description: "Show or clear todo list widget (/todos clear)",
    handler: async (args, ctx) => {
      if ((args ?? "").trim().toLowerCase() === "clear") {
        state.clear();
        persistClearedState(ctx);
        unregisterWidgetSection(ctx, WIDGET_ID);
        ctx.ui.notify("Todo list cleared.", "info");
        return;
      }
      const stats = state.stats();
      updateWidget(state, ctx);
      ctx.ui.notify(stats.total === 0 ? "No todos." : `${stats.completed}/${stats.total} todos completed.`, "info");
    },
  });
}
