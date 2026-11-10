---
name: pi-memory-import
description: Import durable knowledge from URLs, folders, or files into pi-memory. Use when the user asks to preserve external content as memory.
---

# memory-import

Use this skill to curate durable memory from external sources. Do not treat import as file copying; treat it as selecting long-lived context worth remembering.

## Core rule

Analyze first, ask when focus is unclear, then generate confirmed memories using the `memory` write workflow skill.

## Workflow

1. Identify the source type: URL, local folder, or file.
2. Inspect the source safely and selectively.
3. Build a source profile: summary, detected topics, useful memory areas, and risks/noise.
4. Ask the user what to preserve unless they already gave a clear focus.
5. Ask the user to confirm the final memory folder/file path, and provide 3 concrete path options.
6. Generate memories with the `memory` write workflow skill, using confirmed paths, descriptions, tags, source refs, and concise content.
7. Report what was created. Obsidian Sync propagates notes; there is nothing to push.

## Source inspection

### URL

- Use Bun's isolated `bunx --bun defuddle` invocation for extracting readable page content; do not require a global installation or npm.
- Use markdown or JSON output depending on the task:
  - `bunx --bun defuddle parse <url> --markdown`
  - `bunx --bun defuddle parse <url> --json`
- Summarize durable knowledge from the extracted content.
- Do not save full webpage dumps by default.
- Prefer stable concepts, procedures, API usage, decisions, constraints, and project-specific facts.

### Local folder

- Use file listing before reading content.
- Ignore `.git`, `node_modules`, build outputs, hidden files, logs, caches, and generated artifacts.
- Never read `.env` files.
- Sample key files first, then ask before deeper inspection.

### File

- Read the file and determine whether it contains durable memory or temporary content.
- If it has markdown frontmatter, preserve useful metadata but normalize to memory format.

## Questioning rules

Ask a short focus question when the source contains multiple possible memory areas. Present concrete options.

Example:

```txt
I found these possible memory areas:
1. Architecture and module responsibilities
2. Development/test workflow
3. Tool/API usage
4. Project conventions
5. User-facing docs

Which should become long-term memory, and what should I ignore?
```

Do not ask the focus question if the user already specified the scope clearly. Still confirm the final folder/file path unless the user already gave an explicit path.

When asking for the final output path, provide 3 concise alternatives based on the detected topic and existing memory structure:

```txt
Where should I save the generated memory?
1. [folder]/[file].md
2. [folder]/[folder]/[file].md
3. [folder]/[file].md

Pick one, or provide a custom folder/file path.
```

## Metadata rules

- Imported memories must be OKF concept documents with YAML frontmatter containing at least `type`.
- Choose `Reference` for curated reference material, `Runbook` for procedural imports, `Project Note` for project-specific facts, or `Decision` for durable choices.
- Always generate `title`, `description`, `tags`, `created`, `updated`, and `timestamp` for every memory.
- `description` must be one concise sentence explaining why this memory is useful for future retrieval or agent behavior.
- `tags` must be an array of 2-5 separate, lowercase, short, reusable strings nested under `memory/`; never use a comma-separated tag string. example: `tags: ["memory/defuddle", "memory/web-scraping", "memory/cli"]`.
- Add `resource` only for a stable source URL/path, and preserve useful source metadata as non-destructive OKF extension fields when needed.
- Use a `# Citations` section when body claims come from external material.
- Do not use vague tags like `misc`, `notes`, or `imported` alone.

## Write rules

- Use concise, topic-based paths such as `<topic>.md` or `notes/<slug>.md`; do not use reserved OKF filenames `index.md` or `log.md` for concept imports.
- Use `memory_write` (see the `memory` write workflow) for each memory, with `description` as a string and `tags` as a string array. `create` refuses an existing note.
- Prefer existing project memory structure when known.
- Avoid overwriting existing memories unless the user explicitly approves an update.
- When updating an existing memory, `memory_read` it first and merge with `memory_edit` or a reviewed `overwrite` rather than replacing blindly.

## Quality bar

A good imported memory is:

- Durable across sessions
- Useful for future agent behavior
- Specific enough to guide action
- Concise enough to avoid noise
- Traceable to source refs

Avoid importing:

- Installation boilerplate unless project-specific
- Marketing copy
- Full source files
- Temporary notes
- Secrets, credentials, tokens, or `.env` content
- Large unfiltered transcripts or generated artifacts

## Related memory docs

- `memory` write workflow: Create or update memory files with proper metadata and path handling.
