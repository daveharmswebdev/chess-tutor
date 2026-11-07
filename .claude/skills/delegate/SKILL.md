---
name: delegate
description: Hand a scoped task to one of chess-tutor's spokes (engine/core/explorer/tutor/server/web-agent, reviewer, researcher): decide whether to delegate, check the premises, write a schema-checked brief, render it, launch it in a worktree, then verify the hook-checked return. Use for every delegation in this repo.
argument-hint: "[agent] [task]"
---

# Delegate a round

Arguments: `$ARGUMENTS`

## 1. Should this be delegated?

Do it inline for a typo, a one-line fix, docs, or root config: those are coordinator
territory anyway. Delegate implementation work inside an owned area
(`.claude/ownership.json`). Pick **only the spokes the task needs**. A typical feature is
one implementation spoke, then the reviewer. Use the researcher *before* the brief when
an API question would otherwise be guessed.

## 2. Decompose deliberately

List every case the requirement IDs name (e.g. FR-6 (a)–(d)) and make sure each one lands
in some brief's objective or rubric. A category missing from the work traces back to this
step, not to a spoke. Split parallel rounds so their `scope`s don't overlap.

## 2b. Claim the issue

Every round belongs to a GitHub issue (file one first if needed: the user reads issues
and the board, not code). The board is project 5.

```bash
node .claude/scripts/board.ts <n> --status "In Progress"
gh issue comment <n> --body "Started: <agent> is building this (brief <brief_id>)."
```

## 3. Prepare the base

- Commit anything the spoke depends on **first** (contract types, dependencies added to
  package.json and the lockfile, config). Worktrees branch from HEAD
  (`worktree.baseRef: "head"`); uncommitted work isn't carried over.
- `git rev-parse --short HEAD` → `base_sha`.
- **Check every premise** the brief states (a count, a threshold, a path, "tests are green
  at base") by running it, and paste the real output into `contract`.

## 4. Write the brief

`.claude/orchestration/briefs/<NNN>-<slug>-r<round>.json`, against
`.claude/schemas/brief.schema.json` (example: `.claude/schemas/examples/brief.core-agent.json`).
`contract` must be **self-contained**: paste the actual interfaces, types and measured
numbers. The spoke cannot see this conversation.

## 5. Render and launch

```bash
node .claude/hooks/delegation.ts render-brief .claude/orchestration/briefs/<id>.json --out <scratch>/<id>.prompt.md
```

Pass the rendered text as the Agent prompt, with `subagent_type` set to the spoke and
`isolation: "worktree"` for implementation spokes (and for a reviewer that runs commands).
The `pre-agent` hook denies a prompt that wasn't rendered from a valid, unchanged brief.

## 6. When the spoke returns

The hooks have already checked the shape, and `post-agent` tells you the verdict.

- **Not `return_valid`** (`return_invalid`, `contract_failed` or `unchecked`): the round
  failed as `malformed-return`. Use nothing from it; re-plan.
- **`failure`**: read `failure_type`, `retryable` and `alternatives`. Fix the brief or
  the input, then send the next round with a fresh brief and `round + 1`.
- **`success`**: verify, don't trust:
  1. `git diff --name-only <base_sha>..<head_sha>` must equal `files_changed`, and sit
     inside the brief's `scope`.
  2. Re-run the gate (`pnpm test && pnpm typecheck`) on that commit yourself.
  3. Read `brief_defects` and `contract_gaps`: these are *your* errors to fix.
- Only after verification passes: push the spoke's branch as `issue-<n>-<slug>` and open the PR:

  ```bash
  gh pr create --title "<issue title>" --body-file <scratch>/pr.md   # body: Closes #<n>
  node .claude/scripts/board.ts <n> --status "In Review"
  gh pr checks <pr> --watch                                          # CI must be green
  ```

  The PR body is written **for the user**, who reads it instead of the code. Sections:
  *What changed (plain language)*, *How to try it*, *Tests* (counts from your own re-run,
  and the CI check), and a *Delegation record* (brief IDs, rounds, verdicts).
- Run the reviewer (if the change warrants it) before merging. Blocking findings mean
  another round, not a merge.
- Merge with a squash once CI is green: `gh pr merge <pr> --squash --delete-branch`.
  The merge closes the issue. Then `node .claude/scripts/board.ts <n> --status Done`
  (the project's own automation is off; enable "Item closed → Done" in the project's
  settings to make this automatic).

## 7. Record

`.claude/orchestration/log.jsonl` is written by the hooks (dispatch, verdict, tokens,
duration). Append the coordinator's own decision for the round:

```bash
node -e 'require("fs").appendFileSync(".claude/orchestration/log.jsonl", JSON.stringify({ts:new Date().toISOString(),event:"coordinator_verdict",brief_id:"<id>",verdict:"accepted|rejected|re-delegated",reason:"<one line>"})+"\n")'
```
