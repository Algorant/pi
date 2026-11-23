---
name: tandem
description: "Tandem coordination workflows and taxonomy: Tasks, subtasks, Decisions, Accord, papercut capture, rules and board sync. Also Board triage of active Tandem work (pending Tasks, research Tasks, and papercuts): give each a verdict and a decider, act on the owner's cards in the same pass, and bring Algorant only his own list. Use when Algorant asks to triage a Task or review a backlog."
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

Decision bookkeeping is not a report for Algorant: agents correct status themselves with `tandem_update`'s `status` field (*Triage* below) and never ask him to accept, confirm or tidy one.

A Decision is not work: it has no Accord, readiness, or backlog, and is never claimed, delivered, completed, or cancelled to tidy the board. It stays on the board as reference. Its status follows reality, and agents correct it themselves with `tandem_update`'s `status` field; do not ask Algorant to accept a Decision that is already in effect:
- in effect: `accepted`;
- replaced: create the new Decision with `supersedes` and set the old one `superseded`;
- only ever a proposal, never adopted: `deprecated`, with a note pointing to the Task that holds the question (file one if none exists).

### Filing a papercut

Trigger and threshold: global AGENTS.md, *Work*. Capture never interrupts or expands the current task.

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

One framework at three levels: **one Task**, **one board**, **all boards**. The four verdicts, the deciders and the card shape are the same at every level; only the scope, who runs it and its trigger change. Choose the level before starting, and keep a level out of the level below it: the all-boards pass sends a project one request rather than triaging that project's board itself.

### The three levels

| Level | Scope | Runs it | Decides | Output |
| --- | --- | --- | --- | --- |
| **One Task** | A named record, plus what it references | Whoever holds it: its Ceph, or the manus running a board pass | That owner; Algorant only for his list | One card, and the action taken in the same pass |
| **One board** | Every active Task, research Task and papercut on one project's board | That board's Ceph, or a manus it starts | The board owner | One digest: counts line, Decided (reversible), then only Algorant's cards |
| **All boards** | Every project board's flags, plus Herdra's own rows and inbox | Herdra | Herdra routes; each board's Ceph decides its own cards | One digest: a section per project, then Algorant's cards batched three or four at a time |

Triggers, none of which starts a timer or a poller: Algorant asks for a triage, summary or review, at any level; a board reaches a milestone or changes hands, for one board; `herdra-check` raises a cross-board flag (`stale-papercut`, `stale-request`, `task-delivered`, `unlinked-item`), or the same card is stale on three or more boards, for all boards.

Classify work cheaply, decide who acts, and act. Use the same four verdicts for pending Tasks, research, and papercuts; the work type determines what happens after a `ready` verdict. Do not create an Epic or an omnibus papercut Task. Papercut *capture* belongs to *Filing a papercut* above, not this Board-review workflow.

Triage covers Tasks only. Decisions (`decision-N`) are standing ADRs: never give them a verdict or recommend closing, cancelling or archiving them, even when a request says "decisions included". One exception runs on every one-board pass: list any Decision still `proposed` (`tandem_read action=list type=decision`) and correct each yourself by the *Decisions are ADRs* rule above; report the corrections in the pass summary and do not ask Algorant to accept them.

### One delegation brief per level

Copy the level's brief; its owner reads the rest of this section itself.

**One Task** (a helper, or the owner doing it directly):

```
One Task: <project>:<task-id> - <title>
Read the record, its acceptance, blockers and references, then run the per-item methodology on it.
Return one card: id - verdict - decider - why, citing the record or current evidence - next action.
Take the action if it is yours (dispatch, one scoping pass, close with a note and evidence); otherwise name who does. Do not start the work itself.
```

**One board** (the board's Ceph, or a manus for a pass over it):

```
One board: <project>
Triage every active Task, research Task and papercut on the board, and correct any Decision still proposed.
Use the four verdicts and act on the cards that are yours in the same pass: dispatch ready work, one scoping pass per refine-scope card, park a wait with its re-check trigger, cancel superseded or obsolete records with a one-line note.
Report one digest to <return route>: the counts line, then Decided (reversible) with one line per action, then only Algorant's cards, each with what it is, why it exists, what doing it means, what he would see, and your recommendation.
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

The same heuristics run per item at every level; the all-boards pass stops at the one that decides *who* owns the item, then hands the item over. Run them cheap-first and stop as soon as one settles a verdict and a next action: a pass costs reads, not work.

| Heuristic | How to check | Points to |
| --- | --- | --- |
| **Already answered?** | `git log` on its files, completed and archived Tasks (Logs), the current code or config, a cheap reproduction of the reported failure | `already-moved-on` |
| **Same work elsewhere?** | `tandem_read action=search` on this board, other boards' `cwd`, prior `herdra-open` rows | `already-moved-on`, consolidated into the record that carries it |
| **Age and activity?** | `createdAt`/`updatedAt`, attempt count, last note, what landed since filing | priority only, never readiness; high priority with nothing since filing is `refine-scope` |
| **Recurrence?** | the same failure twice, repeated flags in the `herdra-check` log, repeated mentions in sessions | `ready` if it still bites; `already-moved-on` if it never recurred |
| **Premise still true?** | the component, file or line it names, the version, the design, upstream behaviour, the minimal repro | `already-moved-on` if it is gone; `refine-scope` if only part changed |
| **Right owner?** | whose files, credentials, machine or approval it needs | transfer to that Ceph or to Herdra, with a note here |
| **Cost vs now?** | the smallest safe change, files touched, one direct edit or a brief | `ready`, done in this pass; if it needs a plan, his proposal card |
| **Dependencies?** | each blocker's state *now*, the depended Task's Accord, an absent machine or credential | `refine-scope` for stale metadata; a park with a real trigger for a live one |
| **His prior word?** | his words in the record, the *Only Algorant decides* list, earlier rows, Decisions | `already-moved-on` if he decided against it; otherwise his card, never a guess |
| **Visible or live?** | UI, rendered output, a live app or desktop config, a public surface | his proposal card with before/after; never a direct dispatch |
| **A real park trigger?** | the event that reopens it, and the date it is re-checked | `refine-scope`, parked with both written in the record; no trigger means cancel or his card |
| **Same area?** | `relatedFiles`, paths, one symptom across items | one merged fix as the carrier, the rest consolidated into it |

Every verdict cites its evidence: the commit, record id, `file:line`, host or capture it rests on. A verdict without one is the cheapest kind of guess, and two items that would take the same fix are one item.

### Three kinds of item

The twelve checks are the same for everything, but what settles an item depends on who holds it. Classify first: a papercut, an in-progress Task (someone holds it: claimed, delivered or blocked), or a not-started Task.

| Kind | The checks that decide it | What "stale" means |
| --- | --- | --- |
| **Papercut** | Recurrence, cost vs now, same area, a real park trigger | Filed, and nothing has bitten again since |
| **In progress** | The holder is alive and moving, its Accord, the last typed handoff | No motion since the holder's last report, or delivered with nobody accepting it |
| **Not started** | Still wanted, still the right shape, his prior word, priority against age | Old, and nothing has landed behind it |

- **Papercuts** take `ready` (fix it now, the smallest safe change), `already-moved-on` (close it cheaply, with the reason) or `refine-scope` (park it with its trigger). The board owner acts in the pass, and several papercuts never become one omnibus Task.
- **In-progress Tasks** take `ready` (accept or return the delivery), `refine-scope` (the holder's shape is wrong) or `needs-direction` (only his decision is left). The holder's owner acts: release a claim whose terminal is gone, chase one that has gone quiet, accept a delivery under *Accepting delivered work*. Never rescope under a live holder without asking it, and never read a delivered Task as untouched backlog.
- **Not-started Tasks** take all four verdicts. The board owner keeps, rescopes, merges or cancels in the pass; an outcome only he can state goes to him as a card. Priority argues with age, never with readiness.

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

Work he must judge arrives as a concrete proposal (a plan, or a before/after carrying a real capture of the current state, never a mockup standing in for it), not an open-ended Task and not an ask whose options he cannot judge from. A card that cannot be written that way is `refine-scope`: its owner runs the scoping pass first and brings it back (Algorant, 2026-11-22: "I don't have sufficient ability to see what these are about. Need better summaries before using ask me tool"; "when I ask to do a triage or give me a summary/review, it uses these guidelines to tell me what I need to know to make a determination").

The pattern is global (global `AGENTS.md`, *Communication*); the fields above are where a Tandem pass supplies it.

### Select and check (cheap)

1. Run `tandem_status`, then `tandem_read`. For a named Task, inspect that record. For a one-board pass, list active Tasks; use `tandem_read action=list kind=research` or `kind=papercut` if Algorant requested only that slice. Do not triage archived records as new work. Group parents with their children; call out an actionable child separately without double-counting the parent's outcome.
2. Read the record's acceptance, constraints, blockers, Accord status and what it references, then run it through *Per-item methodology* above. A delivered Task awaiting owner review is not untouched backlog, and a promised validation that never tests the suspected failure is `refine-scope`.
3. Stop once one verdict and one next action are justified. Do not start Subagents, web research, implementation or a broad audit merely to assign a verdict. If no outcome is stated anywhere, the card is Algorant's (`needs-direction`); do not guess one.

### Four verdicts

| Verdict | Simple criterion | Next action |
| --- | --- | --- |
| `ready` | One bounded outcome, usable acceptance, and prerequisites met; or delivered work ready for review. | Route by type and dispatch: research → read-only helper; implementation → direct work, a manus with its own worktree, or a Worker (`dendra_start {kind: worker}`, `needsAlgorant` per global AGENTS.md); papercut → the smallest safe fix; delivered → owner verification/review. |
| `needs-direction` | The decision is on Algorant's list (global `AGENTS.md`, *Only Algorant decides*). Nothing else is. | One focused card for him; do not guess or dispatch that part. |
| `refine-scope` | Intent is clear, but scope, evidence, validation, ownership, or a real dependency needs correction. | Run one bounded scoping pass yourself (fix the record, or park with its re-check trigger), then reassess. A blocker pointing to an archived completed Task is stale metadata, not a reason to park work. |
| `already-moved-on` | The outcome is accepted, duplicated, implemented elsewhere, superseded, obsolete, or not worth doing. | Cancel it (or consolidate duplicates into one) with a one-line note naming what supersedes it or why. Never modify an archived record. |

For research, `ready` means ready to **research**, not ready to implement. A topic without a decision to produce is `refine-scope`; a superseded premise is `already-moved-on`. For papercuts, search for an equivalent first and keep a distinct, small outcome rather than consolidating unrelated fixes.

### Cards and routing

Return one compact card per Task: `ID — verdict — decider — why (record/current evidence) — next action`. A card that reaches Algorant carries the five fields under *What Algorant needs to decide* instead of the compact form. For research, also give a one-sentence vision of the decision or finding to produce; if that sentence would be a guess, use `needs-direction`. End a pass with one line per nonempty verdict listing IDs. Mark `ready` cards as **research / implementation / papercut / review**, so the next owner is obvious. Highlight high-risk safety work before low-priority polish, but priority does not change readiness.

#### Who decides

Every card names its decider. Keeping the status quo (keep, park, wait) needs nobody beyond the owner.

- **Board owner** (its Ceph, or the manus running the pass) acts in the same pass: dispatch ready work, launch ready research, one scoping pass per `refine-scope` card, park a wait with its re-check trigger, consolidate duplicates, cancel superseded, obsolete, unreproducible-on-current-code or not-worth-it records with evidence, and dispatch work Algorant already approved. Follow the agency skill and the rest of this skill for delegation and workflow.
- **Herdra** decides ownership between projects and priority between Cephs.
- **Algorant** decides only the global *Only Algorant decides* list (AGENTS.md, *Work*).

Report one digest by your role's route: line one is the counts; then **Decided (reversible)**, one line per action so he can reverse any of them by replying (a cancelled Task is archived; authorized recapture creates a new record); then only his cards, batched three or four at a time. Do not create follow-up Tasks just because a card is `ready`.

### Ready research: keep the existing fast path

For a named research Task or any one-board pass, act on `ready` research immediately; do not wait for another launch approval. If a named Task is not actually research (even if it mentions research, a Task is research only when its `kind` is `research`), say so and use the Board verdict without starting the research loop. Research remains research-only: no implementation or implementation/spec Task creation in the research loop.

- For `refine-scope`, write the one-sentence outcome the research must produce from what the record and its references state; if no outcome is stated anywhere, it is `needs-direction` and Algorant supplies it. Once known, prepend `## Vision` to the active Task body, preserving its content, acceptance, tags, and Accord state; then treat it as `ready`.
- Claim `ready` research (`accord claim`, assignee `pi`). Run one read-only `scout` or `researcher` helper per Task, at most **4 live**; queue the rest. That is `dendra_start {kind: scout|researcher, label, task}` (see the `agency` skill). Give each the vision, acceptance, constraints and evidence boundary. Helpers never mutate files or Tandem records. Continue clarifying other cards while they work.
- On return, verify the report yourself. Append a cited `## Findings` section to the active Task body without overwriting existing content. Before closure, preserve existing tags and add `triaged`; also add `intake` only if findings recommend a new implementation/spec/skill/pilot Task that is not already an owned follow-up. Then run `accord deliver` (summary = short verdict, evidence = cited findings) and only then complete the research Task, so completion follows a delivered Accord. Put the outcome and any archived `intake` IDs in the digest. Follow-ups are then decided under *Who decides*; results whose acceptance names Algorant go to him.
- If the research was already completed in this conversation, attach the findings and finish the loop without re-running helpers. For `already-moved-on`, cite the accepted outcome; add `triaged` before closing an active research Task, not after archival.
