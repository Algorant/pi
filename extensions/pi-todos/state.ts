export type TodoStatus = "not-started" | "in-progress" | "completed";

export type TodoItem = {
  id: number;
  title: string;
  description: string;
  status: TodoStatus;
};

export type TodoDetails = {
  operation: "read" | "write";
  todos: TodoItem[];
  error?: string;
};

export type ManageTodoListInput = {
  operation: "write" | "read";
  todoList?: TodoItem[];
};

type SessionEntry = {
  type?: unknown;
  customType?: unknown;
  message?: {
    role?: unknown;
    toolName?: unknown;
    details?: unknown;
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Apply one session entry to the current todo projection. `undefined` means no
 * authoritative todo event has been observed in the entries considered so far;
 * an empty array is an explicit empty state, including after a clear marker.
 */
export function applyTodoEntry(current: TodoItem[] | undefined, value: unknown): TodoItem[] | undefined {
  const entry = record(value) as SessionEntry | undefined;
  if (!entry) return current;

  if (entry.type === "custom" && entry.customType === "pi-todos:clear") return [];
  const message = entry.type === "message" ? entry.message : undefined;
  if (message?.role !== "toolResult" || message.toolName !== "manage_todo_list") return current;

  const details = record(message.details);
  if (!Array.isArray(details?.todos)) return current;
  return (details.todos as TodoItem[]).map((todo) => ({ ...todo }));
}
