---
name: ship
description: Take a verified spoke round from its worktree branch to merged main — PR written for the user (Closes #n), board to In Review, green CI, squash merge, board to Done, release the claim, and clean up the worktree. Used by /delegate and /cycle after verification passes.
argument-hint: "[issue-number]"
---

# Ship

Arguments: `$ARGUMENTS`. Run this only after `/delegate` step 6 has verified the round:
`git diff` matches `files_changed`, the gate was re-run green, and the reviewer (if run)
found nothing blocking.

## 1. Push and open the PR

The spoke committed on its worktree branch. Publish it under a readable name:

```bash
git push origin <worktree-branch>:issue-<n>-<slug>
gh pr create --base main --head issue-<n>-<slug> --title "<issue title>" --body-file <scratch>/pr-<n>.md
node --no-warnings .claude/scripts/board.ts <n> --status "In Review"
```

If `main` moved since the spoke's base commit, first rebase the worktree branch onto
`origin/main`, re-run the gate, and push that.

## 2. The description is written for the user

The user does not read code; this description is what they read. Keep the part outside
`<details>` short and plain:

```markdown
## What changed
<2-5 plain-language bullets: what you can now see or do, or what now works underneath>

## How to try it
<the exact commands or clicks; "tests only, nothing to click yet" is a fine answer>

## Tests
- `pnpm test`: <N passed> (re-run by the coordinator)  ·  `pnpm typecheck`: clean
- CI: see the check on this PR

## Delegation record
Rounds: <brief ids> · Reviewer: <no findings | n findings, all resolved | filed #n>
contract_gaps / brief_defects: none | <list>

<details><summary>Validated spoke returns</summary>

<one fenced json block per spoke return, labelled by agent and round>
</details>

Closes #<n>
```

Requirement IDs go in **What changed**. End the description with the PR attribution line
from your session instructions.

## 3. Merge (CI must be green)

```bash
gh pr checks <pr> --watch          # red means another round, never a merge
gh pr merge <pr> --squash
gh pr view <pr> --json state -q .state   # MERGED before cleaning up
git push origin --delete issue-<n>-<slug>
```

## 4. After the merge

- `node --no-warnings .claude/scripts/board.ts <n> --status Done` (the merge closed the
  issue; the board's own automation may be off).
- `gh issue edit <n> --remove-label in-progress`.
- If the issue was the last open child of an Epic, say so in the report. Don't close the
  Epic; the user does that.
- **Clean up the worktree.** The squash merge means git won't see the branch as merged,
  so confirm the PR is MERGED first (step 3), then:
  ```bash
  git worktree remove .claude/worktrees/<agent-dir>
  git branch -D <worktree-branch>
  git fetch -q origin && git pull --ff-only
  ```
- Log the outcome:
  ```bash
  node -e 'require("fs").appendFileSync(".claude/orchestration/log.jsonl", JSON.stringify({ts:new Date().toISOString(),event:"shipped",issue:<n>,pr:<pr>})+"\n")'
  ```
- Once the app is on Render (#12): check that the deploy for this commit went live, and
  note the result on the PR.
