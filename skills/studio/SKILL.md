---
name: studio
description: "House style for things made for a person to see: which tool fits which job, the shared Verdigris look and taste rules, and one section each for Pele (Mermaid text to Verdigris SVG/PNG diagrams and charts), Words (Markdown to a self-contained Verdigris HTML document or a terminal view), Excalidraw (editable drawings in Algorant's Obsidian vault) and fframes (videos in code). Use when creating a diagram, chart, drawing, document, handout, video or other visual artifact, or choosing which tool to make it with; Sideshow renders its own mermaid surfaces with Pele."
metadata:
  short-description: Which creation tool for which job, and the shared house style
---

# Studio

House style for things made for a person to see. Pick the tool by the job
(table below), apply the shared style, then follow that tool's section. Each
kind of creation has its own section in the same shape (when to use, how, the
rules that matter); a new kind gets a new section and a row in the table.

Requirements: Bun, the local studio install at `~/.local/share/pi-studio`
(`pele`, `@resvg/resvg-js` and `@pierre/words`, all `latest`), and Liberation
Sans/Mono for PNG output. One-time setup, and the command both renderers print
when the install is missing:

    mkdir -p ~/.local/share/pi-studio
    cp ~/.pi/agent/skills/studio/package.json ~/.local/share/pi-studio/
    cd ~/.local/share/pi-studio && bun install

Refresh that install with `bun update` in the same directory.

## Which tool for which job

| Job | Tool | Result |
| --- | --- | --- |
| A diagram or chart from text (flow, sequence, state, architecture, timeline, xychart, …) for notes, READMEs, plans, research artifacts, image views or presentations | [Pele](#pele) | Verdigris SVG and PNG files |
| A diagram in a Sideshow post | Sideshow `kind:"mermaid"` (the `sideshow` skill) | Sideshow renders it with Pele itself; do not render or upload Pele files there |
| A document someone reads end to end: a report, spec, research write-up or handout, especially one with math, tables or diagrams | [Words](#words) | a self-contained Verdigris HTML page, or a terminal view |
| A drawing Algorant opens and edits by hand: a sketch, a whiteboard, a layout he will move around | [Excalidraw](#excalidraw) | an `.excalidraw.md` drawing in his vault |
| A video, animation, motion graphic, teaser, title card or poster | [fframes](#fframes) | a rendered video (draft first) |

Reach for Pele first for any diagram or chart; choose Words for a whole
document, Excalidraw only when Algorant will work on the drawing himself, and
fframes only for motion or a rendered video.

## Shared style

### Verdigris palette

Everything uses Algorant's Verdigris palette (`~/Projects/verdigris`;
canonical data in `css/palette.json`), dark by default.

| Core | Hex | Role |
| --- | --- | --- |
| ashbronze | `#665c54` | background / weathered metal |
| vellum | `#ebdbb2` | foreground / warm text |
| fern | `#8ec07c` | bright green accent |
| patina | `#689d6a` | primary green |
| aqua | `#83a598` | cool aqua accent |
| ochre | `#e6bf86` | warm brass accent |

Additional colours for roles outside the core: moss `#70764a`
(additions/success), teal `#458588` (secondary blue-teal), oxblood `#74363d`
(removals/errors; a fill, too dark for text: red text uses `#c66f70`),
goldenrod `#b8863b` (warnings/search), deep copper `#b9805f`
(changes/caution), ink-violet `#8989b0` (rare accent).

Each tool carries its own tuned Verdigris: Pele's
[`pele/verdigris.json`](pele/verdigris.json), the Excalidraw skill's `V`
table of stored colours, and fframes' `verdigris-dark` / `verdigris-paper`
presets. Use those rather than pasting raw hex.

### Taste rules

- **Smallest thing that works.** Use the smallest suitable diagram; about 12
  nodes at most, otherwise split it. In video, several short scenes beat one
  long one.
- **Short labels.** One idea per node in a few words; detail goes in the
  reply or the text around it, not the picture.
- **Colour shows role.** Give the same kind of thing the same colour, and use
  only a few roles per piece.
- **Real content.** Label illustrative data as illustrative; never invent
  values shown as real. Copy and calls to action that are not in the source
  are Algorant's to give.
- **Look before showing.** View the rendered PNG or an extracted frame yourself with the `read` tool before reporting it, and fix crowding, overlaps, crossed arrows and low contrast (small muted text on dark is the least readable) before Algorant sees it.
- Taste, brand and visible results are Algorant's call (global AGENTS.md,
  *Only Algorant decides*): deliver visible work for his look.

## Pele

### When to use
Reach for Pele first when creating a diagram or chart, then use its image files in any destination. Use the smallest suitable diagram; keep labels readable and label illustrative data.

### Render
Resolve the bundled script relative to this skill directory. From the input's working directory:

    bun ~/.pi/agent/skills/studio/pele/render.ts diagram.mmd out/

This writes `out/diagram.verdigris.svg` (literal colours) and `out/diagram.verdigris.png` (2x), and prints their paths, dimensions and timings. Use `-` instead of the input file for stdin. Verdigris is the default; the optional last argument `pele-default` uses Pele's own colours.

### Colours
Edit this skill's `pele/verdigris.json`: direct `--pele-*` keys and hex values, initially copied from the accepted showcase palette. The next render reads it. This does not change Herdr's theme.

### Examples
See `../../../plan/pele-showcase/src/`: `01-flowchart.mmd` for agent roles, `04-state.mmd` for Tandem, and `12-xychart.mmd` for an illustrative Usage chart. The showcase README lists all supported families and their syntax.

### Use the files
Use SVG or PNG in a README, plan/research artifact or image view. Render outside the vault; attach/embed into notes through the owning vault workflow (`memory` skill), not raw vault writes.

### Limits
Pele outputs SVG; the script inlines CSS functions before PNG rasterisation. Widths are Arial-table estimates, so dense diagrams and non-Latin labels can still crowd. Inspect the result; shorten or split it when needed. External Mermaid plugins are unsupported. No browser or widget change is required.

## Words

### When to use
A document someone reads end to end: a report, spec, research write-up or
handout, especially one with math, tables or diagrams. Also a quick, readable
look at a `.md` file in a terminal. For a diagram alone use Pele; for something
to review with Algorant, with versions and comments, use Sideshow.

### Render
Resolve the bundled script relative to this skill directory. From the input's
working directory:

    bun ~/.pi/agent/skills/studio/words/render.ts doc.md out/

This writes `out/doc.html` (named for the input's stem), one self-contained page
with Words' own styles, the Verdigris layer, TeX math as SVG, `mermaid` fences
as Pele SVG, GFM tables and task lists. It prints one JSON line with the path,
bytes, rendered diagram count and timing. Raw HTML is removed; pass `--trusted`
for input you wrote or otherwise trust.

For a terminal view:

    bun ~/.pi/agent/skills/studio/words/render.ts doc.md --terminal 80

This prints Words' ANSI at that width (default 80) with its 256-colour accents
remapped to Verdigris truecolour. A terminal cannot draw images, so math stays
TeX and diagrams stay Mermaid source.

### Colours
`words/verdigris.css` is the document layer over Words' `styles.css`, and it
reads the same `pele/verdigris.json` tokens the diagrams use, so a document and
the diagrams inside it match. Edit the palette there for both.

### Use the files
Open the HTML in a browser, attach it to a note or send it as a file: it needs
no network and refers to no external file. Diagrams for anywhere else come from
Pele. Do not write into the vault; notes go through the `memory` skill.

### Limits
Words' math SVGs name STIX Two Math, Cambria Math and Latin Modern Math, so a
machine with none of them falls back through its generic math and serif fonts.
A renderer that rasterises SVG text without font fallback (Obscura) shows those
glyphs as boxes, so check math in a browser or a resvg raster instead. Code
fences keep their own line length: a long line wraps in the terminal and scrolls
inside its block in the page. Look at the result before sending it.

## Excalidraw

### When to use
A drawing Algorant will open and edit himself in Obsidian, or a request to
draw, sketch or diagram something in Excalidraw, or to check what changed in
a drawing.

### How
The Excalidraw project (`~/Projects/excalidraw`) owns the working skill:
`~/Projects/excalidraw/.pi/skills/excalidraw/SKILL.md`.
Pi sessions in that repository load it; from anywhere else, read that file in
full before drawing. It holds the drawing template, the stored-colour `V`
table and the read-back and look scripts.

### Rules that matter
- Drawings go only in `Agentic/excalidraw/` in the `MasterVault` vault,
  through the Obsidian CLI and the plugin's ExcalidrawAutomate API; never
  hand-write `.excalidraw.md` files or touch Algorant's own drawings or the
  plugin's settings.
- Dark mode transforms stored colours: use the skill's `V` table (or its
  `shownAs` helper), never a Verdigris hex directly.
- The PNG view is for the agent to check its own work; Algorant opens
  drawings in Obsidian.

## fframes

### When to use
A video, animation, motion graphic, teaser, changelog clip, title card or
poster rendered in code.

### How
Work in the fframes project (`~/Projects/fframes`), which owns the setup and
guidance; read its `AGENTS.md` first.

- Craft: the upstream `fframes-video` skill, vendored unmodified at
  `.agents/skills/fframes-video/SKILL.md` with `references/api.md`,
  `design.md` and `audio.md`. Pi loads it in that repository; do not install
  it globally.
- House style for video: `style/README.md` (fonts, the Verdigris dark and
  paper presets, components).
- **Work to tap into:** the project's `project-video` skill
  (`.agents/skills/project-video/SKILL.md`) holds the workflow for videos
  about a software project (resolving scope, scaffolding, presets, music
  beds, checks, delivery, gotchas), and `videos/LOG.md` records what each
  video covered. (That skill calls its repository "the studio"; it means the
  fframes repo, not this skill.)

### Rules that matter
- No tests of any kind for videos; the checks are the fframes CLI outputs
  (`timeline`, `inspect`, `strip`, `frame`, `audio analyze`). Look at the
  PNGs before calling anything good.
- Render the full video only when asked; for review offer `preview <time>`
  or a draft.
- Never put renders, drafts or scratch files in `/tmp` (a RAM-backed tmpfs);
  use `~/.cache/fframes/scratch/<video>/` and render through mise.
