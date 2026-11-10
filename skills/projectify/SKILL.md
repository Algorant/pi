---
name: projectify
description: "Create or open a project in Algorant's standard setup: a ~/Projects directory, optional git/GitHub, a Tandem workspace, and a native Herdr app space with `tandem` and `main` (pi) tabs, then hand agreed context to the new project's Ceph and have it report back. Use when Algorant asks to start, set up, or open a project, or work is clearly about a project that may lack this plumbing."
metadata:
  short-description: Create or open a project with the standard setup
---

# Projectify

Projectify is guidance, not a script. It is run by Herdra, or by a Ceph for its own project. It creates the project's space and its Ceph (the Pi in the `main` tab); see the `agency` skill for the roles. Check what already exists and do only the agreed steps. Clarify material gaps by your role's route: a Ceph asks Herdra through the durable inbox; Herdra asks Algorant with `ask_me`. Never overwrite or duplicate an existing project, repo, space, workspace, or tab.

For an existing project, projectify is mostly detection: open what is there and report what is missing. Offer to fill the gaps; don't fill them silently.

## 1. Directory

Every project, throwaway or not, lives at `~/Projects/<name>`.

- Look for it first with FFF `find` under that root (a near match may be the same project under another name).
- For a new project, **confirm the name with Algorant before creating anything**. Prefer short, lowercase, hyphenated names (`[a-z][a-z0-9_-]{0,31}`) that also work as a repo name and a Herdr space or terminal name.
- `mkdir` only after confirmation. If the path exists, it is the project: reuse it.

## 2. Decide the provenance level

Ask when unclear. Typical levels:

| Level | git | GitHub | Tandem |
| --- | --- | --- | --- |
| Throwaway | no | no | no |
| Local (default) | yes | no | yes |
| Published | yes | private repo | yes |

Throwaway projects still get their own directory and Herdr space.

## 3. Git

Default: `git init -b main` in the project unless it is throwaway or already a repo (`git -C <dir> rev-parse --git-dir`). Do not create commits beyond what Algorant agreed to.

## 4. GitHub (only when warranted)

- Check first: `gh repo view Algorant/<name>` and the local `git remote -v`.
- Create private by default: `gh repo create Algorant/<name> --private --source <dir> --remote origin`. Push only if there are commits and Algorant wants it.
- After the first push, run `git -C <dir> remote set-head origin --auto` so `origin/HEAD` points at `main`. Without it Worktrunk can cache the Tandem board branch (`tandem`) as the default branch and `worker_finish` fails at removal.
- A taken name, an existing fork, or a close-name upstream is rare: raise it with Algorant and let them decide. Never pick an alternative silently.
- The `gh` token lacks `delete_repo`. Deleting a repo is Algorant's job.

## 5. Tandem

Check with `tandem_status cwd=<dir>`. If there is no workspace and the project warrants one, run `tandem_init cwd=<dir> title=<name>`. Invoking projectify for a new non-throwaway project counts as Algorant's confirmation to initialize. Tandem works in a fresh repo with no commits.

## 6. Native Herdr space and tabs

Requires `HC_TERMINAL_ID` and the running Herdr window. Read the `herdr` skill, `hc --skill` and `herdr-app --skill`. Without HC, give Algorant the directory and stop here; never create an old Herdr TUI workspace (retired).

**Detect.** Inspect `herdr-app ls`. Match the machine and canonical project path against the existing `main` terminal's current `hc get <terminal>` cwd/repository, not just the space's initial `folder`: that can belong to another terminal or be stale. Reuse the matching space and add only missing tabs. Ambiguity is a clarification, not permission to duplicate or overwrite a live project.

**Prepare the kickoff from section 7 first.** With a Tandem workspace (every non-throwaway project), start the Ceph with one tool call after sections 1–5:

```
ceph_start {project: <name>, folder: <dir>, kickoff: <kickoff>, from?}
```

It refuses when a Ceph for the project already runs on this or a connected machine (unreachable machines come back as not checked), and when the matching space already has a `main` tab (a repair to clarify, not a second Ceph). It reuses the local space for the folder without switching to it, adding a missing `tandem` tab, or creates the new space with `space.new --tab tandem` (`tandem tui`); a new space is shown, which Algorant accepted for a project he asked for. The Ceph is `pi` with core name `<name>` in tab `main`, and the tool appends your return route and "report back when ready" to the kickoff.

A throwaway project without Tandem gets only its main Ceph, with native app creation (shown immediately; no `--no-focus` option):

```bash
herdr-app do space.new --name <name> --folder <dir> --tab main --argv '["pi"]' --task '<kickoff>'
```

**Verify.** Read the tool's result, then `herdr-app ls` and `hc get <returned-main-terminal>`: actual membership in tab `main` (or the pending adoption it names), correct cwd, no native parent, and the real Pi program. An unparented app-backed Pi in `main` is the Ceph. A start acknowledges a terminal, not readiness or kickoff success; the Ceph's report back is the proof. Read its exact screen if blocked; trust/permission decisions go to Algorant through Herdra, never bypass them or blindly resend. Do not invent name synchronization, pane IDs or a second registry.

## 7. Handoff

Put agreed context where it belongs:

- **Description** (required): a one-line `description:` front matter at the very top of the project's `VISION.md`, or `README.md` when it has no VISION. Confirm the line with Algorant. `/task <sentence>` capture uses it to route new Tasks: from another project, a board without one is not offered for filing, while the current board is always offered; capture's notice names every board file still missing the line. Read-only `/task` search ignores descriptions and lists every discovered board.

  ```markdown
  ---
  description: <one plain line saying what this project is>
  ---
  ```
- **Work**: first Tandem Tasks via `tandem_add cwd=<dir>`, each with acceptance criteria.
- **Durable guidance** (how agents work in this project, conventions, orchestration notes): `AGENTS.md` in the project, which Pi loads automatically. Ask before creating it.
- **Database**: a project with a local database uses DuckDB at `data/<project>.duckdb` and gets a `dbs.toml` when it graduates to the homelab Postgres (see the `utils` skill, Databases).
- **One-off context** (ideation, background, what was agreed in this conversation): the kickoff prompt itself. If it's long, write `docs/brief.md` and point the kickoff at it.

Pass the kickoff to `ceph_start` (or as the native app command's `task` for a throwaway `main`), so it is the first message rather than a send into a booting Pi. For an already-running Ceph, queue it once with `agent_send terminal=<current-live-name-or-address>`. This is the same durable inbox used for reports; do not turn `hc send` into a second mailbox or resend an already queued message.

The kickoff states:

1. Where the context lives (Tasks, `AGENTS.md`, brief).
2. What to do now: start the agreed work, or stop at a plan for approval. Ask Algorant (through Herdra if you are a Ceph) if unclear.
3. **The return route.** `ceph_start` appends it for you. Otherwise give the creator's current native name/address from `hc get "$HC_TERMINAL_ID"`, and `agent_send {terminal:"<creator>",kind:"result",body:"[<project>] <outcome>"}`. Resolve named recipients on every send; never save an observed Herdra ID across relaunch. For Herdra in the same core, use `terminal:"herdra"`; from another core use its supplied machine-qualified route, not an assumed global name. Send brief meaningful milestones, a final outcome when done, or `kind:"blocked"` immediately when blocked; do not spam updates. Keep this route scoped to the kickoff, not a new identity registry. For a Ceph on another machine, give the creator as `<machine>/<terminal>` using the name that machine's `hc machine ls` shows (names differ per core); a queued inbox message tells its receiver the reply route itself.

The new Ceph is an app-backed project root, not a disposable child. Reports arrive through the durable inbox; verify claimed results before relaying them as done.

## Report back to Algorant

Summarize what existed, what you created (path, repo URL, Tandem workspace, native space/tab IDs, actual terminal address/name (or unnamed), verified main Ceph and kickoff route), what you skipped and why, and what the child is doing now.
