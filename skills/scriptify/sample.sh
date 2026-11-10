#!/usr/bin/env bash
# Scriptify template: copy what the handoff needs, delete the rest.
# Run it as-is for a harmless demo (it only touches a mktemp dir).
# Try `SCRIPTIFY_PLAIN=1 bash sample.sh` to see the plain fallback.
set -euo pipefail

# ── Exit: one closing box ─────────────────────────────────────────────────────
# If the script stops before its own `summary` (set -e, an explicit exit), the
# trap closes with a fail box. Keep this exact format.
SUMMARY_SHOWN=0
on_exit() {
  local rc=$?
  if ((rc != 0 && SUMMARY_SHOWN == 0)) && declare -F summary >/dev/null; then
    summary fail "Stopped (exit $rc)" "See the message above; later steps did not run."
  fi
}
trap on_exit EXIT

# ── Gate: is a person watching this terminal? ─────────────────────────────────
TTY_OK=0
if [[ -t 0 && -t 1 ]] && [[ ${TERM:-dumb} != dumb ]] && [[ -z ${CI+x} ]] \
   && [[ ${SCRIPTIFY_PLAIN:-0} != 1 ]]; then
  TTY_OK=1
fi
UI=plain;  [[ $TTY_OK == 1 ]] && command -v gum >/dev/null 2>&1 && UI=gum
PICKER=read; [[ $TTY_OK == 1 ]] && command -v fzf >/dev/null 2>&1 && PICKER=fzf

# ── Verdigris theme for gum ───────────────────────────────────────────────────
# Inline copy of ~/.config/theme_colors/verdigris-gum.sh; keep the two in sync.
# fzf picks up Verdigris from FZF_DEFAULT_OPTS in the user's shell.
V_FG='#ebdbb2' V_MUTED='#928374' V_PANEL='#2c2f30' V_BG='#1d2021'
V_FERN='#8ec07c' V_PATINA='#689d6a' V_AQUA='#83a598'
V_OCHRE='#e6bf86' V_MOSS='#70764a' V_ERR='#e36f63'
if [[ $UI == gum ]]; then
  export GUM_CONFIRM_PROMPT_FOREGROUND=$V_FG
  export GUM_CONFIRM_SELECTED_FOREGROUND=$V_BG GUM_CONFIRM_SELECTED_BACKGROUND=$V_FERN
  export GUM_CONFIRM_UNSELECTED_FOREGROUND=$V_MUTED GUM_CONFIRM_UNSELECTED_BACKGROUND=$V_PANEL
  export GUM_CHOOSE_CURSOR='› ' GUM_CHOOSE_CURSOR_FOREGROUND=$V_FERN
  export GUM_CHOOSE_HEADER_FOREGROUND=$V_AQUA GUM_CHOOSE_ITEM_FOREGROUND=$V_FG
  export GUM_CHOOSE_SELECTED_FOREGROUND=$V_FERN
  export GUM_CHOOSE_CURSOR_PREFIX='○ ' GUM_CHOOSE_SELECTED_PREFIX='● ' GUM_CHOOSE_UNSELECTED_PREFIX='○ '
  export GUM_INPUT_PROMPT='› ' GUM_INPUT_PROMPT_FOREGROUND=$V_FERN GUM_INPUT_CURSOR_FOREGROUND=$V_FERN
  export GUM_INPUT_HEADER_FOREGROUND=$V_AQUA GUM_INPUT_PLACEHOLDER_FOREGROUND=$V_MUTED
  export GUM_SPIN_SPINNER=minidot GUM_SPIN_SPINNER_FOREGROUND=$V_AQUA GUM_SPIN_TITLE_FOREGROUND=$V_FG
fi

# ── Output helpers: all UI goes to stderr; stdout carries values only ─────────
# gum drops color when its stdout is captured, so styled pieces built inside
# $(...) and then framed need CLICOLOR_FORCE=1.
# banner TITLE [LINE...]   what the script will touch; every script opens with one
banner() {
  local title=$1; shift
  if [[ $UI == gum ]]; then
    local box
    box=$(CLICOLOR_FORCE=1 gum style --bold --foreground "$V_FERN" "$title")
    (($#)) && box=$(CLICOLOR_FORCE=1 gum join --vertical "$box" "$(CLICOLOR_FORCE=1 gum style --foreground "$V_FG" "$@")")
    gum style --border rounded --border-foreground "$V_PATINA" --padding '0 2' "$box" >&2
  else
    printf '== %s ==\n' "$title" >&2
    (($#)) && printf '   %s\n' "$@" >&2
  fi
  return 0
}
step() {  # step N TOTAL LABEL
  printf '\n' >&2
  if [[ $UI == gum ]]; then gum style --bold --foreground "$V_AQUA" "◆ Step $1/$2 · $3" >&2
  else printf '[%s/%s] %s\n' "$1" "$2" "$3" >&2; fi
}
_line() {  # _line COLOR GLYPH TEXT
  if [[ $UI == gum ]]; then gum style --foreground "$1" "  $2 $3" >&2
  else printf '  %s %s\n' "$2" "$3" >&2; fi
}
note() { _line "$V_MUTED" ' ' "$*"; }
info() { _line "$V_AQUA"  '·' "$*"; }
ok()   { _line "$V_FERN"  '✓' "$*"; }
warn() { _line "$V_OCHRE" '!' "$*"; }
fail() { _line "$V_ERR"   '✗' "$*"; }
# summary ok|warn|fail TITLE [LINE...]   the only closing output of a run;
# follow it with the matching exit (0 for ok/warn, 1 for fail).
summary() {
  local level=$1 title=$2; shift 2
  set -- "$@" "You can close this pane."  # the tracked pane reports the exit itself; never ask the user to tell the agent
  SUMMARY_SHOWN=1
  local color=$V_FERN
  [[ $level == warn ]] && color=$V_OCHRE
  [[ $level == fail ]] && color=$V_ERR
  if [[ $UI == gum ]]; then
    local box
    box=$(CLICOLOR_FORCE=1 gum style --bold --foreground "$color" "$title")
    (($#)) && box=$(CLICOLOR_FORCE=1 gum join --vertical "$box" "$(CLICOLOR_FORCE=1 gum style --foreground "$V_FG" "$@")")
    printf '\n' >&2
    gum style --border rounded --border-foreground "$V_MOSS" --padding '0 2' "$box" >&2
  else
    printf '\n== %s ==\n' "$title" >&2
    (($#)) && printf '   %s\n' "$@" >&2
  fi
  return 0
}
# danger LINE...   ochre frame naming the exact target before a destructive confirm
danger() {
  if [[ $UI == gum ]]; then
    gum style --border thick --border-foreground "$V_OCHRE" --foreground "$V_FG" --padding '0 2' "$@" >&2
  else
    printf '!! %s\n' "$@" >&2
  fi
}

# ── Prompts ───────────────────────────────────────────────────────────────────
# Each returns 0 on success, 1 on decline/cancel, 130 on Ctrl+C, other = failure.
# Handle the status at the call site with on_prompt_rc; never retry automatically.
# A decline and Ctrl+C both stop with 130, the cancel status Scriptify reports
# as CANCELLED; a prompt failure keeps its own status (FAILED).
on_prompt_rc() {
  case $1 in
    1)   summary warn "Cancelled" "Declined; nothing changed."; exit 130 ;;
    130) summary warn "Interrupted" "Nothing changed."; exit 130 ;;
    *)   summary fail "Prompt failed (exit $1)" "Nothing changed."; exit "$1" ;;
  esac
}

confirm() {  # confirm PROMPT   (defaults to No)
  local answer
  if [[ $UI == gum ]]; then gum confirm --default=false "$1"
  else
    read -rp "$1 [y/N] " answer || { printf '\n' >&2; return 1; }  # Ctrl+D fails closed
    [[ ${answer:-n} =~ ^[Yy] ]]
  fi
}

_numbered() {  # _numbered HEADER OPTION...   prints the list, reads one index
  local header=$1 i n; shift
  printf '%s\n' "$header" >&2
  i=1; for n in "$@"; do printf '  %2d) %s\n' "$i" "$n" >&2; i=$((i + 1)); done
}

pick_one() {  # pick_one HEADER OPTION...   short list (about 10 or fewer)
  local header=$1; shift
  if [[ $UI == gum ]]; then gum choose --header "$header" -- "$@"; return; fi
  local reply opts=("$@")
  _numbered "$header" "$@"
  read -rp "Number: " reply || { printf '\n' >&2; return 1; }
  [[ $reply =~ ^[0-9]+$ ]] && ((reply >= 1 && reply <= ${#opts[@]})) || { printf 'Invalid choice: %s\n' "$reply" >&2; return 1; }
  printf '%s\n' "${opts[reply - 1]}"
}

pick_many() {  # pick_many HEADER OPTION...   prints one choice per line
  local header=$1; shift
  if [[ $UI == gum ]]; then gum choose --no-limit --header "$header" -- "$@"; return; fi
  local reply idx opts=("$@")
  _numbered "$header" "$@"
  read -rp "Numbers (space-separated): " reply || { printf '\n' >&2; return 1; }
  [[ -n $reply ]] || return 1
  for idx in $reply; do
    [[ $idx =~ ^[0-9]+$ ]] && ((idx >= 1 && idx <= ${#opts[@]})) || { printf 'Invalid choice: %s\n' "$idx" >&2; return 1; }
    printf '%s\n' "${opts[idx - 1]}"
  done
}

pick_long() {  # pick_long HEADER OPTION...   long fuzzy list (hosts, files, packages)
  local header=$1; shift
  if [[ $PICKER == fzf ]]; then printf '%s\n' "$@" | fzf --header "$header"; return; fi
  pick_one "$header" "$@"   # plain: same numbered read
}
# fzf exits 1 for no match and 130 for Esc or Ctrl+C.

ask() {  # ask HEADER [PLACEHOLDER]   free text on stdout
  local reply
  if [[ $UI == gum ]]; then gum input --header "$1" --placeholder "${2:-}"; return; fi
  read -rp "$1: " reply || { printf '\n' >&2; return 1; }
  printf '%s\n' "$reply"
}

ask_secret() {  # ask_secret HEADER   masked; the value never touches argv or the script body
  local reply
  if [[ $UI == gum ]]; then gum input --password --header "$1"; return; fi
  read -rsp "$1: " reply || { printf '\n' >&2; return 1; }
  printf '\n' >&2
  printf '%s\n' "$reply"
}

run() {  # run TITLE CMD...   safe-to-watch commands only; never wrap interactive sudo
  local title=$1; shift
  if [[ $UI == gum ]]; then gum spin --show-error --title "$title" -- "$@"
  else printf '  … %s\n' "$title" >&2; "$@"; fi
}

# ── Demo flow ─────────────────────────────────────────────────────────────────
banner "Scriptify sample" \
  "Creates and removes demo files in a new mktemp directory" \
  "Nothing outside that directory is touched"

step 1 3 "Choose"
branch=$(pick_one "Deploy which branch?" main dev release/0.9) || on_prompt_rc $?
ok "Branch: $branch"
picked=$(pick_many "Also create which files?" notes.txt todo.txt log.txt) || on_prompt_rc $?
extras=(); [[ -n $picked ]] && mapfile -t extras <<<"$picked"
label=$(ask "Label for this run" "e.g. homelab-server-demo") || on_prompt_rc $?
info "Label: ${label:-<none>}"

step 2 3 "Work"
WORK=$(mktemp -d)
run "Writing demo files" bash -c 'sleep 1; touch "$1"/{a,b,c}.dat' _ "$WORK"
for f in "${extras[@]}"; do touch "$WORK/$f"; done
ok "Created $(find "$WORK" -type f | wc -l) files"
# Display-only: a listing (or a grep with no match) must not decide the exit.
ls -1 "$WORK" | sed 's/^/    /' >&2 || true

step 3 3 "Clean up"
danger "Destructive" "rm -rf $WORK ($(find "$WORK" -type f | wc -l) files)"
if confirm "Delete it?"; then
  rm -rf "$WORK"
  ok "Removed $WORK"
  summary ok "Done" "3 steps ok · demo directory removed"
  exit 0
else
  rc=$?
  [[ $rc == 1 ]] || on_prompt_rc "$rc"
  warn "Kept $WORK"
  summary warn "Done with 1 skipped step" "Demo files remain in $WORK"
  exit 0
fi
