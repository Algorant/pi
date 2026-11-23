# Bash BASH_ENV prelude for Scriptify's child script.
# Do nothing outside an armed runner with an interactive stdin.
if [[ ${SCRIPTIFY_WAIT_SIGNAL:-0} == 1 && -t 0 ]]; then
  read() {
    if [[ ${SCRIPTIFY_PROMPT_ACTIVE:-0} == 1 ]]; then
      builtin read "$@"
      set -- "$?"
      return "$1"
    fi
    if command -v base64 >/dev/null 2>&1; then
      printf '\033]7501;state=blocked:app=scriptify:kind=question:msg=%s\007' \
        "$(printf '%s' 'A script prompt needs your response.' | base64 2>/dev/null)" >&2 || :
    else
      printf '\033]7501;state=blocked:app=scriptify:kind=question\007' >&2 || :
    fi
    builtin read "$@"
    # Save the exact status in this function's positional parameters, avoiding
    # locals that could shadow a variable named by read.
    set -- "$?"
    printf '\033]7501;state=working:app=scriptify\007' >&2 || :
    return "$1"
  }
fi
