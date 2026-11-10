# Memory write

1. Run `memory_check` and verify the vault and the resolved `Agentic/memory/projects/<project-id>` root.
2. Search for an overlapping note with `memory_search`; read it with `memory_read`.
3. Choose a path relative to the scope: directly in the scope or in an optional topic folder such as `research/`, `runbooks/`, or `references/`. Use `scope: "global"` only for knowledge that is not project-specific.
4. New note: `memory_write({ path, content, mode: "create" })`. It fails if the note exists. Replacing a whole note: `mode: "overwrite"`, which fails if the note is missing. Small change: `memory_edit` with an `oldText` that occurs exactly once.
5. Content is an OKF concept: frontmatter with `type`, and preferably `title`, `description`, `tags` (a YAML array of 2-5 short lowercase strings nested under `memory/`, e.g. `memory/nas`), `created`, `updated`, and ISO-8601 `timestamp`. Preserve unknown frontmatter fields. When changing an existing note substantively, refresh `updated` and `timestamp` in the same write or edit.
6. The result warns when the written note is not a valid OKF concept; fix it with `memory_edit` or an overwrite. `memory_check` reports every nonconforming note.

Paths end in `.md` and may not contain `..`, backslashes, or segments starting with `.`; the tools reject them. A single call carries about 90 KB of text at most. Do not create empty placeholders. `index.md` and `log.md` are reserved OKF names. Paths do not determine OKF metadata. Obsidian Sync propagates the change; there is nothing to push.

Notes Algorant captured with `/mem` carry `type: Note` and the `memory/inbox` tag as placeholders. Replace them with a real `type`, a `description` and 2-5 nested tags with `memory_edit` when you touch the note, and drop `memory/inbox` once it is curated.
