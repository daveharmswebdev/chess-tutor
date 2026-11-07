---
name: orient
description: Reconstruct chess-tutor's current state at the start of a session or after /clear — what is in flight (worktrees, PRs, claimed issues), what landed recently and what it flagged, which issues are READY (unblocked and unclaimed), and untracked gaps. Read-only. Used by /cycle; also on its own when the user asks "where are we?".
context: fork
agent: general-purpose
allowed-tools: Bash(git *) Bash(gh *) Bash(node --no-warnings .claude/scripts/ready.ts*) Read Grep Glob
---

You are orienting a coordinator session that is about to start work on chess-tutor. Its
memory is GitHub plus git, not conversation history. You are **read-only**: never file,
label, comment, commit or push.

## Snapshot taken just before you started

Branch and position: !`git status -sb --ahead-behind`

Worktrees (spokes run in `.claude/worktrees/agent-*`): !`git worktree list`

Open pull requests:
!`gh pr list --state open --limit 30 --json number,title,headRefName,isDraft --template '{{range .}}#{{.number}} {{.headRefName}} draft={{.isDraft}} :: {{.title}}{{"\n"}}{{end}}'`

Issues and readiness (from the board, project 5, and GitHub "blocked by" links; READY =
Todo, unclaimed, every blocker closed):
!`node --no-warnings .claude/scripts/ready.ts`

Recently merged:
!`gh pr list --state merged --limit 8 --json number,title,mergedAt --template '{{range .}}#{{.number}} {{.mergedAt}} {{.title}}{{"\n"}}{{end}}'`

CI on main: !`gh run list --branch main --limit 3`

`main`: !`git log --oneline -10 origin/main`

## Work to do

1. `git fetch --quiet origin`. For every worktree branch and every open PR, list the files
   it touches: `git diff --name-only origin/main...<branch>`.
2. Read the last three merged PR descriptions (`gh pr view <n> --json body`). Pull out
   anything they flagged (`contract_gaps`, `brief_defects`, findings, "follow-up") and
   check whether an issue tracks each one.
3. Look for real gaps with no issue: `git grep -nE "TODO|FIXME|not yet|to be verified"` in
   `docs/`, `CLAUDE.md` and `packages/`, `apps/`, plus open questions (`Q-n`) in
   `docs/requirements.md` §8 that aren't resolved and have no issue. Confirm with
   `gh issue list --state all --search "<keywords>"` before calling one untracked.
4. Read the cycle ledger (`.git/cycle-ledger.md`, if it exists) and collect every gap listed
   under **Not filed** in any cycle, with its reason. A gap from step 2 or 3 that matches one
   is not an untracked gap: list it under **Known, not filed** in one line, and skip it unless
   you found new evidence (a new PR or file:line that changes the picture), which you then name.
5. Check that the readiness data is consistent: an issue whose blockers are all closed
   but that is still marked blocked, an issue missing from the board, a closed issue not
   in Done.

## Output (under 50 lines, this exact shape)

```
## Repo state — <date>
**This checkout:** <branch>, <ahead/behind>, <clean|dirty>   **CI on main:** <green|red|running>

**In flight**
| Worktree / PR | Branch | Issue | Files touched (top 5) |

**Collision risk:** files touched by more than one in-flight branch, or an in-flight
branch touching a shared file (root package.json, pnpm-lock.yaml, config/*, docs/*,
.claude/*, .github/workflows/*). "None" if none.

**Landed recently:** #n title — what it flagged, and whether that is tracked

**From you:** issues labelled `from-you` (they outrank everything), and anything in
"Needs you". "None" if none.

**Ready now:** #n (Kind, Priority, owner area) — one line each, highest priority first

**Blocked:** count, and the one or two blockers that unblock the most work

**Untracked gaps:** each with evidence (file:line or PR #) — recommend filing via /triage

**Known, not filed:** gaps the ledger already decided against, one line total, e.g. "bot.ts
castling fallback, promotion picker (ledger)". Only re-raise one with new evidence.

**Suggested next:** 1–3 READY items that don't collide, each with a one-line reason
```

Report only what the commands showed. If a command failed, say which one and continue.
