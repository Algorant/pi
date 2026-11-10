#!/usr/bin/env bash
# Scriptify template: store a project's Postgres role password as a Proton Pass item.
#
# Operator step of the `dbs` stack (see ../SKILL.md, Databases). Algorant runs it; no agent sees
# the password. It reads the role file that homelab-server's postgres.py wrote on homelab-server,
# over ssh, straight into a shell variable, and hands it to pass-cli on STDIN through a
# JSON login template. The value never appears in argv, the terminal, a file, or a log.
#
#   bash store-pg-password.sh <project>
#   DBS_STORE_DRY_RUN=1 bash store-pg-password.sh <project>   # walk the flow, write nothing
#
# Item: vault `fnox`, title `<project>--default--pg-password`, field `password`.
# Rerun-safe: an item that already holds the same value is left alone; one that holds a
# different value (after `postgres.py rotate`) is replaced: trash (recoverable), create,
# read back, and on any failure restore the old item from the trash.
#
# Role password files end with a newline. Anything that sends the raw bytes onward must
# strip it first (`tr -d '\n'`); this script does.
#
# Use: copy this file into a mode-0700 `mktemp -d` directory (do not edit it), hand it
# over as the utils skill's dbs Operator step says, then delete the directory. The
# scriptify tool runs a launcher that execs `bash <copy> <project>` and
# reports the exit code itself.
set -euo pipefail

# ── Exit: one closing box ─────────────────────────────────────────────────────
SUMMARY_SHOWN=0
on_exit() {
  local rc=$?
  rm -f "${ERRF:-}"   # this script's pass-cli stderr scratch file (holds no value)
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
UI=plain; [[ $TTY_OK == 1 ]] && command -v gum >/dev/null 2>&1 && UI=gum

# ── Verdigris theme for gum (copy of ~/.config/theme_colors/verdigris-gum.sh) ─
V_FG='#ebdbb2' V_MUTED='#928374' V_PANEL='#2c2f30' V_BG='#1d2021'
V_FERN='#8ec07c' V_PATINA='#689d6a' V_AQUA='#83a598'
V_OCHRE='#e6bf86' V_MOSS='#70764a' V_ERR='#e36f63'
if [[ $UI == gum ]]; then
  export GUM_CONFIRM_PROMPT_FOREGROUND=$V_FG
  export GUM_CONFIRM_SELECTED_FOREGROUND=$V_BG GUM_CONFIRM_SELECTED_BACKGROUND=$V_FERN
  export GUM_CONFIRM_UNSELECTED_FOREGROUND=$V_MUTED GUM_CONFIRM_UNSELECTED_BACKGROUND=$V_PANEL
fi

# ── Output helpers: UI to stderr ──────────────────────────────────────────────
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
step() {
  printf '\n' >&2
  if [[ $UI == gum ]]; then gum style --bold --foreground "$V_AQUA" "◆ Step $1/$2 · $3" >&2
  else printf '[%s/%s] %s\n' "$1" "$2" "$3" >&2; fi
}
_line() {
  if [[ $UI == gum ]]; then gum style --foreground "$1" "  $2 $3" >&2
  else printf '  %s %s\n' "$2" "$3" >&2; fi
}
note() { _line "$V_MUTED" ' ' "$*"; }
info() { _line "$V_AQUA"  '·' "$*"; }
ok()   { _line "$V_FERN"  '✓' "$*"; }
warn() { _line "$V_OCHRE" '!' "$*"; }
fail() { _line "$V_ERR"   '✗' "$*"; }
summary() {
  local level=$1 title=$2; shift 2
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
danger() {
  if [[ $UI == gum ]]; then
    gum style --border thick --border-foreground "$V_OCHRE" --foreground "$V_FG" --padding '0 2' "$@" >&2
  else
    printf '!! %s\n' "$@" >&2
  fi
}

# ── Prompts ───────────────────────────────────────────────────────────────────
on_prompt_rc() {
  case $1 in
    1)   summary warn "Cancelled" "Declined or cancelled; nothing changed."; exit 1 ;;
    130) summary warn "Interrupted" "Nothing changed."; exit 130 ;;
    *)   summary fail "Prompt failed (exit $1)" "Nothing changed."; exit "$1" ;;
  esac
}
confirm() {  # confirm PROMPT   (defaults to No)
  local answer
  if [[ $UI == gum ]]; then gum confirm --default=false "$1"
  else
    read -rp "$1 [y/N] " answer || { printf '\n' >&2; return 1; }
    [[ ${answer:-n} =~ ^[Yy] ]]
  fi
}

# ── Inputs and constants ──────────────────────────────────────────────────────
PROJECT=${1:-}
[[ $PROJECT =~ ^[a-z][a-z0-9_]*$ ]] || {
  summary fail "Usage: bash store-pg-password.sh <project>" "<project> is the lowercase Postgres role name, e.g. codeparse"
  exit 2
}
SSH_HOST=${DBS_SSH_HOST:-homelab-server}
VAULT=fnox
TITLE="${PROJECT}--default--pg-password"
ROLE_FILE="~/homelab-server/.secrets/postgres/roles/${PROJECT}.password"   # expanded on $SSH_HOST
DRY=${DBS_STORE_DRY_RUN:-0}
TOTAL=4
PW=

banner "Store Postgres role password in Proton Pass" \
  "Vault: $VAULT   Item: $TITLE   Field: password" \
  "Source: $SSH_HOST:$ROLE_FILE (read over ssh, never printed)" \
  "$([[ $DRY == 1 ]] && echo 'DRY RUN: nothing is read or written' || echo 'May create the item, or replace it after your confirmation')"
confirm "Continue?" || on_prompt_rc $?
ERRF=$(mktemp)                    # pass-cli stderr only; removed by on_exit

# pass_view_state: sets STORED (value) and returns 0 when the item exists, 1 when it
# does not; any other failure stops the script.
STORED=
pass_view_state() {
  local rc=0
  STORED=$(pass-cli item view --vault-name "$VAULT" --item-title "$TITLE" --field password 2>"$ERRF") || rc=$?
  ((rc == 0)) && return 0
  if grep -q 'No item found' "$ERRF"; then STORED=; return 1; fi
  fail "pass-cli could not read the item: $(head -c 200 "$ERRF" | tr '\n' ' ')"
  summary fail "Could not check Proton Pass" "Run: pass-cli login, then rerun this script."
  exit 1
}

# ── 1 Preconditions ───────────────────────────────────────────────────────────
step 1 "$TOTAL" "Check tools, Proton session, and the role file"
for bin in pass-cli ssh jq; do
  command -v "$bin" >/dev/null 2>&1 || { fail "$bin not found"; summary fail "Missing $bin" "Install it (global mise), then rerun."; exit 1; }
done
pass-cli info >/dev/null 2>&1 || { fail "No Proton Pass session"; summary fail "Not logged in" "Run: pass-cli login, then rerun this script."; exit 1; }
ok "pass-cli session present"
if ! ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "test -s $ROLE_FILE" 2>/dev/null; then
  fail "No role password file for '$PROJECT' on $SSH_HOST"
  summary fail "Role file missing or ssh failed" \
    "Ask homelab-server to run postgres.py create $PROJECT on $SSH_HOST (or check 'ssh $SSH_HOST true' works)."
  exit 1
fi
ok "role file exists on $SSH_HOST"

# ── 2 Read the password into memory only ──────────────────────────────────────
step 2 "$TOTAL" "Read the role password (not shown)"
if [[ $DRY == 1 ]]; then
  PW=dry-run-placeholder
  info "dry run: would run  ssh $SSH_HOST cat $ROLE_FILE | tr -d '\\n'"
else
  PW=$(ssh -n -o BatchMode=yes -o ConnectTimeout=10 "$SSH_HOST" "cat $ROLE_FILE" | tr -d '\n') || PW=
  [[ -n $PW ]] || { fail "Could not read the role file"; summary fail "Empty or unreadable role file" "Check ssh $SSH_HOST and the file's permissions."; exit 1; }
  ok "read the password (trailing newline stripped)"
fi

# ── 3 Does the item exist, and does it already match? ─────────────────────────
step 3 "$TOTAL" "Check the Proton Pass item"
EXISTS=0
if pass_view_state; then
  EXISTS=1
  if [[ $STORED == "$PW" && $DRY != 1 ]]; then
    ok "item already holds this password"
    summary ok "Nothing to do" "$TITLE is current."
    exit 0
  fi
  info "item exists with a different value (or dry run)"
else
  info "item does not exist yet"
fi
STORED=

# ── 4 Create (or replace) and verify ──────────────────────────────────────────
step 4 "$TOTAL" "Write the item"
create_item() {  # password on stdin of jq only; pass-cli reads the JSON template on stdin
  printf '%s' "$PW" | jq -Rn --arg t "$TITLE" \
    '{title: $t, username: null, email: null, password: input, totp_uri: null, urls: []}' \
  | pass-cli item create login --vault-name "$VAULT" --from-template - >/dev/null
}
if ((EXISTS)); then
  danger "Replace existing item" "$VAULT / $TITLE  (old item goes to the Proton trash, recoverable)"
  if [[ $DRY == 1 ]]; then
    info "dry run: would confirm, then: pass-cli item trash --vault-name $VAULT --item-title $TITLE"
  elif confirm "Replace it with the current role password?"; then :
  else
    rc=$?
    [[ $rc == 1 ]] || on_prompt_rc "$rc"
    warn "Kept the existing item"
    summary warn "Skipped" "$TITLE was left unchanged."
    exit 0
  fi
  if [[ $DRY != 1 ]]; then
    pass-cli item trash --vault-name "$VAULT" --item-title "$TITLE" >/dev/null 2>"$ERRF" \
      || { fail "Could not trash the old item"; summary fail "Nothing changed" "pass-cli: $(head -c 200 "$ERRF" | tr '\n' ' ')"; exit 1; }
    ok "old item moved to the trash"
  fi
fi
if [[ $DRY == 1 ]]; then
  info "dry run: would run  jq (password from stdin) | pass-cli item create login --vault-name $VAULT --from-template -"
  info "dry run: would read the item back and compare it with the role password"
  summary ok "Dry run complete" "No Proton item was created, changed, or trashed."
  exit 0
fi
if create_item 2>"$ERRF" && pass_view_state && [[ $STORED == "$PW" ]]; then
  STORED=
  ok "created and verified $TITLE"
  summary ok "Stored" "$VAULT / $TITLE is current. Verify from the project: fnox exec -- dbs status"
  exit 0
fi
STORED=
fail "Create or verification failed: $(head -c 200 "$ERRF" | tr '\n' ' ')"
if ((EXISTS)); then
  pass-cli item untrash --vault-name "$VAULT" --item-title "$TITLE" >/dev/null 2>&1 \
    && warn "Restored the old item from the trash" \
    || warn "Could not restore the old item automatically: untrash '$TITLE' in Proton Pass (vault $VAULT)"
fi
summary fail "Item not stored" "Rerun after fixing the cause above; the role file was not modified."
exit 1
