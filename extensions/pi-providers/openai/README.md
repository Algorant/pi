# pi-openai

This local extension owns OpenAI-specific behavior for the configured GPT-5.6 models and Fast mode for GPT-6.1 Sol, GPT-6 Astra, Sol and Luna. Its narrowed compaction implementation derives from Alexis Gallagher's MIT-licensed `pi-openai-server-compaction`; see `LICENSE.md`.

- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

## Native compaction

On Pi compaction, the extension generates a portable local Pi summary and requests Responses compaction v2. The portable summary remains the authoritative safety path. If the remote request fails, Pi stores and uses the portable summary. If portable summary generation fails, the extension returns control to Pi's default compactor instead of storing an opaque-only checkpoint.

A successful remote request stores one version-2 opaque artifact under `CompactionEntry.details.remoteCompaction`. Compatible later Codex turns reconstruct replay history from that artifact. Lifecycle hooks clear and reconstruct runtime replay state across compaction, tree navigation, forks, session changes, model changes, reload, and shutdown.

Runtime context prefixes (currently the managed Worker brief) arrive through the same-process `pi:context-prefix` event. Each event carries exactly the messages supplied by the `context` hook, scoped to its Pi session. Remote replay inserts them after the immutable replacement prefix and before the subsequent live history; it does not save them into `explicitHistory`, compaction artifacts or chat. The prefix resets at each agent run and shutdown. This preserves non-persistent context without parsing text sentinels or deriving Task state in the provider adapter. Ordinary requests without remote replay keep the SDK-built input.

The extension intentionally does not support direct `openai/*` provider overrides, custom WebSocket transport, `previous_response_id`, Azure, version-1 artifacts, separate configuration files, or migration shims. Pi's built-in `openai-codex` transport remains authoritative.

## Pi 0.84 compatibility decision

**Keep remote compaction v2 as a best-effort optimization.** Pi 0.84's native `openai-codex-responses` continuation uses an in-memory WebSocket cache and `previous_response_id` deltas. It reduces repeated request input, but it does not create a durable compaction artifact and it is not the replay source after reload or branch navigation. Remote compaction v2 stores a version-2 opaque item in the Pi compaction entry and can reconstruct replay history from that entry.

The keep decision has a strict boundary: normal turns continue through Pi's native provider and transport. Remote compaction uses the resolved Pi 0.84 model endpoint and resolved credentials only for the optional compaction request. `ModelRegistry.getApiKeyAndHeaders()` performs the runtime auth resolution (including OAuth refresh) before the extension starts both compaction paths, so both paths use one fresh credential. Null auth-header deletion markers are honored, and remote error text redacts that credential. The portable local Pi summary remains authoritative when remote compaction fails or is cancelled. No native continuation shim, v1 artifact, or broad provider compatibility layer is added.

## Fast mode

Fast mode is on at each session start. Use:

```text
/fast on
/fast off
/fast toggle
/fast status
```

When Fast mode is on for `openai-codex` GPT-5.6 Sol/Terra/Luna or GPT-6.1 Sol and GPT-6 Astra/Sol/Luna, the extension adds `service_tier: "priority"` to requests. The state is in memory only. It is not stored in session entries or settings. Fast mode uses more ChatGPT credits than Standard mode (OpenAI's Codex docs cite about 2.5x included usage). `response.completed` reports `service_tier: "default"` even when priority is applied, so do not use it as evidence; task-335-6 measured about 1.6-1.9x output throughput for GPT-6 Luna, 6.1 Sol and 6 Astra on 2026-10-02. GPT-6 models do not enter the GPT-5.6-only remote compaction/replay path.

The same GPT-6.1 Sol and GPT-6 Astra/Sol/Luna models on Pi's `openai` provider are also eligible, but only when its stored credential is Sign in with ChatGPT (`auth.json` `openai.type` is `oauth`); with an API key, priority would be billed at the priority rate rather than drawing on the ChatGPT plan. OpenAI documents `service_tier` as unsupported on that route, yet on 2026-10-06 it accepted `priority` (about 55 vs 34 tok/s for GPT-6.1 Sol) and rejected `flex` (task-378). If OpenAI starts rejecting it, requests fail visibly; turn Fast off with `/fast off`.

Sign in with ChatGPT tokens cannot read `wham/usage` (401 `no_matching_rule`), so the powerbar and `/limits` show `openai/*` plan usage through the legacy `openai-codex` login. Keep both logins; the quota service resolves the legacy token through Pi so it is refreshed even when only `openai/*` models are used.

`fast-request.ts` owns the eligibility and payload patch policy. The full extension reuses that policy with session-local `/fast` state. Ineligible models and malformed request payloads are no-ops.

The full extension publishes typed `pi-openai:fast-state` events. `pi-ui` consumes this event only to show active Fast state in the existing powerbar.

## Live validation

After installing or updating the shared Pi configuration:

1. Fully restart Pi so the external package is unloaded and the local extension is discovered.
2. Run `pi list` and confirm the required packages from `agent/config-manifest.json` are present; the one-time `agent/scripts/bootstrap-pi.mjs` restores missing ones.
3. Run `/fast status`, `/fast on`, `/fast off`, and `/fast toggle` on GPT-5.6, GPT-6.1 Sol and GPT-6 Astra/Sol/Luna Codex models.
4. Confirm `⚡️` appears after the thinking level only when Fast mode is on for an eligible model.
5. Switch to an ineligible model and confirm the command reports that it is not eligible and the powerbar hides `⚡️`.
6. On a GPT-5.6 Codex model, run `/compact`, continue the conversation, then reload/resume it. Confirm the session remains coherent.
7. Inspect the new compaction JSONL entry. Confirm `details.remoteCompaction.version` is `2`, `implementation` is `responses_compaction_v2`, and `replacementHistory` ends in one `compaction` item.
