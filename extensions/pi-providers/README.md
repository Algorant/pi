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
