# Shared Scriptify UI theme and helpers. Safe to source from BASH_ENV.
# Defines defaults only; scripts may define any helper before sourcing this file.

TTY_OK=0
if [[ -t 0 && -t 1 && ${TERM:-dumb} != dumb && -z ${CI+x} && ${SCRIPTIFY_PLAIN:-0} != 1 ]]; then
  TTY_OK=1
fi
UI=plain
if [[ $TTY_OK == 1 ]] && command -v gum >/dev/null 2>&1; then UI=gum; fi
PICKER=read
if [[ $TTY_OK == 1 ]] && command -v fzf >/dev/null 2>&1; then PICKER=fzf; fi

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

SUMMARY_SHOWN=${SUMMARY_SHOWN:-0}
WAIT_SIGNAL=${WAIT_SIGNAL:-0}
if [[ $WAIT_SIGNAL == 0 && ${SCRIPTIFY_WAIT_SIGNAL:-0} == 1 ]] \
   && [[ -t 0 && -t 2 && ${TERM:-dumb} != dumb ]] \
   && command -v base64 >/dev/null 2>&1; then
  WAIT_SIGNAL=1
fi

# Report a failed requested gate only when a caller explicitly asks; sourcing stays silent.
declare -F signal_gate_report >/dev/null || signal_gate_report() {
  [[ ${SCRIPTIFY_WAIT_SIGNAL:-0} == 1 && $WAIT_SIGNAL != 1 ]] || return 0
  local reason
  if [[ ! -t 0 ]]; then reason='Waiting signal off: stdin is not a terminal.'
  elif [[ ! -t 2 ]]; then reason='Waiting signal off: stderr is not a terminal.'
  elif [[ ${TERM:-dumb} == dumb ]]; then reason='Waiting signal off: TERM=dumb.'
  elif ! command -v base64 >/dev/null 2>&1; then reason='Waiting signal off: base64 is unavailable.'
  else return 0
  fi
  printf '%s\n' "$reason" >&2
}

# Helpers define themselves only when the script has not already defined them.
declare -F banner >/dev/null || banner() {
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
declare -F step >/dev/null || step() {
  printf '\n' >&2
  if [[ $UI == gum ]]; then gum style --bold --foreground "$V_AQUA" "◆ Step $1/$2 · $3" >&2
  else printf '[%s/%s] %s\n' "$1" "$2" "$3" >&2; fi
}
declare -F _line >/dev/null || _line() {
  if [[ $UI == gum ]]; then gum style --foreground "$1" "  $2 $3" >&2
  else printf '  %s %s\n' "$2" "$3" >&2; fi
}
declare -F note >/dev/null || note() { _line "$V_MUTED" ' ' "$*"; }
declare -F info >/dev/null || info() { _line "$V_AQUA" '·' "$*"; }
declare -F ok >/dev/null || ok() { _line "$V_FERN" '✓' "$*"; }
declare -F warn >/dev/null || warn() { _line "$V_OCHRE" '!' "$*"; }
declare -F fail >/dev/null || fail() { _line "$V_ERR" '✗' "$*"; }
declare -F err >/dev/null || err() { _line "$V_ERR" '✗' "$*"; }
declare -F summary >/dev/null || summary() {
  local level=$1 title=$2; shift 2
  set -- "$@" "You can close this pane."
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
declare -F danger >/dev/null || danger() {
  if [[ $UI == gum ]]; then gum style --border thick --border-foreground "$V_OCHRE" --foreground "$V_FG" --padding '0 2' "$@" >&2
  else printf '!! %s\n' "$@" >&2; fi
}
declare -F prompt_status >/dev/null || prompt_status() {
  [[ $WAIT_SIGNAL == 1 ]] || return 0
  local state=$1 kind=$2 message
  case $kind in
    permission) message='A confirmation needs your response.' ;;
    question) message='A question needs your response.' ;;
    auth) message='Authentication input needs your response.' ;;
    *) return 0 ;;
  esac
  if [[ $state == working ]]; then
    printf '\033]7501;state=working:app=scriptify\007' >&2
  else
    printf '\033]7501;state=blocked:app=scriptify:kind=%s:msg=%s\007' \
      "$kind" "$(printf '%s' "$message" | base64)" >&2
  fi
}
declare -F await_prompt >/dev/null || await_prompt() {
  local kind=$1 rc=0; shift
  prompt_status blocked "$kind"
  export SCRIPTIFY_PROMPT_ACTIVE=1
  "$@" || rc=$?
  unset SCRIPTIFY_PROMPT_ACTIVE
  prompt_status working "$kind"
  return "$rc"
}
declare -F on_prompt_rc >/dev/null || on_prompt_rc() {
  case $1 in
    1) summary warn "Cancelled" "Declined; nothing changed."; exit 130 ;;
    130) summary warn "Interrupted" "Nothing changed."; exit 130 ;;
    *) summary fail "Prompt failed (exit $1)" "Nothing changed."; exit "$1" ;;
  esac
}
declare -F confirm >/dev/null || confirm() { await_prompt permission _confirm "$@"; }
declare -F _confirm >/dev/null || _confirm() {
  local answer
  if [[ $UI == gum ]]; then gum confirm --default=false "$1"
  else read -rp "$1 [y/N] " answer || { printf '\n' >&2; return 1; }; [[ ${answer:-n} =~ ^[Yy] ]]; fi
}
declare -F _numbered >/dev/null || _numbered() {
  local header=$1 i n; shift
  printf '%s\n' "$header" >&2
  i=1; for n in "$@"; do printf '  %2d) %s\n' "$i" "$n" >&2; i=$((i + 1)); done
}
declare -F pick_one >/dev/null || pick_one() { await_prompt question _pick_one "$@"; }
declare -F _pick_one >/dev/null || _pick_one() {
  local header=$1; shift
  if [[ $UI == gum ]]; then gum choose --header "$header" -- "$@"; return; fi
  local reply opts=("$@")
  _numbered "$header" "$@"
  read -rp "Number: " reply || { printf '\n' >&2; return 1; }
  [[ $reply =~ ^[0-9]+$ ]] && ((reply >= 1 && reply <= ${#opts[@]})) || { printf 'Invalid choice: %s\n' "$reply" >&2; return 1; }
  printf '%s\n' "${opts[reply - 1]}"
}
declare -F pick_many >/dev/null || pick_many() { await_prompt question _pick_many "$@"; }
declare -F _pick_many >/dev/null || _pick_many() {
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
declare -F pick_long >/dev/null || pick_long() { await_prompt question _pick_long "$@"; }
declare -F _pick_long >/dev/null || _pick_long() {
  local header=$1; shift
  if [[ $PICKER == fzf ]]; then printf '%s\n' "$@" | fzf --header "$header"; return; fi
  _pick_one "$header" "$@"
}
declare -F ask >/dev/null || ask() { await_prompt question _ask "$@"; }
declare -F _ask >/dev/null || _ask() {
  local reply
  if [[ $UI == gum ]]; then gum input --header "$1" --placeholder "${2:-}"; return; fi
  read -rp "$1: " reply || { printf '\n' >&2; return 1; }
  printf '%s\n' "$reply"
}
declare -F ask_secret >/dev/null || ask_secret() { await_prompt auth _ask_secret "$@"; }
declare -F _ask_secret >/dev/null || _ask_secret() {
  local reply
  if [[ $UI == gum ]]; then gum input --password --header "$1"; return; fi
  read -rsp "$1: " reply || { printf '\n' >&2; return 1; }
  printf '\n' >&2
  printf '%s\n' "$reply"
}
declare -F run >/dev/null || run() {
  local title=$1; shift
  if [[ $UI == gum ]]; then gum spin --show-error --title "$title" -- "$@"
  else printf '  … %s\n' "$title" >&2; "$@"; fi
}
