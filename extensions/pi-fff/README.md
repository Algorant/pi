# pi-fff

## Purpose
custom extension for [fff](https://github.com/dmtrKovalenko/fff)

## Dependencies
- @ff-labs/fff-bun

## Components
- `index.ts` wires the tools, health/rescan commands, autocomplete, and native finder lifecycle.
- `find` and `grep` register during extension load so Pi can bind their custom renderers while rebuilding transcript rows before `session_start` on `/reload`. Execution resolves the current session resources at call time.
- Each bound session owns its primary finder, external finder pool, cursor store, and lifecycle generation. Shutdown invalidates deferred callbacks before it destroys these resources. A hidden SDK session cannot destroy or replace its caller's finder.
- `tools/`, `commands/`, `autocomplete/`, and `native/` hold the small feature modules.

## How to use
Reload Pi with this directory installed. Use `find`, `grep`, `@path` autocomplete, `/fff-health`, and `/fff-rescan` as needed.

## Examples
Ask the agent to find a file path with `find({ pattern: "config" })` or search content with `grep({ pattern: "registerTool" })`. Paths outside cwd use a visibly reported external FFF index. Existing file paths are checked against the applicable FFF index; if the exact file is not indexed, the search is refused with a message directing the agent to the `read` tool.

## Troubleshooting

Use ordinary `find` and `grep` calls first. If FFF reports zero indexed or candidate files unexpectedly, check the path/exclude constraint and remember that FFF does not index gitignored files; use the `read` tool to inspect a known file. Keep ordinary searches on FFF.

Grep `limit` is a target number of matching lines per page, checked at file boundaries: whole files are added until the total reaches `limit`, and the `cursor` advances by whole files. A single file with many matches therefore returns all of them in one page (verified against fff-bun 2026-09-30, task-307). This is deliberate: fff-bun's per-file cap (`maxMatchesPerFile`) drops the remaining matches with no cursor to reach them, so pi-fff does not set it. Narrow the path or pattern, or use `read`, for large files. A follow-up call with `cursor` keeps the original search's `limit` unless it passes its own; a grep with a non-default `limit` therefore returns a stored cursor token, like a scoped grep.

## Pattern text
FFF's grep query reads whitespace-separated words as file filters (`*.rs`, `!name`, `dir/`, `name.ext`, `type:`), so pattern words could silently become filters. A plain pattern is therefore searched with fff-bun `multiGrep`, which takes the literal pattern apart from the path and exclude filters (a pattern with a line break is refused). Regex and fuzzy-retry patterns have no such API: words starting with `*`, `!` or `/` are sent with FFF's documented `\` escape, and a word FFF cannot protect (trailing `/`, a `/` with glob characters, `{a,b}`, `type:`, `name.ext` beside other words, `\*`/`\!`/`\/`, or whitespace other than single spaces) is refused with the word and a rewrite (for example `\x2F` for `/`, `\x2E` for `.`). A plain pattern with such a word is not retried as fuzzy text.

## Path and exclude scope
An existing directory `path` bounds results to that directory: it is sent as an anchored `dir/**` glob relative to the index root, including when a reused external index is rooted at a parent (FFF's bare `dir/` token would also match `x/dir/` anywhere). A directory whose index-relative path contains whitespace, glob characters or a leading `!`/`\` cannot be expressed as one FFF token, so the search is refused. `exclude` entries apply inside that scope.

An existing file `path` is sent as its index-relative path when the name has an extension (`README.md`); FFF's query grammar has no file token for an extensionless name (`LICENSE`, `Makefile`), so it is sent as a `**/<path>` glob instead of being read as a directory. Both tokens also select same-named files elsewhere, and only the exact file's matches are returned. A file path FFF cannot express as one token (whitespace, glob characters, a leading `!`/`\`) is refused.

When a constrained grep finds nothing, fff-core retries the whole raw query as text with the path and exclude constraints dropped (an exact file path survives), and fff-bun does not report it; regex alternation or fuzzy mode then matches anywhere in the index. Grep therefore accepts only scope it can check on every returned match (`tools/scope.ts`):

- `exclude` entries must be directories (`dir/`, `dir/**`), `*.ext` or file names (`name.ext`, `dir/name.ext`). Other forms (`**/x/**`, other globs, bare words, `type:`) are refused before searching (`unenforceable-exclude`).
- Outside the workspace, `path` must be an existing directory or file; a glob or missing path is refused (`unenforceable-external-path`). Inside the workspace such a path is still passed to FFF as a fuzzy or glob filter, and the result says it is not enforced.
- Every native page (regex/plain, the fuzzy retry, exact-file pages) is checked. A page with any match outside the directory or under an exclusion is withheld and the call fails with `scope-violation` and no cursor; it does not claim the scope has no matches.
- Cursors of a scoped or path-filtered grep are stored tokens that keep their query and scope, so a follow-up call with only `cursor` cannot drop them.

## External indexes
External indexes are limited to three active roots, expire after five idle minutes, and are destroyed at session shutdown. The current Bun backend does not traverse directory symlinks; request the target directory directly when it must be indexed. Filesystem-root and exact-home-directory indexing are refused; request a narrower path instead.

## Bun-managed dependency lifecycle

`pi-fff` requires the official Bun-native `@ff-labs/fff-bun` package and Pi itself running under Bun. The shared manifest expects all of the following:

- `settings.json` sets `npmCommand: ["bun"]` and lists `npm:@ff-labs/fff-bun` in `packages`;
- Pi owns `agent/npm/package.json`, `bun.lock`, and `node_modules` through that package entry;
- npm/pnpm/yarn lockfiles and unrelated direct dependencies are treated as drift.

Install the package entry once with `pi install npm:@ff-labs/fff-bun`. On later starts, Pi automatically restores missing package artifacts with Bun because the source remains in `settings.json`. Use `pi update npm:@ff-labs/fff-bun` or `pi update --extensions` for updates; both honor `npmCommand` and therefore run Bun. Do not separately run npm or add `@ff-labs/fff-node`.

Run `/fff-health` after installation or updates. Keep searches on FFF; the only shell-search exception is the bounded `~/.pi/sessions` recipe in the global tool-use policy (`agent/AGENTS.md`) for recovering a known past Pi conversation.
