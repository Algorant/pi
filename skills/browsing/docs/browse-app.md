# browse app

**Profile.** Only the agent profile `~/.local/share/chromium-agent` is paired (`browse pair --list`). Never pair, open or drive Zen or the default Chromium profile. If the agent Chromium isn't running, say so before you open it (it is a visible window):

```sh
hc run --bg --rm --name chromium-agent --label label="Agent Chromium" -- chromium --user-data-dir="$HOME/.local/share/chromium-agent" --no-first-run --no-default-browser-check about:blank
```

[opencode browse](https://github.com/anomalyco/browse) (MIT, local) drives a real, visible Chromium through an extension and a local relay. Approved by Algorant (2026-11-07) for exploration, on request only. Use it instead of Obscura only when:

- Algorant asks for browse, or hands you a tab with its toolbar button;
- the job needs a site he is signed into in the agent profile;
- Obscura cannot do it: service workers, long-tail CSS or media, real-Chromium rendering, bot challenges;
- you need a recording (MP4/WebM), the flight recorder, or a HAR.

For routine checks and renders, stay on Obscura.

**Call.** Use the `mcp__browse` tools from `codemode`; check them with `describeTool` first. The main tool is `tools.mcp__browse__execute({ code })`, which runs Playwright JS against `page` with the helpers `snapshot()`, `ref()`, `handoff()` and `secrets.type()`. The CLI equivalent is `browse execute --session <s> --file x.js`.

**Sessions.** Create a named session first (`session_new` or `browse session new <name> --allow-origin host,...`). Give every session that touches logged-in sites an allowlist naming only the hosts it needs. Use `handoff()` for logins, 2FA, payments and anything irreversible; Algorant clicks Continue. Never complete a payment yourself. A `handoff()` blocks the `execute` call until he clicks Continue (default wait 10 min, `timeoutMs` to change it); the `browse` entry in `mcp.json` sets `"timeout": 660` so Pi's 60 s MCP default does not cut it off. Tell him in chat first, since he may not see the prompt otherwise.

**Clean up.** Use the browse MCP `tabs_cleanup` with `idleMinutes: 0` to close tabs in your own sessions, then delete the session(s) you created. Do not use the CLI's global `browse tabs cleanup --idle-minutes 0`; it can affect other agents' sessions.

**Large file uploads (input capture only so far).** Playwright's `setInputFiles` refuses files of 50 MB or more, because browse's extension link is never "co-located". browse does allow the raw CDP command `DOM.setFileInputFiles` with a local path inside its file roots (`/tmp`, the temp dir, `OPENCODE_BROWSER_FILE_ROOTS`); stage the file in `/tmp` and set the input that way. That route was only seen to capture the input, and a completed upload is unverified. When neither path works, leave the exact page ready for Algorant to add the file himself, and say so.

**Pitfalls.**
- `browse install --help` runs the installer (seen in 0.0.14). Never run `install`; read `browse --help` instead.
- A locator that matches a hidden element waits its whole 30 s timeout. Take a `snapshot()` first and target what is visible.
- `OPENCODE_BROWSER_AUTO_UPDATE=off` is set in mise and in `mcp.json`. Updates go through mise.
- Site secrets (`browse secrets add --origin ...`) and Proton Pass in the agent profile are Algorant's decisions; the only approved path is `browse-signin`, documented in [browse-signin-amazon](browse-signin-amazon.md).
