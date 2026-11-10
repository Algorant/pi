# pi-ui

## Purpose
my various custom ui tweaks. custom header, footer, toolcall renders, etc

## Dependencies
None.

## Overview

Collects personal Pi UI polish: startup header, powerbar, clear-screen behavior, pasted-image handling, user-message rails, a native working message with a whimsy word each turn, and tool-call rendering.

## Components
- `index.ts` wires each UI module.
- `tool-ui/` contains built-in/custom tool renderers, and `widget-layout.ts` coordinates above-editor widget sections.

## How to use
Reload Pi with this extension enabled. Most behavior is automatic; press `Ctrl+L` for clear-screen behavior and expand tool rows for richer details.

`Ctrl+L` clear-screen depends on the tracked `agent/keybindings.json`. Pi has no native clear-screen action; its default `Ctrl+L` is `app.model.select`, a reserved action extensions cannot override, so that file moves model selection to `Ctrl+Shift+L` (and `/tree`'s labeled-only filter to `Ctrl+Alt+L`). An isolated `PI_CODING_AGENT_DIR` without that file keeps Pi's default: Pi reports `Extension shortcut 'ctrl+l' ... conflicts with built-in shortcut. Skipping.` and `Ctrl+L` opens the model selector. That warning is the missing remap, not a pi-ui defect. To keep the shared shortcut in an isolated agent dir, link only the tracked keybindings file, never credentials or settings:

```sh
ln -s ~/.pi/agent/keybindings.json "$PI_CODING_AGENT_DIR/keybindings.json"
```

## Examples
The startup header lists this runtime's loaded skills and the registered-tool count captured once at startup. The extension row is omitted because Pi does not expose a list of loaded extensions.

Tool calls render as compact boxed cards, pasted local image paths can become attachments, the native working loader picks a whimsy word each turn, and shared widgets are ordered through the layout manager. The powerbar displays subscription usage for Codex, Anthropic, and Pi-managed OAuth xAI; unused Codex Spark quotas are omitted.

`/limits` opens a temporary overlay showing usage for every configured provider, independent of the active model. Plan providers render subscription windows as meters, reusing the same fetchers and cache files as the powerbar, in the owner's pecking order: OpenAI Codex, xAI Grok, Anthropic Claude, then the pay-as-you-go providers. xAI Grok is Pi-managed OAuth only (`auth.json` `xai.type=oauth`) and shows at most one consumed current-period meter (Week or Month). A current period with no credit percent maps to 0%, not `usage unavailable`; an account with only an `XAI_API_KEY` is omitted rather than shown as a failure. Pay-as-you-go providers render allowance meters (OpenCode Go), a consumed balance meter plus money spend (OpenRouter), and a monthly money line (Baseten). Every meter means consumed; money without a denominator is a plain line with no meter. Cached values render immediately, providers refresh concurrently, and one provider failing or hanging never blocks the other. Values older than the cache TTL and providers whose refresh failed are labeled stale with their age. A provider without credentials is omitted rather than shown as a failure. Press `r` to refresh and `Esc` or `q` to close.

Configured state is read from the same credential source each provider's fetch uses: OAuth files for the plan providers — including Pi-managed xAI OAuth, never `getProviderAuth().apiKey` (which does not see the Claude, Codex, or xAI OAuth tokens) — and `getProviderAuthStatus().configured` for the api-key pay-as-you-go providers. The Claude and Codex subscription endpoints are private and read-only and may change or rate limit. OpenCode Go uses `GET /opencode.ai/zen/go/v1/usage`, a key-authenticated endpoint that is not officially documented but is live (the same endpoint the opencode-quota project reads); its response shape is `usage.{rolling,weekly,monthly}.{status,percent,resetsAt}`. OpenRouter is documented and ready once a key is configured. Failures are reported as `usage unavailable` and no credential or remote error body reaches the UI, cache, or logs.

Herdr's Usage widget and its own collector are owned by Herdra in `~/Projects/herdra/herdr-app/usage`. The old Pi popup and startup installer were retired under task-532 after the accepted Herdra task-52 deployment. Pi no longer provisions `mods/usage` or its assets. Pi's `/limits`, powerbar, provider fetchers and caches remain unchanged and do not depend on that widget.

The single-line powerbar listens for the typed `pi-openai:fast-state` event and shows `⚡️` while session-local OpenAI Fast mode is active for an eligible model. `pi-openai` owns eligibility and request policy. `pi-ui` only presents the published state. Codex Spark quota windows are omitted from the powerbar; every rate-limit label containing `spark` is filtered case-insensitively. Pi-managed OAuth xAI (`auth.json` `xai.type=oauth`) adds at most one SuperGrok window (Week or Month) through the unofficial cli-chat-proxy (`GET /v1/user` then `GET /v1/billing?format=credits` with `x-userid`). The snapshot reports a single current period (unified-billing payloads may omit `creditUsagePercent`); missing percent with a current period is 0%, and no 5h or extra weekly row is synthesized when absent. An account with only an `XAI_API_KEY` shows no xAI meters in the powerbar or in `/limits`, where Pi-managed OAuth xAI appears as the `xAI Grok` plan section.

A pasted image path is a standalone whitespace-delimited token (optionally `@`-prefixed or quoted). Paths embedded in code, such as `read({path:"/tmp/a.png"})`, and paths inside Markdown code spans or fences stay literal. An image already supplied with the prompt (for example the same file as an RPC image) is attached once; its path remains visible beside the attachment marker.

Pasted-image preparation reports an informational notice only after attachment succeeds. Missing, unreadable, unsupported, oversized, conversion-failed, and resize-failed images produce a warning that names the affected path and reason; partial success reports both outcomes.

## Image admission

`image-policy.ts` bounds user/pasted attachments, direct and nested tool results (including structured read/MCP results), and each request-local context. Main sessions use 1024px / 300 KiB base64 per image / 1 MiB aggregate image payload; task-scoped children use 4096px / 4.5 MiB / 12 MiB, subject to lower native limits. There is no image-count limit: pasted paths, attachments, tool results and request context admit any number of images within those byte and edge budgets. Resizing uses Pi's native encoder. Decode/resize failures become explicit text omissions, never original-image fallback.

A run snapshots the pre-existing image-bearing messages before its new user/custom message is persisted. Those old images are omitted; new images remain usable through tool rounds, retries and queued inputs until `agent_settled`. Session replacement/resume starts without an active run, so historical originals cannot revive. Nothing rewrites source files or raw transcript entries. The newest admitted images win when a request reaches its aggregate byte budget.

The existing event bus publishes a session-bound projection function to pi-providers, not image data or a persisted registry. Its final payload check also catches provider-owned replay transforms; the legacy GPT-5.6 custom compaction input uses the same projection. `request-metrics.ts` renders numeric request/response entries supplied by pi-providers. They are hidden by default; `/request-metrics [on|off]` (bare command toggles) reveals/hides even existing entries immediately. Visibility is saved across sessions in the ignored agent-directory `request-metrics.json`; recording never stops. When shown, compact and expanded views never contain payload bodies or image data.

## Notes
This extension should not own another extension's business logic; custom tool helpers under `tool-ui/custom-tools/` are renderers only.
