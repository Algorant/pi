# One app-owned Scriptify runner below the work pane; its invoking Pi receives the result:
#   bash scriptify-job.sh <script> <recipient> <inbox> <caller-cwd>
# One outcome goes through the existing inbox. No result (hard runner/host loss)
# is never success; nothing supervises or automatically reruns the script.
script=$1 recipient=$2 inbox=$3 cwd=$4
status=1
outcome="ended before a script result was observed (not a success)"

report() {
  trap '' HUP INT TERM
  trap - EXIT
  bun "$inbox" result "$recipient" "Scriptify: $script $1" >/dev/null
}
cancel() {
  report "CANCELLED: $1"
  exit 130
}
classify() {
  status=$1
  case $1 in
    0) outcome="succeeded (exit 0)" ;;
    130) outcome="CANCELLED (exit 130: declined at its prompt, or Ctrl+C)" ;;
    *) outcome="FAILED: exit $1" ;;
  esac
}

trap 'report "$outcome"; exit "$status"' EXIT
# Closing this pane or hc kill hangs up the runner; the caller ending alone does not.
trap 'cancel "its terminal was closed (hangup)"' HUP
trap 'cancel "terminated"' TERM
# Ctrl+C reaches the script; its own status decides (it may handle Ctrl+C).
trap : INT

# pane.split starts in its work pane's folder; a native child may work elsewhere.
cd -- "$cwd" || { outcome="FAILED: cannot enter the invoking agent's working directory"; exit 1; }
printf 'Reviewed script: %s\n' "$script"
printf '\033]7501;state=working:app=scriptify\007'
"$script"
classify $?
exit
