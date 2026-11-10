# fnox and Proton Pass reference

## Responsibility map

| Component | Owns | Does not own |
|---|---|---|
| Proton Pass | Encrypted source-of-truth values, vault/item permissions | Project declarations or process launch |
| `pass-cli` | Proton authentication, sessions, vault/item writes | fnox profiles or project configuration |
| fnox | References, profiles, resolution, injection, optional MCP/proxy/cache | Proton item creation or update |
| mise | Installing CLIs and project task entrypoints | Secret values or provider authentication |
| Application | Reading its normal environment variables | Calling fnox or pass-cli internally |
| Pi skill | Selecting and explaining the approved workflow | Acting as a vault, receiving values, or granting hard isolation |

The fnox provider type is `proton-pass`. Unix `pass` is a separate product and
uses fnox's `password-store` provider.

## Local baseline

The shared dotfiles currently provision these through mise:

- `github:jdx/fnox`
- `github:ProtonPass/pass-cli`
- `github:cachix/secretspec` during migration

Inspect the effective configuration before changing ownership or adding a
project pin. Do not assume today's installed version remains fixed when the
shared declaration intentionally tracks latest.

On selected hosts, tracked Zsh configuration sets
`PROTON_PASS_KEY_PROVIDER=fs` so Zsh-launched interactive and agent processes
can decrypt the persisted standard pass-cli session after reboot. This setting
does not perform login, does not put secret values in the shell, and is not a
general service architecture. Processes not launched through Zsh do not inherit
it.

## Project and machine-global ownership

Project-owned applications use the normal project declaration described below:
the repository owns its `fnox.toml`, launch boundary, and any intentional
version pin.

Algorant's machine-global tools may instead use the personal dotfiles convention.
Their live value-free manifests are stored at
`~/.config/fnox/manifests/<consumer>.toml`. Create or edit that live file, then
enroll it through the native tracker:

```sh
mise bootstrap dotfiles track ~/.config/fnox/manifests/<consumer>.toml
```

The copy that `mise dot` records in private `Algorant/.dotfiles` is a repository
snapshot, not the live configuration agents should edit directly. Consumers
must name the live manifest and keep fnox options before `exec --`:

```sh
fnox --non-interactive -c ~/.config/fnox/manifests/<consumer>.toml exec -- <approved-command>
```

These are separate synchronization planes: mise-backed dotfiles share only the
value-free manifest and Proton item references, while Proton Pass shares the
secret values. A persistent consumer-specific synchronization helper is needed
only when the consumer cannot read process-scoped environment injection. An
environment-aware consumer should use the direct `fnox ... exec --` boundary.

## Configuration layers

fnox loads its global configuration first, then project directories from outer
to inner. At each directory it may load:

1. `fnox.toml` or `.fnox.toml`;
2. `fnox.<profile>.toml` for active non-default profiles;
3. `fnox.local.toml` or `.fnox.local.toml`.

Closer definitions replace provider/secret entries as units. They do not merge
individual fields. `root = true` stops parent-directory project discovery but
still retains the global base.

Use `fnox config-files` before relying on inheritance. Explicit `--config`
paths have different discovery behavior; do not substitute them casually for
the default project file.

## Standard project file

```toml
#:schema https://fnox.jdx.dev/schema.json
root = true
env = "exec"
if_missing = "error"

[providers.proton]
type = "proton-pass"
vault = "fnox"

[secrets.SERVICE_TOKEN]
provider = "proton"
value = "sample--default--service-token"
description = "Credential used by the sample service"
```

`env = "exec"` prevents shell integration and ordinary `fnox export` from
placing the value in the interactive environment. It still permits `fnox exec`
to inject it into the child. This reduces ambient inheritance and accidental
exposure; it is not an OS or same-user security boundary, since another process
running as the same user can invoke fnox itself.

`if_missing = "error"` makes a required secret fail the command instead of
silently launching a broken or partially configured process.

Defaults in fnox configuration are plaintext. Use `default` only for
non-sensitive configuration.

## Profiles

A profile is an fnox overlay, not a Proton vault. Top-level secrets are the
default profile:

```toml
[secrets]
API_KEY = { provider = "proton", value = "sample--default--api-key" }

[profiles.production.secrets]
API_KEY = { provider = "proton", value = "sample--production--api-key" }
```

```sh
fnox exec -- ./development-command
fnox --profile production exec -- ./production-command
```

Use profiles only when an observed environment needs different references. Do
not create staging/production structure preemptively.

## Provider reference forms

With `vault = "fnox"`, an item-only value reads its `password` field:

```toml
API_KEY = { provider = "proton", value = "sample--default--api-key" }
```

fnox also supports `item/field`, `vault/item/field`, full `pass://` URIs, and
item-ID references. The local convention intentionally uses item-only titles:
it is readable, avoids `/` ambiguity, and uses the cross-provider default
password-field model.

Vault, item, and field names are repository-visible metadata when committed.
Keep titles descriptive but non-sensitive.

## Read-only write hazard

fnox 1.35.2's Proton provider implements retrieval and connection testing but
not remote storage. The generic `fnox set` command is not a safe write adapter:
with a Proton provider it can store the supplied plaintext in `fnox.toml` as if
it were the provider reference.

Therefore:

- never use `fnox set`, `fnox edit`, import, or provider-write commands to
  create/update Proton values;
- use a reviewed temporary operator Scriptify script for writes;
- commit the value-free fnox reference separately.

## Current provider-test incompatibility

The installed fnox 1.35.2 Proton provider's `test_connection` still invokes
`pass-cli test`. Proton Pass CLI 2.3.3 removed that subcommand. Consequently,
`fnox provider test <proton-provider>` is not valid readiness evidence for this
combination.

Do not add a compatibility shim. Use distinct checks:

```sh
# Operator/session readiness; suppress identity details when they are irrelevant.
pass-cli info >/dev/null

# Project declaration and resolution; prints status, never values.
fnox check --all
```

Treat a future upstream fix as a versioned behavior change to verify, not an
assumption embedded in this skill.

## Safe inspection and verification

For the named task and scope, inspect only what is necessary and prefer
value-free metadata. Credential files such as `.env`, local overrides, auth
files, pass-cli sessions, or provider values are not routine inspection sources.
If a specific file is necessary, obtain explicit, scoped approval first; secret
values must never enter agent context or output.

Value-free inspection:

```sh
mise exec -- fnox --version
mise exec -- pass-cli --version
fnox config-files
fnox profiles
fnox list --sources
```

Resolution status:

```sh
fnox --non-interactive check --all
```

Presence-only child check for explicitly named variables:

```sh
fnox --non-interactive exec -- bash -c '
  status=0
  for name in "$@"; do
    if [[ -n ${!name+x} ]]; then
      printf "%s: present\n" "$name"
    else
      printf "%s: missing\n" "$name"
      status=1
    fi
  done
  exit "$status"
' bash EXPECTED_NAME_1 EXPECTED_NAME_2
```

This proves only injection presence. It does not prove that a credential is
valid with its remote service. A live provider request needs its own bounded,
approved validation that redacts requests and responses.

Do not use environment dumps, shell tracing, verbose provider logs, or commands
that expose lengths/hashes. Hashes and encodings remain derived secret
material.

## Operator writes

For each credential write workflow that requires a genuine operator handoff,
Pi generates one reviewed temporary Scriptify script under a mode-0700
temporary directory. Do not install a general-purpose Proton write helper.
The script targets the one agent vault, `fnox`, one login item per secret, the
password field, and the title `<project>--<profile>--<secret-name>`. These
credential-specific provisions do not gate ordinary authorized agent work.

For these credential handoffs, the script accepts values only through hidden
interactive input and uses pass-cli's stdin template creation path. `pass-cli
item update --field password=<value>` is prohibited because the value appears in
process arguments.
Replacement must stage and verify a new item, move the old item to recoverable
trash, rename the candidate using metadata only, and retain a mode-0600,
value-free recovery receipt until final verification.

Under HC, native `scriptify` starts a reviewed executable at once (its own first
confirmation is the presence boundary) and returns its exit code through the
inbox. For these credential handoffs, Algorant supplies values; Pi observes only
value-free output. After independent non-disclosing verification, delete the
temporary credential handoff script and directory. A
consumer-specific persistent command such as `ketch-sync` may remain when the
consumer requires explicit synchronization, but it is not a vault-write tool.

## mise integration

Prefer an explicit task wrapper:

```toml
[tasks.dev]
run = "fnox exec -- npm run dev"
```

This works from a shell, editor, or CI and does not depend on shell activation.
Do not use the experimental `mise-env-fnox` plugin. Do not move language
packages into mise; mise owns tool/runtime binaries while the project's package
manager owns application libraries.

## Advanced agent mechanisms

These are opt-in responses to observed needs, not baseline setup:

- fnox MCP: `tools = ["exec"]`, explicit `secrets` allowlist, output redaction
  retained. Literal redaction does not detect transformed values.
- Credential proxy: `egress = "strict"`, narrow exact rules. It works only for
  compatible HTTPS clients and is not a process sandbox.
- Encrypted sync: remote values copied into an encrypted local override. It
  changes availability, key ownership, and rotation behavior and needs a
  separate consumer-specific decision.
- Proton agent session: the shared `homelab-agents` identity through
  `~/scripts/pass-agent-exec` (see SKILL.md, *Readers*). Its pass-cli session
  lasts about two hours; the wrapper logs in again from the PAT when it lapses.
