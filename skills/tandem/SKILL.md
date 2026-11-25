---
name: tandem
description: "Tandem coordination workflows and taxonomy: Tasks, subtasks, Decisions, Accord, papercut capture, rules and board sync. Also Board triage of active Tandem work (pending Tasks, research Tasks, and papercuts): apply the triage rule to each, name its decider, act on the owner's cards in the same pass, and bring Algorant only his own list. Use when Algorant asks to triage a Task or review a backlog."
---

# Tandem coordination

Use the installed Tandem tools/CLI for coordination. Tandem owns IDs, hierarchy, workflow, Accord, rules, and board synchronization; do not reimplement them in TypeScript or manipulate `.tandem/` files.

## Archived-record corrections

Archived records are read-only to agents (global AGENTS.md, *Work*); `tandem update` accepts only active records. If a correction is refused, explain once and let Algorant decide on a supported repair; never edit `.tandem/` or reopen/recreate a Task to bypass it.

## Normal coordination

Every call uses the JSON envelope. `tandem_read` uses `scope=active|archived|all`; active versus archived is determined by the returned `location`, not `state` or `resolution`. `tandem_sync` supports sync, local status, and conflict resolution.

Use `tandem_status` before coordination. Pass the same `cwd` to every call for the board you checked, especially when reading or closing records; a close with a different or omitted `cwd` can target the same ID on another board. If no workspace exists, ask before `tandem_init`. Use `tandem_add action=task` for normal work, with a non-empty `acceptance` array.

### Decisions are ADRs, not work items

A Decision (`decision-N`) is an ADR on every board, not a homelab-server habit: it records one lasting architecture choice — a structure, protocol, storage format, boundary or dependency the project will live with — and why. Create one only when that is what happened, in the step it is settled, set `accepted` in the same step (Tandem creates Decisions as `proposed`). Never leave a Decision `proposed`: an open question belongs in a Task or a research doc.

Not a Decision, whatever it decides: Algorant's answer to a question, his pick between options, a scope change, a deferral or a "do it this way" instruction. Those are recorded on the Task that asked — its evidence, note or body — where the work and its history already live. "He decided X" is not the signal; "the project will be built this way from now on" is. When in doubt it is a note on the Task, not a Decision: a wrong Decision outlives the question that produced it, and four of them on one question is exactly how a board stops being read.

Decision bookkeeping is not a report for Algorant: agents correct status themselves with `tandem_update`'s `status` field and never ask him to accept, confirm or tidy one.

A Decision is not work: it has no Accord, readiness, or backlog, and is never claimed, delivered, completed, or cancelled to tidy the board. It stays on the board as reference. Its status follows reality, and agents correct it themselves with `tandem_update`'s `status` field; do not ask Algorant to accept a Decision that is already in effect:
- in effect: `accepted`;
- replaced: create the new Decision with `supersedes` and set the old one `superseded`;
- only ever a proposal, never adopted: `deprecated`, with a note pointing to the Task that holds the question (file one if none exists).

### Filing a papercut

Trigger and threshold: global AGENTS.md, *Work*. When a tool call fails, recover first; file only if it shows a brittle tool contract, confusing guidance or recurring friction, after checking for a duplicate; expected one-off failures do not count. pi-tandem's turn-end context line lists the turn's failed calls to make the decision easy. Capture never interrupts or expands the current task.

Search first so duplicates do not accumulate: `tandem_read action=list kind=papercut scope=active` (or `action=search`) for an equivalent. If one exists, add a reference or note only when useful; do not file a duplicate. If no equivalent exists, `tandem_add action=task` with `priority: low`, `kind: "papercut"`, and at least one acceptance criterion.

Workers and Subagents keep the same eager posture but never file Tandem records. They report a candidate to the parent — short title, one-line friction, and why it still hurts — and the orchestrator decides and files. Capture itself never triages, consolidates or cleans up the backlog, and never creates omnibus `papercut-fix` Tasks; consolidating and cancelling belong to a triage pass (*Board triage*, *Who decides*, below).

### Tasks, subtasks, and Epics

For discrete work a Ceph takes on, follow the Task default in global AGENTS.md, *Work*; Task-free briefs are only a Worker or manus option for sub-pieces below Ceph level.

- Default to a standalone Task for one independently deliverable outcome.
- When that outcome needs defined steps, use a Task with appropriate subtasks/milestones within it. A request for a Task with subtasks is not permission to create an Epic with child Tasks.
- An agent may ask Algorant whether an Epic is warranted. Do not create an Epic (`kind=epic`) unless Algorant explicitly requests or approves an Epic. Scope size, effort, multiple steps, or coordination needs alone do not authorize one; without approval, use Tasks and appropriate subtasks/milestones.
- An Epic's children are subtasks to `dendra_start {kind: worker}`, which refuses them (a Worker owns a whole root Task). When an approved Epic's pieces should go to Workers, create those pieces as root Tasks and reference them from the Epic (`references`) instead of parenting them under it.
- Tandem owns hierarchy and IDs. Check the installed CLI's current taxonomy and parent semantics before creating or converting a hierarchy; do not infer them from older guidance or fabricate subtask IDs. IDs are immutable, so a subtask cannot be promoted to a root Task: Tandem 0.17.7 refuses a reparent that changes its canonical role. Never clear or change a subtask's parent.

`accord claim` requires `assignee`; `deliver` requires `summary` and at least one non-empty `evidence` entry, and accepts changed files. `rework`, `block`, and `release` require a note. `resume` takes only the ID. `tandem_close action=cancel` requires a note.

Lifecycle (installed Tandem; re-check after upgrades):
- `deliver` sets the Accord to `delivered` but leaves workflow `state` unchanged (the Task stays in progress).
- `tandem_review` is exceptional human escalation and the only way into `state: validation`: it requires a `criterion` that exactly matches one of the Task's acceptance criteria (a non-matching criterion is rejected) and a note.
- Review is root-only: a Subtask (`task-N-M`) fails with `Subtasks cannot be reviewed`. Do not retry it, review a different record to emulate it, or file a duplicate review Task. To record a human decision pending on a Subtask, `tandem_accord action=block` that Subtask with a note naming the pending choice and where it is being decided (the Herdra/Algorant thread), then `resume` it once decided. Review the root Task instead only when the decision gates one of the root's own acceptance criteria.
- `tandem_close action=complete` on a delivered Task accepts the Accord and archives it in one step; there is no separate accept action. Completing a Task that was never delivered succeeds with the warning "complete normally follows a delivered Accord"; that is by design, but deliver first when there is evidence.
- There is no `move` command, and `update --status` applies only to Decisions; on a Task it fails.

Use `tandem_update` for metadata and explicit `clear` fields. It cannot change assignee or Accord state. Use `tandem_rules` for project rules. Workers report evidence; the orchestrator owns root workflow transitions and cleanup.

Tandem syncs its board itself through the `tandem` branch. Mutation `data.sync.status` may be `synced`, `pending`, `local-only`, or `not-git`; `pending` means saved locally, not failed. Temporary IDs such as `task-new-3f9a2c1d` remain accepted after numbering. Linked worktrees have no `.tandem/`; Tandem commands from them use the main worktree's board.

Use `tandem_sync` for synchronization and local `sync status`. Surface conflicts and held edits to Algorant; resolve only with `tandem sync resolve <id> --keep local|remote|edited` when authorized. Never stage, commit, push, edit, delete, or rename `.tandem/` or the `tandem` branch; board sync is independent of source Git push. Delivery requires nonempty observational evidence; test counts are not acceptance. Who completes a delivered Task: global AGENTS.md, *Work*, "Accepting delivered work"; completing records `reviewer` as the person whose approval it rests on (normally Algorant).

## Board triage

One framework at three levels: **one Task**, **one board**, **all boards**. The rule, the deciders and the card shape are the same at every level; only the scope, who runs it and its trigger change. Choose the level before starting, and keep a level out of the level below it: the all-boards pass sends a project one request rather than triaging that project's board itself.

### The three levels

| Level | Scope | Runs it | Decides | Output |
| --- | --- | --- | --- | --- |
| **One Task** | A named record, plus what it references | Whoever holds it: its Ceph, or the manus running a board pass | That owner; Algorant only for his list | One card, and the action taken in the same pass |
| **One board** | Every active Task, research Task and papercut on one project's board | That board's Ceph, or a manus it starts | The board owner | One digest: counts line, Decided (reversible), then only Algorant's cards |
| **All boards** | Every project board's flags, plus Herdra's own rows and inbox | Herdra | Herdra routes; each board's Ceph decides its own cards | One digest: a section per project, then Algorant's cards batched three or four at a time |

Triggers, none of which starts a timer or a poller: Algorant asks for a triage, summary or review, at any level; a board reaches a milestone or changes hands, for one board; `herdra-check` raises a cross-board flag (`stale-papercut`, `stale-request`, `task-delivered`, `unlinked-item`), or the same card is stale on three or more boards, for all boards.

### The triage rule

Run `~/Projects/herdra/bin/herdra-triage --rules` for the current rule. It reads:

1. An agent is working on it right now: leave it.
2. Delivered: verified → complete it (if it's Algorant's call, a card first). Not verified → rework to its owner.
3. Not started: start it, scope it, ask Algorant, or cancel it.
4. Anything else (idle, blocked, stale): still wanted → a new Task citing the old one, then archive the old one. Not wanted → archive it with a note.

Decisions are never triaged.

Archiving a Task is `tandem_close action=cancel` with a note; archived records are read-only.

Classify work cheaply, decide who acts, and act. Apply the matching rule line to every Task, research Task and papercut; the work type determines what starting it means. Do not create an Epic or an omnibus papercut Task. Papercut *capture* belongs to *Filing a papercut* above, not this Board-review workflow.

### One delegation brief per level

Copy the level's brief; its owner reads the rest of this section itself.

**One Task** (a helper, or the owner doing it directly):

```
One Task: <project>:<task-id> - <title>
Read the record, its acceptance, blockers and references, then run the per-item methodology on it.
Return one card: id - matching rule line - decider - why, citing the record or current evidence - next action.
A helper reports the card and takes no action; its owner acts on it in the same pass. Do not start the work itself.
```

**One board** (the board's Ceph, or a manus for a pass over it):

```
One board: <project>
Triage every active Task, research Task and papercut on the board; never a Decision.
Apply the matching rule line to each, and act on the cards that are yours in the same pass.
Report one digest to <return route>: the counts line (one count per rule line), then Decided (reversible) with one line per action, then only Algorant's cards, each with what it is, why it exists, what doing it means, what he would see, and your recommendation.
Post anything he must see or judge in <Sideshow session>. Do not wait for it.
```

**All boards** (Herdra; it routes rather than triages another project's board):

```
All boards: read the herdra-check flags, the herdra-open rows and inbox open, and each board's active Tasks.
Fix what is Herdra's: its rows, its inbox, and its own board as a one-board pass.
Send every other board's Ceph one request naming the cards found and asking for a one-board pass on that board.
Report one digest: a section per project, then Algorant's cards batched three or four at a time.
```

### Per-item methodology

The same heuristics run per item at every level; the all-boards pass stops at the one that decides *who* owns the item, then hands the item over. Run them cheap-first and stop as soon as one settles a rule line and a next action: a pass costs reads, not work.

| Heuristic | How to check | Tells you |
| --- | --- | --- |
| **Already answered?** | `git log` on its files, completed and archived Tasks (Logs), the current code or config, a cheap reproduction of the reported failure | whether it is still wanted |
| **Same work elsewhere?** | `tandem_read action=search` on this board, other boards' `cwd`, prior `herdra-open` rows | whether another record carries it; cite that record in the note |
| **Age and activity?** | `createdAt`/`updatedAt`, attempt count, last note, what landed since filing | priority only, never readiness |
| **Recurrence?** | the same failure twice, repeated flags in the `herdra-check` log, repeated mentions in sessions | whether it still bites |
| **Premise still true?** | the component, file or line it names, the version, the design, upstream behaviour, the minimal repro | whether it is still wanted, or which part to scope |
| **Right owner?** | whose files, credentials, machine or approval it needs | who acts: transfer to that Ceph or to Herdra, with a note here |
| **Cost vs now?** | the smallest safe change, files touched, one direct edit or a brief | the smallest safe change; if it needs a plan, his proposal card |
| **Dependencies?** | each blocker's state *now*, the depended Task's Accord, an absent machine or credential | whether the blocker metadata is stale (scope it) |
| **His prior word?** | his words in the record, the *Only Algorant decides* list, earlier rows, Decisions | his card, never a guess; a decision against it means it is not wanted |
| **Visible or live?** | UI, rendered output, a live app or desktop config, a public surface | his proposal card with before/after; never a direct dispatch |
| **Same area?** | `relatedFiles`, paths, one symptom across items | one carrier Task for the fix; the rest are cancelled with a note naming it |

Every disposition cites its evidence: the commit, record id, `file:line`, host or capture it rests on. A disposition without one is the cheapest kind of guess, and two items that would take the same fix are one item.

### Three kinds of item

The checks are the same for everything, but what settles an item depends on who holds it. Classify first: a papercut, an in-progress Task (someone holds it: claimed, delivered or blocked), or a not-started Task.

| Kind | The checks that decide it | What "stale" means |
| --- | --- | --- |
| **Papercut** | Recurrence, cost vs now, same area | Filed, and nothing has bitten again since |
| **In progress** | The holder is alive and moving, its Accord, the last typed handoff | No motion since the holder's last report |
| **Not started** | Still wanted, still the right shape, his prior word, priority against age | Old, and nothing has landed behind it |

- **Papercuts** follow the rule line their state gives, usually rule 3. Several papercuts never become one omnibus Task.
- **In-progress Tasks** follow rules 1, 2 and 4.
- **Not-started Tasks** follow rule 3; an outcome only he can state goes to him as a card. Priority argues with age, never with readiness.

### Reading the ask

The kind and the level come from the words, and a pass never widens them on its own. A named kind is a filter (`papercuts`, `in progress`, `todo`); with no kind named, take every kind. The level is the scope the ask names, else the scope implied by who is speaking.

| The ask | Kind | Level |
| --- | --- | --- |
| "triage the papercuts" | papercuts only | the implied level: that board when a project is in play, every board when it reached Herdra with none |
| "triage the in progress" | claimed, delivered and blocked Tasks only | the same |
| "triage the todo" | not-started Tasks only | the same |
| "triage <project>" | every kind | that board |
| "triage the boards" (to Herdra, with no project) | every kind | every board, one request per Ceph |

"Triage this Task" needs no split: it is one item. State the kind and level you read in the digest's first line, so a wrong reading costs one reply instead of a whole pass.

### What Algorant needs to decide

When he asks for a triage, a summary or a review, every item he is shown gives him what he needs to decide it himself: **what it is**, in plain words and by its label; **why it exists**; **what doing it means**, the concrete change, its owner and its size; **what he would see**; and **the recommendation with its reason**. Batch three or four at a time and keep detail behind a link.

Work he must judge arrives as a concrete proposal (a plan, or a before/after carrying a real capture of the current state, never a mockup standing in for it), not an open-ended Task and not an ask whose options he cannot judge from. A card that cannot be written that way needs scoping: its owner runs the scoping pass first and brings it back (Algorant, 2026-11-22: "I don't have sufficient ability to see what these are about. Need better summaries before using ask me tool"; "when I ask to do a triage or give me a summary/review, it uses these guidelines to tell me what I need to know to make a determination").

The pattern is global (global `AGENTS.md`, *Communication*); the fields above are where a Tandem pass supplies it.

### Select and check (cheap)

1. Run `tandem_status`, then `tandem_read`. For a named Task, inspect that record. For a one-board pass, list active Tasks; use `tandem_read action=list kind=research` or `kind=papercut` if Algorant requested only that slice. Do not triage archived records as new work. Group parents with their children; call out an actionable child separately without double-counting the parent's outcome.
2. Read the record's acceptance, constraints, blockers, Accord status and what it references, then run it through *Per-item methodology* above.
3. Stop once one rule line and one next action are justified. Do not start Subagents, web research, implementation or a broad audit merely to place an item. If no outcome is stated anywhere, the card is Algorant's (ask him); do not guess one.

### Acting on the rule

- **Start it** (rule 3): one bounded outcome, usable acceptance, prerequisites met. Route by type: research → read-only helper; implementation → direct work, a manus with its own worktree, or a Worker (`dendra_start {kind: worker}`, `needsAlgorant` per global AGENTS.md); papercut → the smallest safe fix.
- **Scope it** (rule 3): the owner runs one bounded scoping pass (fix the record), then reassesses.
- **Ask Algorant** (rule 3): the decision is on his list (global `AGENTS.md`, *Only Algorant decides*); nothing else is. One focused card for him; do not guess or dispatch that part.
- **Cancel it** (rule 3) and **archive it** (rule 4): the note says why, or names what supersedes it.
- **Delivered** (rule 2): the owner verifies the actual outcome under global `AGENTS.md`, *Work*, "Accepting delivered work", then completes it or reworks it to its owner. Where the acceptance is Algorant's call, he gets a card first. Accord mechanics stay under *Lifecycle* above.

For research, starting means starting the **research**, not implementing it. A topic without a decision to produce needs scoping; a superseded premise is archived. For papercuts, search for an equivalent first and keep a distinct, small outcome rather than consolidating unrelated fixes.

### Cards and routing

Return one compact card per Task: `ID — rule line — decider — why (record/current evidence) — next action`. A card that reaches Algorant carries the five fields under *What Algorant needs to decide* instead of the compact form. For research, also give a one-sentence vision of the decision or finding to produce; if that sentence would be a guess, the card is Algorant's. End a pass with one line per nonempty rule line listing IDs. Mark start-it cards as **research / implementation / papercut**, so the next owner is obvious. Highlight high-risk safety work before low-priority polish, but priority does not change readiness.

#### Who decides

Every card names its decider.

- **Board owner** (its Ceph, or the manus running the pass) acts on the cards that are his in the same pass by the matching rule line, and dispatches work Algorant already approved. Follow the agency skill and the rest of this skill for delegation and workflow.
- **Herdra** decides ownership between projects and priority between Cephs.
- **Algorant** decides only the global *Only Algorant decides* list (AGENTS.md, *Work*).

Report one digest by your role's route: line one is the counts by rule line; then **Decided (reversible)**, one line per action so he can reverse any of them by replying (a cancelled Task is archived; authorized recapture creates a new record); then only his cards, batched three or four at a time. Do not create follow-up Tasks except the replacement rule 4 calls for.

### Research to start: the fast path

For a named research Task or any one-board pass, start startable research immediately; do not wait for another launch approval. If a named Task is not actually research (even if it mentions research, a Task is research only when its `kind` is `research`), say so and apply the triage rule without starting the research loop. Research remains research-only: no implementation or implementation/spec Task creation in the research loop.

- For research that needs scoping, write the one-sentence outcome the research must produce from what the record and its references state; if no outcome is stated anywhere, it is Algorant's and he supplies it. Once known, prepend `## Vision` to the active Task body, preserving its content, acceptance, tags, and Accord state; then start it.
- Claim startable research (`accord claim`, assignee `pi`). Run one read-only `scout` or `researcher` helper per Task, at most **4 live**; queue the rest. That is `dendra_start {kind: scout|researcher, label, task}` (see the `agency` skill). Give each the vision, acceptance, constraints and evidence boundary. Helpers never mutate files or Tandem records. Continue clarifying other cards while they work.
- On return, verify the report yourself. Append a cited `## Findings` section to the active Task body without overwriting existing content. Before closure, preserve existing tags and add `triaged`; also add `intake` only if findings recommend a new implementation/spec/skill/pilot Task that is not already an owned follow-up. Then run `accord deliver` (summary = short verdict, evidence = cited findings) and only then complete the research Task, so completion follows a delivered Accord. Put the outcome and any archived `intake` IDs in the digest. Follow-ups are then decided under *Who decides*; results whose acceptance names Algorant go to him.
- If the research was already completed in this conversation, attach the findings and finish the loop without re-running helpers. For research whose outcome already landed, cite the accepted outcome; add `triaged` before closing an active research Task, not after archival.
