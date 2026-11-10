# pi-ask-me

## Purpose
my custom 'decisions' style dialog pop-up for pi

## Dependencies
None.

## Components
- `index.ts` registers the model-facing tool and validation rules.
- `ui.ts` renders the transient question screen through Pi's inline custom UI.

## How to use
Keep this directory under `~/.pi/agent/extensions/pi-ask-me/` and reload Pi. The agent will call `ask_me` when a missing decision would materially change the work.

## Examples
Ask one choice question, or ask several independent questions in one call. Use freeform only when the answer space is truly open-ended. See the skill for the explain-first `context` contract.

## Waiting status
Pi's inline custom UI reports the question as blocked while the prompt is open; this extension publishes no host status event.

Noninteractive validation and no-UI failures occur before the prompt starts.

## Surface contract
**Explain first, choose second.** Required `context` (at least 60 characters) is the clear decision explanation: what is being asked, why, and the relevant plan or trade-offs. It renders as ordinary Markdown in the main conversation, outside the compact tool card. Use headings and short paragraphs when useful; simple decisions need only a short explanation.

Before opening and focusing the picker, the UI synchronously paints that explanation. This fixes the original same-turn visibility problem. Do not use `sendMessage` for this: Pi queues custom messages until the current tool turn ends.

Pi's inline custom screen temporarily replaces the editor while the question is open and restores its draft afterward. It only restates the current question and lists options. There is no dock summary or per-question clarification field. Put that information in `context` instead. Only the highlighted option shows its short description; the full comparison belongs in the preceding explanation.

The question screen is capped at 30% of terminal height, without minimum-height padding. The question stays fixed while choices/input scroll with Shift+Up/Down. Question tabs ride on the top rule when they fit; the hint line keeps essential keys and drops optional ones rather than wrapping. Blank rows separate sections when space allows and are given up first on short terminals, before choices scroll with a `more choices` indicator. There is no bottom rule; the editor border follows directly. In fullscreen mode PgUp/PgDn scrolls the conversation; in regular mode use terminal scrollback. A terminal too small to show the question and a choice must be enlarged before answering.

Enter saves an answer and advances. The last answer submits immediately—no review screen. Tab/Shift+Tab navigate questions and retain answers/drafts. Typing or pasting opens a custom answer immediately, preserving the first character. Choices disappear while typing; Esc returns to them with the draft intact. `Other…` also remains available when freeform is allowed.

Cancellation, abort, and teardown resolve typed outcomes with any partial answers and restore focus. The full explanation and compact completed-answer card remain in the transcript. The pending card is only a two-row frame/title, so it does not duplicate the dialog or crowd out the explanation.

## Notes
This is a local UI helper; it does not persist answers beyond the normal Pi session/tool result history.
