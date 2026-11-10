# Pi session archive (manual, per-machine)

`agent/scripts/pi-session-archive.ts` is a small operator tool that moves old
Pi session JSONL files out of their live session roots into a per-machine
archive, and restores one exact archived file on request. It is deliberately
**not** a scheduler, Pi extension, remote backup, compression layer, or
pi-agency integration, and it never touches Pi runtime or settings.

Run it by hand, on one machine. Pi may be open; see the accepted risk below.

## Accepted open-session risk

There is no process check and no offline guarantee. A session that is still
open and appends after its file was archived keeps writing to the original
path, so that history splits between the archive copy and the new file at the
original path. Algorant accepted this in exchange for running the tool without
closing Pi. The tool does not prevent, detect, or clean up that split; that is
the deliberate trade-off, not a bug.

## Guarantees

- **Preview is the default.** It lists candidates and writes nothing.
- **Archived bytes are identical by construction.** A move hardlinks the source
  inode into the archive, fsyncs the archive directory, and only then unlinks
  the source. Restore is the same move in reverse.
- **Nothing is permanently deleted.** `unlink` happens only after the same
  inode is reachable at the other path.
- **Fail closed.** Collisions, non-session files, symlinks, unsafe or
  overlapping roots, an ambiguous restore root, and a cross-filesystem archive
  root all abort without overwriting.

## Commands

Run from the checkout root, or use the absolute script path from anywhere:

```sh
cd ~/.pi
bun agent/scripts/pi-session-archive.ts --help
bun agent/scripts/pi-session-archive.ts preview
bun agent/scripts/pi-session-archive.ts archive
bun agent/scripts/pi-session-archive.ts archive --days 30 --root ~/.pi/sessions
bun agent/scripts/pi-session-archive.ts restore ~/.pi/sessions_archive~/.pi/sessions/<file>.jsonl
```

From any other directory, use `bun ~/.pi/agent/scripts/pi-session-archive.ts <args>`
instead of the relative `agent/scripts/...` path.

- `preview` (or no subcommand) scans roots and reports which files are older
  than the cutoff. Read-only.
- `archive` moves every candidate. Re-runnable: a completed run is a no-op, and
  a run interrupted between link and unlink is finished on the next run.
- `restore <archived-file>` moves that one file back to its original absolute
  path. The path is reconstructed losslessly from the archive layout and must
  match exactly one configured `--root`; zero or multiple matches abort.

Options: `--root DIR` (repeatable), `--archive-root DIR`, `--days N`
(default 60, filesystem mtime), `--json`.

## One-time preserved-root cutover

A machine can hold valid sessions outside every live root, for example the
`~/.pi.preserved/agent/sessions` backlog discovered on this machine (339 files,
earliest 2026-04-21). Start with a read-only review of the recent backlog:

```sh
cd ~/.pi
bun agent/scripts/pi-session-archive.ts preview --days 30 --root ~/.pi.preserved/agent/sessions
```

That preview moves nothing. Moving the whole preserved backlog is a separate,
explicit cutover the operator chooses only after reviewing the preview:

```sh
bun agent/scripts/pi-session-archive.ts archive --days 1 --root ~/.pi.preserved/agent/sessions
```

`--days N` is an mtime cutoff, so `--days 1` covers the preserved backlog while
a file modified within the last day stays put; the operator picks the cutoff to
run. The move is a hardlink relocation, so JSONL bytes and inodes are unchanged
and the mirrored layout records each file's original absolute path.

## Roots and layout

Source roots resolve as: explicit `--root`, otherwise a nonempty
`PI_CODING_AGENT_SESSION_DIR`, otherwise `$PI_CODING_AGENT_DIR/sessions` or
`~/.pi/agent/sessions`. An empty `PI_CODING_AGENT_SESSION_DIR` fails closed
rather than silently substituting another root.

The default archive root is `~/.pi/sessions_archive`, which the repository
`.gitignore` leaves untracked. The layout mirrors each absolute source root
below the archive root:

```
<archive-root>/<absolute-root-without-leading-slash>/<root-relative-path>
```

The mirror is lossless, so an archived file keeps its original location and
restore never has to guess. Source roots and the archive root must be on one
filesystem (the move is a hardlink); a cross-device archive root fails closed.

## Disk and `/resume`

The move is a hardlink, so the archived bytes stay on the same volume and no
space is freed. Archiving **declutters `/resume`** by removing old sessions
from the live session roots; it does not save disk space. It is not a backup:
the archive lives on the same machine and the same filesystem.

## Operator handoff

There is no shutdown prerequisite and no active-Pi check. The operator decides
when to run; a still-open session can split its history as described above.

1. Preview: `cd ~/.pi && bun agent/scripts/pi-session-archive.ts preview`
2. Confirm the roots, cutoff, and candidate list.
3. Archive: `cd ~/.pi && bun agent/scripts/pi-session-archive.ts archive`
4. Verify a sample with `restore` if needed.

## Validation status

No live session history was archived during development; the script was
validated only against synthetic temporary fixtures outside this repository's
suite. Archive and restore were exercised with synthetic fixtures while this Pi
was running. This repository does not add a permanent test file for this tool.
