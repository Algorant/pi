# Amazon sign-in

Profile, sessions and tab cleanup are in [browse-app](browse-app.md).

**Signing in to Amazon (agent profile only).** The sole approved credential path is `agent/scripts/browse-signin`, using the existing `~/.config/fnox/manifests/amazon.toml` references and Algorant's already-authenticated personal `pass-cli` session (not `pass-agent-exec`). The value-free manifest maps existing Proton Pass item IDs and `email`/`password` fields to the script's username/password keys. This reference-only design neither creates a new vault item nor copies credentials or grants access. Values flow through stdin into the browse secret store and are typed with `secrets.type`; never put them in chat, arguments, logs, or output. Missing personal session or manifest/reference means stop; do not fall back to another identity or credential path. TOTP seeds are never read or stored.

The title and username/email matching lookups that established the references were approved for that setup once, not as standing permission. Do not rediscover, remap, or add accounts/references without explicit permission. This path requires no password-manager extension, new vault item, or credential copy.

1. Create a named browse MCP session allowlisted to only the Amazon hosts needed (`session_new` / `browse session new <name> --allow-origin ...`).
2. Run `browse-signin add <account>`. It reads the referenced username/password and adds `amazon-<account>-username` and `amazon-<account>-password`, scoped to `https://www.amazon.com`.
3. In `execute`, open the sign-in page. Type the username secret with `secrets.type(locator, "amazon-<account>-username")` only if Amazon asks for it; a remembered intended-account password-only prompt need not receive it again. Type the password with `secrets.type(locator, "amazon-<account>-password")`. Select "Keep me signed in" if appropriate.
4. Before submitting, check the page identifies the intended account. If it does not, stop without submitting. Submit once only; do not retry.
5. If MFA, captcha, a checkpoint, or anything unexpected appears, stop and hand the browser to Algorant with `handoff()`; tell him in chat first. Do not claim this handoff has been exercised unless observed.
6. Always run `browse-signin remove <account>` after success or failure, including if `add` only added one secret. Check `browse secrets list` is empty; if add/remove failed, remove any remaining username/password secret and verify again. Secret removal is not logout and does not clear authenticated cookies or other profile state.
7. Close tabs with the browse MCP `tabs_cleanup` (`idleMinutes: 0`) and delete only the session(s) you created. Keep the agent Chromium profile running; do not use global CLI tab cleanup.

Observed 2026-11-09 (task-641): one sign-in using the referenced password succeeded for the intended remembered account; Amazon showed no MFA or checkpoint, and the transient secrets were removed with the browse secret store empty. The live human handoff was not exercised.

The transient browse secrets are removed after use, while authenticated cookies may persist in the agent Chromium profile. Sign in only when needed; Amazon may require reauthentication.
