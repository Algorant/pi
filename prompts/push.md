---
description: Commit and push
argument-hint: "[context]"
---

Commit current work and push the relevant repo. First show a concise changed-files preview, including Tandem task/log/config changes as project state when present, then proceed. If repo/branch/scope unclear, use `ask_me` before acting.

Tandem syncs its board itself through the `tandem` branch; source Git push is independent. Treat `pending` as saved locally, not as a failure, and do not require board state to be clean before pushing source changes. Surface conflicts and held edits to Algorant; resolve only with `tandem sync resolve` when authorized. Never stage, commit, push, edit, delete, or rename `.tandem/` or the `tandem` branch.

For worker accepted/validated work, confirm the commit/merge target is clear and clean up safe disposable worker branch/worktree after push; if unsafe or unclear, stop and report the blocker. Fold in any extra context. $ARGUMENTS
