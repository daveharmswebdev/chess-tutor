# Orchestration: hub and spoke

| | |
|---|---|
| Status | Adopted 2026-11-07 |
| Adapted from | the setup in `my-team-is-better/.claude`, ported to TypeScript and cut down for this repo's size |

Development runs as **hub and spoke**. The main Claude Code session is the **coordinator**
(the hub). Specialised subagents (the spokes) do scoped work. **All communication goes
through the coordinator**; spokes never talk to each other.

## Principles

1. **Isolation.** A spoke inherits none of the coordinator's conversation and remembers
   nothing between runs. Everything it needs is in its brief: interfaces pasted verbatim
   and measured facts. Two calls to the same spoke are two independent briefs.
2. **Contracts as JSON Schema, enforced by code.**
   - `brief.schema.json` (coordinator → spoke) is checked when the brief is rendered, and
     again when it is dispatched.
   - `return.schema.json` (spoke → coordinator) is checked by hooks before the report
     reaches the coordinator.
3. **The schema checks shape, the coordinator checks truth.** Valid JSON can still claim
   tests passed when they didn't. The coordinator re-runs the gate and compares
   `git diff` with `files_changed` before accepting a round.
4. **Failures trace to their origin.** A missing category of work is a decomposition
   failure by the coordinator, not a spoke failure. Spokes report the coordinator's
   mistakes in `brief_defects` and `contract_gaps`.
5. **The coordinator chooses spokes per task.** It doesn't run every spoke on every task.

## The spokes (`.claude/agents/`, ownership in `.claude/ownership.json`)

| Spoke | Kind | Owns |
|---|---|---|
| engine-agent | implementation | `packages/engine/**` |
| core-agent | implementation | `packages/chess-core/**`, `repertoire/**` |
| explorer-agent | implementation | `packages/explorer/**` |
| tutor-agent | implementation | `packages/tutor/**`, `prompts/**`, `evals/**` |
| server-agent | implementation | `apps/server/**` |
| web-agent | implementation | `apps/web/**` |
| reviewer | read-only | nothing; reviews a commit range |
| researcher | read-only | nothing; answers API and docs questions with sources (no shell) |
| *coordinator* | hub | everything else: `docs/`, `config/`, `.claude/`, root config, dependencies |

Implementation spokes work test-first and **in their own git worktree**
(`isolation: "worktree"`, branched from the coordinator's HEAD), and they commit their work
there. The coordinator merges a spoke's branch only after verifying it.

## Enforcement

```
coordinator                                       spoke (in a worktree)
───────────                                       ─────────────────────
brief JSON ──render-brief (schema + ownership + base commit)──► rendered prompt
Agent call ──[PreToolUse Agent: pre-agent]────────────────────► starts
               denies: not rendered · brief edited since ·
               wrong agent · no worktree isolation
                                                   Edit/Write ──[PreToolUse: guard-edit-scope]
                                                                 denies edits outside ownership
                                                   report ──[PreToolUse SubagentHandback: pre-handback]
                                                   or final ──[SubagentStop: subagent-stop]
                                                                 invalid → errors sent back to the
                                                                 SPOKE to fix (max 2), then contract_failed
result ◄──[PostToolUse Agent: post-agent]── logs, tells the coordinator the verdict
verify: git diff == files_changed · re-run gate · read brief_defects → merge or re-delegate
```

- Hook code lives in `.claude/hooks/` and is tested (`pnpm test` includes `.claude/hooks/test`).
- Hooks always execute the **main checkout's** copy (the command `cd`s to the git common
  dir's parent), so a spoke can't change its own guardrails inside its worktree.
- Hooks **fail closed**: a crashing gate exits 2, which blocks the action.

## Observability

`.claude/orchestration/log.jsonl` is tracked in git. One JSON line per event:

| Event | Written by |
|---|---|
| `dispatch`, `dispatch_denied` | pre-agent |
| `return_valid`, `return_invalid`, `contract_failed` | pre-handback / subagent-stop |
| `edit_denied` | guard-edit-scope |
| `agent_complete` (tokens, duration, contract verdict) | post-agent |
| `coordinator_verdict` | the coordinator, by hand (accepted / rejected / re-delegated) |

Briefs are kept in `.claude/orchestration/briefs/` (tracked), so every round can be replayed.

## Workflow and visibility

The user tracks progress on **GitHub**, not in code:
[issues](https://github.com/daveharmswebdev/chess-tutor/issues) and the
[project board](https://github.com/users/daveharmswebdev/projects/5), with columns
Needs you → Todo → In Progress → In Review → Done, a Kind field and a Priority field.
Dependencies are GitHub "blocked by" links, so a card shows why it hasn't started.

| Skill | What it does |
|---|---|
| `/cycle [parallel] [rounds]` | The usual loop: orient, triage gaps, pick READY issues, work them in parallel worktrees, ship, repeat. Keeps a ledger in `.git/cycle-ledger.md` |
| `/orient` | A read-only snapshot (forked agent): in flight, landed, READY, blocked, untracked gaps |
| `/triage` | Files gaps and findings as readable issues: deduped, clustered, on the board, with blocked-by links |
| `/delegate` | One issue, one spoke: claim, brief, launch, verify |
| `/ship` | A PR written for the user, CI green, squash merge, board to Done, worktree cleanup |

Scripts: `.claude/scripts/board.ts` (set Status, Kind and Priority; P0/P1 need the user's
approval) and `.claude/scripts/ready.ts` (which issues are unblocked and unclaimed).

## Known limits

- The hook input fields come from the Claude Code docs. They're confirmed by the first
  real dispatch, not by tests (the tests feed in synthetic input).
- `guard-edit-scope` sees Edit and Write, not files written through Bash. The coordinator's
  `git diff` check covers that.
- `.claude/settings.json` changes (the hook wiring) are made by the user, not by Claude.
