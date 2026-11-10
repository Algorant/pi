---
name: scriptify
description: "Use a reviewed script for a genuine user-run handoff: operator-only credentials, login, or physical interaction; an explicitly requested user-run script; or elevation established by a failed authorized non-elevated attempt. Otherwise run authorized work directly with existing permissions."
metadata:
  short-description: Package genuine user-run handoffs as reviewed scripts
---

# Scriptify

Scriptify replaces a list of commands handed to Algorant **when Algorant actually needs to run them**. A reviewed script preserves ordering, checks preconditions, carries values safely, and makes retries predictable at that human execution boundary. It is not an agent execution or approval gate.

If Algorant authorized the work and the agent has the necessary permissions, run the operation and verify it directly. Do not write a wrapper or open a split just to hand execution back to Algorant.

## Native HC: one runner below the work pane

Under `HC_TERMINAL_ID`, call model-only `scriptify` with the reviewed executable `script_path`, a readable `label` and the genuine user-run reason. It resolves the caller's work pane once (through native parents for a child) and uses native `pane.split down` with the script as direct argv: **one** app-created terminal, agent above (two-thirds), runner below. The tool briefly jumps pane focus/zoom (approved by Algorant) and restores the original focus/zoom and selected space/tab; if restored zoom hides the runner, he unzooms normally and you never change his lasting zoom. Missing/inconsistent view metadata fails before launch. There is no fallback placement, overlay, readiness loop, timer, service or supervisor; a partial placement failure is not permission to rerun or cancel automatically (inspect the terminal and your inbox first).

The script starts immediately; its own first confirmation before any change is the presence boundary. Credentials stay inside the runner. Sudo requires an actual failed non-elevated attempt and prior approval; the password prompt is not approval. Read-only helpers ask their owner. A managed Worker writes and reviews the script, then asks its owner through `worker_ask` to run it: the outcome returns to the caller's inbox, and a Worker invocation ends at `worker_ask`/`worker_report`, so the tool refuses a Worker caller before launch. Remote steps run from the owning agent's work tab on that host; there is no `machine` parameter or attach bridge.

The runner is app-owned: the caller ending alone does NOT kill it, and it cannot take an hc parent/name/`--rm` (do not nest `hc run` to simulate them). Its label names the job; `hc keep --off` disables loss recovery; normal exit closes the pane. One outcome goes to the ORIGINAL invoking Pi's inbox, even when the work pane belongs to its parent: `succeeded (exit 0)`, `FAILED` (other nonzero), or `CANCELLED` (exit 130/No/Ctrl+C or pane-close/hangup/terminate). Hard runner/host loss can prevent a report: no result is **not success**, and nothing reruns automatically. Verify the effect independently of exit 0.

## When this fires

Use this skill for a real user-run handoff:

- an operator-only credential, login, browser authorization, hardware prompt, or physical interaction that the agent cannot perform; do not collect credentials in chat
- Algorant explicitly requests a **user-run** script (not merely a script as a project deliverable)
- an authorized non-elevated attempt actually fails for lack of permissions, establishing that elevation is necessary and Algorant must run the elevated step; get any required approval before preparing it, and never retry with `sudo` automatically

When such a handoff requires several commands, provide one reviewed script and one command rather than a loose command list or long chained shell line. Do not bypass required human approval or broaden the agent's permissions.

## When this does not fire

Step count, package management, `sudo` hypotheticals, sensitive-looking paths, remote systems, repeatability, preflights, or the desire for careful ordering are not triggers by themselves. Handle authorized work with existing access directly, including multi-step operations, diagnostics, migrations, and package-manager commands. If a command succeeds without elevation, finish and verify it instead of packaging a script for approval.

For example, run an authorized `mise up` yourself if it succeeds without `sudo`; do not write a script, open a Scriptify window, and wait for Algorant. Short disposable Git verification commands can also run directly, without a script or tracked pane. Ordinary source files that happen to be scripts remain normal implementation work.

## Writing the script

Only write a handoff script once the user-run boundary above is established. A human runs this, so it carries the care you would normally apply yourself. Review the script before handing it over; keep authorized agent-run setup and verification outside the script where possible.

**Announce before acting.** Open with a `banner` of what the script will touch, then print what is about to happen before each meaningful step (see [Interactive UI](#interactive-ui)). The user should never wonder what the script is doing to their machine.

**For credential operations requiring a genuine human/operator handoff, accept secrets at runtime.** Never write a credential into the script body, invocation, or chat. Prompt for it with `ask_secret` from `sample.sh` (plain fallback: `read -rsp`), or read it from an environment variable the user already has. This credential-specific rule does not require a handoff for ordinary authorized agent work.

```bash
GH_TOKEN=$(ask_secret "GitHub token") || on_prompt_rc $?
```

**Fail loudly and early.** Set `set -euo pipefail` in bash. Check preconditions up front: required binaries, existing files, network reach. Exit with a message a human understands, naming what failed and what to do about it.

**Copy the Exit block from `sample.sh` verbatim.** Its EXIT trap still fires when `set -e` aborts and closes an unfinished run with a `summary fail` box.

**Decide the exit status deliberately.** The status reflects whether the intended change happened, never the last command that happened to run. A display or verification command at the end of a step (`sshd -T | grep …`, `systemctl status`, `ls`) must not decide it: a `grep` with no match exits 1 and turns a successful run into a failure. Give display-only commands `|| true`; turn a verification into an explicit check that reports `ok`/`warn`/`fail` and records the outcome. A remote block (`ssh host bash -s`) returns its last command's status, so end it with an explicit `exit`. For loops over hosts or items, collect failures in an array and decide once at the end.

**Never assume or retry elevation.** Attempt the authorized operation non-elevated first; after a permission failure, obtain any required human authorization before an elevated handoff. If a `sudo` prompt is declined or times out, stop and say so; do not retry or continue into steps that assume it succeeded.

**Be safe to rerun.** Assume the user will run it twice, or run it after it died halfway. Check whether each step is already done before doing it. Do not duplicate config lines, do not clobber an existing key without asking.

**Confirm before the first change.** Under native HC the script starts as soon as the runner launches, so its own first prompt is the presence boundary: after the `banner`, ask `confirm "Continue?" || on_prompt_rc $?` (or an equivalent prompt such as a required secret) before anything is created, changed, or sent. `on_prompt_rc` stops a decline or Ctrl+C with 130, which Scriptify reports as CANCELLED.

**Confirm before destructive actions.** Deleting, overwriting, or reconfiguring something that already exists gets an explicit prompt inside the script, even though the user chose to run it.

**Keep it readable.** The user may scan it before running. Comments where intent is not obvious. No cleverness that obscures what happens to their system.

## Interactive UI

Start from [`sample.sh`](sample.sh) in this skill directory. It is a runnable template: the gate, the Verdigris gum theme, output helpers with plain twins, prompt helpers, exit-status handling, and a harmless demo flow. Copy the blocks the handoff needs into the script and delete the rest. The script stays self-contained: never `source` the template or a dotfile from a handoff script. A reviewed template for one recurring operator handoff, storing a project's Postgres role password as a Proton item, lives in the `utils` skill's Databases section (`agent/skills/utils/scripts/store-pg-password.sh`).

Gum is optional decoration, never a requirement. When a real terminal is in front of a person, gum makes banners, confirmations, menus, spinners, and status lines pleasant. Otherwise every helper falls back to `echo` / `read`. Never install gum from the script: global mise (the machine environment, see global AGENTS.md) declares `"aqua:charmbracelet/gum" = "latest"`. Do not add glow, a `%` progress bar (gum has no progress command; measurable progress stays plain bash), or a compiled Charm helper.

### Gate

Decide once, at the top: is a person watching this terminal? The terminal checks are:

- stdin and stdout are TTYs (`-t 0`, `-t 1`)
- `TERM` is set and not `dumb`
- `CI` is unset; a set-but-empty `CI=""` still counts as CI
- `SCRIPTIFY_PLAIN` is not `1`

When they hold, `UI=gum` if `command -v gum` succeeds and `PICKER=fzf` if `command -v fzf` succeeds. Otherwise both stay plain.

The `-t 1` test is deliberate and it is ours, not gum's: a script whose stdout is redirected or piped is acting as a data source, so it uses plain prompts even though gum itself could still render on the controlling terminal. stderr is not part of the gate.

UI and logs go to **stderr**. `gum spin` already writes there; `gum style` writes to **stdout**, so the helpers redirect it (`>&2`). stdout stays reserved for values.

### Theme

Never rely on gum's default Charm colors (pink and purple). When `UI=gum`, export the Verdigris `GUM_*` block from `sample.sh`. That inline copy is authoritative on machines without the `mise dot` port at `~/.config/theme_colors/verdigris-gum.sh` (absent on this machine); where both exist, change them together. Roles:

- **fern** `#8ec07c`: cursor `›`, focused confirm button, selections, `✓`
- **aqua** `#83a598`: headers, step titles, spinner, `·` info
- **vellum** `#ebdbb2`: prompts, items, body text; **gray** `#928374`: placeholders, notes
- **ochre** `#e6bf86`: `!` warnings and the destructive-action frame; **error** `#e36f63`: `✗` only
- **patina** `#689d6a` banner frame; **moss** `#70764a` summary frame

fzf needs no flags: it inherits Verdigris from `FZF_DEFAULT_OPTS` in Algorant's shell. The gray key-hint footer inside gum prompts is hard-coded and has no flag.

### Script shape

Every script opens with a `banner`: a title plus one line per thing it will create, change, or ask for. The banner is the announcement this skill requires before acting, in both modes. Then:

1. `step N TOTAL "label"` before each meaningful step
2. `info` / `ok` / `warn` / `fail` for status lines, and `note` for quiet detail
3. `danger "what" "exact target and size"` immediately before a destructive `confirm`
4. one `summary ok|warn|fail "title" "detail…"` at the end, followed by the matching `exit` (`0` for ok/warn, `1` for fail)

The summary box is the only closing output: no raw `echo "Done …"` lines before or after it. The helper ends every box with "You can close this pane." Never ask the user to tell the agent the script finished: the native outcome reports the exit itself. Only a result the agent cannot observe (for example, a value shown on another machine during a bring-up) is a reason to ask for a relay. A multi-host result goes inside it, e.g. `summary fail "2 of 4 hosts failed" "failed: laptop old-laptop" "ok: homelab-server workstation"; exit 1`. When the script stops early, `on_prompt_rc` and the EXIT trap supply the box.

Use these glyph helpers, not `gum log`: `--level.foreground` recolors every level the same.

### What to call

| Job | Helper in `sample.sh` | With gum | Plain fallback |
| --- | --- | --- | --- |
| Destroy/overwrite confirm | `confirm` | `gum confirm --default=false` | `read -rp "... [y/N] "` |
| Short pick (about 10 or fewer) | `pick_one` | `gum choose` | numbered `read` |
| Several from a short list | `pick_many` | `gum choose --no-limit` | numbered `read`, space-separated |
| Long pick (hosts, files, packages) | `pick_long` | `fzf` (when `PICKER=fzf`) | numbered `read` |
| Free text | `ask` | `gum input --header` | `read -rp` |
| Secret | `ask_secret` | `gum input --password` | `read -rsp` |
| Wait on a command | `run` | `gum spin --show-error --title` | `echo ... >&2` then the command |

Use fzf for every long or fuzzy list; do not use `gum filter`. Pickers print values on stdout; capture them with `$(...)`.

`gum spin` shows only the spinner and hides the wrapped command's output. `--show-error` surfaces the failing command's stderr; use `--show-output` when both streams matter. The command's exit code still governs the script. Reserve `gum spin` for commands that are safe to watch. Never wrap an interactive `sudo` in it: sudo keeps its own plain prompt.

### Prompt exit status

Non-zero results from a prompt are not all "the user said no":

- `1`: declined or cancelled (`gum confirm` answered No, `gum choose` aborted with Esc, no fzf match, invalid or empty plain answer), or the prompt itself failed. `gum choose` with no usable TTY exits `1` and prints a diagnostic, so read the message instead of assuming a decline.
- `130`: interrupted with Ctrl+C (fzf also returns `130` for Esc)
- any other non-zero: the prompt failed

Handle those three cases separately, never fall through into the action, and do not retry the prompt automatically. `sample.sh` does this with `on_prompt_rc`:

```bash
branch=$(pick_one "Deploy which branch?" main dev) || on_prompt_rc $?

danger "Destructive" "rm -rf ./build (1.2 GB)"
if confirm "Delete it?"; then
  rm -rf ./build
else
  rc=$?
  [[ $rc == 1 ]] || on_prompt_rc "$rc"   # 130 or failure: stop
  warn "Kept ./build"                   # 1: declined; skip only this step
fi
```

When decorating inside a frame, gum drops color from anything captured with `$(...)`. The banner and summary helpers set `CLICOLOR_FORCE=1` on those inner calls; copy them as they are.

## Placement and execution

For a one-time user-run handoff, write to `$(mktemp -d)` or a clear named path under `/tmp`. Make it executable. If Algorant requests a lasting user-run utility, put it in the repository's established script location instead.

### Native HC: the scriptify tool

```
scriptify script_path=/abs/path.sh reason="<the established user-run boundary>" label="Reviewed handoff label"
```

Tell Algorant in one line what the runner runs and what it will ask first, then end the turn: the outcome arrives in your inbox (no polling). Treat `CANCELLED` and `FAILED` as not done; ask before rerunning. A script that runs `sudo` follows the rule above. Never prepend `sudo` to the whole script unless all of it needs it; keep elevation at the individual commands.

### Without HC

Run authorized work directly with existing access and verify the result; neither a script nor a terminal handoff is needed for routine agent-run work.

If the user must run the script (the triggers above): tell them briefly what it will inspect or change and what it will ask for, give the exact path and one command to run, then stop for their report.

## After execution

Under HC the app closes the pane on normal exit and the outcome reaches your inbox; verify the intended effect yourself through whatever you can observe, since exit 0 alone is not success (if the effect is missing, ask Algorant what the script printed). Without a native outcome the user reports back conversationally; verify the same way (file exists, service responds, auth succeeds), then continue. If it failed, ask what the script printed, revise it and hand back the corrected version.

## Example

Algorant asks for deploy access configured on their machine using a key that must remain theirs and a host password the agent cannot use. This is an operator-only login handoff, not a reason to hand off unrelated authorized setup or diagnostics.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Exit block, gate, Verdigris theme, output helpers, confirm, and on_prompt_rc copied from sample.sh.
# (Omitted here; paste them verbatim.)

KEY="$HOME/.ssh/id_ed25519_deploy"
HOST_ALIAS="deploy"
HOST="deploy.example.com"
USER_NAME="deploy-user"

banner "Set up deploy access to $HOST" \
  "Creates an SSH key at $KEY (if missing)" \
  "Adds it to your ssh-agent" \
  "Copies the public key to $HOST (asks for your password)" \
  "Adds a '$HOST_ALIAS' entry to ~/.ssh/config (if missing)"
confirm "Continue?" || on_prompt_rc $?

command -v ssh-keygen >/dev/null || { fail "ssh-keygen not found."; exit 1; }
command -v ssh-copy-id >/dev/null || { fail "ssh-copy-id not found. Install openssh-client."; exit 1; }

step 1 4 "Key"
if [[ -f "$KEY" ]]; then
  note "Key already exists at $KEY, keeping it."
else
  ssh-keygen -t ed25519 -f "$KEY" -C "$USER_NAME@$HOST_ALIAS"
  ok "Generated $KEY"
fi

step 2 4 "Agent"
eval "$(ssh-agent -s)" >/dev/null
ssh-add "$KEY"
ok "Key added to ssh-agent"

step 3 4 "Copy to $HOST"
info "You will be asked for your password on $HOST."
if ! ssh-copy-id -i "$KEY.pub" "$USER_NAME@$HOST"; then
  fail "Could not copy the key. Check the hostname, username, and password."
  summary fail "Deploy access not configured" "Key is local only; nothing changed on $HOST"
  exit 1
fi
ok "Public key installed on $HOST"

step 4 4 "SSH config"
if grep -q "Host $HOST_ALIAS" "$HOME/.ssh/config" 2>/dev/null; then
  note "SSH config already has a '$HOST_ALIAS' entry, leaving it alone."
else
  mkdir -p "$HOME/.ssh"
  cat >> "$HOME/.ssh/config" <<EOF

Host $HOST_ALIAS
    HostName $HOST
    User $USER_NAME
    IdentityFile $KEY
EOF
  ok "Added '$HOST_ALIAS' to ~/.ssh/config"
fi

summary ok "Deploy access ready" "Verify with: ssh $HOST_ALIAS"
exit 0
```

Under HC, launched with `scriptify script_path=/tmp/tmp.8fJx2a/setup-deploy-key.sh reason="operator-only host password and personal deploy key"` and handed off as:

> The Scriptify window is open and the script has started. It first asks you to confirm, then ask for your password on the server. Its exit code comes back to me and I'll check the result.

Without HC, give the command itself and ask Algorant to say when it's done:

> ```
> bash /tmp/tmp.8fJx2a/setup-deploy-key.sh
> ```

Note what the script does that a pasted command list cannot: it states up front everything it will touch, it checks for an existing key instead of overwriting one, it stops cleanly if `ssh-copy-id` is missing, it does not duplicate the config block on a second run, and it fails with a readable message if the password is wrong.
