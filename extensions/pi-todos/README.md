# pi-todos

## Purpose
a small todo list for the current session

## Dependencies
None.

## Overview

Adds the `manage_todo_list` tool and a compact todo widget for multi-step agent work.

## Components
- `index.ts` owns todo state reconstruction, validation, widget updates, and `/todos`.
- Todo state is persisted through normal Pi tool result details in the session history.

## How to use
The agent should create or update the full todo list for meaningful multi-step tasks. Use `/todos` to show status or `/todos clear` to clear the widget.

## Examples
A typical list has sequential ids, concise titles, detailed descriptions, and statuses of `not-started`, `in-progress`, or `completed`.

## Notes
Avoid using this for trivial one-step requests; the extension intentionally requires whole-list writes instead of partial patches.

Todo state is an ephemeral projection reconstructed only from `manage_todo_list` tool results in the active Pi session. pi-todos does not parse Tandem documents, invoke Tandem, mutate task/accord lifecycle, or serve as project source of truth. The orchestrator may generate a Tandem-context-rich list for the one tracked worker that owns a Task's direct-Subtask campaign, but the worker supplies that ordinary list through the same tool boundary and Tandem remains authoritative. Completing projected items never completes Subtasks; the parent reconciles the campaign's single root settlement.
