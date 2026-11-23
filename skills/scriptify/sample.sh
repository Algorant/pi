#!/usr/bin/env bash
# Scriptify template: start here for structure; the runner loads theme.sh for you.
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

# theme.sh supplies the TTY gate, Verdigris theme, prompt signal, and UI helpers;
# the runner preloads the same library for every bash handoff script.
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/theme.sh"
signal_gate_report

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
