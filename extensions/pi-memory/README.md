# pi-memory

## Purpose
my simple memory system, which goes to my obsidian vault

## Dependencies
- obsidian
- flock
- [shared Obsidian CLI client](../lib/obsidian-cli.ts)

## Client requirements

GUI Obsidian with its command line interface enabled (the `obsidian` command on `PATH`). Obsidian is started automatically (detached, via `uwsm-app -- obsidian`) when it is not running, which requires a graphical session (`WAYLAND_DISPLAY` or `DISPLAY`) and `uwsm-app`; on headless machines it must already be running. In a bare SSH shell (no `DISPLAY`, where the CLI would crash with `Trace/breakpoint trap`) the client takes the session variables from `systemctl --user show-environment` and runs the CLI through `env` with them; if the user manager has no `DISPLAY` either, the call fails naming `DISPLAY`. When an Obsidian process runs but `$XDG_RUNTIME_DIR/.obsidian-cli.sock` is missing, the client fails asking for a restart instead of launching it again (task-461). Never run the CLI with an isolated `HOME`/config while sharing the real `XDG_RUNTIME_DIR`: that unlinks the running app's socket. `flock` (util-linux) is required for the cross-process CLI lock. On Omarchy, `user-flags.conf` for Obsidian must use `--disable-gpu`.

## Overview

Notes are Markdown files in the vault, reached through **one backend fixed by configuration**: the Obsidian CLI by default, or the vault directory on disk on a host whose global settings set `vaultPath` (see [Disk backend](#disk-backend)). **Obsidian Sync owns synchronization**: there is no Git, no sync tool, and no fallback path; nothing switches backends at runtime. Missing configuration, an unknown vault, an absent or disabled CLI, an `Error:` result, and a timeout (Obsidian not running) fail with a clear message.

Supported hosts: workstation and laptop (CLI), homelab-server (disk backend over Obsidian Headless Sync), and any other host that configures the disk backend for its own synced vault copy. old-laptop and any other host without the CLI or a `vaultPath` fail clearly.

## Layout

```text
<vault>/Agentic/memory/
├── global/
└── projects/<project-id>/
```

Notes can live directly in each scope. Add subfolders only when useful. Directory nesting does not control OKF metadata.

## Configuration

Per-machine, untracked global `settings.json`:

```json
{ "pi-memory": { "vault": "MasterVault" } }
```

Optional project `.pi/settings.json`: `{ "pi-memory": { "projectId": "<stable id>" } }`. To act on another project's memory for one call, pass the tool's `project` parameter (see [Tools](#tools)); it needs no settings change. Only `vault`, the global-only `vaultPath`, and `projectId` are read; the retired `repoUrl`, `localPath`, `memoryDir.*`, `globalMemory`, and `pi-memory-md` keys are ignored.

The project ID is the normalized Git-root basename (lower-case, filesystem-safe); Pi configuration maps to `pi`. Obsidian cannot see dot-prefixed folders, so leading dots are stripped (`.dotfiles` → `dotfiles`), an ID that is empty after normalization is an error, and note paths with any segment starting with `.` are rejected. A real `pi` repository would collide with Pi configuration and needs an explicit `projectId`.

## Disk backend

Only for hosts without the Obsidian CLI that keep a full, synced copy of the vault on disk: for example homelab-server with [Obsidian Headless Sync](https://help.obsidian.md/sync/headless) (`ob sync --continuous`). Selected solely by the per-machine global `settings.json`:

```json
{ "pi-memory": { "vault": "MasterVault", "vaultPath": "~/vaults/MasterVault" } }
```

`vaultPath` is ignored in project settings; it must be absolute or start with `~/`, and the directory must contain `.obsidian/`, or every call fails clearly. Without `vaultPath` the CLI is used exactly as before, and a CLI failure never falls back to disk. Implemented in [`disk.ts`](disk.ts):

- Same vault-relative paths, path validation, OKF check, and error messages as the CLI backend.
- Writes are atomic: a dot-prefixed temp file in the target folder (ignored by Obsidian and Sync), fsynced, then `link()` for `create` (fails if the note exists) or `rename()` for `overwrite` and `memory_edit`.
- `memory_search` supports plain words and `"phrases"` (case-insensitive substrings), `/regex/` (case-insensitive), and `tag:name` (frontmatter `tags`, nested: `tag:memory` matches `memory/nas`). All terms must match the same note. Any other Obsidian operator (`path:`, `file:`, `line:`, `section:`, `[property]`, `OR`, `-term`, parentheses) fails with a clear message.
- `memory_check` reports `Backend: disk (<path>)` or `Backend: obsidian-cli`.

## /mem

`/mem <text>` captures a memory snippet without an LLM and without interrupting the agent (the handler returns at once; the capture runs detached). It opens the same docked capture panel as `/task` ([`../lib/capture-panel.ts`](../lib/capture-panel.ts)); [`capture.ts`](capture.ts) supplies the rows and the write. It registers one slash command and **no LLM-callable tool**.

1. Duplicate search: up to four distinctive words from the text (lower-cased; stopwords and words under four letters dropped; longest first) are searched one by one in the project and global scopes with the same `searchContext` call `memory_search` uses, so it works on both backends. A note matching at least two of the words (one when there is only one) is listed as a possible duplicate, at most three per scope. A search or vault failure shows the error in the panel and only `esc` works; nothing falls back to a new note.
2. Panel rows (`↑↓` moves between them, `←→` changes a choice, `o` previews a duplicate, `esc` cancels, `enter` saves):
   - `scope`: `project <id>` (the resolved project ID) or `global`.
   - `target`: `new note`, or `append → <path>` for each duplicate in that scope. Changing the scope resets the target.
   - `path`: editable, relative to the scope root, default a slug of the title (first six ASCII words, `.md`; `note-YYYYMMDD-HHMM.md` when nothing is left). Type `topic/name.md` for a topic folder. It shows the existing path, read-only, when appending.
3. Saving goes through the same session and write helpers as `memory_write` and `memory_edit` ([`session.ts`](session.ts)): path confinement, the configured backend (Obsidian CLI, or disk where `vaultPath` is set) and the OKF check. A new note is written with `create`, so an existing path fails with `File already exists` and the panel stays open to change the path. Appending replaces the note's whole text with the same text plus the new paragraph (`replaceOnce`, so a note changed meanwhile fails clearly) and refreshes `updated` and `timestamp` when the note has them. A failure keeps the panel open (`Saving failed: …`); cancelling writes nothing.

A new note:

```text
---
type: Note
title: "<first sentence or line, at most 80 characters>"
description: "<same>"
tags:
  - memory/inbox
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
timestamp: "YYYY-MM-DDTHH:MM:SS±hh:mm"
---

<the text as typed>
```

`type: Note` and the `memory/inbox` tag are placeholders; set a real type, description and tags later with `memory_edit`. Typed text only; there is no classifier, last-message or selection capture. Per [the memory skill](../../skills/memory/SKILL.md), never capture secrets.

## Tools

`memory_check`, `memory_search`, `memory_read`, `memory_write`, `memory_edit`, `memory_trash`. Every tool takes an optional `project` (project ID, validated and normalized exactly like `projectId`: lower-cased, unsafe characters replaced, leading dots stripped, empty is an error) that replaces the current project for the project scope. Each verifies once per call that the CLI resolves exactly the configured vault name, because an unknown vault name silently targets the active vault.

- `memory_search({ query, scope, project })`: Obsidian search syntax (`tag:x`, `/regex/`, `"phrase"`, `path:`, `[property:value]`) over `project` (default), `global`, or `all`.
- `memory_write({ path, content, mode, scope, project })`: `create` fails if the note exists; `overwrite` fails if it is missing.
- `memory_edit({ path, oldText, newText, scope, project })`: one exact, unique replacement through `app.vault.process`.
- `memory_trash({ path, scope, project })`: `app.fileManager.trashFile`, which follows Obsidian's Deleted files setting.
- `memory_trash` fails clearly on the disk backend (trash semantics under Headless Sync are unverified).
- `memory_check({ directory, project })`: vault, backend, project ID and the vault-relative project and global roots, file counts and listing, and the OKF conformance report. `memory_read` and `memory_check` read the vault state.

Note text never travels through the CLI's `content=` argument, which rewrites backslash sequences. Writes go through `obsidian eval` with a base64 payload decoded inside Obsidian, so they are byte-faithful; one call carries about 90 KB of text. Paths are relative to the scope root and end in `.md`. CLI calls run one at a time, within a process by a queue and across Pi processes by an exclusive per-user `flock` on `$XDG_RUNTIME_DIR/pi-obsidian-cli.lock` (held by a short-lived `flock` child, released when it exits or Pi dies, 60 s wait), because concurrent invocations returned each other's output. Raw `obsidian` shell commands are not covered.
