---
name: memory
description: Unified memory operations for pi. Use for durable memory search, read, write, edit, import, or digest in the Obsidian vault.
compatibility: Pi with the local pi-memory extension and the pi-memory.vault setting, plus either GUI Obsidian with its CLI enabled (auto-started in a graphical session) or, on hosts without the CLI, a pi-memory.vaultPath kept current by Obsidian Sync (for example Headless Sync).
---
# memory

Store curated durable knowledge, not transcripts or secrets. Search before writing.

Ask for explicit confirmation before storing sensitive or ambiguous information, overwriting or deleting useful memory, or importing a large folder deeply. Never store secrets, tokens, private keys, cookies, `.env` content, logs, caches, or unfiltered transcripts.

## Storage model

Memory is Markdown in Algorant's Obsidian vault, reached through the memory tools only: by the Obsidian CLI, or, on hosts configured with `vaultPath`, by the tools' own disk backend. Do not read or write vault files with other tools. **Obsidian Sync owns synchronization**; there is no Git and no sync tool, and nothing here pulls or pushes.

```text
<vault>/Agentic/memory/
├── global/
└── projects/
    └── <project-id>/
        └── <notes>.md
```

Project subfolders are optional. Do not create ceremonial files or mandatory `core/` nesting. OKF frontmatter is independent from paths. Each concept needs YAML frontmatter with `type`; prefer `title`, `description`, `tags`, `created`, `updated`, and `timestamp`. Memory tags are nested under `memory/` (for example `memory/nas`) so they stay out of Algorant's personal vault tags; search them with `tag:memory/nas`.

## Prerequisites and configuration

- GUI Obsidian needs the vault and **Settings → General → Command line interface** enabled, so the `obsidian` command is on `PATH`. When Obsidian is not running, the client starts it automatically (detached via `uwsm-app -- obsidian`, up to ~30 s wait), but only in a graphical session (`WAYLAND_DISPLAY` or `DISPLAY`); on headless machines Obsidian must already be running and the call fails clearly otherwise. If Obsidian is running but its CLI socket (`$XDG_RUNTIME_DIR/.obsidian-cli.sock`) is missing, the client does not launch it again; it fails asking for an Obsidian restart. **Never run the `obsidian` CLI with an isolated `HOME`/config (scratch or test environments) while sharing the real `XDG_RUNTIME_DIR`:** that call unlinks the running app's socket and leaves Obsidian unreachable until it is restarted. Give scratch runs their own `XDG_RUNTIME_DIR`, or use the real user environment for read-only checks. **Bare SSH shells:** the CLI crashes (`Trace/breakpoint trap`) without `DISPLAY`, so when `DISPLAY` is unset the client reads `DISPLAY`, `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, and `DBUS_SESSION_BUS_ADDRESS` from `systemctl --user show-environment` (once per process) and runs the CLI with them. If the user manager has no `DISPLAY` either (nobody is logged in to the desktop), the call fails with a message naming `DISPLAY`; log in to the desktop session and retry. CLI calls are serialized across all Pi processes on the machine by a per-user lock (`$XDG_RUNTIME_DIR/pi-obsidian-cli.lock`, via `flock`), so concurrent sessions do not receive each other's output; raw `obsidian` commands in a shell bypass it. On Omarchy, `user-flags.conf` for Obsidian must contain `--disable-gpu`.
- Supported hosts: workstation and laptop (CLI); homelab-server (disk backend, Obsidian Headless Sync); any other host that configures the disk backend for its own synced vault copy. old-laptop and any host without either fail clearly; there is no fallback between backends.
- Disk-backend hosts only: global `settings.json` also sets `vaultPath` (never in project settings): `~/vaults/MasterVault` on homelab-server. Search there supports only plain words, `"phrases"`, `/regex/`, and `tag:`; other operators fail clearly.
- Per-machine, untracked global `settings.json`: `"pi-memory": { "vault": "MasterVault" }` (the vault name). Missing configuration, an unknown vault, an absent or disabled CLI, an `Error:` result, and a timeout (Obsidian not running) are reported as errors. Before every tool call the CLI must resolve exactly the configured vault name.
- Optional project `.pi/settings.json`: `"pi-memory": { "projectId": "<stable id>" }`.

The project ID is the normalized Git-root basename; a non-Git directory uses its basename. Pi configuration (anything under `~/.pi`) uses `pi`. Normalization lower-cases, replaces unsafe characters with `-`, and strips leading dots because Obsidian cannot see dot-prefixed folders (`.dotfiles` becomes `dotfiles`). An ID that is empty after normalization is an error. If two repositories share an ID (a real `pi` repository collides with Pi configuration), set an explicit `projectId`; never let two projects share a folder accidentally.

## Tools

Every tool takes an optional `project` (a project ID, normalized exactly like `pi-memory.projectId`) to act on another project's memory instead of the current one, with no settings change; it applies to the project scope, and an empty value is an error. Example: `memory_read({ path: "nas.md", project: "homelab-server" })`.

- `memory_check({ directory, project })`: vault name, backend, project ID, the vault-relative scope roots, file counts and listing, and the OKF conformance report.
- `memory_search({ query, scope, project })`: Obsidian search syntax over `project` (default), `global`, or `all` (the disk backend supports a subset; see above).
- `memory_read({ path, scope, project })`: exact note text.
- `memory_write({ path, content, mode, scope, project })`: whole-note write. `create` fails if the note exists; `overwrite` fails if it is missing.
- `memory_edit({ path, oldText, newText, scope, project })`: replace one exact, unique occurrence.
- `memory_trash({ path, scope, project })`: move one note to Obsidian's trash (the vault's Deleted files setting). Confirm with Algorant before trashing a note that may still be useful.

`memory_trash` needs the Obsidian CLI backend; on a disk-backend host it fails clearly.

Paths are relative to the scope root, end in `.md`, and may not contain `..`, empty segments, backslashes, or any segment starting with `.`. Content is limited to about 90 KB per call; split larger notes.

`/mem <text>` is Algorant's own quick capture (a slash command, not a tool): it opens a panel to confirm the scope (project or global), the target (a new note, or an append to a likely duplicate found by memory search) and the path, then writes an OKF note (`type: Note`, tag `memory/inbox`, `title` and `description` from the first sentence) through the same write paths as `memory_write` and `memory_edit`. Notes it creates are inbox notes: when you meet one, curate it (a real `type`, `description` and tags) with `memory_edit`. Do not call it yourself.

Read the relevant workflow: [search](docs/search.md), [write](docs/write.md), [import](docs/import.md), [digest](docs/digest.md), or [layout and OKF contract](docs/okf-adoption-spec.md).

For broad independent retrieval, delegate one coherent research question when several searches, matched-note reads, and synthesis are needed. Keep ordinary one-shot searches direct. After finding notes, use `memory_read` to inspect complete contents before detailed summaries. Memory search does not inject notes automatically; retrieve them explicitly.

Use the memory tools for every note operation, including content: the vault is not on a path that native `read`, `edit`, or `write` can reach safely.
