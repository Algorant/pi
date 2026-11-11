---
name: herdr
description: "Use herdr-core (CLI `hc`) to run a background job, a long-running command or server, a sub-agent or another agent, or work on another machine, and to read or control terminals; prefer it over your own sub-agent tool, a shell '&', nohup or tmux. Then, for Herdra's window: build and check Herdr app mods, widgets, overlays, mod panes and layouts."
---

# Herdr

Two sections: [herdr-core](#herdr-core-upstream-verbatim) (`hc`: terminals,
children, other machines; an upstream copy kept verbatim) and
[Herdr app widgets](#herdr-app-widgets) (mods, overlays, mod panes and
layouts for Herdra). This Pi skill is named `herdr` but covers herdr-core and
the Herdr app; the old `herdr` multiplexer and its skill, which the upstream
text below mentions, are retired.

## herdr-core (upstream, verbatim)

Provenance: the text up to *Local note* is a verbatim copy of the skill text
that ships with [herdrdev/herdr-core](https://github.com/herdrdev/herdr-core)
(at commit `dbcdcffc779f7516d5815cbd6f0a37da2b5e6628`), licensed Apache-2.0;
see [LICENSE](LICENSE) and [upstream.json](upstream.json). Do not edit it
locally; local guidance goes in *Local note*.

This skill is for herdr-core, whose command is `hc`. It is not `herdr`,
the older terminal multiplexer: that has its own `herdr` command and skill.
Use `hc` here, never `herdr`.

If `$HC_TERMINAL_ID` is set, you're running inside herdr-core: use hc.
If not, ask the user once this session whether to use hc for this work.

Before using hc, run `hc --skill` and follow it.
For the Herdr window (spaces, tabs, layouts, mods, what's shown),
run `herdr-app --skill`.

### Local note

Start read-only children, manus, Cephs and Workers with the pi-herdr dispatch tools (`dendra_start`, `manus_start`, `ceph_start`), never a hand-written `hc run`; `agency` describes them, their reports and child lifetime. `agent_send` is the durable agent inbox. hc and the Herdr app are the single current path; the old `herdr` command and its skill are retired. Never stop or update the user's core or app. For agent work, end the turn and act on the inbox (global AGENTS.md, *Work*); `hc wait` and `--timeout` are for a person watching one command, never for an agent waiting on another agent, child or message.

`hc keys` presses named keys, not text: names are case-insensitive (`A` types `a`; `shift+a` types `A`), `space` is the space, a bare space or `colon` is rejected, and `shift+;` types `;`, so `:` and other shifted punctuation cannot be typed. Literal text (case, spaces, punctuation, paths) goes only through `hc send`, which pastes it exactly and always presses Enter. No native hc method types literal text into a draft without submitting it; that is an upstream herdr-core limitation, so never emulate it with `hc keys`.

## Herdr app widgets

Use this section only for Herdr app mods/widgets, overlays, mod panes, and layouts in Herdra. Herdr's installed guide and generated API declarations are authoritative; this section keeps only the Herdra-specific facts and conventions the guide does not state. Paths such as `herdr-app/<mod>/mods/<mod>` are in the Herdra repository (`~/Projects/herdra`). [Official: `defaults/AGENTS.md`, “What mods are written in”, “Layouts”, “Mods”, “A mod”, “UI”; generated `herdr.d.ts` and `gpui-kit.d.ts`.](https://github.com/herdrdev/herdr-app/blob/7fe7ac34fef8a3ee76cb5d2f17bc8d6331e50bd/defaults/AGENTS.md)

### Before building

Read `~/.config/herdr-app/AGENTS.md` and the generated `herdr.d.ts` and `gpui-kit.d.ts`; inspect the target layout, mod, and relevant shipped examples. Those type files describe this installed Herdr version. Shipped mods/layouts are Herdr-owned: clone before changing them. [Official: “What mods are written in”, “Layouts”, “Mods”.](https://github.com/herdrdev/herdr-app/blob/7fe7ac34fef8a3ee76cb5d2f17bc8d6331e50bd/defaults/AGENTS.md#layouts-layoutsnamejson)

### Herdra-specific behaviour

- For a mod pane, follow the layout's block and pane-frame contract. For overlays, use `openOverlay` with the intended `kind`, `frame`, and size; close with `closeOverlay`. Window overlays can be dragged; stop mouse-down propagation on controls that should not drag the window. A `key` remembers the dropped position, which takes precedence over a later computed `at`. [Official: “Pane frames”, “Floating blocks”, “The `herdr` module”; `src/window.rs` Overlay and `src/window/movable.rs` at the cited commit.](https://github.com/herdrdev/herdr-app/blob/7fe7ac34fef8a3ee76cb5d2f17bc8d6331e50bd/src/window/movable.rs)
- **Overlay units:** `window.viewport_size()` reports pixels. Convert viewport bounds to design units by dividing by `settings().zoom`; overlay `width` and `height` are supplied as designed and drawn at current zoom. Position is different: the upstream `Overlay.at` is stored as `Point<Pixels>` (`src/window.rs:311`), and `render_window` uses `at.x`/`at.y` directly for `.left(x).top(y)` without zoom (`src/window/movable.rs:92, 99-100, 128`). Therefore multiply a position computed in design units by `zoom` before passing `at`. [Upstream Herdr source, master at `b721deda985270ec8256552692729a4add389b2a`: `window.rs` Overlay fields; `movable.rs` `render_window`.](https://github.com/herdrdev/herdr-app/blob/b721deda985270ec8256552692729a4add389b2a/src/window.rs#L311-L313)
- **Responsive behavior is not prescribed by the official guide.** Its examples use flex layout, fixed pixel sizes, weights, min/max constraints, and overlays sized from content or explicit dimensions; do not present a particular responsive policy as official. [Official examples: `defaults/layouts/main.json`, `defaults/layouts/terminals.json`, shipped `defaults/mods/agents/main.js` and `tabs/main.js` at the cited commit.](https://github.com/herdrdev/herdr-app/tree/7fe7ac34fef8a3ee76cb5d2f17bc8d6331e50bd/defaults)
- **Herdra convention:** prefer flex/weight-based space for mod content; use `on_size_change` when content genuinely needs its available logical size. Avoid tying inner content widths to an outer window's fixed width. For overlays derived from a viewport, account for zoom as above; a keyed window's remembered dropped position overrides `at`. This convention applies Herdr's documented APIs to Herdra; it is not a Herdr-prescribed responsive standard.

### Recipes

- **Reader window (Sideshow and Herdra):** keep the same small `readerWindow()` helper in each mod's `main.js`; Herdr's `herdr-app check` rejects a relative import that resolves outside that mod folder (`module ... resolves outside the application directory .../<mod folder>`). The [official mod guide](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md) documents mods as modules under `mods/<name>` and imports from installed modules, but does not state this path restriction; the check error is the source for the one-folder rule. The helper uses `layout()`, `window.viewport_size()`, `settings().zoom`, and the width cap. It reads the sidebar, tab-row (`tab-row` or `tabs`), status, and work-body padding in design units; viewport pixels are divided by zoom. The window is 90% of the pane work area, capped in width, and `at` centres it there while leaving the Spaces sidebar and tab row visible. A hidden sidebar makes the area full width. Use a fresh key so an old remembered place cannot override `at` (`herdr-app/sideshow/mods/sideshow/main.js:toggle`, `herdr-app/herdra/mods/herdra/main.js:readerSize` and its Sideshow-opening call).
- **Small edge-anchored window (Usage):** compute `at` only when the window must align to an edge or layout element. Convert viewport-pixel coordinates to design units by dividing by `zoom`; keep overlay width/height and layout sizes in design units (`herdr-app/usage/mods/usage/main.js:spot`). Let inner content follow actual window width with flex or `on_size_change`.
- **Verify:** run `herdr-app check <mod-dir>`, then on a machine whose Herdr window is on screen (laptop when Algorant is there) run one fast command per widget, so it is open for well under a second: `hc exec --on laptop -- sh -c 'herdr-app do mod.open --name <mod>; sleep 0.3; herdr-app shot /tmp/<mod>.png; herdr-app do mod.open --name <mod>'`, then `scp laptop:/tmp/<mod>.png /tmp/`, look at it and measure the margins. Confirm `herdr-app status` shows `overlays: []` afterwards. `shot` saves the last presented frame, so a hidden window gives a stale shot. Never leave a test window open on his screen, and never type keys into a terminal to toggle it.

### Herdra delivery

Mods live in `herdr-app/<mod>/mods/<mod>` and are symlinked live on workstation and laptop; merging a change deploys it. Run `herdr-app check <mod dir>`; the check renders an initial description but does not replace inspection in the app. Before delivery, run the Verify recipe above and look at the shot. [Check: official “Changing things safely” and “Check before you finish”; symlink and two-machine render checks: Herdra convention.]
