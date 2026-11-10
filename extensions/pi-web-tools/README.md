# pi-web-tools

## Purpose
web search, browser use, and other web based tools extension. powered by things like [ketch](https://github.com/Algorant/ketch), [obscura](https://github.com/h4ckf0r0day/obscura), and [xurl](https://github.com/xdevplatform/xurl)

## Dependencies

- ketch
- xurl
- fnox
- obsidian

## Modules

| Module | Tools | Backend |
|---|---|---|
| `index.ts` + `ketch-support.ts` | `web_search`, `fetch_content`, `code_search`, `get_search_content` | [Ketch](#ketch-requirement) (Brave, grepapp, Obscura) |
| `x-bookmarks/` | `x_bookmarks` | `xurl` launched through the fnox manifest, Obsidian CLI (shared `../lib/obsidian-cli.ts`) |

`index.ts` is the single entry point: it registers the Ketch tools and calls `registerXBookmarks(pi)` from `x-bookmarks/index.ts`. Add a new module as a subfolder exporting a `register…(pi)` function and call it from `piWebTools`; do not create a separate top-level extension for web or X access.

Researcher Subagents load this entry point but enable only the tools on their `--tools` allowlist, so module tools such as `x_bookmarks` stay unreachable there.

## Ketch tools

- `index.ts` registers `web_search`, `fetch_content`, `code_search`, and `get_search_content`.
- `fetch_content` is the single Ketch-backed scraper. Ketch owns direct HTTP, Obscura rendering, extraction, caching, and fallback behavior.
- Raw Ketch results are stored in memory for the current Pi session and can be retrieved by id. `get_search_content` returns up to 80,000 characters of the stored result's JSON text per call (`maxChars` up to 200,000) and pages with `offset`; each truncated page ends with a notice naming the exact next call, and truncated `web_search`/`fetch_content` displays name the stored id. Offsets count characters of the stored JSON text, not the displayed markdown.
- Ketch warnings from successful commands are preserved in tool output and details.

## Ketch requirement

Ketch-backed tools require the operator-managed `ketch` command on `PATH`. Pi does not enforce a semantic version because downstream builds may use their own release identifiers. Check the active installation with:

```sh
command -v ketch
ketch --version
```

Ketch owns compatibility with its configured Obscura renderer.
## Rendered-page behavior

`fetch_content` is the only page-fetch tool. The patched Ketch binary owns the fallback sequence:

```text
Ketch direct HTTP
  → Obscura for JavaScript shells and suitable HTTP 403 responses
  → clean Markdown extraction and cache handling
```

Install Obscura v0.1.11 or newer and keep `obscura` on `PATH`. Ketch invokes it internally. Pi does not invoke Obscura directly.

Obscura has no full layout or paint engine. It does not solve CAPTCHAs, interactive Cloudflare challenges, DataDome or Akamai active challenges, authentication failures, or IP-based blocks. Chromium is not part of the Pi web-tools path.

## Fetch-path policy

The extension has one page-fetch path:

- `fetch_content` calls `ketch scrape`.
- Ketch owns direct HTTP, Obscura rendering, 403 retry, extraction, caching, and errors.
- The extension does not invoke Obscura, Chromium, `curl`, a proxy, or another extraction service.
- Ketch remains responsible for behavior enabled in its operator-managed configuration.

If Ketch cannot render a page with Obscura, Pi receives Ketch's final error.

## Search and fetch are separate

`web_search` asks the Brave Search API for indexed titles, URLs, and snippets. Brave does not proxy the full page body. `includeContent` and `fetchResult` make separate requests through Ketch's normal scraper and configured renderer.

Use `fetch_content` for a selected URL. Ketch decides whether direct HTTP or Obscura is appropriate. The extension does not launch a renderer for every search result.

Ketch can exit successfully while warning that one result could not be scraped. The extension preserves stderr warnings so this partial failure is visible instead of silently returning only the search snippet.

## X bookmarks module

`x-bookmarks/` saves Algorant's X bookmarks as notes in `Agentic/bookmarks/` of the configured Obsidian vault and curates them. Usage, note format, and the sync/curate workflow are documented in the `xurl` skill (`agent/skills/xurl/SKILL.md`, "Save and curate bookmarks").

| File | Role |
|---|---|
| `index.ts` | `registerXBookmarks(pi)`: tool schema and action dispatch |
| `xurl.ts` | read-only `fnox … exec -- xurl` GETs (`whoami`, bookmarks page, conversation search) and error kinds |
| `sync.ts` | page newest→oldest, skip saved status ids, write post/author notes, create or update `Bookmarks.base` (tool-owned), report each note's saved source text within the per-note/per-report caps plus the curate rules |
| `note.ts` | post/author note rendering, provisional title and summary, Saved text callout |
| `thread.ts` | fold the author's own follow-ups into a thread |
| `cover.ts`, `card.ts` | pick a cover from media/quotes/articles/link previews; render a PNG card for text-only posts |
| `curate.ts` | plan-then-write title rename, summary, tags, status, related links |
| `read.ts` | read one saved post note by title or path (exact text, bounded to Pi's tool-output limit) |
| `paths.ts`, `tags.ts`, `base.ts` | vault layout and titles, tag validation/preference, the Bookmarks Base definition |

Dependencies: `xurl` with an OAuth2 user session, `fnox` with `~/.config/fnox/manifests/xurl.toml` and a signed-in `pass-cli`, and a running Obsidian with its CLI. The module never writes to X.
