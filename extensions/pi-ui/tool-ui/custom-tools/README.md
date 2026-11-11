# Tool UI custom-tool helpers

Owner extensions keep ownership of their tools. This directory only exports shared TUI render helpers that match the `pi-ui/tool-ui` design language.

## Rule of ownership

- The owner extension still calls `pi.registerTool()`.
- The owner extension still owns schemas, prompt snippets/guidelines, execution, model-facing `content`, and `details`.
- Helpers here only provide `renderShell`, `renderCall`, and `renderResult` (or functions used by those slots).
- Do not centrally re-register another extension's tools from `pi-ui`.

## Usage pattern

For a small owner extension in `agent/extensions/foo/index.ts`:

```ts
import { createFooRenderer } from "../pi-ui/tool-ui/custom-tools/foo";

pi.registerTool({
  name: "foo",
  parameters: FooParams,
  ...createFooRenderer(),
  async execute(...) {
    // unchanged behavior/model-facing result
  },
});
```

## Current helpers

- `dispatch.ts` — pi-herdr `dendra_start`, `manus_start` and `ceph_start` cards: one line when collapsed (`⇢ <kind> <label> (<name>, <terminal>) · <where>`, the label from the result or, before it, the start path's own default, plus `see details` for a request-close/tab-rename problem or unchecked machines), the boxed launch fields (optional Task/Task-free, needsAlgorant, worktree/shared isolation, cwd, branch, space/tab, first message, return route, closed request; labels and brief when expanded) otherwise, and the boxed refusal on error.
- `hc-scriptify.ts` — model-only local Scriptify adopted-pane card: the job's label (hc name and terminal in parentheses), actual native terminal, input boundary and inbox outcome; no live-status mirror.
- `hc-report.ts` — native HC child `report` card: question/final, parent/child identity, waiting/kept/closing/failure state; long report path and expanded native session path. Owned/registered by pi-herdr, not the durable inbox.
- `agent-inbox.ts` — `agent_send` card and the delivered `pi-agent-message` transcript card used by the `pi-agency` inbox. Peers are named by `peerName` from `agent/scripts/whois.ts` (the envelope's whois label, `@machine` when remote). Both collapse to one mirrored line (`✉ kind → recipient · 12% · m4f1a2c9 · <first line>  +N lines`; `✉ kind ← sender · 47% · m4f1a2c9 ↩ m3c9d0e1 · <first line>  +N lines`, where the percent is the sender's context usage when it sent the message and the ids come from the inbox envelope), with the kind coloured (blocked ochre, result fern, request dim) and ✉ ochre when the message needs Algorant (blocked, or a request to Herdra), fern otherwise, and show the full boxed card only when expanded (ctrl+o) or, for `agent_send`, on failure.
- `inbox-overlay.ts` — the `/inbox` overlay drawn for the `pi-agency` inbox: Open / Recent / Thread tabs over the transcript, arrow keys, Enter opens a thread, `c` closes a message with a note, Esc leaves. pi-agency supplies the data and the close action.
- `ask-me.ts` — boxed `ask_me` call/result card used by `pi-ask-me` without changing the popup dialog UI.
- `tandem.ts` — boxed Tandem workspace/task/accord/log/rule/decision/Papercut/search cards used by `pi-tandem` tools.
- `web-tools.ts` — boxed ketch cards used by `pi-web-tools` tools.

When adding a new helper, keep the collapsed view compact, use dot-separated metadata, and reserve expanded mode for diagnostics/previews that would be noisy by default.
