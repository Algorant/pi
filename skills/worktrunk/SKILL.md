---
name: worktrunk
description: Safely inspect and operate worktrunk-managed git checkouts. Use for `wt`, worktree lifecycle, hook approval, or worktrunk/herdr coordination.
metadata:
  short-description: Safe Worktrunk checkout operations
---

# Worktrunk

Worktrunk is the explicit Git checkout integration and cleanup authority in
this setup; hc and the Herdr app own terminals and presentation. Use this
skill when a task involves a Worktrunk-managed repository or the `wt` CLI. Keep this guidance small: use `wt --help`, `wt <command> --help`, and
[worktrunk.dev](https://worktrunk.dev) for command details.

## Authority boundary

| System | Owns | Does not authorize |
| --- | --- | --- |
| **Worktrunk** | Worktree/branch switching, explicit merging, removal, hooks, and hook approvals | Tandem task state or Herdr agent ownership |
| **hc / Herdr app** | Native terminal identity, parent/child lifetime and presentation | Worktrunk checkout/hooks or Tandem workflow |
| **Pi and Workers** | Validated orchestration, Task execution, and the delegation/session bridge | Reimplementing Worktrunk or hc lifecycle policy |
| **Tandem** | Task, accord, review, and delivery workflow | Proof that a branch is safe to merge or remove |

## Host boundary

Under `HC_TERMINAL_ID`, an owned-worktree manus starts with `manus_start {worktree: true}`, which runs `wt switch --create <label slug> --no-cd` under the normal hook approval. A Task-backed or Task-free Worker uses `dendra_start {kind: worker}`, with exactly taskId OR brief, which owns `wt switch --create --base @ --no-cd` and Worktrunk's approved creation lifecycle before starting its native HC child. Worktrees default on; explicit `worktree:false` skips creation, refuses another active worktree-less Worker on that captured checkout, and retains shared checkout/branch on finish/discard (no merge/removal). Native Worker guidance lives in `agency` and [pi-hc](../../extensions/pi-hc/README.md#native-workers-m3).

## Inspect first

From the repository or an explicit repository path, establish the checkout and
configuration before changing anything:

```bash
wt list
wt config show
git rev-parse --show-toplevel
git status --short --branch
```

Use `wt list` to identify Worktrunk-managed worktrees and their status. Use
`wt config show` to see the effective user/project configuration and whether
shell integration is active. When more detail is needed, use `wt list --help`,
`wt switch --help`, `wt merge --help`, or `wt remove --help` rather than
assuming flags or paths.

## Pi shell cwd

A Pi shell command does **not** persist `cd` into later tool calls. In
particular, `wt switch` cannot move the Pi process into another checkout.

- Run commands in the intended checkout explicitly: `cd /path/to/worktree && <command>`.
- Or direct Worktrunk explicitly: `wt -C /path/to/repo list`.
- After a switch/create request, inspect the result and use its reported path
  in later commands; do not assume the next shell call uses it.
- Do not change branches in place to imitate a Worktrunk switch. Let `wt`
  create or select the checkout when lifecycle work has been authorized.

## Lifecycle safety

`wt switch` creates/selects checkouts; `wt merge` integrates and normally
removes the source checkout; the Worker finish bridge deliberately uses
`wt merge --no-remove`, closes the captured native terminal, then calls
foreground `wt remove` for the captured branch. `wt remove` can delete a
checkout and branch. These are consequential operations.

- Inspect first, preserve uncommitted work, and follow the repository's
  instructions and assigned role.
- Board sync (the `tandem` branch, linked worktrees, conflicts, `.tandem/`) is
  independent of source Git and Worktrunk integration; its rules are in the
  `tandem` skill.
- A Worker works only in its owned checkout. It must not merge, remove a
  worktree, delete branches, or clean up its worktree; report evidence to its
  parent.
- An orchestrator or human decides whether to create, finish, or dispose.
  `worker_finish` confirms the current scope/evidence, integrates once, records
  the accepted git/inbox outcome and any linked Tandem outcome, closes its captured terminal/presentation before removal, and preserves a
  minimal receipt for retrying only an unfinished disposal step. For a Worker whose Pi runtime crashed, `worker_finish` with `crashSummary` runs the same sequence without a typed ready report. Confirm the
  target, diff, project-required validation, and Worktrunk's own safety result;
  a Tandem transition alone is insufficient.
- A dirty merge target is not by itself unsafe. Current Worktrunk preserves
  non-overlapping staged, unstaged, and untracked target changes. It refuses
  overlapping paths, in-progress Git operations, and synchronization failures
  with its own diagnostics and rollback behavior. Do not duplicate those checks.
- Never add `-f`/`-D`, `--yes`, or `--no-hooks` merely to make a lifecycle
  command proceed. Escalate dirty source worktrees, Worktrunk refusals, and
  unapproved hooks.

## Configuration and hooks

Use `wt config show` before editing configuration. In ordinary repositories,
`.config/wt.toml` is repository-shared and user config is machine-local. This
dotfiles setup intentionally tracks the shared Worktrunk preference template,
while these remain local per machine:

- Worktrunk hook/alias approvals: `~/.config/worktrunk/approvals.toml`
- Worktrunk lock/state files and generated checkouts

Creation has two hook phases: `pre-start` blocks until required provisioning
finishes; `post-start` runs in the background. Keep dependencies/data needed by
the first Worker turn in `pre-start`. Dispatching `post-start` does not establish
completion or service readiness. Worktrunk owns background processes and logs;
inspect them with `wt -C <checkout> config state logs`.

Project hooks and aliases require approval on first run and when their command
changes. Treat the prompt as a human security boundary: inspect with
`wt config approvals list`, but do not pre-approve, copy, commit, clear, or
bypass approvals for convenience. `--yes` is for explicitly authorized CI or
human-directed automation, not routine agent work.

Never drive an interactive picker with synthetic terminal input or derive the
repository from whatever workspace happens to be focused.

When a workflow boundary is unclear, stop after inspection and ask the parent
or user rather than creating parallel state or compensating infrastructure.
