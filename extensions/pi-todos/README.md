# pi-todos

## Purpose
a small todo list for the current session

## Dependencies
None.

## Overview

Adds the `manage_todo_list` tool, a compact todo widget for multi-step agent work, and the tool's call card.

## Components
- `index.ts` owns todo state reconstruction, validation, widget updates, and `/todos`.
- `state.ts` owns the item/status types and the session-entry projection; `TODO_STATUSES` is the one status list the tool schema and validation use.
- `view.ts` owns how a list looks: the status glyphs, the counts summary, and the item lines. The widget and the tool card render through it, so they cannot drift apart.
- Todo state is persisted through normal Pi tool result details in the session history.

## How to use
The agent should create or update the full todo list for meaningful multi-step tasks. Use `/todos` to show status or `/todos clear` to clear the widget.

## Examples
A typical list has sequential ids, concise titles, detailed descriptions, and statuses of `not-started`, `in-progress`, `waiting`, or `completed`. More than one item may be in progress; `waiting` means the item is blocked on someone or something else.

## Presentation

The widget shows one header line (`todos · 2 in progress · 1 next · 1 waiting · 1 done`, zero counts left out) and one row per item with a coloured glyph and no status words:

| status | glyph | style |
| --- | --- | --- |
| `in-progress` | `●` | accent |
| `not-started` | `○` | plain |
| `waiting` | `◌` | muted |
| `completed` | `✓` | dim, title struck through |

The `manage_todo_list` card in `pi-ui` folds to the same counts on one line (`wrote 5 · 2 in progress · 1 next · 1 waiting · 1 done`) over one body line of glyph counts (`● 2  ○ 1  ◌ 1  ✓ 1`, the way the Bash card carries its command), shows the same glyph list when expanded, and renders a failed write as an error section. `pi-ui`'s widget layout adds one blank line between the widget area and the editor.

## Notes
Avoid using this for trivial one-step requests; the extension intentionally requires whole-list writes instead of partial patches.

Todo state is an ephemeral projection reconstructed only from `manage_todo_list` tool results in the active Pi session. pi-todos does not parse Tandem documents, invoke Tandem, mutate task/accord lifecycle, or serve as project source of truth. The orchestrator may generate a Tandem-context-rich list for the one tracked worker that owns a Task's direct-Subtask campaign, but the worker supplies that ordinary list through the same tool boundary and Tandem remains authoritative. Completing projected items never completes Subtasks; the parent reconciles the campaign's single root settlement.
