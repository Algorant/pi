---
name: audit
description: "Review a project's code for problems and improvement opportunities using the checks below. Use when asked to audit, review for cleanup, or find implicit state machines. Read-only; report findings, don't change code."
---

# audit

A read-only review of a project for the checks below.
Scope it first: project, files, which checks. Read the project's instructions.
Report findings; don't change code.

Each finding:
- `file:line` and the supporting code.
- What's wrong, why it matters, and the smallest fix.
- What is confirmed, inferred, or still unknown; don't call a static trace a runtime failure.

Deliver one Sideshow post or a short Markdown report.
Fixes become the project's own papercuts only if its owner agrees.

## Checks

### Implicit state machines

Look for: flags or fields that change together, branches that depend on earlier
events, timers/retries, restart recovery.

Show: the states and transitions, with source lines; note guards and effects.
Keep independent state dimensions separate.

Test the reasoning: first-seen vs real start, duplicates, late results, restart.
Don't start live services or manufacture tests just to trace these cases.

Fix: name the states or add a small transition function; don't require a library.

### Poka-yoke (mistake-proofing)

Look for: destructive or hard-to-undo actions whose safety depends on someone remembering (right environment, right target, right order, a flag).
Show: the mistake → its harmful effect, the current guard and how it can be bypassed, with source lines.
Test the reasoning: missing setup, wrong target, skipped step, retry; trace it, never trigger the harm.
Fix: the smallest guard, type or safe default that makes the wrong case impossible or refused at the boundary.

### (your next check)

Add the next check here. Move a check to its own file only if it grows.
