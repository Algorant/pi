---
name: pi-memory-digest
description: Digest recent session context into curated memory markdown memories. Use when the user asks to summarize recent work, preserve decisions, extract learnings, or convert session history into durable memory.
---

# memory-digest

Turn recent session context into concise, durable markdown memory. Prefer curation over transcript summarization.

This local skill replaces the old tape-based `pi-memory` digest workflow. Tape is not available in `memory`; use session files, current conversation context, and existing memory search instead.

## Core rule

Inspect relevant context first, propose memory changes, then write only after user confirmation using the `memory` write workflow skill.

- Keep each memory focused on one durable topic.
- Save durable preferences, conventions, decisions, workflows, and recurring fixes as OKF concept documents.
- Prefer OKF `type` values `Decision`, `Project Note`, `User Profile`, or `Task Plan` depending on content.
- Do not save raw transcripts, temporary debugging noise, secrets, or one-off details recoverable from git.

## Workflow

1. Identify the scope:
   - current conversation only, or
   - recent Pi session files under `~/.pi/agent/sessions`, or
   - a specific project/session path the user names.
2. Inspect existing memories before proposing updates:
   - `memory_search({ scope: "all", query: "topic OR keyword" })`
   - `memory_check()` when paths/structure are unclear.
3. Extract durable candidates:
   - user preferences
   - project decisions
   - architecture constraints
   - reusable implementation patterns
   - recurring bugs and fixes
   - workflow habits
   - unresolved questions/future directions
4. Compare candidates against existing memory and decide create/update/skip.
5. Present proposed changes and ask for confirmation.
6. After confirmation, use `memory` write workflow to create or update files.
7. Report what was written. Obsidian Sync propagates notes; there is nothing to push.

## Proposal format

Before writing, respond with:

```md
# Proposed memory updates

## Create
- `path/to/file.md`
  type: Decision
  reason:

## Update
- `path/to/file.md`
  type: Project Note
  reason:

## Skip
- item:
  reason:
```

End by asking: `Proceed with these memory updates?`

## Related memory docs

- `memory` write workflow: Create or update memory files with valid frontmatter.
- `memory` search workflow: Search existing memory before proposing changes.
