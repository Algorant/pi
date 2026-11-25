---
name: browsing
description: "Driving the browser for agent web work: the user's real Chromium through browse. Use for pages that ordinary web search or fetch cannot settle, signed-in sites, and visual or interaction checks. Never a second browser window, never Playwright/Puppeteer/Selenium directly."
---

# Browsing

One browser: **browse**, driving the user's real Chromium through its paired extension in whichever profile
Chromium is actually running — today Chromium's **Default** profile, which also holds his Proton Pass and his
site sessions. There is no separate "agent profile": pairing ties the extension to the local relay, it does
not create a browser profile.
Never open a different visible browser or a second window of one, and never install or drive Playwright, Puppeteer or Selenium. Web search and
`fetch_content` stay separate; use browse when a page needs JavaScript, interaction, real layout or a
signed-in session.

Its tools are codemode-deferred: call `tools.mcp__browse__status`, `tools.mcp__browse__execute` and
`tools.mcp__browse__tabs` from a `codemode` script, finding them with
`searchTools(…, { namespace: "mcp__browse" })` and checking `describeTool` when unsure. Check each
result's `isError`; a script continues after an MCP error, so a resolved call is not a success.

## Check the connection first

Call `status` and read `nextStep`.

- Connected: go on.
- Relay up, extension **unpaired**: tell the user to open Extensions → browse → Options → **Pair with a code**, run `browse pair` in their own terminal, then enter the printed code in Options and click Connect. You never read, relay or store that code.
- Paired but browser disconnected: you open that Chromium yourself, on the machine browse runs on, in the paired profile (currently Default) — never ask Algorant to open it, and never ask browse or him for permission to. Opening it is not a second browser: it is the same paired profile.
  1. Look first: if a Chromium for that profile is already running, do not launch another; just re-check `status`.
  2. Launch without taking focus. On the Hyprland desktop (0.56): `hyprctl dispatch 'hl.dsp.exec_cmd("exec chromium --profile-directory=Default", { workspace = "3 silent" })'` (verified: opens on workspace 3, active window and workspace unchanged). On another browse host use that host's own focus-preserving launcher for the same paired profile; if it has none, report that as the blocker.
  3. Observe `status` a few times over a bounded window (tens of seconds); the extension reconnects by itself. Do not re-launch blindly.
  4. Work only once `status` says connected. If it does not, report exactly what you saw (launch result, running or not, `status` text) and stop — without asking him to open the browser.

  If relay or extension is missing, report it and stop. Never switch browsers, profiles or accounts, or reinstall.

## Work on a page

`execute` runs one script with a Playwright-style `page` plus `browse.<tool>(…)` for the other tools.
Tabs are the handle: without `tab`, `page.goto(url)` opens a new background tab and the result names
its id; pass that id as `tab` next time. If more than one browser is connected, choose the intended browser explicitly with `tabs`'s `browser` option when opening the tab.

1. `page.goto(url)`; read the returned URL, title and status.
2. `snapshot()` for an outline with refs; act through `ref("e12")` or a role/CSS selector with the
   documented `page`/`locator` methods (`click`, `fill`, `press`, `hover`, `dragTo`, `setInputFiles`,
   …).
3. Take a fresh `snapshot()` when the page changed or the refs you need went stale — not after every
   keystroke.
4. When you need network or console evidence, start capture before the action being checked (`browse.network({tab, action: "start"})` or `browse.console({tab, action: "start"})`) and end it afterward (`action: "stop"` returns the network exchanges; console uses `read`, then `stop`). Console capture is detectable by bot checks; stop it when done. Verify from page state: fresh snapshot text, a bounded `evaluate`, the resulting URL and title, `network` for the request, the console for errors. A call reporting "dispatched" is not a result.
5. `page.screenshot()` when layout or visuals are the question; wait for text, URL or a selector instead
   of guessing a delay.

Separate what you observed from what you did. If a page fails, check URL and status first, then console
and network, before calling it a site defect.

## Tabs

Use `tabs` to list, name, group and close. Prefer one tab per flow and reuse it. Preserve every tab you
did not open; touch an existing tab only when the user explicitly lends it to you for this task, and
give it back rather than closing it. Close the tabs you opened and name them in the report.

## Local files

Read local files with Pi's own file tools, never `file://` URLs or the browser as a file reader. Uploads can use only absolute paths inside browse's file roots and are limited to 50 MB per call.

## Signed-in work, logins, challenges

- The browser holds the user's own sessions, in that Chromium profile. For a login, 2FA, captcha or payment, `handoff(message)` shows a card with instructions; he acts in that tab, then clicks Continue. Tell him in chat first, and say plainly that Proton Pass and his passkeys are his to use there: never type credentials into a tool call and never pretend to complete a passkey step. The session he creates persists in that profile afterwards, until the site expires it or he clears it.
- Never complete a payment, put credentials in a tool call, or echo cookie or storage values.
- When navigation reports a bot challenge, hand the interactive one over; never solve it or retry in a
  loop.
- Ask before touching an account that is not already approved for agent use.

## Leave his settings alone

Pairing, updates, tab behaviour, the relay and the extension belong to the user. Do not change them to
make a task easier. browse's own updater is off on purpose: `OPENCODE_BROWSER_AUTO_UPDATE=off` in
`~/.pi/agent/mcp.json`, because mise owns this install and `mise up` updates it, while browse's
self-updater would fight the package manager.

## Report

URL and behaviour tested, actions taken, observed result, console or network failures, screenshot
evidence when visuals mattered, any limit that leaves the result inconclusive, and the tabs you closed.
