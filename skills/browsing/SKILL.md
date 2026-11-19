---
name: browsing
description: "Driving the browser for agent web work: the user's real Chromium through browse. Use for pages that ordinary web search or fetch cannot settle, signed-in sites, and visual or interaction checks. Never a second browser window, never Playwright/Puppeteer/Selenium directly."
---

# Browsing

One browser: **browse**, driving the user's real Chromium through its extension in the paired agent profile.
Never open another visible browser and never install or drive Playwright, Puppeteer or Selenium. Web search and
`fetch_content` stay separate; use browse when a page needs JavaScript, interaction, real layout or a
signed-in session.

Its tools are codemode-deferred: call `tools.mcp__browse__status`, `tools.mcp__browse__execute` and
`tools.mcp__browse__tabs` from a `codemode` script, finding them with
`searchTools(…, { namespace: "mcp__browse" })` and checking `describeTool` when unsure. Check each
result's `isError`; a script continues after an MCP error, so a resolved call is not a success.

## Check the connection first

Call `status` and read `nextStep`.

- Connected: go on.
- Relay up, extension **unpaired**: tell the user to run `browse pair` in their own terminal and enter
  the printed code on the browse onboarding page, then click Connect. You never read, relay or
  store that code.
- Relay or extension missing: report it and stop. Never switch browsers or reinstall.

## Work on a page

`execute` runs one script with a Playwright-style `page` plus `browse.<tool>(…)` for the other tools.
Tabs are the handle: without `tab`, `page.goto(url)` opens a new background tab and the result names
its id; pass that id as `tab` next time.

1. `page.goto(url)`; read the returned URL, title and status.
2. `snapshot()` for an outline with refs; act through `ref("e12")` or a role/CSS selector with the
   documented `page`/`locator` methods (`click`, `fill`, `press`, `hover`, `dragTo`, `setInputFiles`,
   …).
3. Take a fresh `snapshot()` when the page changed or the refs you need went stale — not after every
   keystroke.
4. Verify from page state: fresh snapshot text, a bounded `evaluate`, the resulting URL and title,
   `network` for the request, the console for errors. A call reporting "dispatched" is not a result.
5. `page.screenshot()` when layout or visuals are the question; wait for text, URL or a selector instead
   of guessing a delay.

Separate what you observed from what you did. If a page fails, check URL and status first, then console
and network, before calling it a site defect.

## Tabs

Use `tabs` to list, name, group and close. Prefer one tab per flow and reuse it. Preserve every tab you
did not open; touch an existing tab only when the user explicitly lends it to you for this task, and
give it back rather than closing it. Close the tabs you opened and name them in the report.

## Local files

Read local files with Pi's own file tools, never `file://` URLs or the browser as a file reader.

## Signed-in work, logins, challenges

- The browser holds the user's own sessions. For a login, 2FA, captcha or payment, `handoff()` shows a
  card; the user acts, then clicks Continue. Tell him in chat first.
- Never complete a payment, put credentials in a tool call, or echo cookie or storage values.
- When navigation reports a bot challenge, hand the interactive one over; never solve it or retry in a
  loop.
- Ask before touching an account that is not already approved for agent use.

## Leave his settings alone

Pairing, updates, tab behaviour, the relay and the extension belong to the user. Do not change them to
make a task easier.

## Report

URL and behaviour tested, actions taken, observed result, console or network failures, screenshot
evidence when visuals mattered, any limit that leaves the result inconclusive, and the tabs you closed.
