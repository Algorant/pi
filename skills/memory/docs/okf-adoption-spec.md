---
type: Specification
title: pi-memory layout and OKF contract
description: Canonical vault layout, project identity, configuration, and OKF rules for pi-memory.
tags: [pi-memory, okf, obsidian]
---
# pi-memory layout and OKF contract

## Storage

Memory lives in Algorant's Obsidian vault under `Agentic/memory/`: `global/` and `projects/<project-id>/`. It is reached only through the memory tools: by the Obsidian CLI, or by the tools' disk backend on a headless host whose global settings set `vaultPath` (Obsidian Headless Sync keeps that copy current). Obsidian Sync is the sole synchronization mechanism. Project folders can contain notes directly, and topic subfolders are added only when useful. Paths do not imply OKF type or delivery behavior. `Agentic/bookmarks/` belongs to another tool and is not part of memory.

## Configuration

- Global, per machine, untracked `settings.json`: `"pi-memory": { "vault": "<vault name>" }`.
- Optional project `.pi/settings.json`: `"pi-memory": { "projectId": "<stable id>" }`.

The global-only `vaultPath` selects the disk backend on headless hosts and is the only other key read; no other `pi-memory` key is read; the retired `repoUrl`, `localPath`, `memoryDir.*`, `globalMemory`, and `pi-memory-md` settings are ignored without migration. The CLI must resolve exactly the configured vault name before any operation, because the CLI silently targets the active vault for an unknown name. Missing configuration, an unknown vault, an absent or disabled CLI, an `Error:` result, and a timeout are errors with no fallback.

Supported hosts are workstation and laptop (GUI Obsidian with the CLI enabled; on Omarchy `user-flags.conf` must use `--disable-gpu`). homelab-server uses the disk backend. old-laptop and any host without the CLI or a `vaultPath` fail clearly.

## Identity and paths

The default project ID is the lower-case, filesystem-safe Git-root basename; a non-Git directory uses its current basename; Pi configuration (anything under `~/.pi`) uses `pi`. Overrides are normalized to lower-case letters, digits, `.`, `_`, and `-`.

- Obsidian cannot see dot-prefixed folders or files, so **leading dots are stripped** (`.pi` → `pi`, `.dotfiles` → `dotfiles`), and any note or folder path segment starting with `.` is rejected.
- An ID that is empty after normalization is an error.
- Colliding IDs need an explicit stable readable `projectId` in project settings. A real `pi` repository collides with Pi configuration and needs one.
- Note paths are relative to the scope root, end in `.md`, and contain no `..`, empty segment, backslash, or NUL.

## OKF

Each concept is Markdown with frontmatter and a non-empty `type`. Recommended fields are `title`, `description`, `tags`, `created`, `updated`, and ISO-8601 `timestamp`. Tags are nested under `memory/` so memory stays out of Algorant's personal vault tag list. Metadata is independent from directory nesting. `index.md` and `log.md` remain reserved. `memory_check` reports nonconforming notes and `memory_write` warns when a written note is not a valid concept.

## Safety

Require explicit confirmation before sensitive storage, overwriting or deleting useful notes, and large recursive imports. Never persist secrets or raw transcripts. `memory_write` with `create` never replaces an existing note and `overwrite` never creates one; `memory_edit` requires one exact, unique match. Content is limited to about 90 KB per call.
