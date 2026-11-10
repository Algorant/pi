---
name: ask-me
description: "Use the ask_me tool to resolve ambiguity, high-stakes decisions, or missing requirements with one lightweight dialog containing 1-4 independent questions."
metadata:
  short-description: Lean clarification gate using ask_me
---

# Pi Ask Me Clarification Gate

Use `ask_me` when a user's request is ambiguous enough that guessing would materially affect the outcome.

Not for Cephs and manus (a project's long-running Pi tab): they send questions to Herdra with `agent_send` per AGENTS.md.

## Decision boundary

Ask before proceeding when any of these is true:

- The next step affects architecture, API/schema contracts, migrations, deployment, or security posture.
- The change is costly to undo.
- Requirements or success criteria are missing, conflicting, or preference-dependent.
- Multiple valid implementation directions exist and the right choice depends on the user.

Do not ask for trivial preferences that do not materially affect implementation.

## How to ask

There is one tool: `ask_me`. One call carries 1-4 independent blocking questions, and a single question is valid. Do not split one question across calls.

- Ask only the first blocking question when later questions depend on its answer. Do not group sequential or branching questions or work around thinking through the decision tree.
- Prefer 2-5 clear options when the choice space is known; put the recommended option first and mark it `(Recommended)` when useful.
- Keep questions and option titles short. An option may have a brief description, shown only while it is highlighted. Explain the full comparison and question-specific rationale in `context`, not in the picker. Use freeform for genuinely open choices; treat custom responses as feedback to address.
- **Explain before opening the dialog.** Required `context` supplies a clear explanation of what is being asked and why. The tool renders it as ordinary Markdown in the conversation and paints it before opening the picker. Show any plan you ask the user to approve or edit. Use short headings or bullets where helpful; do not turn a simple decision into an infodump.
- Pi's inline custom screen temporarily replaces the editor while the dialog is open and restores the draft afterward. The dialog only restates the current question and lists choices. There is no separate summary or question-description field. It uses at most 30% of the terminal and is never padded to that height. The question stays fixed; Shift+Up/Down scrolls choices/input. PgUp/PgDn scrolls the conversation in fullscreen mode; regular mode uses terminal scrollback.
- Typing or pasting starts a custom answer immediately. `Other…` is also available when freeform is allowed. Esc returns from custom input to choices, preserving the draft.
- Enter saves the current answer and advances. The last answer submits automatically, with no review step. Tab/Shift+Tab move between questions and preserve drafts and saved answers.
- Do not use multi-select phrasing for v1. If many details are needed, ask for a precise custom answer instead.

## Before asking

Gather the facts first. Put the explanation, relevant plan, and trade-offs in `context`. Make it useful to Algorant without assuming he knows the task history. The tool visibly renders that explanation before opening the dialog; the dialog is only an answer picker. Do not add a summary or repeat the rationale there.

## After the answer

1. Restate the user's decision briefly.
2. State what you will do next.
3. Proceed without asking again unless new material ambiguity appears.

## Example

```json
{
  "context": "### Situation\nThe exporter needs its first integration surface before command wiring starts.\n\n### Proposed plan\nShip the CLI first, then add the TUI after validation.\n\n### Trade-offs\nCLI-only is smaller and can ship today. Adding the TUI now covers both interfaces but doubles the change surface.",
  "questions": [
    {
      "header": "Scope",
      "question": "Which scope should I implement first?",
      "options": [
        {
          "title": "CLI only (Recommended)",
          "description": "Smallest safe change; TUI can follow after validation."
        },
        {
          "title": "CLI + TUI",
          "description": "More complete, but broader regression surface."
        }
      ]
    }
  ]
}
```
