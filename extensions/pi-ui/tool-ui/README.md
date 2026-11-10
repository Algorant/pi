# pi-ui tool UI

Official personal tool-call UI subsystem for `pi-ui`.

This is the home for the OMP-inspired, not copied, Pi tool-call presentation scheme. Other `pi-ui` concerns stay at the extension top level (`startup-header`, `pasted-images`, `clear-screen`). Tool-call rendering lives here.

## Design language

- Prefer boxed/framed captures for significant tool calls.
- Keep headers compact: status glyph + accent/verdigris tool name + ` · ` metadata.
- Use semantic sections only when they clarify the result: `Output`, `Preview`, `Diff`, `Details`, `Sources`, etc.
- Hide low-value defaults in collapsed mode (`Args`, raw `Response`, routine cwd, exit 0, default timeout).
- Use expanded mode for diagnostics, extra metadata, validation details, and longer previews.
- Keep model-facing content unchanged. These modules are TUI presentation only.

## Layout

```text
tool-ui/
  index.ts               # register/export tool UI subsystem
  core/
    card.ts              # framed card component and boxed renderer helper
    render-cache.ts      # cross-frame render memoization for card components
    text.ts              # formatting/truncation/status helpers
    types.ts             # shared renderer model types
  builtins/
    index.ts             # resolver for read/bash/write/edit/codemode renderers
    read.ts              # read renderer factory
    bash.ts              # bash renderer factory
    write.ts             # write renderer factory
    edit.ts              # edit renderer factory
    codemode.ts          # codemode renderer factory (script/nested-call card)
  custom-tools/
    README.md            # owner-extension opt-in guide
    ask-me.ts            # ask_me renderer helper
    web-tools.ts         # pi-web-tools renderer helper
```

## Built-in tools

`pi-ui/index.ts` calls `registerToolUi(pi)`, which installs one `registerToolRenderer` resolver for Pi's own `read`, `bash`, `edit`, `write`, and `codemode` tools. It runs during extension load, not `session_start`, so `/reload` scrollback rebuilds can see the custom renderers before Pi emits reload lifecycle events.

pi-ui owns presentation only. Pi owns the tool definitions: execution (against the session cwd), schemas, prompt metadata, and the built-in codemode extension (`builtin:codemode`, loaded by default). pi-ui registers no definitions for these tools, and nothing here proxies or wraps Pi's codemode factory. Each tool has a renderer factory (`createReadRenderer`, `createBashRenderer`, `createEditRenderer`, `createWriteRenderer`, `createCodemodeRenderer`) built on `createBoxedToolRenderer`; the resolver returns it for the matching tool name and otherwise defers to `next()`:

```ts
const renderers = new Map([["read", createReadRenderer()], /* … */]);
pi.registerToolRenderer((toolName, next) => renderers.get(toolName) ?? next());
```

The codemode card shows the script, one line per nested call (`server/tool` for MCP tools, args, status, duration, classifier cost), and the script output, with indented JSON for returned objects.

### One card per tool call

Card durations are recorded, never measured at render time. `core/timing.ts` observes Pi's `tool_execution_start` and `tool_result` for each top-level call (nested calls carry `parentToolCallId` and are skipped) and stores the real execution window under `details.piUiTiming`; `renderResult` reads it, so live cards, session replay, and HTML export show the same value. Results without it (older sessions, or details that are neither undefined nor a plain object) omit the label. Pi's HTML export renders bash, read, write, and edit with its own template, so only the other cards appear there.

Pi renders a `renderShell: "self"` tool by calling `renderCall` and then `renderResult` on every display cycle (arguments, partial and final results, expand/collapse, theme changes) and stacks both components. `createBoxedToolRenderer` therefore keeps a single `ToolBoxComponent` in the renderer state and hands out a thin slot component from each call. The call slot draws the card until a result exists; the result slot draws it afterwards. Exactly one is visible, `invalidate()` is delegated to the box, and `renderResult` always owns the model once a result exists, so partial, final, error, and expanded states never show two cards.

HTML export stringifies the call and result renderers separately. The result slot is a real component, so the interactive `/export` shows a completed codemode card (Calls and Output, collapsed and expanded). Pi's template always keeps the invocation card captured before the result, so the export shows that initial pending-style call card above the completed card; this is a known limitation of Pi's exporter, not worked around here. Pi's core exporter also renders `read`, `bash`, `edit`, and `write` with its own templates and ignores their resolvers; that native output is accepted.

Rules:

- register the resolver during extension load so historical tool rows render correctly after `/reload`;
- use `context.cwd` for rendering; execution cwd belongs to Pi;
- do not call startup-sensitive runtime methods such as `pi.getAllTools()` during extension load;
- preserve Pi's result/details shape because session logic and rendering depend on it.

Tool loadouts are per session. After this cutover start a fresh session; `/tree` into an older session restores that session's historical loadout (for example script-only `read`/`bash`). No compatibility shim exists.

## Render memoization

Pi calls `render(width)` on every transcript component on every frame, so an
uncached card rebuilt its borders, title, dividers, and truncation once per card
in the whole transcript for every keystroke, including cards scrolled out of
view. Every card component in this subsystem therefore memoizes its rendered
lines through `core/render-cache.ts`.

Rules for a card component:

- keep the whole line build in a private `buildLines(width)` method and let
  `render(width)` go through `renderCached(...)`;
- clear the cache in `invalidate()`. Pi calls it when cached output is stale,
  for example on a theme change, so an empty `invalidate()` is a defect;
- clear the cache whenever the model is replaced, as `ToolBoxComponent.setModel`
  does;
- pass every render input that is not the width to `renderCached` as an
  identity-compared input. Components that read a mutable renderer-state object,
  such as the web-tools and FFF cards, list each state field they read;
- never hand out the cached array. `RenderCache` returns a copy, so a caller
  that mutates the returned lines cannot corrupt cached state.

`renderCached` is also the cards' one terminal-output boundary: every built
line passes `terminalSafeLine`, which keeps SGR styling and drops every other
escape sequence and control character. Raw tool output (a script's OSC 7501
status, a title, a cursor move) therefore never reaches the calling Pi's own
terminal, where hc would report it as that Pi's status.

The theme is a proxy whose identity never changes when the theme changes, so
the cache key includes a cheap `themeSignature(theme)` fingerprint as well.

## Custom tools

Custom/significant tools opt into helpers from `custom-tools/`, but the owner extension still owns registration and execution.

Examples:

- `agent/extensions/pi-ask-me/index.ts` imports `createAskMeRenderer()`.
- `agent/extensions/pi-web-tools/index.ts` imports `createWebToolsRenderer()`.

This keeps one shared visual scheme without centralizing unrelated tool ownership.

## Future work

User-message rendering is intentionally deferred. Keep related notes in `plan/user-message-rendering-options.md` until Pi exposes an appropriate public hook or a separate design is approved.
