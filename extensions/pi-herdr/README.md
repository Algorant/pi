# pi-herdr

Native herdr-core integration for Pi. Enabled by `HC_TERMINAL_ID`; it does not
create an app layout, report status, or emulate Herdr panes. Pi already emits
OSC 7501. Use `hc ls` / `hc get` for live terminal discovery and identity.

## Purpose

custom extension for herdr and herdr-core (hc)

## Dependencies

- herdr

## M1: durable inbox

`pi-herdr` registers the pi-agency inbox: one tool, receiver and journal
implementation. `agent_send` takes one `terminal` recipient:

- `terminal: "herdra"` — a native HC name or live address in the local core.
  Resolve with `hc get` on **every send**; don't save a currently observed
  Herdra terminal id as its identity. An unnamed Pi is addressed by the live
  address returned by `hc ls`, until it is relaunched with a native name.
- `terminal: "laptop/t3"` — a terminal in another machine's core, by its
  native `hc machine ls` name (no host/target aliases). See below.

The current native terminal and permanent core id identify HC queue keys in
`$XDG_STATE_HOME/pi-agency/inbox/` (default `~/.local/state/pi-agency/inbox/`).
Names/labels/parents/status remain native HC
facts, not another registry. `HC_SCOPE` is **not** used as a persistent identity.

Delivery is the existing atomic file drop + filesystem watcher + public
`pi.sendMessage` path, not `hc send` text pasted into a composer. Message ids,
`reply_to`, the `/inbox` overlay, inbox CLI, local journal and shared compaction
hold/release behavior are retained. A live terminal can queue mail until its Pi
loads; finished terminals are rejected. Pending mail is scanned on session start
and after settlement. Existing version-1 Herdr envelopes remain readable without
rewriting history; unsupported/misaddressed pending files are retained and reported.

### Across machines

A `machine/terminal` send needs that machine connected in `hc machine ls`. The
sender puts the machine's permanent core id (its `id` there) in `to.core` and
pipes the envelope through native `hc exec --on <machine> -i` to that machine's
`inbox drop` (`.pi/agent/scripts/inbox` below its home; the same resources at
the same home-relative path). That core resolves its own terminal now, rejects
a core id other than the addressed one or a terminal that is not live, and
queues the file with the same atomic drop its Pi watches. No SSH, second store,
outbox, retry or composer paste. Failures (unknown or disconnected machine,
missing resources, wrong or finished terminal, changed core) are reported to
the sender and logged as `fail`; the sender logs `send`, the receiver `deliver`.

The receiver answers by core id, not by name: machine names differ per core
(desktop calls homelab-server `homelab-server`). On delivery it looks up the sender's
`from.core` in its own `hc machine ls` and tells the agent to answer
`terminal=<that name>/<from.terminal>`; with no such machine it says the message
cannot be answered from there. A reply needs the route in both directions.

Both endpoints need the updated resources loaded. Reload only affected Pis when
idle; do not reload the fleet. A nested Pi in the same terminal does not install
a second inbox consumer.

## Native operations versus inbox

`hc send` is useful for bootstrap instructions, but is **not** durable inbox
transport. From inside HC it wraps text as an agent report, including text such
as `/reload`; that is not a Pi slash-command invocation. For an approved control
operation on an owned/authorized idle terminal, use native keys, for example
`hc keys <terminal> / r e l o a d enter`, then verify the actual reload result.
Never force through a blocked dialog or restart the person's core/app.

## Idle compaction

`compaction.ts` is registered after the shared inbox: an unparented Pi in an
app space (Herdra, a Ceph or a manus; `hc get` shows no parent and a
`herdr.space` label) that settles idle, with nothing pending, at or above 60% of
its window calls `ctx.compact()`. It adds no instructions and injects nothing:
pi-agency's nstar is the only post-compaction injector (its block plus this
terminal's open inbox items). The inbox holds delivery during any compaction;
a failed attempt is retried only after the context grows. Pi's native
auto-compaction remains the backstop. No working-token cap or model/window
setting is introduced.

## Native read-only children

The native `scout`, `researcher` and `reviewer` helpers run `pi --agency-profile <name>`
under `child-exit`, with the task as Pi's first message on its command line:

```sh
hc run --bg --rm --no-notify --name trace-scout -- ~/.pi/agent/scripts/child-exit pi --agency-profile scout -- "Read only src/x.ts; return the API contract with line references."
```

Agents start them with `dendra_start` (below), which runs exactly this launch.

Profiles use the existing `pi-agency/agents/<name>.md` tools/prompt and
`model-roles.json` quota/availability policy, not models copied into templates.
The tool allowlist applies to direct and nested codemode calls. All three profiles include `bash` (database queries, Python/uv, git, file readers); read-only is the profile prompt's role instruction, not a tool lockout. Profile startup
cannot fall through to ordinary main tools or the orchestrator model selector.
Finite analysis image limits remain the existing policy. Parent/model metadata are native facts, not a run map.

A child calls `report({text, question:true})` for clarification. A question ends
its job too: after sending it, the child closes unless explicitly kept. The
parent can answer a kept child or start follow-up work using the saved artifacts.
An ordinary final assistant answer is forwarded automatically at `agent_before_settle`
through the same durable inbox path, with no extra model request. Explicit final
`report({text})` also works. A successful final delivery exits after settlement
unless native `keep` is true; `--rm` is native cleanup. Questions MUST use
`report({text, question:true})`: plain text is always final, never a question.
Call report alone after other tools finish. Line 1 of `text` is the answer: a
first line over 160 characters is rejected with `put a one-line headline first,
details below`, nothing is sent, the job does not end and report may be called
again; an automatic plain final answer keeps its headline cut to 160 characters. One attempt is allowed per prompt;
question and failed attempts suppress duplicate sending/retry. Failures are
recorded in the session and sent as an error outcome through the same durable
parent inbox, then the child closes unless kept. This does not retry an ambiguous
report. A vanished parent cannot receive a notice; the session/native exit
record remains, without an orphan process. Pending final text is consumed once.

Every outcome (final, question or error) goes through `sendAgentMessage`, the
one durable inbox: the parent's Pi receives a labelled `result` agent message
(`pi.sendMessage`, never its composer or `hc send`), so an unsent draft there is
left alone. Final reports and questions are written in full to a private
`/tmp/pi-herdr-report-*/report.md`; the message carries only the labelled headline
(`Final report (<role>): …` / `Question (<role>): …`), that report path and the
kept session path. An error carries its cause in the headline,
`Error (<role>): <cause>`, plus the session (or a note that startup wrote none). The parent must be a Pi (its inbox receiver). The receipt is
the queued envelope id; it proves the message was queued, not that the parent
processed it. An unconfirmed drop is an error outcome, never resent or typed.

Require an actual final report, not just idle/done/exit0. A failed profile
startup (unknown profile, missing parent `pi.model`, no available model, …)
makes no model request and sends exactly one `Error (<role>): HC profile startup
failed: …` to the parent inbox; that message is the failure record. Native HC
still records `exit_code: 0`: the only public close, `ctx.shutdown()`, takes no
code and exits 0 by design (upstream pi#11746), and Pi reports OSC 7501 `error`
only for a failed run, so its status stays `idle` until exit. Pi's model picker can
report done while it owns input (task-506). No private exit/status hack or
duplicate notification system is added (task-505).

Pi publishes its current `pi.model=provider/id` label on its own terminal at
startup and model selection, and clears it on orderly shutdown. A reviewer uses
the native parent's label and existing opposite-company selection (including
aggregator model-family mapping); missing/unmapped metadata fails before inference.

Native HC owns parent/child placement, status, events, peek, keep and lifetime.
No Subagent launch/result/message/continue tools, placement/completion polling,
retained-run state or mirror registry is added under HC.

Native exit/blocked notes are typed into the parent's composer like `hc send`
(a draft there is submitted with them), and `--rm` drops hc's exit note
entirely unless the parent sits in `hc wait`, which agents never do (task-601).
So every child whose end its owner must hear (helpers, Workers, manus, Cephs and
background jobs) runs `--no-notify` under `agent/scripts/child-exit <command>`.
It runs the command in the foreground and exits with its status. When the command
ends without its terminal having sent any inbox message since it started, it
sends one inbox `result` to the owner: the hc parent, else the `starter=` label.
That covers a Pi that dies before loading its report path, crashes, or is
killed, and every plain program. The result names the child, its exit, its
folder and its last screen lines. "Reported" is decided only from the durable
inbox log. A duplicate is preferred to silence; there is no watcher, registry
or retry. Scriptify uses one app-created terminal without an hc parent; its
explicit original-caller inbox result is the outcome path (see below).

## One child lifecycle

Every native Pi child—not only profile helpers—hands back its outcome and closes
when its job ends, unless explicitly kept. Start a background job whose end you
need (a build, a measurement, a timer) as
`hc run --bg --rm --no-notify --name <job> -- ~/.pi/agent/scripts/child-exit <command>`:
its end arrives as an inbox result and starts your turn, with no waiting. A
job you never need to hear from (a server, the agent Chromium) keeps plain
`hc run --bg --rm`. Omitting `--rm` retains a finished record, not a running job. Keep an interactive
child only on an explicit request with native `hc keep`/`--keep`, then release
with native close/remove. No label taxonomy, expiry table or parent-side cleanup watcher.

## Scriptify

`scriptify` resolves the caller's actual work pane before launch (native
parent ancestry for a child), then calls `pane.split down` with the runner
script as its direct argv. This creates **one app-owned native terminal**,
not an hc-launch wrapper plus another runner. The runner enters the invoking
agent's cwd (a native child may work outside its parent's pane folder).
Native space/tab labels are
supplied by the app; readable `label=` and `kind=scriptify` are set afterwards.

Algorant explicitly approved the brief native focus/zoom jump (Herdra
m0be7bf9c, option B). The tool reads Herdr's own `view.json` and live status
before launch, immediately restores the work tab's original focus/zoom and
previous selected space/tab using native actions, and sizes the caller/runner
with `layout.resize` weights 2:1. The runner is **below**, bottom third of
the split pair; the agent is above, top two-thirds. Other existing panes still
share their tab. Native focus restoration can briefly select the caller's tab
before returning to the previously shown tab. Restored zoom can hide the runner
until Algorant unzooms normally.

Only supported app actions are used. No right-adoption fallback, guessed
direction/ratio labels, job discovery, readiness wait, overlay/peek, timer,
supervisor, bridge or layout service. Missing/inconsistent work-pane or native
view metadata fails before launch; unsupported layout-block focus is reported,
not guessed. Restoration is attempted even after an ambiguous split response.
A partial placement failure names the launched terminal when known: inspect it
and the inbox; never rerun or cancel a running user script automatically.

The script starts immediately; its own first confirmation before any change
is the presence boundary. Sudo still requires an observed non-elevated
permission failure and Algorant's prior approval. Credentials stay in the
runner. Read-only helpers ask their owner; a managed Worker (`--worker-context`)
is refused before launch and asks its owner through `worker_ask` to run the
reviewed script, since its invocation ends before any outcome. Remote steps run from their owning
agent's tab on that host; no `machine` switch or remote attach/kill bridge.

**App-owned lifetime is intentional** (Herdra m8e30e9b0). Native `pane.split`
does not expose hc parent, name or `--rm`; caller ending alone does NOT kill
the runner. Do not nest `hc run` to emulate those settings. The runner is
labelled, not given a fabricated native name. Native `hc keep --off` disables
loss recovery; the reviewed command is never automatically rerun. Normal exit
closes its pane natively; the script summary still says “You can close this pane.”

The existing `bash scriptify-job.sh` sends one outcome to the ORIGINAL invoking
Pi's durable inbox, even when its work pane belongs to its parent. `CANCELLED`
means exit130 (No/Ctrl+C) or runner hangup/terminate (pane close/`hc kill`).
Other nonzero statuses are `FAILED`; plain exit1 is not cancellation.
Verify effect independently of exit0. Hard runner/host loss can prevent a
report: no observed result is never success.

## Naming: label and whois

One naming system (task-585, herdra task-81 design B). Every start path
(`dendra_start` helper and Worker, `manus_start`, `ceph_start`, `scriptify`)
takes `label`, 2-5 plain words for Algorant ("Cleaner alert cards"). Without one
Task-free Worker/manus starts require it; otherwise it falls back to the Task title or first line of the helper task (Scriptify: of the reason). It is stored on the primitive, as hc labels
`label=` and `kind=` (scout, researcher, reviewer, worker, manus, ceph,
scriptify); there is no registry. The hc name, and a Worker's or manus's
branch, is the label's slug (`cleaner-alert-cards`), `-2`, `-3`… when a live hc
terminal, any Worker's durable name or a branch of that repo already has it.
Labels never depend on a Task id; a Task id rides in the `task=` label. A Ceph
keeps its project as hc name (its route); its label defaults to
"<project> Ceph". Scriptify's app-created terminal is the other exception:
its readable native label names it at its address, with no fabricated hc name.
A Worker's label is also in its control record, so it names
the Worker between invocations.

`agent/scripts/whois.ts` resolves any id to `{label, kind, project, id}`, and
`agent/scripts/whois` is its CLI (`whois [--json] [--cwd DIR] <id>...`). A
terminal's name is its `label=`, else "Herdra" for the Pi named `herdra`, else
"<Project> Ceph" for a Pi in a space's `main` tab, else its hc name, else its
address. `hcAddress` (whois.ts) gives the inbox that name, so every message
carries `from.label`.

## Dispatch: dendra_start, manus_start, ceph_start

`dispatch.ts` registers the three start tools of the task-65 contract (Herdra
m63db715a) for owner Pis (not Workers or read-only profile children). Each one
checks every precondition before any side effect, launches once, checks the
launch and returns `{terminal, name, …}`. None selects or focuses anything (the
one approved exception: `space.new` shows a NEW project's space), waits,
polls, retries, falls back, or sets a model; defaults come from
`model-roles.json`. A later failure keeps what already exists (a created
checkout or space) and names it; nothing is removed automatically.

- Return route: the caller's hc name, or its live address when it is unnamed
  (no invented name). Children of `dendra_start` report to their native parent.
- `from: <msg id>` must be an open request/blocker addressed to the caller in
  this machine's inbox log; after a confirmed launch it is closed through the
  shared inbox close (`closeMessage`) with the note `dispatched to <label> (<name>)`. A failed close is reported, the
  launch stands.
- `dendra_start {kind, task, label?}` for `scout`/`researcher`/`reviewer` runs
  `hc run --bg --rm --no-notify --json --name <slug> --cwd <cwd> --label label=<label>
  --label kind=<kind> -- child-exit pi <owner's -e set> --agency-profile <kind> -- "<task>"`
  and requires a live terminal with that name. The report arrives as before;
  an end without one arrives from `child-exit`.
- `dendra_start {kind:"worker", taskId?, brief?, label?, worktree?, needsAlgorant?, prompt?}` is the one Worker start. Exactly taskId OR brief, label required Task-free. A Task-free Worker is small self-contained work; larger work gets a Task or manus. No fabricated Task, `change` shortcut or alternate launcher.
- `manus_start {taskId?, brief?, label?, worktree?, needsAlgorant?, direction?}` resolves the unique app host whose native space ID matches the caller's `herdr.space` label and whose tab contains the caller terminal; when `herdr.tab` exists it must match too. This also supports existing local callers that have no `herdr.tab` label, while still requiring unique actual terminal membership. It checks the app space's native machine alias against the caller's permanent HC core id using that app host's `hc machine ls`; it discovers only the local app and currently connected peers. Missing app binaries are skipped; no membership, multiple memberships, or unresolved identity refuses before side effects. The HC launch, worktree, starter and inbox return route remain on the caller's core. With default worktree:true it creates the checkout through Worktrunk, `wt switch --create <branch> --base @ --no-cd`, so a manus branches from its starter's HEAD exactly as a Worker does, then writes a manus record (below) before launching, so a created checkout always has an owner. Native `--rm --no-parent` under `child-exit` (its `starter=` hears an unreported end), optional task=, starter=, label= and needsAlgorant= labels. The child receives the unqualified native `herdr.space` id and uses the resolved host for its one app rename; it never merges or closes itself. A failed launch keeps the checkout and names the record, so the starter can finish or discard it. No focus/wait/poll.
- Task-free brief strings preserve the request verbatim with nonempty Outcome / Scope / Exclusions / Check / Done sections (Markdown headings accepted). Scope lists repo-relative files/directories, directories ending in `/`; Check uses runnable `$ ` lines plus manual observations. Managed context adds label, owner/return route, project/checkout and needsAlgorant. Git and originating inbox thread are the record, alongside existing Worker lifecycle/receipts.
- `ceph_start {project, folder, kickoff, label?}` requires `folder` to be its own Git
  checkout root with a Tandem workspace (projectify prepares both). It refuses
  when `hc ls` shows a live terminal named `<project>` or at `<project> / main`
  on this or a connected machine; unreachable machines are returned as
  `notChecked`. It reuses the local space for `folder` without switching
  (adding a missing `tandem` tab by adoption; a space that already has a
  `main` tab is a repair to clarify) or creates the new space with
  `space.new --tab tandem`, then starts `pi` named `<project>` (labels
  `label=<label or "<project> Ceph">`, `kind=ceph`) in it and renames its tab `main`.

Raw `pi "<brief>"` launches have no hc first message: their start proof is the
live terminal with the requested name, and the real proof is the child's own
inbox report. Manus and Ceph launches forward the caller's explicit
`--no-extensions`/`-e` set exactly as Workers do. Each tool draws its pi-ui
card (`custom-tools/dispatch.ts`): one line when collapsed (`⇢ <kind> <name> ·
<terminal> · <where>`), the boxed fields when expanded, the boxed refusal on
error, through a load-time resolver so reloaded rows keep their cards.

## Pi reload and shared live inventory

`/pi-reload` sends typed control requests through the EXISTING inbox, never
through another Pi's composer or `hc keys`. Its consume result records delivery
without starting a target model turn. A typed control is consumed by its
receiver, never shown to the model, so it is delivered even while the target is
working: the target records it as a `pi-reload-pending` entry plus one card
naming the request and why it waits (`this Pi is working`, `waiting for queued
messages`). Every idle boundary retries the recorded request
(`agent_settled`, and the private apply mode itself), so a request that cannot
apply now is never dropped: it applies at the Pi's next idle boundary. A
dispatch that never ran is retried by the next boundary; there is no latch that
can strand a request. A request still unapplied 10 minutes after it was recorded
is answered with `not-applied` instead of staying pending, so it always leaves a
visible outcome. A request recorded in an earlier session is recorded as
deferred at `session_start` and applies at the next idle boundary (never a
reload from inside `session_start`). A self-addressed request travels the same
path as a peer's, with the same pending state and outcome.
Idle receivers dispatch `/pi-reload` with
the private argument `--internal-apply`; busy receivers persist the request and
dispatch from `agent_settled` with
`pi.sendUserMessage(..., {expandPromptTemplates:true})`. The argument is not in
argument completion and the command list keeps one entry.
The registered command alone calls `await ctx.reload(); return;`. The caller
reloads FIRST, only when its loaded revision differs from `~/.pi` HEAD: it writes
a hidden `pi-reload-sweep` session entry (no card of its own) and reloads; the new runtime consumes that
entry once at `session_start` (`reason: "reload"`, marked done by a
`pi-reload-sweep-done` entry) and runs the sweep itself, so the ack handling and
card are always the newest code, there is no early-ack race, and a change to this
very reload path works on the sweep that ships it. A caller already on HEAD
sweeps immediately. No timers, polling or keys. Honest limit: a Pi still running
older code (before this change) starts the old kind of sweep; the guarantee holds
from the first sweep started by a caller that has it.

Known limit: **an open dialog on the target closes when it reloads**; this was
observed on real `/settings` and accepted through Herdra m575081c0. Drafts must
survive. Native idle/done is NOT proof of an empty editor or no dialog. No
arguments, model change, package update (the one pull is below), core/app restart, polling,
watcher or shell/keying fallback. Busy callers/pending messages are refused;
current repository HEADs are skipped. Tracked modifications and untracked
files are informational "local changes present", never a reload gate. A durable
compact/expanded summary card (`reload-summary.ts`) counts `Reloaded 12/13 to
<rev>` and names every Pi the sweep did not reach with its reason, in one
`not reached:` list: `busy: applies at its own idle boundary` (the request was
delivered and the target applies it itself), `bootstrap` / `unreadable` /`offline`
skips, and the failed ones. A busy target is never folded into a count and never
counted as done; it is requested, and its acknowledgement updates the same card
when it arrives. A connected machine whose `~/.pi` HEAD differs from
the caller's is classified from history only (behind, ahead, diverged, or unknown):
one read-only `git rev-list`, run on that machine through `hc exec` only when just it
knows the caller's commit. Only a **strictly behind** machine is then fast-forwarded,
before any reload is requested there: `git -C ~/.pi pull --ff-only` through `hc exec`
(`pullBehind` in `live-pis.ts`), never forced, reset or stashed. The card says
`homelab-server: pulled 80476428 → 991b17b9`, or `homelab-server: not pulled (diverged | ahead |
unknown history | pull failed: <git's message>)` and that machine's Pis reload their
own checkout. Peers on a machine with its own HEAD are grouped as
`<machine> on its own checkout (<rev>) n/m`. Boilerplate (HEAD marker is not byte
attestation, no keys or polling, local changes, dialog limit) is expanded-only.

`session_start` writes the repository HEAD observed at load to native
`pi.resources` (unknown only if unidentifiable), plus `pi.pgid` (its process
group) and `pi.session` (its session file), clearing them at shutdown.

**A Pi that lost its terminal is never reloaded** (task-632). A Pi stopped and then
continued without `fg` keeps running as a background job of its shell: the pty is
`-tostop`, so it still renders and runs inbox turns, and hc keeps reporting it
idle/done, but its next tty read (a key, or the replies to the colour query every
reload sends) stops its whole group with SIGTTIN, and from then on it consumes
nothing. The sweep compares `pi.pgid` with hc's foreground (`piBackground` in
`core.ts`): such a Pi, or one already stopped, gets a FAILED row `stopped or a
background job (terminal foreground: zsh)` with `restart: pi --session <file>`
and no request. A target that finds its own group (`/proc/self/stat`) is not
its tty's foreground answers `not-foreground` instead of reloading, and
`agent_send` reports such a recipient as `background`: it waits until restarted.
Local changes never suppress that HEAD marker. This is not byte attestation;
HEAD-current does not claim that local resource bytes are unchanged.
After a requested reload, the new runtime verifies the expected revision and
sends ONE typed `result` (`control.type` `pi-reload-ack`, `reply_to` the request)
through the existing inbox to the caller. The caller's inbox transform records
it in a hidden `pi-reload-ack` session entry and consumes a success (`verified`,
`current`) with `return null`: no caller turn, no conversation entry, whether or
not it matches a sweep on this caller. A target answers every request recorded
while the private apply mode runs (a second queued request on an idle Pi), and a
request whose revision HEAD has since moved past is `current` when the target
already runs HEAD. A failure (`not-verified`, `not-reloaded`, `not-applied`,
`not-foreground`,
a request that could not be sent) is recorded in the card; when every request of
the NEWEST sweep is answered and any failed, ONE ordinary `pi-reload-failure` message
repeats the card's own compact line (`Reloaded 5/6 to <rev>; FAILED: <Pi>: <why>`, so the model need not see the card; rendered as one red line, the per-Pi rows when expanded) (once per sweep, `pi-reload-notified`
entry; an unanswered target keeps the sweep unsettled, so no message; an older,
superseded sweep settles silently). A failure
matching no sweep card is delivered as the ordinary result it is. The sweep
card reads the recorded acknowledgements when it renders, so a late (busy)
target updates the SAME card (appending the hidden ack entry repaints the TUI;
observed, with no explicit repaint call). A
pending target stays pending until its acknowledgement arrives (no polling or
timers); the card names it under `not reached` with `busy: applies at its own
idle boundary` meanwhile. Accepted input alone is never proof of reload. The caller's own reload
is never an acknowledgement sent to itself.
`pi.reload=1` advertises an actually loaded receiver, not readiness. First
installation: EACH old-loaded participating Pi needs an ordinary built-in
`/reload` at its actual idle prompt; one caller bootstrap cannot upgrade an
absent target receiver. Missing receivers are reported, never blindly keyed.
Native children/Workers are reported unsupported and never requested: their
owner controls their job lifetime. Any target can exit before acknowledging;
a requested result is never counted as verified. Rerun is explicit, not a watcher.

### Typed model request (cutover receiver)

Same endpoints, same inbox interception and same idle/`agent_settled` dispatch as reload (long-lived
tui owners only; Workers/children and non-tui get a failure result). Control
`{type:"pi-model", model:"provider/id", thinking, fast}` (canonical refs as in `model-roles.json`;
`modelControlError` in `inbox/envelope.ts` validates on both sides) is consumed before note capture: no
target model turn and no composer input, so drafts survive. At idle (from the inbox transform) or
`agent_settled` the receiver itself calls `pi.setModel()` and `pi.setThinkingLevel()` and dispatches
the existing `/fast on|off` command (no new command; the Fast owner is required, else the request
fails); when that owner publishes `pi-openai:fast-state` it sends ONE `result`
(reply_to the request) with the actual end model, thinking and Fast, or `model request FAILED:
<reasons>. Actual: ...` for an unknown/unauthenticated model, invalid field, unsupported endpoint,
clamped thinking or ineligible Fast. Sender, standalone Bun (no Pi runtime), no fake context:
`import { requestModel } from "agent/scripts/live-pis.ts"`;
`requestModel(target /* LivePi.address */, { model, thinking, fast }): Promise<{ id, route }>`
(throws on invalid fields or an unroutable target). The change is recorded in the target's session
and published as `pi.model`; defaults and settings are untouched. Fast is session-local and resets
to on at the next `session_start` (including `/reload`). Needs the updated resources loaded on the
target (one ordinary `/reload` to install, as for reload). Receivers advertise `pi.model-control=1` (cleared at shutdown; `LivePi.modelCapable`); `requestModel`
refuses a target without it before anything is queued, because an older Pi would deliver the request to its
model. Ack aggregation is not part of this.

Shared read-only discovery: `agent/scripts/live-pis [--json]`, or import
`livePis(): Promise<LivePiInventory>` / `resourceRevision(root?)` from
`agent/scripts/live-pis.ts`. Native core/machine/terminal APIs plus whois's
`terminalWho` supply labels/roles, exact routes, model/status, loaded marker,
per-machine `~/.pi` target HEAD/informational local-change state and errors.
The existing `resourcesDirty` boolean reports repository tracked/untracked
changes only; neither the helper nor reload predicates use it as a refusal. Missing markers are
unknown. JSON is returned even on partial inspection; the CLI exits 1 if a
machine/Pi cannot be inspected. See [the design boundary](../../../plan/safe-pi-reload.md)
for schema details, exact idle-versus-settled proof evidence and limitations.

## Native Workers (M3)

Task-backed and Task-free Workers run as native HC children of their owner Pi. Tandem stays
the Task/ownership authority, Worktrunk the checkout/merge/removal authority, and
the existing handoff/receipt store (`$XDG_STATE_HOME/pi/worker-handoffs`,
`worker-integration-outcomes`) the workflow record. Each datum has one writer:

- `handoff-hc-*.json` (version 8) is an owner **control** record, written only
  by the owning Pi: Task, owner `{core, terminal}` and session, captured
  checkout/model/assignment, plan policy and approval, the exact direction, the
  owner's launch observation, owner state (pending/failed/paused/discarding/
  discarded), handoff-read, rework and discard stamps. It names the Worker
  invocation it directs by `invocationId` and never holds what the Worker
  produced (control writes reject report/question/handoff/session fields).
- A **manus** writes the same record with `kind: "manus"` (no separate store or
  prefix). It is just as complete, so every reader — including a Pi still
  running the previous release — validates it instead of failing the list: it
  carries its label, Task plus captured `assignment` (or its brief), needsAlgorant,
  starter `{core, terminal}`, the Pi session it was launched with, base HEAD and
  the captured integration, with `planRequired: false` and `model: "pi-default"`
  because a manus takes Pi's own default model rather than a dispatch model role.
  The Worker-only delivery fields it does not have (direction, plan approval,
  rework stamps) are refused if present. Finish and discard read it like a
  Worker's and record the same integration receipt.
- The writer validates before writing: an incomplete record (no
  `childSessionId`, `model` or `planRequired`) is refused at write time with a
  clear message and nothing is stored, so no reader is poisoned later. A
  unreadable or invalid file already in the store is skipped by the list with a
  stderr warning naming the file, and every tool keeps working with the healthy
  records (task-680: one bad file must never take the store down as a whole).
- `invocation-hc-*.started.json` is the Worker's start acknowledgement and
  `invocation-hc-*.json` its one typed handoff (question, report or failure,
  with its real terminal and session). The Worker creates each once
  (exclusive link); nothing rewrites them.

Receipts stay version 2. No Herdr pane/workspace fields, no status mirror.
Files left by the retired legacy Worker runtime are not read.

- `dendra_start {kind: "worker"}` (the native Worker start) keeps the Task-backed eligibility gate (root Task, effort,
  validations/relatedFiles, plan-first, 12k assignment limit) and refuses a second
  active Worker for a linked Task. Task-free work has no Task gate. With default worktree:true it creates the checkout through Worktrunk's own
  creation lifecycle, `wt switch --create <branch> --base @ --no-cd` (no
  `--no-hooks`/`--yes`): Worktrunk refuses unapproved project hooks before it
  creates anything, blocks on pre-switch/pre-start, and dispatches
  post-start/post-switch in the background, so hooks run exactly once and
  pre-start finishes before Pi starts. A lifecycle failure after creation keeps
  the checkout for inspection. It writes the pending record, claims the Task once for the
  stable native Worker name, then runs
  `hc run --bg --rm --no-notify --outlive-parent --name <worker> --cwd <checkout>
  --label pi.worker.invocation=<id> --label kind=worker --label task=<project>:<taskId>
  --label label=<label> -- child-exit pi <owner's -e set> --session-id <id>
  --model <worker role> --worker-context -- <prompt>`. A failed `hc run` is
  resolved by that atomic label; it is never retried.
- The Worker captures its invocation from its own label (checked against name,
  session ID, checkout and core) once, when a run starts, and uses that capture
  until the run settles; a later label or owner change never re-binds it.
  `worker_report` takes a short form for trivial/small-effort Tasks (status,
  summary, files, evidence; version, taskId and empty validation/blockers/risks
  are filled in) and requires every field for medium and larger Tasks; the
  brief carries the matching guidance. The stored report keeps one shape.
  `worker_report`/`worker_ask` publish the invocation's handoff and end it; at
  settlement a run that published nothing publishes its failure (the real
  diagnostic, including plain text without a report), one notice goes to the
  inbox of whichever owner control currently holds the invocation, and the
  invocation closes unless natively kept. The owner derives the delivery state
  (question/ready/delivered/failed/paused/...) from its control record, the
  handoff and the native terminal. The pi-herdr child `report` path is off for
  Workers. A vanished owner cannot receive the notice; the handoff remains.
- `worker_feedback`/`worker_answer`/`worker_resume` open a successor delivery and
  start a NEW invocation with the SAME `--session-id`, checkout and captured
  model; no checkout or creation hook reruns. A working invocation receives
  in-flight feedback with `hc send --if working`. An explicitly kept settled
  invocation is relabelled to the new invocation and continued in place; an
  unkept live one that is still starting/closing is refused. Plan approval
  (a plan handoff needs `approve:true` again), question IDs, post-ready
  rework-once receipts and Tandem block/resume are unchanged. Each delivery
  records its exact direction (start prompt, feedback, approval or answer) and
  the delivery whose typed handoff it answers; it reached the Worker exactly
  when that invocation acknowledged its start. A refused send/launch fails the delivery, an
  unconfirmed one stays pending; either way nothing is retried, `worker_handoff`
  shows the direction with the prior handoff, `worker_feedback`/`worker_answer`
  refuse, and `worker_resume` delivers exactly that direction (only a Worker that
  already received its direction gets the generic continuation). Because owner
  and Worker never write the same file, neither can drop the other's data.
- `worker_recover` adopts a Worker into a new owner session/terminal (owner Pi
  restart) without continuing it: a successor control record for the SAME
  invocation, carrying only owner data, with no relabel, so a running
  invocation's late handoff and notice reach the new owner. `worker_status`
  shows its terminal, runtime and `report · delivery` state; `worker_pause`
  records the Tandem block, marks its control paused, interrupts and confirms
  it stopped working (a handoff published first still wins).
- A ready `worker_report` runs the Task's runnable validations once in the
  Worker checkout, records their exit codes against the reported HEAD in the
  immutable report (`checks`; a failure is recorded, not hidden) and delivers
  the report to Tandem (`accord deliver`) only when Task-backed. Task-free runs baseline diff-check plus runnable Check/project-rule commands instead of Task validations. Its owner notice carries the report,
  the diffstat and a short diff (at most 120 lines / 8000 characters, with a
  `[diff cut: …]` marker naming the full `git diff` command), so the owner can
  review and call `worker_finish` without another read.
- Auto-finish always refuses needsAlgorant:true; the owner routes that judgement to Algorant before manual finish. Task-free Workers are small by definition, using declared Scope instead of effort/relatedFiles. Auto-finish (Algorant, herdra task-68): the owner Pi's inbox reads its own
  Worker's ready notice before delivery. A small (or trivial) Task without
  plan-first and not tagged `review` (Algorant must see or judge it), whose report has no blockers, whose recorded checks (at least
  one) all passed at the current HEAD, whose diff stays inside the Task's
  `relatedFiles` (an entry ending in `/` covers a folder) and whose target
  checkout is clean, is finished there by the same `worker_finish` path
  without an owner call; the delivered notice names the merge range and the
  `git revert` command. Otherwise the review notice is delivered with
  `Auto-finish not applied: <reason>` and nothing is merged.
- `worker_finish` and `worker_discard` keep the merge-once and discard receipts:
  checks that passed at worker_report on the same HEAD are reused (any other
  HEAD or a recorded failure reruns them), `wt merge --no-remove` once, one
  Tandem write (`tandem complete --note` naming the merge) accepts the already
  delivered outcome,
  then only the captured terminal is ended and only the captured checkout is
  removed with foreground `wt remove`. A retry resumes unfinished steps only.
  Task completion, release and removal stamp their intent first; a retry after
  a lost marker accepts the step only from that intent plus observed Tandem
  (archived `completed` for this Worker / released with a higher discard count)
  or Git state (checkout unregistered and gone), never from absence alone. One
  owner's lifecycle tools for the same Worker run one at a time.
- Both tools also take a **manus** record. Its inbox delivery is the handoff, so
  the Worker-only gates are skipped: no typed report, no invocation-id match, no
  Worker scope/assignee equality, and Tandem acceptance only when the record
  carries a Task (delivered from the integration itself, with the changed files;
  Task-free stays git + inbox). CrashSummary applies only to a Worker. The
  worktree half is the same code: validate the captured checkout, refuse a dirty
  source, `wt merge --no-remove`, write the receipt, close the terminal with `hc
  kill` then `hc rm` (the Herdr tab follows its terminal; pi never calls an app
  tab command), foreground `wt remove`; discard force-removes with `--force
  --force-delete`. A live manus whose terminal is working is refused until it
  delivers. A manus belongs to the starter's core and terminal rather than one
  Pi session, so a starter that resumes a new session still finishes it, while
  any other Pi is refused by name. A Task-backed finish runs the Task's runnable
  validations at the manus HEAD and a failing check blocks the merge; Task-free
  runs the baseline diff-check plus its Check lines.
- Explicit worktree:false refuses a second active worktree-less Worker on the same checkout. Source and target are that checkout, launch HEAD is the diff base. Finish accepts committed work there without merging and closes only its child; finish/discard retain shared checkout/branch and uncommitted work. No lock or queue. The shared accepted range covers commits since dispatch; owners coordinate other actors there.
- Task-free report/continuation/recovery/pause/finish/discard never writes Tandem. needsAlgorant and originating thread survive recovery. worker_status/handoff/recover/resume accept an unambiguous label or hc name; recovery taskId is optional and must match when supplied. Receipts retain label, optional Task, originating thread, accepted git range and revert. Uncommitted work cannot be ready: it is preserved and reported needs-input.

Every native Worker tool (owner and Worker side) draws the pi-ui Worker card,
also through a load-time renderer resolver, so rows rebuilt by `/reload` or a
resumed session before `session_start` registers the tools stay boxed. Native
cards show the actual terminal and its runtime, or "no invocation", never a
Herdr workspace. The native Worker brief says it is the last delegation level:
it starts no Subagents, Reviewers, Workers or other agents and asks its owner
with `worker_ask` instead.

Workers inherit the owner's explicit `--no-extensions`/`-e` selection so owner
and Worker run one protocol version. `worker_feedback` routes in-flight
direction; `worker_pause` interrupts.

## Migration boundary

Inbox (including `machine/terminal` routes), idle-compaction, native read-only
profiles, native Workers and Scriptify work-tab splits are enabled under HC, the single
current path. A Pi outside HC registers nothing native. The legacy Herdr
integration (pi-herdr, pane-backed Subagents/Workers, Herdra widget, naming and
lead hooks, SSH pane routing) was removed in task-551 and lives only in Git
history.

The name `pi-herdr` was reused on 2026-11-10 for this extension, which was called
`pi-hc` until then: `hc` is herdr-core, and naming the extension after the CLI it
drives was the confusing half. Commits, Tandem records and plan documents from
before that date that say `pi-herdr` mean the retired pane integration above, and
anything that says `pi-hc` means this extension.

Shared model selection remains registered by
pi-agency. Helpers keep HC's default parent lifetime; Workers use `--outlive-parent`
(see `plan/hc-parent-lifetime.md`). Tandem and Worktrunk remain the policy, Task
and checkout authorities.
