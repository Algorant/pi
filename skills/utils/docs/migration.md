# Secrets migration workflow

Migrate one consumer at a time. The target is not command-name parity; preserve
the behavior the consumer actually needs with fnox primitives where they exist.

## 1. Inventory without values

Inspect tracked declarations and launch boundaries for the named task and
scope, using the minimum necessary access and preferring value-free metadata.
Credential files such as `.env`, local overrides, auth files, audit logs,
pass-cli sessions, or provider values are not routine inspection sources. If a
specific file is necessary, obtain explicit, scoped approval first; secret
values must never enter agent context or output.

- secret/environment names and descriptions;
- provider references and profiles;
- mise tasks, Justfiles, package scripts, service units, and containers;
- persistent application credential files and synchronization helpers;
- `.gitignore`, operator documentation, and repository rules;
- effective global/project tool ownership.

Do not list vaults/items to discover what should be an explicit operator
decision.

Classify each declared value:

- actual credential;
- sensitive identity/account setting;
- ordinary non-secret configuration;
- generated/derived value;
- obsolete or unused declaration.

Do not carry ordinary configuration into Proton merely because SecretSpec
previously stored it there. Record a committed fnox `default` only when the
value is non-sensitive and appropriate for the repository.

## 2. Map behavior, not syntax

| Existing SecretSpec behavior | fnox target | Important difference |
|---|---|---|
| `secretspec run -- cmd` | `fnox exec -- cmd` | Keep injection process-scoped |
| `secretspec check` | `fnox check --all` | No general fnox local audit log |
| Proton `set` | Temporary operator Scriptify write | fnox Proton provider is read-only |
| Default profile | Top-level `[secrets]` | Use `default` only in the item title |
| Named profile | `[profiles.NAME.secrets]` | Profile is not a vault |
| Required secret | `if_missing = "error"` | Set globally unless exceptions are real |
| `as_path` | `as_file = true` | Verify cleanup for the actual command |
| Scope allowlist | Separate profile/config or MCP allowlist | fnox exec has no SecretSpec-style run scope |
| Required reason/local audit | `pass-agent-exec --reason` | Proton audits the shared agent identity only; personal-session runs have no audit |
| Provider fallback/generation/composition | No automatic equivalent | Stop for an observed requirement; do not add a fallback manager |

SecretSpec can write Proton Pass; fnox cannot. The approved replacement is a
reviewed temporary operator Scriptify scripts, not `fnox set`, a permanent
general-purpose helper, or retaining SecretSpec indefinitely as an invisible
writer.

## 3. Prepare canonical Proton items

For each retained credential, prepare value-free metadata:

```text
vault: fnox
item:  <project>--<profile>--<secret-name>
field: password
```

Algorant copies the current value into the new item through a reviewed temporary
Scriptify script. Pi must not receive the old or new value. Initial migration
copies values; rotation is a later, separately verified pass. Delete the script
after value-free verification.

Repository visibility matters: committed references expose item titles. Use
non-sensitive project and credential names.

## 4. Add fnox beside the working path

Create the value-free `fnox.toml` and ignore local overrides. Keep the old
launch path intact while validating fnox.

Use the repository's existing command composition. Do not create a second task
runner or duplicate application orchestration merely to insert fnox.

Validate in layers:

1. tool versions;
2. `fnox config-files`;
3. `fnox list --sources`;
4. suppressed `pass-cli info` success/failure when authentication readiness is
   relevant;
5. `fnox check --all`;
6. a named presence-only `fnox exec` child;
7. the real bounded application entrypoint.

Only the last check establishes that the application works. None may emit
values, lengths, hashes, full environments, or credential-bearing URLs.

## 5. Cut over one entrypoint at a time

Replace the old wrapper at its owner boundary:

- mise task or Justfile recipe;
- package/script invocation;
- explicit operator synchronization helper;
- service unit only when that real service is in scope.

Update active documentation and error text that tells users which wrapper to
run. Application code should continue reading ordinary environment variables.

Do not redesign hypothetical CI, services, profiles, caches, or agent identities.
When a real unattended consumer exists, inspect its actual environment and
create a separate bounded decision if the interactive path is insufficient.

## 6. Remove the superseded path

After the new entrypoint is directly observed:

- remove that consumer's SecretSpec wrapper and manifest declarations;
- remove obsolete shell-wide exports;
- retain SecretSpec globally while any other consumer remains;
- leave old Proton items intact until Algorant approves retirement;
- rotate copied credentials later, one integration at a time.

Search active tracked files for old command references. Historical Tandem logs
remain historical and are not rewritten.

## Cross-repository handoff checklist

A migration Task must name:

- owning repository and exact related files;
- credential names only, never values;
- operator actions and when Scriptify is required;
- existing entrypoints being replaced;
- value-free checks and the bounded real behavior check;
- any live network/provider limits;
- explicit non-goals and cleanup point;
- confirmation that no other repository will be mutated by its Worker.
