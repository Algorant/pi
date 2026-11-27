---
name: audit
description: "Review a project's code for problems and improvement opportunities using the checks below; a full audit runs all checks. Use when asked to audit, review for cleanup, or find implicit state machines. Read-only; report findings, don't change code."
---

# audit

Scope it first: which project and files. Run every check below unless Algorant names specific ones.
Read the project's instructions. Report findings; don't change code.

Before recommending a finding, triage it with exactly one label:
- **Broken** — provably wrong now; fix it.
- **Outdated** — was right, now wrong; update it.
- **Deprecated** — nothing uses it; remove it, don't guard it.
- **Unproven** — no evidence; prove it with a real check or observed failure, or drop it. No recommendation without proof.
- **Out of scope** — assumes an attacker or situation absent from Algorant's one-user, own-machines setup; drop it with one line why.

A fix must remove at least as much as it adds; prefer deleting a risky step over guarding it.

Each finding:
- Its one triage label, `file:line`, and the supporting code.
- What's wrong, why it matters, and the smallest fix.
- What is confirmed, inferred, or still unknown; don't call a static trace a runtime failure.

Deliver one Sideshow post or a short Markdown report, with one section per check, including "nothing found".
Fixes become the project's own papercuts only if its owner agrees (see `../tandem/SKILL.md`, *Filing a papercut*).

## Checks

### Implicit state machines

Applies to code and scripts.

Look for: flags or fields that change together, branches that depend on earlier
events, timers/retries, restart recovery.

Show: the states and transitions, with source lines; note guards and effects.
Keep independent state dimensions separate.

Test the reasoning: first-seen vs real start, duplicates, late results, restart.
Don't start live services or manufacture tests just to trace these cases.

Fix: name the states or add a small transition function; don't require a library.

### Poka-yoke (mistake-proofing)

Applies to code, scripts, and skills or runbooks with risky steps.

Look for: destructive or hard-to-undo actions whose safety depends on someone remembering (right environment, right target, right order, a flag).
Show: the mistake → its harmful effect, the current guard and how it can be bypassed, with source lines.
Test the reasoning: missing setup, wrong target, skipped step, retry; trace it, never trigger the harm.
Fix: the smallest guard, type or safe default that makes the wrong case impossible or refused at the boundary.

### Cold read

Applies to any text read cold.

Read the text as someone who saw none of the conversation and report only three
gaps: context only the conversation explains, references that do not resolve,
and no clear definition of done.

Apply `cold-read.md` beside this file: the three gaps, how to verify every
reference against the repository root, and the finding format. It is the same
definition the dispatch cold reads use: the scout a caller starts on a draft
new Task-free brief before submitting it (`../agency/SKILL.md`, *Cold-read a brief*), and
the advisory scout `pi-herdr` starts after a Ceph kickoff (`../../extensions/pi-herdr/README.md`).
Report the findings; never rewrite the skill.
