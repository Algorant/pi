---
name: browsing
description: "Choosing and driving a browser for agent web work. Obscura through Pi's MCP is the default for tests, review renders, checks, screenshots, navigation, forms and diagnostics. opencode browse, in the agent Chromium profile, is on request only: when Algorant asks, when the job needs a site he has signed into in that profile, when Obscura cannot do it, or when a recording or HAR is needed. Never open another visible browser window, and never use Playwright, Puppeteer or Selenium directly."
---

# Browsing

Two browsers. **Obscura** through Pi's MCP is the default for every browser task. **opencode browse**, in the agent Chromium profile, is on request only, for the cases below; its procedure is in [browse-app](docs/browse-app.md), read it when you use it.

## Which one

Use Obscura unless one of these is true:

- Algorant asks for browse, or hands over a tab with its toolbar button.
- The job needs a site he has signed into in the **agent profile**. Today the only approved path is the Amazon sign-in in [browse-signin-amazon](docs/browse-signin-amazon.md); any other signed-in site is a question first.
- Obscura cannot do it: service workers, long-tail CSS or media, real-Chromium rendering, bot challenges.
- You need a recording (MP4/WebM), the flight recorder, or a HAR.

For routine checks and renders, stay on Obscura. Algorant's dashboards, his other accounts, and any other site behind a login are not approved for browse: ask first.

## Rules that always apply

- Never install or drive Playwright, Puppeteer or Selenium, and never open any other visible browser window on Algorant's desktop. A project's own committed test commands still run as that project defines them; this rule is about agents choosing a browser, not replacing a project's test suite. Ordinary web search remains separate.
- The single Chromium exception: one-shot headless Chromium when Obscura is known to mis-render a pixel-exact publication image — close it at once and state the reason in the report.
- Stop every browser and preview server you started, and confirm cleanup in the report.

## Obscura

### Call and discover

Pi's built-in MCP connects the `obscura` server from `~/.pi/agent/mcp.json` at session start. Its tools are named `mcp__obscura__<tool>` and use `codemode-deferred` exposure: they are not declared as model tools, and the `codemode` description only names the namespace and its tool count. Call them from a `codemode` script through `tools.mcp__obscura__<tool>(args)`. Each call resolves to an MCP `CallToolResult` (`{ content, structuredContent?, isError? }`); text is in `result.content[i].text`.

Find or inspect the tools inside a script before first use:

```js
return await searchTools("interactive elements forms", { namespace: "mcp__obscura" });
```

```js
return await describeTool("mcp__obscura__browser_fill_form");
```

Chain several browser steps in one script and return only what matters:

```js
await tools.mcp__obscura__browser_navigate({ url: "http://127.0.0.1:3000" });
const snap = await tools.mcp__obscura__browser_snapshot({ max_chars: 2000 });
const els = await tools.mcp__obscura__browser_interactive_elements({ limit: 30 });
text(snap.content[0].text);
text(els.content[0].text);
```

Forward a screenshot to the model with `image()`:

```js
const shot = await tools.mcp__obscura__browser_screenshot({});
image(shot.content[0]);
```

Check `result.isError` before relying on a result; a script continues after an MCP error result. Use the exact names and arguments from `describeTool()`. Do not import assumptions from Playwright, Puppeteer, or another MCP server. `/mcp` shows the server state, tools, and connection errors; `/mcp reconnect obscura` restarts it.

### Local-project verification workflow

Before touching the browser, establish:

- the behavior the user wants verified;
- the exact local URL from the user, project documentation, configuration, or an already-running development server;
- the expected initial state and successful outcome.

Do not interpret connection refusal as an application defect until the development server and URL have been checked independently.

Then use this loop:

1. Navigate with `browser_navigate`.
2. Capture the initial state with `browser_snapshot`.
3. List targets with `browser_interactive_elements` or inspect forms with `browser_detect_forms`.
4. Act through a returned ref when possible: click, fill, type, select, press a key, or scroll.
5. Wait for the expected selector or text rather than using an arbitrary delay.
6. Take a fresh snapshot after navigation, interaction, scrolling, or a framework rerender. Old refs can be stale.
7. Verify the outcome from observable state.
8. Inspect console and network diagnostics.
9. Take a screenshot when layout or visual state matters.
10. Close every browser and stop every preview server you started when the task is finished; confirm cleanup in the report.

Keep observations and actions separate. Never claim success merely because an action reported that it was dispatched.

### What counts as verification

Choose evidence that matches the behavior:

- **Navigation:** expected URL, page title, and destination content.
- **Forms:** field values or resulting state, submission response, validation text, and absence of unexpected errors.
- **State changes:** fresh snapshot text, element count, attribute, or a bounded `browser_evaluate` result.
- **Loading and API behavior:** relevant request URL and status from `browser_network_requests`.
- **Runtime health:** new errors or warnings from `browser_console_messages`.
- **Visual behavior:** `browser_screenshot`, with viewport dimensions when they matter.
- **Multi-page flows:** tab list plus the active tab's URL/title before and after switching.

Use `browser_search`, `browser_count`, `browser_get_attribute`, or `browser_evaluate` for focused assertions instead of dumping excessive page content. Prefer ordinary interaction tools over JavaScript that bypasses real user behavior.

### Common flows

#### Follow a link or button

1. Snapshot or list interactive elements.
2. Click the current ref.
3. Wait for destination text or selector.
4. Snapshot again and verify URL/title/content.
5. Check console and failed requests if the transition is wrong.

#### Fill and submit a form

1. Detect the form or list interactive elements.
2. Fill fields individually or with `browser_fill_form`.
3. Snapshot before submission when field state matters.
4. Submit through the real control.
5. Wait for the success, validation, or error state.
6. Verify the resulting page and diagnostics.

Do not put credentials or other secrets into tool calls unless the user explicitly authorized that exact use. Never echo cookie or storage values into the response.

#### Investigate a UI defect

1. Capture the initial snapshot and screenshot.
2. Record baseline console messages and network requests.
3. Reproduce the smallest user-visible sequence.
4. Capture a fresh snapshot, screenshot, console output, and relevant request status.
5. Separate observed facts from likely cause.

#### Verify retained state

The browser remains alive across calls in the current Pi session. To prove state retention, navigate or mutate the page, then inspect it in a later call without navigating again. Cookies, history, tabs, and DOM state should remain available until `browser_close`, Pi reload, or session shutdown.

### Local and private URLs

This Pi configuration launches Obscura with `--allow-private-network`, so localhost, loopback, LAN, and other private-network development URLs are reachable. Use the exact project URL; do not scan unrelated local services or private-network hosts.

Do not use Obscura to navigate `file://` URLs or read local files. This configuration does not pass a file-access flag, but Obscura 0.2.2's MCP browser currently accepts file navigation anyway. Treat the MCP process as trusted local code, not as a filesystem sandbox, and use Pi's explicit file tools for authorized local-file work.

### Screenshots and diagnostics

- `browser_screenshot` returns native PNG image content to the model. Use it for layout, rendering, visual regressions, canvas content, or controls that text inspection cannot explain.
- Use `browser_console_messages` for page errors and warnings.
- Use `browser_network_requests` for requests, status codes, and failed resources.
- Use `browser_evaluate` only for bounded inspection or setup that standard tools cannot perform.

For a verification report, state:

- URL and tested behavior;
- exact action sequence;
- observed result and whether it matched expectations;
- relevant console or network failures;
- screenshot evidence when visual behavior mattered;
- any limitation that prevented a conclusive result.

### Session and authentication behavior

Built-in MCP starts the local stdio server when the Pi session starts and keeps it alive for the session. Browser state survives separate `codemode` scripts in the current Pi session. The process closes when the Pi session shuts down or reloads.

Cookies and storage are session-scoped by default. Use storage-state export or restore only when the user asks for it. Call `browser_close` after the browser task to clear open pages and tabs.

### Limits

Obscura is an independent Rust browser engine, not Chromium. It supports JavaScript, DOM interaction, common CSS layout and paint, screenshots, cookies/storage, tabs, and browser diagnostics, but long-tail CSS, service workers, native media, some Web APIs, compositor/GPU behavior, and platform font rendering can differ from Chromium.

Pages within one Obscura process share a V8 isolate. CPU-heavy JavaScript in one page can delay another. Element refs describe current rendered state and must be refreshed after changes.

**Known rendering gap (tandem task-82):** text-box sizes and painting can differ from Chromium. Do not file layout bugs from Obscura pixels alone; confirm suspected rendering-gap cases with one-shot headless Chromium first, then close it immediately. State this narrow confirmation in the report; it does not authorize routine Chromium testing or visible windows. If Obscura cannot establish another browser-specific result, report the limitation rather than switching browser automation.

**Reported gaps and their verification path (tandem task-497).** These were reported in earlier agent work; if the symptom occurs, use the path below rather than retrying in a loop or filing it as a page defect.

- **Blank Sideshow surface iframes.** Sideshow session (`/session/:id`) and post pages embed each surface in a sandboxed iframe, and those cards have been reported blank in Obscura. A blank card there is not evidence that the surface failed. Open the surface directly instead: `/s/<postId>?part=<zero-based index>` on the same origin renders that one surface as a normal page (the embedding iframe's `src` shows the exact URL). Follow the Sideshow skill's verification budget: one surface at risk, at most one screenshot.
- **Mermaid SVG geometry.** Some Mermaid diagrams with curved or labelled edges have been reported to fail with `Could not find a suitable point for the given distance`, likely an SVG-geometry gap (`getBBox`, `getComputedTextLength`, `getPointAtLength`). If that occurs, verify the diagram from its source text (the file, or `sideshow_get_post` for a `mermaid` surface), and for a visual check render that same Mermaid text with Pele (`studio` skill; resvg, no browser) and inspect the PNG. Pele is a different renderer: it checks the diagram's content and layout, not the page's own mermaid.js output; report that limit.
