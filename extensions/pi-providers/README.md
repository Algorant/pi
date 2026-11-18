# pi-providers

## Purpose
all things related to various providers and my settings for them

## Dependencies
None.

## Image payloads and request measurements

The existing pi-ui image owner publishes an in-process, session-bound admission projection. Apply it after the Anthropic/OpenAI payload transforms and before numeric measurement; a missing/failed policy never passes image originals through. The legacy GPT-5.6 custom compaction input is projected explicitly because it bypasses the normal context hook.

`pi-request-metrics` custom entries record request sequence, provider/model context, UTF-8 serialized JSON bytes, native image count, base64 image bytes, decoded image bytes and remaining JSON bytes. Base64 bytes, not HTTP/TLS bytes, define the image budget. Response entries record headers/first parsed-event timing only when the native hooks expose an unambiguous request. Overlapping pre-first-event requests suppress timing attribution instead of guessing. Sequence resumes from the active branch on reload; no bodies, headers, credentials or image data are logged.

The pi-ui entry renderer hides these lines by default. `/request-metrics` toggles them immediately; `/request-metrics on` and `/request-metrics off` set an explicit state. Visibility persists in the machine-local, ignored `request-metrics.json` under Pi's agent directory; capture is always on, including while hidden. When shown, the renderer supplies compact and expanded presentation. Coverage is the native provider payload hook, not standalone summarization/compaction calls or custom fetches (see Compaction coverage below). HTTP/TLS overhead and opaque provider-state contents are not inferred. Context-provider labels describe the session context; the payload's model field is preferred when available.

## Compaction coverage

Compaction requests are outside `before_provider_request` and `after_provider_response`: upstream Pi's compaction passes no `onPayload`/`onResponse`, so no `pi-request-metrics` entry is written for them and neither the payload nor the response timing of a compaction is measured. Do not read request-metrics coverage as covering compaction. No supported extension path exposes the compaction stream function or request options to `session_before_compact`, so full hook coverage needs an upstream change.

The timeout that covers each compaction path:

- Pi's native compaction (every model without the extension's handling, and the fallback when `session_before_compact` returns nothing) runs through the agent stream function: `retry.provider.timeoutMs` (default `httpIdleTimeoutMs`) and `before_provider_headers` apply.
- GPT-5.6 on `openai-codex`: the `session_before_compact` handler starts the custom remote-compaction fetch (`remote-compaction.ts`) and the portable Pi summary (`compact()` without a stream function) in parallel. Neither goes through Pi's provider request options, so both are bounded only by the event abort signal and Pi's global HTTP dispatcher `httpIdleTimeoutMs` (header and body idle). `retry.provider.timeoutMs` is deliberately not applied: native Pi uses it only until response headers arrive, but the remote compaction answer arrives whole and the portable summary streams, so a total deadline of that size would routinely abort long-session compactions (a real 3-turn compaction took 22s) and silently drop the remote replacement history.

## Fresh usage snapshot

`~/.pi/agent/scripts/limits --json` runs the same refresh as `/limits` (its provider set, `buildFetchers` and `LimitsController`) and prints, per configured provider: `status`, `fresh`, `fetchedAt`/`ageSeconds`, and each window's `usedPercent` and absolute UTC `resetAt` (`null` when the provider gives none). No inference and no settings changes; like `/limits` it rewrites the provider cache files on success. A failed provider reports `status: "error"`, `fresh: false`, and any windows it shows are the previous cached reading at that `fetchedAt`; the command then exits 1. Budget per call: one HTTP read each for Anthropic, OpenAI and OpenCode Go, two for xAI, each bounded by a 10s timeout. Windows are account/plan-wide unless their label names a model family (Anthropic `Opus`/`Sonnet`, OpenAI additional limits; Codex Spark is filtered out as in `/limits`); an OpenCode Go percentage is account-wide, not a per-model figure.

Anthropic and xAI credentials resolve through Pi's `ModelRegistry` as in a session (an expired OAuth token may be refreshed). The OpenAI Codex-plan meter owns its `openai` provider entry and its own credential (`limits login`, below); it never reads, copies or falls back to Pi's stored credentials or ambient environment tokens.

### The limits-owned OpenAI sign-in

The OpenAI Codex-plan meter is separately credentialed from OpenAI inference. Its one credential owner is `agent/extensions/pi-providers/quota/codex-auth.ts`: a fresh official OpenAI Codex OAuth sign-in written to `~/.local/state/pi-limits/codex-auth.json` (parent `0700`, file `0600`) through the public `ModelRuntime.create({ authPath })`/`login`, with the SDK's own locked, double-checked refresh. `limits login` runs that flow in the operator's own TTY: it prints the browser sign-in URL (nothing is launched) or offers the device code, and never echoes the sign-in prompts. Pi's own `agent/auth.json` is not read, copied, symlinked or used as a fallback, and no extra auth directory or custom credential logic exists.

The meter is published as provider `openai` (`LABELS.openai` is `OpenAI Codex plan`) and cached at `~/.pi/cache/powerbar-openai-usage.json`; the CLI/JSON, `/limits`, the powerbar and the pi-agency quota gate all read that one cache. The `openai` key is the approved mapping for the one OpenAI inference route, not a verified claim that this reading is the new direct grant's own meter.

Missing sign-in is not an unconfigured-provider omission: it is listed as `status: "error"` with `error: "OpenAI usage: login needed, run \`limits login\`"` (also printed once on stderr, exit 1), and the pi-agency quota gate reports that provider as unknown. A refresh/sync rejection and an HTTP 401/403 are the same expected auth failure, normalized to that hint without carrying SDK error text. On any of them the `openai` cache is removed, so an auth-invalid reading is never served as ready and never keeps gating launches on old high numbers; `--max-age` also cannot serve it from cache without a stored limits sign-in. Other providers are unaffected.

### Bounded reads: `--max-age <seconds>`

`limits --json --max-age 900` (or `--max-age=900`, either flag order; non-negative safe integer, `0` = same as no flag; a bad, missing or repeated value exits 2 before any SDK, cache or network work) bounds how often providers are fetched. The default `limits --json` is unchanged: it fetches every configured provider fresh and ignores any attempt marker. With `--max-age N`, per configured provider and from its own existing cache file:

- reading younger than N seconds: not fetched; `status: "cached"`, `fresh: false`, the original `fetchedAt` and its `ageSeconds`, with the cached windows. The cache file is not touched.
- otherwise, if an attempt newer than the last success is younger than N seconds: not fetched again; `status: "error"`, `fresh: false`, `fetchedAt`/`windows` of the last success (`null`/`[]` when there never was one), plus `attemptedAt` and `attemptAgeSeconds`. This is the retry bound after a failed or incomplete attempt.
- otherwise (stale, missing or no usable cache): refetched through the same `buildFetchers`/`LimitsController` as `/limits`. `ready` + `fresh: true` on success; on failure `status: "error"`, `fresh: false`, the previous reading unchanged, plus `attemptedAt`.

`fresh: false` only means "not fetched on this call", not ineligible: the consumer judges `ageSeconds` and each window's `resetAt` itself and never reads the cache files. Top level adds `maxAgeSeconds`. Exit 0 when every provider is `ready` or `cached`, 1 when any is `error`.

The attempt budget lives in the provider's existing cache file as an optional `attemptedAt`, written (atomic rename, `reserveLimitsAttempt`) before the fetch with the last successful `fetchedAt`/`windows`/`money`/`balance` preserved; a never-cached provider gets `attemptedAt` and empty `windows` only. Nothing is rewritten after a failed fetch, so a concurrent successful write is not overwritten by stale data; the success writer replaces the whole file without `attemptedAt`, ending the suppression. Other readers (powerbar, model roles) ignore the field, and a provider that never had a cache now reads as "ready, no windows, no `fetchedAt`" instead of idle until its first success.

Budget and limits: at most one fetch attempt per provider per N seconds from `--max-age` callers (Anthropic, OpenAI, OpenCode Go one HTTP read; xAI two; 10s timeout each; OpenRouter/Baseten one each when configured); cached or suppressed providers make zero reads. This assumes a single watch caller. It is not a global quota-read guarantee: there is no lock, so overlapping `--max-age` runs, a manual `limits --json`, `/limits`, or a live Pi session's powerbar can each fetch the same provider, and the pre-fetch marker is a read-modify-write that can race with a success write within the same few milliseconds. A 429 `Retry-After` longer than N is not honored.
