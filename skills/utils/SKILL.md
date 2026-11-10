---
name: utils
description: "Operator utilities: secrets with fnox, Proton Pass (`pass-cli`) and mise; database mirrors with `dbs`; one-off croc file transfers. Use for credentials, secret injection or rotation, a project database, or sending files between machines or people."
metadata:
  short-description: Secrets (fnox, Proton Pass), dbs mirrors, croc transfers
---

# Utils

Three operator utilities, one section each. Read the section the job needs;
the Databases and File transfers sections lean on the Secrets rules.

- [Secrets](#secrets): fnox, Proton Pass (`pass-cli`) and mise. Details:
  [docs/fnox.md](docs/fnox.md), [docs/migration.md](docs/migration.md).
- [Databases (dbs)](#databases-dbs): one-way DuckDB/SQLite mirror to the
  homelab Postgres. Reference: [docs/dbs-stack.md](docs/dbs-stack.md).
- [File transfers](#file-transfers--one-off-croc-file-transfer-xfer): one-off
  croc transfers between machines or people.

Use it for credentials or secret injection, operator login or rotation, agent
delegation over secrets, new-project setup, SecretSpec migration, or deciding
how a tool should receive secrets; for a project's database (a `dbs.toml`
exists, bootstrap, mirror, status, verify or sql, data browsable from another
machine or project, or setting up the Postgres database, role and `PGPASSWORD`
secret); or for one-off or bulk transfer of files or folders between machines
or people (fresh croc code and two controlled terminals by default, shared
fnox-secret transfers only on request, never ongoing synchronization).

## Secrets

Proton Pass holds the values, `pass-cli` handles authentication and writes, and
fnox holds committed references and injects values into one process. mise owns
the CLIs; repositories own their declarations and launch commands.

Read [docs/fnox.md](docs/fnox.md) for configuration and command details. Read
[docs/migration.md](docs/migration.md) before replacing SecretSpec or another
credential path.

### Non-negotiable boundaries

- The fnox Proton Pass provider is read-only. **Never run `fnox set` with a
  `proton-pass` provider**; it can write the plaintext into `fnox.toml`.
- Never use `fnox get`, `fnox export`, `fnox list --values`, `pass-cli item
  view`, or vault/item listings in agent work.
- Never put a value, token, password, session key, secret-bearing URL, value
  length, or hash in chat, Git, logs, memory, Tandem, shell arguments, or task
  evidence.
- Access credential-related files only when necessary for the named task and
  scope; prefer value-free metadata. `.env`, PAT files, Pi/provider auth files,
  pass-cli session data, `fnox.local.toml`, and unrelated credential
  configuration are not routine inspection sources. If one is required, obtain
  an explicit, scoped approval first. Secret values must never enter agent
  context or output.
- Secret writes, logins, grants and vault changes are Algorant's operator
  actions (see *Operator actions*). Pi prepares them and verifies value-free
  success or failure.
- Guidance, fnox profiles, MCP allowlists and redaction are not OS boundaries:
  a same-user process can call the CLIs directly.

Fail clearly rather than falling back to `.env`, plaintext defaults, ambient
shell exports, another secrets manager, or an unreviewed pass-cli write.

### One vault for agent secrets

Every secret an agent or agent-run tool uses lives in the Proton Pass vault
**`fnox`** (Algorant, 2026-11-06: "I am ok with just one vault for secrets,
shared by agents"). It is the existing convention vault that most consumers
already name. Do not create, rename or split vaults, or move items between
them; that is Algorant's call, and the answer is normally `fnox`.

- Item: one login item per secret, value in the `password` field.
- Title: `<project>--<profile>--<secret-name>`, lowercase kebab-case, no `/`.
- fnox key: the environment variable the application expects.
- **Approved exception — existing personal logins:** Algorant's existing Amazon login items are referenced in the Amazon consumer manifest, not copied into `fnox`. This uses his personal pass-cli session; it grants no access to `homelab-agents` and depends on that session remaining available.
- **Used-once exception — approved by Algorant on 2026-11-09:** one title lookup and one account-matching lookup may be used to map the Amazon references. The title lookup returns only vault and Amazon-matching titles; the approved match reads only the necessary username/email field in-process and prints item ID to account only. Never print, log or store the field value; never read passwords. Do not repeat these lookups.

A fnox **profile** selects an environment (default, production); it is not a
vault. Use the literal `default` segment for top-level secrets.

Commit references only. Ignore `.env`, `fnox.local.toml` and `.fnox.local.toml`; the
project-file shape and every option are in [docs/fnox.md](docs/fnox.md).

#### Readers

Two identities read `fnox`: Algorant's personal pass-cli session and the shared
agent identity **`homelab-agents`** (viewer on `fnox` only). The agent reaches
every item in the vault, on every machine that holds its PAT; Algorant accepted
that.

- Agent-run and unattended consumers that must not depend on his personal
  session launch through the wrapper, which logs in as the agent in its own
  session directory and records the reason in Proton's audit log:

  ```sh
  ~/scripts/pass-agent-exec --reason "<why>" -- <fnox args>
  ```

- The wrapper is owned by Algomarchy (`~/scripts`, omarchy dotfiles); homelab-server
  keeps a byte-identical copy. The PAT lives at
  `~/.config/pass-agent/homelab-agents.pat` (mode 0600) on homelab-server, desktop and
  laptop only, never in Git, dotfiles, Proton or chat. Never read it.
- Renewal (yearly) issues a new token that must replace every copy; revocation
  is `pass-cli agent delete homelab-agents`; audit is `pass-cli agent monitor
  homelab-agents`. All three are operator actions.
- No further agent identities, grants or PAT copies without Algorant.

Consumer: `agent/scripts/browse-signin` uses existing Amazon item IDs and `email`/`password` fields mapped to the script's username/password keys in `~/.config/fnox/manifests/amazon.toml`, read through Algorant's personal `pass-cli` session, then adds short-lived browse secrets (see the `browsing` skill, [browse-signin-amazon](../browsing/docs/browse-signin-amazon.md)). It does not read credentials from the `fnox` vault or use `pass-agent-exec`; the personal-session reference grants no standing permission to discover or remap accounts.

### Ownership

A project-owned application keeps its `fnox.toml` in its repository. An
Algorant machine-global tool uses a live value-free manifest at
`~/.config/fnox/manifests/<consumer>.toml`, enrolled once with
`mise bootstrap dotfiles track <path>`; edit the live file, not the snapshot in
private `Algorant/.dotfiles`. Machine setup scripts touch only that machine's
consumers. Never edit another repository from the current Task: hand the exact
change to its owner.

### Workflow

1. **Inventory without values.** Read the Tandem rules and Task, then tracked
   fnox/mise files, launch scripts, units, docs and ignore rules. Name the
   environment variables, every entrypoint that needs them, and the owner of
   each edit. Inspect effective mise ownership before adding a pin; dotfiles
   already provision fnox and pass-cli.
2. **Pick the launch boundary.**
   - Environment-aware command: `fnox exec -- <command>`, or
     `pass-agent-exec --reason … -- exec -- <command>` for agent-run work.
   - Project shortcut: put that wrapper in the existing mise task, Justfile
     recipe, package script or unit. Never activate secrets shell-wide.
   - Persistent-config tool: a narrow consumer-specific sync command (such as
     `ketch-sync`), with its local copy and rotation step documented.
   - Unattended service, CI or remote automation: scope the observed consumer
     separately; add no cache, renewal or new credential path speculatively.

   Application code reads its normal environment variables and never calls
   fnox.
3. **Configure.** Prefer `root = true`, `env = "exec"`, `if_missing =
   "error"`. Add a named profile only when the same key intentionally resolves
   to another item (`fnox --profile production exec -- …`). Keep fnox options
   before `exec --`. Do not use the mise fnox environment plugin; wrap tasks
   explicitly (`run = "fnox exec -- npm run dev"`).
4. **Validate without disclosure** (see docs/fnox.md): `fnox config-files`,
   `fnox list --sources`, `pass-cli info >/dev/null`, `fnox check --all`, a
   presence-only child check, then the real bounded entrypoint. Never print
   values, lengths, hashes, encodings or full environments.

### Operator actions

Login, item creation, replacement, retirement, moves, grants, vault changes and
PAT renewal go through one reviewed temporary script per job (load the
`scriptify` skill):

- Write it under a mode-0700 temporary directory; no general-purpose write
  helper on `PATH`.
- For credential operations requiring a genuine operator handoff, take values
  only through hidden prompts and create items from an in-memory JSON template
  on stdin. Never `pass-cli item update --field password=…` (the value lands in
  process arguments).
- Confirm before the first change and before anything destructive (default
  No); check what is already done so a rerun is safe.
- For credential operations requiring a genuine operator handoff, under
  `HC_TERMINAL_ID` hand it to native `scriptify`; the exit code returns through
  the inbox. Verify the effect value-free, then delete the credential handoff
  script.

### Agent delegation

Default to one exact command under the declared fnox file. Explain why the task
needs those values and do not widen access. Opt-in extras for a concrete need:
fnox MCP (`exec` only, explicit allowlist, redaction on), the credential proxy
(strict egress, narrow rules), or OS isolation when a process must be unable to
reach fnox or pass-cli at all.

### Migration

Migrate one consumer at a time: add fnox beside the working path, have
Algorant copy values into canonical `fnox` items, verify resolution and the
real entrypoint, then remove the old path. Rotation follows separately.

## Databases (dbs)

The standard database stack: **a project's database is one local DuckDB file** (`data/<project>.duckdb`; a project that already has SQLite or DuckDB keeps it). The local file is the source of truth. When Algorant wants the data reachable elsewhere, the project gets a database on the homelab Postgres and `dbs mirror` makes a one-way full-refresh copy. Nothing else ever writes to the mirror. Postgres as a project's primary is out of scope; backups belong to homelab-server.

Full reference (declaration format, semantics, install, failure causes): [docs/dbs-stack.md](docs/dbs-stack.md). `dbs` is `agent/scripts/dbs`, a shell script around the system `duckdb` CLI; it registers no Pi tool. It is on `PATH` inside Pi sessions through the tracked symlink `agent/bin/dbs` (Pi puts `~/.pi/agent/bin` first on `PATH`). Algorant's own terminal does not have that directory on `PATH` yet, so anything he runs outside Pi (a Justfile recipe, a terminal command) uses the full path: `fnox exec -- ~/.pi/agent/bin/dbs mirror`.

### Decided

- DuckDB is the default engine; the pilot is codeparse (then ffsync, p40; finanza has no database yet).
- The mirror runs **by hand** after the project's own write step: `fnox exec -- dbs mirror`. No timers; the mirror failing never fails the project's own command.
- Secret: Proton item `<project>--default--pg-password`, exposed as `PGPASSWORD` through the project's `fnox.toml`.
- **homelab-server creates each project's database and role** (`postgres.py create <project>` on homelab-server). `dbs bootstrap` only reports and prints that command; it never creates anything.
- A future agent-sessions database is excluded from homelab-server's nightly dump.

### Declare

`dbs.toml` at the project root, committed and value-free:

```toml
project = "codeparse"            # Postgres database AND role name, [a-z][a-z0-9_]*

[[source]]
name   = "codes"
engine = "duckdb"                # duckdb | sqlite
path   = "data/codes.duckdb"
# schema  = "public"             # first source defaults to public; later ones must set their own
# exclude = ["scratch_table"]
```

### Commands

Run from the project root, through fnox so `PGPASSWORD` is injected. Exit 0 ok, 1 stale or mismatch, 2 usage or environment error. Output is names, counts and sizes only.

| Command | Does |
| --- | --- |
| `dbs bootstrap` | Checks `dbs.toml`, the duckdb CLI and extensions, the database and role (`postgres.py list` over ssh), the `fnox.toml` reference; prints what to do for anything missing. Never reads a password. |
| `fnox exec -- dbs mirror [--source N] [--via-ssh] [--dry-run]` | One transaction: replace every table, add primary keys, drop vanished tables, record `_mirror_runs`. A failure rolls back and leaves the previous mirror intact. `--dry-run` writes nothing; without `PGPASSWORD` it checks only the source side (tables, row counts, CLI version) and says the Postgres check was skipped. |
| `fnox exec -- dbs status` | Last run, per-table counts, fresh or stale. |
| `fnox exec -- dbs verify [--deep]` | Row counts; `--deep` adds a two-way `EXCEPT ALL` per table. |
| `fnox exec -- dbs sql [--local] "<select>"` | Read-only query on the mirror (or the source with `--local`). It prints query results by design. |

`--via-ssh` (mirror, status, verify, sql) tunnels through homelab-server when Postgres is not reachable directly; it is explicit, never an automatic fallback.

### Operator step: the Proton item

**Order matters:** store the Proton item first, verify it, and only then add `[secrets.PGPASSWORD]` to the project's `fnox.toml`. With `if_missing = "error"`, a reference to a missing item breaks every fnox command in the project (ffsync's `just sync` and `just dev` broke).

After homelab-server creates the database, the role password exists only on homelab-server. Algorant stores it in Proton with the reviewed template [scripts/store-pg-password.sh](scripts/store-pg-password.sh): it reads the role file over ssh, strips the trailing newline, and gives the value to `pass-cli` on stdin without echo. Follow the `scriptify` skill: copy the template unchanged into a fresh `mktemp -d` directory (mode 0700), hand it over, verify with `fnox exec -- dbs status`, then delete the directory. Rotation (`postgres.py rotate <project>` by homelab-server) is the same script; it replaces the item. Read the Secrets section above for the surrounding rules.

- **Native HC** (`HC_TERMINAL_ID` set): the `scriptify` tool runs a script without arguments, so add an executable launcher beside the copy and hand that over. The exit code arrives in your inbox.

  ```sh
  project=<project>   # the dbs.toml project, e.g. codeparse
  dir=$(mktemp -d)
  install -m 0700 ~/.pi/agent/skills/utils/scripts/store-pg-password.sh "$dir/"
  printf '#!/usr/bin/env bash\nexec bash %q %q\n' "$dir/store-pg-password.sh" "$project" > "$dir/run.sh"
  chmod 0700 "$dir/run.sh" && echo "$dir/run.sh"
  ```

  Then call `scriptify script_path=<dir>/run.sh reason="operator-only Proton Pass write of the <project> role password"`.

### Rules

- Never print, log, or put into evidence a password or a data value. Use `dbs sql` only for the figures a task needs; some projects' contents (p40 health data) stay private in output.
- Do not mirror while the project's writer is running: a locked source fails clearly; wait and re-run.
- Keep views and other dependents out of the mirror schema; use another schema.
- Do not add a timer or an automatic mirror to a project without Algorant's decision; an unattended writer needs the secret-in-service design first.
- The system duckdb CLI must be at least as new as the DuckDB that wrote a file; `dbs` fails with the upgrade step otherwise.

## File transfers — one-off croc file transfer (xfer)

`croc` moves files and folders between two machines or people. This is a
one-off transfer, not synchronization, mirroring, or background replication.
Prefer one normal croc send and one interactive receive with a **fresh code**,
including between Algorant's known personal machines. Do not preflight Proton
Pass or fnox on this path. Use the shared-secret workflow only when Algorant
explicitly requests it. Start the sender before launching the receiver (see
[Sender-first startup order](#sender-first-startup-order)).

Without a configured override, croc uses its default **public relay for
rendezvous**; it may then transfer data directly. Tailscale or SSH provides a
way to control the other terminal, not a replacement for croc's rendezvous.
Do not claim this is relay-free, and do not silently select or configure the
separate homelab relay. Never add `--relay`, `--pass`, `--remember`, or a
persistent relay setting without a separate explicit request.

### Under HC, report the blocker first

Under `HC_TERMINAL_ID` the two controlled terminals are hc terminals whose text
you hand over as a command-line argument, so there is no private code-handoff
helper: the sender's fresh code cannot reach the receiver without passing
through your context. The default fresh-code flow therefore cannot complete
under HC (`task-518`).

- Report that blocker before starting a sender; do not offer to start the
  transfer and hand the code to Algorant yourself.
- The one working path under HC keeps the code out of agent context: an
  external recipient without a controlled terminal, where the fresh code goes
  only to that intended recipient through an already trusted channel. Otherwise
  Algorant chooses the next step: the opt-in shared-secret transfer below, or
  running the receiver himself in an operator-owned terminal.

The transfer steps below apply outside HC, or to that external-recipient case.

### Control both terminals

A machine is not whichever Agent happens to be live there. Never inject
transfer commands into an unrelated Agent terminal based on its title, cwd, or
idle state. Use ordinary terminal processes in surfaces dedicated to the
transfer.

**Host.** Under `HC_TERMINAL_ID`, those surfaces are hc terminals you start
as your own children, observed with `hc get` (foreground process) and
`hc read`; other machines are the ones in `hc machine ls`. Change what
Algorant sees only with `herdr-app`, as `herdr-app --skill` describes.

1. Locate the exact source and an **existing, explicit** recipient directory;
   distinguish WSL `~/Downloads` from Windows Downloads. Check that croc is
   available on both machines. For a directory, send its directory path, not
   just its contents. Note any existing destination name; `--rename` preserves
   it rather than overwriting it.
2. Use one fresh sender and one fresh receiver terminal; do not reuse a
   previous sender's code-bearing scrollback. Under HC, start each as your
   own hc child (see [Presentation](#presentation-and-completion)); run the
   receiver through verified SSH from a local terminal, or with `--on
   <machine>` on a connected machine in `hc machine ls`. Leave focus
   unchanged.
3. For SSH routing, use Tailscale status/MagicDNS to locate the intended machine,
   then verify SSH independently: being online does not imply SSH access.
   Ordinary SSH's first-connection host-key prompt is sufficient when Algorant
   chooses to trust that host; do not invent a fingerprint enrollment script
   or disable host-key checking. Use passwordless SSH when verified, with
   `ssh -tt` for the interactive croc receiver. If SSH requires an operator
   password, let Algorant enter it in the dedicated terminal. For a durable SSH
   key installation, confirm the direction(s) of access before changing
   `authorized_keys`; use `scriptify` for a genuine user-run login handoff,
   not just because SSH takes multiple commands.
4. If there is no remote execution path, ask Algorant to run the receiver in
   an operator-owned terminal. Do not invent unattended access.

### Fresh-code transfer (not under HC)

Start the sender first, keeping its native progress visible. Explicitly remove
any ambient machine-global secret so this really generates a fresh code:

```sh
env -u CROC_SECRET croc --disable-clipboard send <file-or-folder> [more-files-or-folders ...]
```

Keep its output in the sender terminal; `--disable-clipboard` avoids copying
the code to the clipboard. Start the receiver in its own interactive terminal,
with an explicit existing destination:

```sh
env -u CROC_SECRET croc --out <destination> --rename
```

Observe the sender's instruction block and confirm it is still running before
starting the receiver. For SSH, run that recipient command through the verified
`ssh -tt` route, using `BatchMode=yes` when key access already works. Do not
re-enroll keys, ask for a password, or start the receiver before the sender
merely to demonstrate readiness. No code belongs in an SSH command.

Confirm the offered names/count/size against the authorized source, then send
`y` and Enter yourself. Do not add `--yes` or ask Algorant to copy codes or
approve routine plumbing when both terminals are controllable. For an external
recipient without a controlled terminal, give the fresh code only to that
intended recipient through an already trusted channel.

Never run under shell tracing or record a code in chat, files, logs, memory,
Git, Tandem, or task evidence. The code may be echoed in the transfer terminal:
inspect via in-process redaction or fixed status/exit/progress markers, never
return the raw instruction block. If private native input is unavailable,
report that concrete blocker instead of leaking the code through CLI arguments.

The code is a per-transfer secret for the intended recipient only. On Unix,
never give it as a `croc` command-line argument or `--code`, and never enable
`--classic`; croc rejects command-line receive codes for security
(CVE-2023-43621). Do not switch to the machine-global shared secret
implicitly.

### Presentation and completion

Launch each side as `bash --noprofile --norc -c '<transfer command>'`,
avoiding zsh startup banners, aliases and mangled long pasted command lines.
No new Pi tool, terminal framework, or persistent service is needed.

- Under HC, start each side with `hc run --bg --rm --name <xfer-send|xfer-recv>
  -- bash --noprofile --norc -c '<transfer command>'`, adding `--on <machine>`
  for a remote side. Do not wait: start the transfer, end the turn, and check
  the terminal's output once afterwards with `hc read <t> --json --lines 0`,
  or act when Algorant or the inbox reports. Never sleep or poll.
- Print a short colored header with the exact source/destination, count/size
  and current phase.
- Launch the sender first. Only launch the receiver's croc process after
  inspecting the sender startup.
- Show croc's own percentage, byte counts, speed and ETA; do not invent a
  percentage or use `--quiet` on the fresh-code sender.
- Wrap each command to capture its real exit immediately and print a unique,
  anchored per-side marker, then keep the terminal open. SSH must return
  croc's status. Match an emitted marker line, not text in the echoed shell
  command.
- After both exits are zero, verify the received names/count/size; use content
  checksums when warranted. Then give Algorant a sanitized “Verified”
  receipt showing hosts, destination, totals and both exits, and close the
  code-bearing terminals. Under HC, put the receipt in your reply and
  `hc kill` the two transfer terminals you started (`--rm` removes them).
  A `not_found` reply to that single kill is known HC friction (`task-519`):
  confirm with `hc ls` that they are gone instead of retrying.
- On failure, retain the owned terminals and report the exact value-free
  error. Do not silently restart, change transport, or show a success receipt.

### Sender-first startup order

Start the sender before the receiver. A spawned process, instruction banner, or
established TCP socket is **not** proof of completed relay registration, so
never turn a fixed sleep into a readiness guarantee. The tested default is the
staged sender-first interactive flow above, not a simultaneous unattended
launch; if the receiver is refused (`could not secure channel`, `flate: corrupt
input`), stop and inspect rather than adding a retry loop. A stronger
unattended readiness contract remains upstream work.

The mechanism is still present in the installed croc: source tracing points to
the receiver's 500 ms pre-transfer local-probe timeout and a late uncompressed
response reaching the compressed-message decoder ([tagged source](https://github.com/schollz/croc/blob/v11.6.5/src/croc/croc.go),
`localProbeResponseTimeout`, `receiveControlFrame` / `receive` /
`senderWaitForHandshake`). Receiver-first was reproduced on 11.5.3 over public
and private relays, sender-first passed there, and no retest on a later version
has been run; treat the order as the known-good rule, not a version claim.

The `best-relay` cache alone does not prove the route a code uses: a supplied
code maps to the public relay its phrase encodes, while a generated code uses
the relay the probe chose and cached as `best-relay`. Use synthetic-only
diagnostics to inspect route/debug behavior; never derive or log
production-secret hashes, lengths or fragments. Private relay selection is an
explicit scoped choice, not part of this default.

### Opt-in shared-secret transfer

Only when Algorant **explicitly requests** the fnox path, read the
Secrets section above. Before either side starts, preflight **every** participating machine
in its actual transfer/login environment:

```sh
command -v croc fnox
test -f ~/.config/fnox/manifests/transfers.toml
croc --version
fnox --non-interactive -c ~/.config/fnox/manifests/transfers.toml check --all
```

Return only host identity, versions, readiness state and value-free errors.
A successful check proves resolution, **not equality** of the secret values
or a successful croc handshake. Never run `fnox get`, `fnox export`,
`fnox list --values`, `pass-cli item view`, or a general vault listing.
Never print, hash, measure, log, or put `CROC_SECRET` in arguments or evidence.

Start the sender first (do not launch the two sides simultaneously):

```sh
fnox --non-interactive -c ~/.config/fnox/manifests/transfers.toml exec -- \
  croc --quiet --disable-clipboard send <file-or-folder> [more-files-or-folders ...]
```

Receiver, interactively, only after sender startup has been inspected:

```sh
fnox --non-interactive -c ~/.config/fnox/manifests/transfers.toml exec -- \
  croc --out <destination> --rename
```

Both sender flags are mandatory. In the installed croc 11.6.5,
`--disable-clipboard` is what stops the code being copied to the clipboard
(`src/croc/croc.go`: `if !c.Options.DisableClipboard`); `--quiet` only sends
croc's stderr to `/dev/null`, so it is no substitute. Do not use
`--code`, `--classic`, `--overwrite`, or `--extended-clipboard`. Relay flags
require a separate explicit relay-selection request.
If either preflight or command fails, stop and report the machine and exact
value-free error. Do not retry with plain croc or another path unless
Algorant explicitly chooses it. For a readiness failure, ask whether to
switch to a fresh one-time code (recommended), fix fnox first, or cancel;
never choose the fallback silently.

### Verify and clean up

A submitted command or waiting receiver is not proof of delivery. Require
zero exits on **both** sides, then verify the expected file/folder exists at
the explicit destination; check count/size for a multi-file directory. Only
report non-sensitive filenames and outcome, never either kind of code. Keep
failed output available long enough to report the value-free error; do not
relaunch another transfer automatically. Once verified, keep the sanitized
receipt described above. Remove only temporary files and live transfer
surfaces created for this operation; never remove the user's source or
received files. Close the retained receipt when Algorant requests it.

Out of scope: ongoing sync, `croc store`, `croc ssh`, installing croc, firewall
changes, private relay configuration, unattended restart, and overwriting
existing files. croc's internal Tailcat/Tailscale transport is croc's own
userspace network, not Algorant's tailnet.
