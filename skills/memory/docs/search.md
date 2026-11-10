---
name: pi-memory-search
description: Search and retrieve information from pi-memory notes in the Obsidian vault. Use when you need to search memory.
---

# Memory Search

Search and retrieve OKF-shaped memory notes with Obsidian's search.

## Required tool discipline

Use the memory extension tools for all memory work:

1. Use `memory_check` to list current project/global memory notes and inspect OKF concept/nonconformance counts when the user asks what memories exist or asks for an overview.
2. Use `memory_search` to find relevant notes.
3. Use `memory_read` to inspect the full text of specific notes before summarizing detailed contents.
4. Do **not** use `bash`, `find`, `rg`, or other shell access to the vault, and do not read vault files from disk yourself. The vault is reached only through the memory tools (the Obsidian CLI, or the tools' disk backend on headless hosts).
5. Search results and `memory_check` list paths relative to the scope root. Pass them unchanged to `memory_read` together with the same `scope`.

For a request like “what are the current memory files and their basic contents,” the correct flow is:

```
memory_check({})
memory_read({ path: "<note-path>" })
memory_read({ path: "<next-note-path>", scope: "global" })
```

Then summarize from the `memory_read` outputs.

## Query syntax

`memory_search({ query, scope })` passes `query` to Obsidian's search, limited to the scope root (`project` by default, or `global`, or `all`). It supports:

| Syntax | Meaning |
|--------|---------|
| `typescript` | Notes containing the word (terms are ANDed) |
| `"exact phrase"` | Exact phrase |
| `typescript OR javascript` | Either term |
| `-draft` | Exclude a term |
| `tag:memory/probe` | Notes with a tag (frontmatter `tags` included); memory tags are nested under `memory/` |
| `/regex/` | Regular expression, for example `/\bAPI\b/` |
| `path:research` | Notes whose path contains the text |
| `[type:Decision]` | Frontmatter property filter |

A note matched by a tag, path, or property filter is listed without a matching line.

On headless hosts using the disk backend (`pi-memory.vaultPath`, for example homelab-server), only plain words, `"exact phrase"`, `/regex/`, and `tag:` are supported, all ANDed and case-insensitive. `OR`, `-term`, `path:`, `[property]`, and other operators fail with a clear message; run separate searches instead of `OR`.

## Examples

```
memory_search({ query: "typescript" })
memory_search({ query: "architecture OR component OR module", scope: "all" })
memory_search({ query: "tag:memory/user", scope: "global" })
memory_search({ query: "[type:Decision]" })
memory_search({ query: "/\\bAPI\\b/" })
```

## Rules

- Search results are capped per scope; narrow the query rather than paging.
- Treat `index.md` and `log.md` as reserved OKF files, not normal concept documents.
