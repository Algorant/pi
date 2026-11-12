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
| **Worktrunk** | Worktree/branch creation, switching, explicit merging, removal, hooks, and hook approvals | Tandem task state or Herdr agent ownership |
| **hc / Herdr app** | Native terminal identity, parent/child lifetime and presentation | Worktrunk checkout/hooks or Tandem workflow |
| **Pi and Workers** | Validated orchestration, Task execution, and the delegation/session bridge | Reimplementing Worktrunk or hc lifecycle policy |
| **Tandem** | Task, accord, review, and delivery workflow | Proof that a branch is safe to merge or remove |

## One lifecycle

Every worktree in this setup is created, integrated and removed through
Worktrunk. Nothing calls `git worktree` directly (the read-only registry checks
in `pi-agency/workers/shared.ts` are inspection, not creation), and no second
launcher, queue or cleanup script exists.

| Step | Worktrunk command | Called by |
| --- | --- | --- |
| **create** | `wt -C <repo> switch --create <branch> --base @ --no-cd --format json` | `dendra_start {kind: worker}` for a Worker checkout, `manus_start` for a manus checkout, or a human running `wt switch --create <branch>` directly |
| **finish** | `wt -C <checkout> merge <target> --no-remove`, close the child, `wt -C <repo> remove <branch>` | the starter/owner: `worker_finish` for a Worker or a manus |
| **discard** | `wt -C <repo> remove <branch> --force --force-delete` | the starter/owner: `worker_discard` for a Worker or a manus |

- `--base @` branches from the caller's HEAD, so a new checkout never starts
  from a stale default branch.
- A child that owns a checkout never merges, removes its checkout or deletes its
  branch. A Worker delivers through `worker_report`; a manus delivers through
  `agent_send` to its starter and ends its turn. The starter then runs
  `worker_finish` (verified, approved work) or `worker_discard` (work not to be
  kept) on that exact child; both tools take a Worker or a manus record.
- The Herdr app's own worktree menu is not part of this lifecycle: it creates
  checkouts with raw `git worktree` and keeps their branches, so nothing here
  manages what it leaves. `herdra-check` flags those leftovers and their
  project's owner removes them with `wt remove --foreground <path>`. A human who
  wants a checkout makes one with `wt switch --create <branch>` directly, which
  Worktrunk merges and removes like any other.
- Closing is `hc kill` then `hc rm` on the captured terminal. The Herdr tab is a
  presentation of that terminal and follows it; Pi never calls an app tab
  command.
- `worker_finish` and `worker_discard` keep receipts: the merge happens once,
  then Tandem acceptance (only when the record carries a Task), the close and
  the removal are stamp-first steps, so a retry resumes only what is unfinished.
- A shared checkout (`worktree: false`) is never merged or removed by these
  tools; only the captured child closes there.
- `wt remove` deletes a checkout and its branch. A dirty merge target is not by
  itself unsafe: current Worktrunk preserves non-overlapping target changes and
  refuses overlapping paths, in-progress Git operations and synchronization
  failures with its own diagnostics. Do not duplicate those checks.
- Never add `-f`/`-D`, `--yes`, or `--no-hooks` merely to make a lifecycle
  command proceed. Escalate a dirty source checkout, a Worktrunk refusal or an
  unapproved hook to the owner instead.

An orchestrator or human decides whether to create, finish or dispose; confirm
the target, the diff, the project's validation and Worktrunk's own safety
result. A Tandem transition alone is insufficient.

## Sweeping leftover worktrees

`wt list --format json` is the read. It reports each `items[].branch`, its
`worktree.path`, its `worktree.changes` (staged, modified, untracked, renamed,
deleted, conflicted) and `display.state` (`is_main`, `integrated`, `ahead`, ...).

A checkout is disposable only when Worktrunk itself proves both facts:

- `display.state` is `integrated` — the branch is merged into the default
  branch — **and**
- every `worktree.changes` flag is `false`.

Remove exactly that branch, one at a time:

```bash
wt list --format json | jq -r '.items[] | select(.display.state == "integrated") | .branch'
wt -C <repo> remove <branch> --foreground --format json
```

Everything else is not yours to delete. A `ahead` branch (unmerged commits), a
dirty worktree, a directory under the checkout root that Git does not register,
or an unreadable Worktrunk result is reported with its branch, path, unmerged
commit count or dirty files, and the owner (or Algorant) decides. A
merged-but-dirty checkout is preserved: `--force` would delete that work too.

## Inspect first

From the repository or an explicit repository path, establish the checkout and
configuration before changing anything:

```bash
wt list
wt config show
git rev-parse --show-toplevel
git status --short --branch
```

Use `wt config show` to see the effective user/project configuration and whether
shell integration is active. When more detail is needed, use
`wt list --help`, `wt switch --help`, `wt merge --help`, or `wt remove --help`
rather than assuming flags or paths.

## Pi shell cwd

A Pi shell command does **not** persist `cd` into later tool calls. In
particular, `wt switch` cannot move the Pi process into another checkout.

- Run commands in the intended checkout explicitly: `cd /path/to/worktree && <command>`.
- Or direct Worktrunk explicitly: `wt -C /path/to/repo list`.
- After a switch/create request, inspect the result and use its reported path
  in later commands; do not assume the next shell call uses it.
- Do not change branches in place to imitate a Worktrunk switch. Let `wt`
  create or select the checkout when lifecycle work has been authorized.

## Configuration and hooks

Use `wt config show` before editing configuration. In ordinary repositories,
`.config/wt.toml` is repository-shared and user config is machine-local. This
dotfiles setup intentionally tracks the shared Worktrunk preference template,
while these remain local per machine:

- Worktrunk hook/alias approvals: `~/.config/worktrunk/approvals.toml`
- Worktrunk lock/state files and generated checkouts

Creation has two hook phases: `pre-start` blocks until required provisioning
finishes; `post-start` runs in the background. Keep dependencies/data needed by
the first child turn in `pre-start`. Dispatching `post-start` does not establish
completion or service readiness. Worktrunk owns background processes and logs;
inspect them with `wt -C <checkout> config state logs`.

Project hooks and aliases require approval on first run and when their command
changes. Treat the prompt as a human security boundary: inspect with
`wt config approvals list`, but do not pre-approve, copy, commit, clear, or
bypass approvals for convenience. `--yes` is for explicitly authorized CI or
human-directed automation, not routine agent work.

Board sync (the `tandem` branch, linked worktrees, conflicts, `.tandem/`) is
independent of source Git and Worktrunk integration; its rules are in the
`tandem` skill.

Never drive an interactive picker with synthetic terminal input or derive the
repository from whatever workspace happens to be focused.

When a workflow boundary is unclear, stop after inspection and ask the parent
or user rather than creating parallel state or compensating infrastructure.
