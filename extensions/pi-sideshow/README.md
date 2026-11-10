# pi-sideshow

## Purpose
dedicated extension for [sideshow](https://github.com/modem-dev/sideshow)

## Dependencies
- sideshow

## Overview

`pi-sideshow` is a custom Pi extension for publishing visual posts to a Sideshow browser board and receiving browser feedback. Its self-contained operating and design contract lives in `agent/skills/sideshow/SKILL.md`.

Sideshow is an operator-managed global mise npm tool. Bun is the mise npm-backend installer; the upstream `sideshow` command runs under Node >=22.18. Pi does not install Sideshow, rewrite its files, or replace its generated command.

## Local integration

- `index.ts` registers native tools and `/sideshow status|start|reset`.
- `http.ts` handles HTTP requests, authentication, session-first handoff URLs, bounded output, and lazy local startup.
- `schema.ts` provides provider-compatible inline schemas for `html`, `markdown`, `mermaid`, `diff`, `terminal`, `image`, `json`, `code`, and `trace`.
- `validation.ts` performs provider-safe local validation.
- `mermaid.ts` renders every `kind:"mermaid"` surface with Pele (`skills/studio/pele/render.ts` as a `bun` subprocess) before any post call. Publish, update, add and edit post it as an uploaded `image` surface followed by its source as a `code` surface (language `mermaid`, title "Mermaid source"). A Pele failure throws, naming the diagram, and posts nothing. Add and edit take two calls (image, then source); if the second fails, the error reports the partial state. Sideshow 0.14 cannot collapse a code surface, so the source is not collapsed.
- `state.ts` reconstructs the remembered session from Pi tool results.
- `trace.ts` synchronizes bounded Pi turn activity to the Sideshow Session Timeline on `turn_end`.

The extension also provides post recovery (including every comment on a post), targeted surface mutation, asset upload, a feedback drain, and concrete post-thread replies.

## Basic use

1. Use a Sideshow tool. With a local origin, it probes and lazily starts the existing CLI (`sideshow serve`) when needed. Explicit remote origins are never started automatically. `/sideshow start` is an explicit alternative.
2. Publish with `sideshow_publish_post`; give its returned session workspace `/session/:sessionId` URL as the default handoff, and reserve the direct `/p/:postId` URL for explicit single-artifact sharing. For a remote handoff, check the MagicDNS session URL before presenting it as reachable (see the Sideshow skill).
3. Revise with `sideshow_update_post` or a targeted surface tool.
4. Use `sideshow_list_posts` and `sideshow_get_post` after restart or context compaction to recover state.
5. Browser comments are a backup channel. Every write result surfaces piggybacked `userFeedback`; `sideshow_wait_for_feedback` drains undelivered comments immediately by default and waits only with an explicit `timeoutSeconds`; `sideshow_get_post` lists every comment on a post from all authors without consuming feedback. The server labels a browser comment `user` only from a same-origin viewer (localhost or HTTPS); from plain-HTTP MagicDNS it is stored under the session agent's name and only `sideshow_get_post` shows it.

The default server URL is `${SIDESHOW_URL:-http://localhost:8228}`. Startup logs are written under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/logs`. The extension uses direct HTTP routes including `/api/posts`, `/api/comments`, and `/api/assets`, and sends `SIDESHOW_TOKEN` as a bearer token. Lazy startup binds a local IPv4 origin (`localhost` or `127.0.0.1`) to `0.0.0.0`, so the server can answer at both localhost and the serving machine's MagicDNS/Tailscale address. `0.0.0.0` listens on **all IPv4 interfaces**, including other machine interfaces; MagicDNS is naming, not access control or TLS. Treat the service as exposed to those interfaces and retain the existing `SIDESHOW_TOKEN` behavior. An explicit IPv6 loopback origin still binds to `::1`. For manual starts, use `sideshow serve --host <addr>` or `SIDESHOW_HOST=<addr>`; unset host configuration keeps Sideshow's all-interface default. A running server is used as-is and is not rebound by the extension.

Sideshow also provides `GET /api/posts/:id/markdown` for a portable Markdown export of a complete post. The extension documents this read-only endpoint instead of adding a separate tool, preserving the focused post-centric tool surface while keeping export available when an agent needs it.

## Scope

The current extension includes canonical post tools, session/list/get recovery, targeted surface edits, session reconstruction, provider-safe validation, authentication and redaction, aborts and truncation, Timeline synchronization, and lean local lazy startup. Other renderer, listener, diagnostics, test-post, and URL behavior remains subject to the explicit follow-up review. The session workspace `/session/:id` route is the default user-facing handoff; the direct `/p/:id` page remains available for explicit single-artifact sharing.

Run the end-to-end check against a live Sideshow server with:

```sh
./validate-canonical.sh
```
