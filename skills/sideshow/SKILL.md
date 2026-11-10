---
name: sideshow
description: Use sideshow's native pi tools to publish visual work, revise artifacts, recover sessions, and handle browser feedback.
---

# Sideshow

Sideshow is a visual workspace for showing work and receiving browser feedback. Use it as a two-way loop: publish a useful visual artifact, let the user inspect and comment, then revise the artifact or publish the next meaningful step. Use native `sideshow_*` tools. This skill is the normal, self-contained operating contract.

## Installation, runtime, and startup

Sideshow is an operator-managed global mise npm tool. Mise uses Bun to install the npm-registry package, while the upstream `sideshow` command runs under Node >=22.18. Pi does not install Sideshow, rewrite its files, or replace its generated command.

Any Sideshow tool starts the configured server on demand when a local origin is stopped. The extension probes `${SIDESHOW_URL:-http://localhost:8228}` and, for localhost/127.0.0.1/`::1` only, launches the ordinary `sideshow serve` command and waits briefly for readiness. Lazy local IPv4 startup explicitly passes `--host 0.0.0.0` so localhost and the serving machine's MagicDNS/Tailscale address can reach it; an explicit IPv6 loopback origin still passes `--host ::1`. **`0.0.0.0` also exposes the server on every other IPv4 interface on that machine, not only the tailnet. MagicDNS provides naming, not access control or TLS.** Keep the existing bearer-token behavior and assess exposure before sharing sensitive content. An already-running server is not restarted or rebound. For manually started servers, `sideshow serve --host <addr>` and `SIDESHOW_HOST=<addr>` select the listener; leaving both unset preserves the server's all-interface default. It never starts a remote origin automatically. Remote origins must be started separately; a non-tailnet remote origin should use HTTPS, while plain-HTTP MagicDNS stays the accepted path between Algorant's own machines. `/sideshow status`, `/sideshow start`, and `/sideshow reset` are available.

A session is one workstream containing its Stream, posts, comments, assets, and Timeline. On the first publish, pass `sessionTitle` as the user's task name. Reuse the remembered session for that workstream. Use `newSession=true` only for an explicitly separate workstream, privacy boundary, or user request. Do not publish credentials or other secrets.

Establish a new session with one completed `sideshow_publish_post` or `sideshow_upload_asset` call before issuing other session-scoped calls. Never run calls in parallel when more than one could create or infer the remembered session; they can race into separate sessions. After the first result returns, pass its explicit `sessionId` to subsequent uploads or publishes when doing so removes ambiguity.

## Posts, Stream, and revisions

A post is a card in the session's chronological Stream. It has ordered surfaces, a stable id, a current version, and bounded retained prior versions. Retained versions are revision history, not additional Stream entries.

Decide whether the result is exploration or revision:

- **One decision or proposal is one post.** Put the current version ("today" or before) and every alternative (A, B, C…) as labelled surfaces in that single post, with the recommendation marked, so Algorant can compare them without paging between posts. Never split the options of one decision across posts.
- A new topic, milestone, or later round of the same decision publishes a **new post in the same session**, even if related or similarly titled. This preserves visible chronology.
- Corrections, polish, and refinement of the same artifact update that post. Use `sideshow_update_post` for a full replacement, or targeted add/edit/remove/reorder tools for a surgical change. Uncertainty defaults to a new post.

Do not use a targeted add merely to represent a new step. A concrete post id is required for revisions and replies.

## Authored surfaces

A post has one or more of these nine surface kinds. Each field belongs to specific kinds; sending a field to another kind is rejected (for example, `mermaid` accepts only its source, not `title`; surface `title` exists only on `terminal`, `code`, and `trace`):

- `html`: a rich body fragment for a UI sketch or interactive visual. It is not a document: omit `<!doctype>`, `<html>`, `<head>`, and `<body>`. `<style>` and `<script>` are allowed; scripts are confined to the sandbox iframe and cannot access the host page. Keep content in normal document flow; the card column is approximately 720–800px wide and height follows content. Never use `position: fixed`, and avoid absolute overlays in fixed-height boxes. To overlap content, use grid stacking (`display: grid` with children on `grid-area: 1 / 1`); the `slides` kit uses this pattern.
- `markdown`: prose, headings, lists, tables, links, and fenced code. Raw HTML in markdown is escaped; use `html` for live markup. Uploaded images can be embedded as `![caption](/a/<id>)`.
- `mermaid`: Mermaid source for a flow, sequence, state, or architecture diagram. Write `kind:"mermaid"`; the tool renders it with Pele (Verdigris) and posts an image surface with the source in a code surface (language `mermaid`) right below it, on publish, update, add and edit alike. Do not render or upload it yourself and do not hard-code colors. A Pele failure fails the call and names the diagram; fix the source and retry (nothing was posted). Prefer `flowchart TD`/`TB` and short labels; a wide `LR` map renders as a tiny image. To change a rendered diagram, replace it with `sideshow_update_post`; editing one surface leaves its old source surface behind. Add/edit are two calls (image, then source); a failure of the second reports the partial state.
- `diff`: a unified `patch` is preferred because it is compact; use `files` with filename/before/after only when no patch exists. Choose `layout` `unified` or `split`.
- `terminal`: raw command output in `text`, optionally with `cols` and `title`; ANSI SGR color/bold/italic/underline is supported, but cursor-addressing TUIs are not resolved.
- `image`: an uploaded asset reference by `assetId`, with optional `alt` and `caption`.
- `json`: any JSON-serializable value in `data` (including `null`).
- `code`: source in `code`, optionally `language`, `title`, and one-based `lineStart`.
- `trace`: ordered `steps` (`label`, optional `kind`, `detail`, ISO `ts`) rendered as a timeline, or an uploaded trace `assetId`; optional `title`. Use it for a run history such as a Worker's steps.

For ordinary tables and lists, prefer Markdown, and for diagrams that fit, prefer `mermaid` (rendered through Pele); both have useful native Sideshow-widget presentations. Reserve `html` for genuinely interactive or visual mockups that benefit from browser rendering; the widget shows only a short preview and opens it in the browser.

Sideshow is one destination for things made for a person to see. Which tool fits a visual job (Pele diagrams and charts, Excalidraw drawings Algorant edits himself, fframes video) and the shared Verdigris house style are in the `studio` skill; read it before making a visual that is not a mermaid surface.

HTML is sandboxed presentation. Allowed external resources are limited to `cdnjs.cloudflare.com`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`, `fonts.googleapis.com`, and `fonts.gstatic.com`; images may also use any HTTPS URL, `data:` URI, or uploaded `/a/<id>` asset. Use semantic HTML and accessible labels. The injected `sendPrompt(text)` posts a surface message to the post thread for the user to relay deliberately; it does not enter the feedback loop or impersonate the user. `openLink(url)` asks for confirmation before opening an external link, and ordinary links are routed through it. Theme every color with the core variables `--color-background-primary|secondary|tertiary` (and semantic `-info|-danger|-success|-warning`), `--color-text-primary|secondary|tertiary` (and semantic variants), and `--color-border-tertiary|secondary|primary` (and semantic variants). Use `--font-sans|serif|mono` and `--border-radius-md|lg|xl`; never hard-code colors, so dark mode remains legible.

Every html surface also gets a built-in kit: bare `button`, `input`, `select`, and `textarea` are pre-styled (don't restyle them); SVG classes `t`/`ts`/`th` (text: body, small muted, heading), `box` (neutral rounded rect), `arr` (connector), `leader` (dashed guide), `node` (clickable shape), and color ramps `c-blue`, `c-teal`, `c-amber`, `c-coral`, `c-green`, `c-red`, `c-gray` (fill+stroke on shapes or a `<g>`, readable text in both themes); and an injected `<marker id="arrow">` for `marker-end="url(#arrow)"`. For diagrams use `<svg width="100%" viewBox="0 0 680 H">` with those classes. Tabler icons are available via `https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3/dist/tabler-icons.min.css` (`<i class="ti ti-check"></i>`). Style: flat (no gradients, shadows, or decorative effects), sentence case, no emoji, font weights 400 and 500 only, one concept per post (a decision's alternatives together are one concept).

The `html` surface's optional `kits` names supported bundles. Use `issues` for issue/PR/CI trees or status boards and `slides` for a `.deck` of `.slide` elements with navigation. Use only known kits; list them with `GET /api/kits` (or `sideshow kits`).

## Publish and revise operations

- New artifact or meaningful exploration: `sideshow_publish_post` with `title` and non-empty `surfaces`. The first call may set `sessionTitle`; use `session` to select a known session, or `newSession=true` to create a boundary. Do not combine `session` and `newSession`.
- Whole-card correction/refinement, including removing or reordering surfaces: `sideshow_update_post` with the post id and title and/or the complete ordered `surfaces` (use `sideshow_get_post` first for the current list).
- One-surface correction/refinement: `sideshow_add_surface` or `sideshow_edit_surface`. Targets are stable surface ids or non-negative zero-based indexes. Use `sideshow_get_post` first if ids, ordering, or content are uncertain.
- After publishing or revising, give the returned session workspace URL `/session/:sessionId` as the default user-facing handoff: it opens the full workspace with the session's posts, Stream/Timeline controls, and sidebar. The tool also returns the direct post URL `/p/:postId`; use that only when Algorant explicitly asks to share or isolate a single artifact. The configured origin is prepended by the tool. Unless Algorant is confirmed to be working locally, derive the serving machine's name with `tailscale status --json` → `Self.DNSName`, replace only the hostname in the session URL, and make one bounded HTTP request to that exact MagicDNS session URL (e.g. `curl --noproxy '*' --max-time 3 --fail --silent --show-error --output /dev/null --write-out '%{http_code}' '<session-url>'`). Supply both localhost and MagicDNS session URLs only if localhost publication succeeded and the remote URL responds successfully; otherwise supply the reachable URL and report the remote status/error or missing DNS name explicitly, without presenting an unreachable URL as usable. Do not claim remote reachability from the local probe or DNS resolution alone. For a configured explicit remote origin, never auto-start it or substitute a machine-local MagicDNS host for that remote service.
- To export a complete post as portable Markdown, fetch `GET /api/posts/:id/markdown` with the post id. This remains documented rather than exposed as another tool because export is a simple read-only HTTP subresource and the extension's tool surface stays focused on post authoring, revision, recovery, and feedback.

## Verification budget

A successful Sideshow authoring tool result is sufficient to establish an ordinary publish or revision at its configured origin; the bounded MagicDNS HTTP check above is still required before claiming remote reachability. Return only verified reachable session URLs and let the user inspect the artifact. Do not open Obscura, take screenshots, call `sideshow_get_post`, inspect the session page in a browser, drain feedback, or check network/console output merely to prove that Sideshow accepted the content.

Use browser verification only when the user explicitly requests it or when a concrete risk makes it necessary, such as interactive JavaScript, a reported rendering defect, uncertain external asset loading, or a release-critical visual gate. State the risk being checked first, then use the smallest targeted check:

1. Open the direct URL for the one surface at risk rather than the session page. The session page embeds surfaces in iframes, and a blank iframe in a browser harness is not evidence that the surface failed.
2. Take at most one screenshot for that surface. Add console or network inspection only when the risk specifically involves script execution or resource loading.
3. Stop when that question is answered. Do not inspect every surface, theme, viewport, or post unless the request requires that scope.
4. If a defect is found, revise only the affected surface and perform one focused recheck of that defect.

For static HTML mockups, prefer normal-flow layouts that fit the documented card width. Reason from the authored markup first; do not turn routine publication into an exploratory browser-testing loop.

## Recovery and feedback

After restart, session switch, or context compaction, recover instead of creating a duplicate: call `sideshow_list_posts` for the remembered/known session (or `all=true` if unknown), select the post, then call `sideshow_get_post`. Inspect current surfaces, stable ids, indexes, version, and retained history before continuing. If the intended result is meaningfully new, publish a new same-session post.

Browser comments are a backup channel: Algorant normally reviews posts and replies inline in the conversation. Never wait for browser comments unless he explicitly asks you to. Comments reach you three ways:

- Piggyback: every Sideshow write result (publish, update, surface add/edit/remove/reorder, reply) may include `userFeedback`, delivered once. Treat each as user instruction.
- Drain: `sideshow_wait_for_feedback` returns undelivered comments immediately by default. Call it when relevant, for example before revising a post Algorant was reviewing. Pass a positive `timeoutSeconds` only when he asked you to wait.
- Recovery: `sideshow_get_post` lists every comment on that post from all authors without consuming feedback. Use it when Algorant says he commented but nothing arrived. The server labels a browser comment `user` only when the viewer is same-origin (localhost or HTTPS); from a plain-HTTP MagicDNS page it is stored under the session agent's name, so drains miss it and only this recovery path shows it.

Use `sideshow_reply_to_user` for a short acknowledgement and always provide its concrete `postId`. Make substantive feedback changes with the exploration-versus-revision rule above.

## Assets, auth, and Timeline

Use `sideshow_upload_asset` for local images/files before referencing an `assetId`; it accepts a path or base64 data, not both, and rejects files over 5 MiB. Asset ids are content-addressed SHA-256 hashes, so identical bytes deduplicate and remain available while referenced; use the returned id/URL (or `/a/<id>` in markdown/HTML). The extension sends `SIDESHOW_TOKEN` as `Authorization: Bearer ...`, redacts that token from errors, and uses the configured `SIDESHOW_URL`; do not expose tokens in posts or replies.

On every `turn_end`, when a session exists, the extension resets a bounded session trace reconstructed and scoped from Pi activity. It synchronizes that trace to the session Timeline. This is broader than only the latest turn summary, separate from authored post surfaces, and observational sync must not interrupt a turn.

## Tool selection

Use `sideshow_publish_post` for new work; `sideshow_update_post` or the targeted surface tools for same-artifact corrections; `sideshow_list_posts`/`sideshow_get_post` for recovery; `sideshow_upload_asset` for files; `sideshow_wait_for_feedback` to drain undelivered comments (never wait unless asked); `sideshow_get_post` also to recover every comment on a post; and `sideshow_reply_to_user` for concrete post-thread acknowledgements. The extension's automatic local startup and `turn_end` Timeline sync need no extra tool call.
