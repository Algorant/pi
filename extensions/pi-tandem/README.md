# pi-tandem

## Purpose
dedicated extension for [tandem](https://github.com/Algorant/tandem)

## Dependencies
- tandem

## Overview

`pi-tandem` is a thin `execFile` adapter for Tandem plus the `/task` search and capture command. Tandem owns parsing, storage, IDs, hierarchy, workflow, Accord, and rules. The adapter never reads or mutates `.tandem` files.

## Tools

The exact tool surface is `tandem_status`, `tandem_init`, `tandem_read`, `tandem_add`, `tandem_update`, `tandem_accord`, `tandem_review`, `tandem_close`, `tandem_sync`, and `tandem_rules`. Every command sends `--json` and reports Tandem's `ok/data/warnings` envelope. `tandem_status` additionally reports the binary version and nearest Tandem workspace. `tandem_sync` supports `sync`, `sync status`, and `sync resolve <id> --keep local|remote|edited` through CLI argument arrays.

Papercut capture is intentionally not a separate tool. Record small non-blocking friction with `tandem_add action=task`, `priority: low`, `kind: "papercut"`, and at least one acceptance criterion.

Arguments are passed as arrays to `execFile` (`tandem_add` puts the title last, after `--`, so a title starting with `-` is not read as a flag); no shell command strings or protocol compatibility shims are used. Read filtering is delegated to Tandem. Use `location` to distinguish active Board records from archived Logs.

## Independent board sync

Tandem 0.15 stores the board on its own `tandem` branch and performs board fetch, merge, and push itself. Mutations return `data.sync` with status, message, renamed temporary IDs, conflicts, and held edits. `pending` means the change is saved locally and awaiting publication; it is not a mutation failure. New records may temporarily use IDs such as `task-new-3f9a2c1d`, and those IDs continue to work after numbering.

Use `tandem_sync` for `sync`, local/no-network `sync status`, and `sync resolve <id> --keep local|remote|edited`. Surface conflicts and held edits to Algorant; resolve only with `tandem sync resolve` when authorized. Linked worktrees have no `.tandem/`; Tandem commands there use the main worktree's board.

Never stage, commit, push, edit, delete, or rename `.tandem/` or the `tandem` branch. Source Git push is independent of board synchronization; do not require `.tandem/` to be clean.

## /task

`/task` has two entrypoints, both interactive-UI only, both adding **no LLM-callable tool**:

- `/task` (no argument) opens a read-only search over existing Tasks on every local board.
- `/task <sentence>` proposes a new Task for review on one board (capture).

Both discover boards the same way (see [Boards](#boards)), once per invocation.

### /task: search existing Tasks

`/task` opens a centred overlay that lists the **active** Tasks (Board scope, as in `tandem tui`; archived Logs are not searched) of the current board and every discovered local board. The scope line names each searched board. Each hit is prefixed with its board, `board / task-id · title`, and keeps that board's cwd: its detail is read with `tandem show` from that board, so equal Task IDs on different projects never resolve against the caller's board. Type to filter: every word must appear in the board name, Task ID or title, and `board/task-id` also matches (`home/task-8`). `↑↓` choose, Enter opens the selected Task read-only (board and cwd shown first; `↑↓` scroll, `Esc` back to the results), `Esc` closes.

Search only runs `hc ls`, `tandem list --type task` and `tandem show`. It makes no classifier or provider call, puts nothing in the composer, sends no message, and creates, claims or changes nothing. Boards without a `description:` line are still searched. A board whose list fails is named with its error; the others still show. A discovery failure is shown as an error, with no fallback discovery.

### /task \<sentence\>: propose a Task for review

`/task <sentence>` opens a centred review overlay immediately and returns control to the running agent. The proposal stays unfiled until explicit `f` confirmation. It is a module of pi-tandem (`task/`, registered from the extension's entry point) and adds one slash command and **no LLM-callable tool**. Every Tandem call uses pi-tandem's `tandemJson` adapter and exported argument builders; Ceph messages use pi-agency's existing agent-inbox path to the Ceph's HC `terminal`.

The review card shows the unfiled title, details, acceptance criterion, selected board and why, kind, Jev route confidence, and possible duplicates. `b` chooses a board, `k` chooses task/papercut/research, `e` edits title/details/acceptance (`Ctrl+S` saves to the draft), and `o` opens the selected duplicate read-only. `Esc` cancels the proposal; within an editor, chooser, or preview it backs out one level. Only `f` files, and only in the review card when all checks are ready (never inside an editor, chooser, or preview). Ordinary Enter never confirms filing. `Ctrl+Enter` is not used: terminals such as Ghostty bind it (fullscreen), so it may never reach Pi.

Opening, routing, editing, changing board/kind, and duplicate checks add no Task and send no Ceph message. Board/kind choices made explicitly by the user remain selected across content edits. Changed content and board selections refresh relevant routing/duplicate checks. Pending checks disable filing, and early confirmation keys are not buffered. Cancellation aborts pending work and late results cannot file or reopen the overlay. One focused proposal/receipt is allowed; another `/task` invocation preserves it and asks the user to finish or cancel first. This is an in-flight UI ownership rule, not a sentence/time repeat cache. There is no timeout or content repeat guard.

After confirmation, the overlay shows `Filing…` and accepts no second filing. Success becomes a persistent receipt with the actual Task ID, board, kind, and Ceph notification outcome. `o` opens the filed Task read-only; Enter/Esc dismisses the receipt without cancelling the Task. Filing errors remain visible on the draft. No post-filing move or duplicate-cancellation actions are provided; use ordinary Tandem workflow to change a filed Task.

### Boards

Boards are discovered once per `/task` invocation; nothing is polled, saved or kept in a registry. The session's own board is always first.

- **Native HC** (`HC_TERMINAL_ID` set): one `hc ls --json` snapshot, the same policy as Herdra's `bin/herdra-tui`. A board is a live local terminal (address without `/`, so other machines are excluded) whose `where` ends in ` / main`, the Ceph's place in its space, and whose cwd holds `.tandem`; one board per real cwd. The board is named for its space and its Ceph is that terminal. The current board is named for this session's space; a linked worktree counts as its main worktree's board, so it is not listed twice. A failed `hc ls` is an error.
- **Outside HC**: only the current board.

### Board and kind inference

Capture offers the discovered boards that have a description; the current board is always offered. Each board's description is the deliberate `description:` front-matter line at the top of `VISION.md`, or `README.md` when there is no VISION. File names match case-insensitively. A VISION file without the line is not replaced by README; the missing description path is shown instead.

One Jev call (`typesafe/jev-latest`) chooses among available boards (another board requires confidence ≥0.60) and, unless keyword-overridden, the kind. A leading `papercut:`, `research:` or `task:` sets kind and is stripped from the title; otherwise exactly one of the words “papercut” or “research” sets kind. Duplicate checking reads active Tasks on the selected board and uses Jev to identify possible matches. The standard acceptance criterion is used initially.

### Failures and capture log

Discovery, classifier, list, duplicate-check, add, preview, and Ceph-notice errors are shown in the proposal/receipt; no fallback board, automatic filing, or silent retry is used. An add error is treated as an uncertain outcome: that proposal cannot submit again until the board is checked, so a possibly successful add is not blindly duplicated. The local append-only `<agentDir>/state/task-capture.jsonl` log records confirmed filings and failures; it is untracked machine state.

### Known limits

Only local boards are offered or searched; other machines are not. A board is found only while a terminal sits in its space's `main` tab. A Worker's linked worktree has no `.tandem/`, so its own board is the main worktree's, named for the Worker's space. Search filters active Task IDs and titles only; it does not search bodies or archived Logs.

## Maintenance

Use direct handoff/source verification and live end-to-end checks. Do not create unit tests or an orchestration test harness.
