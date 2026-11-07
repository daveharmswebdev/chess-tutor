---
name: triage
description: Turn findings from spoke or reviewer returns, or untracked gaps from /orient, into GitHub issues the user can read — dedupe against open and closed issues, cluster repeated symptoms, set Kind/Priority on the board, add blocked-by links, and batch once per round.
argument-hint: "[findings.json or description]"
---

# Triage

Input: `$ARGUMENTS`: usually findings from this round's returns, or `/orient`'s
untracked gaps. `blocking` findings on the work in hand are **not** issues: they go into
the next round of that work. Skip `minor` findings unless one is cheap and clearly worth
tracking.

Filing is outward-facing and the user reads the tracker, so do the whole batch in one
pass and report what you did. **The tracker's failure mode is volume, not missed
findings.** Before filing a P3 Engineering issue, ask whether anyone will ever pick it
up. If not, a sentence in the PR description is enough.

## For each finding or gap

1. **Search before filing**, in both states, by symptom and by file:
   ```bash
   gh issue list --state all --limit 20 --search "<2-4 distinctive words> in:title,body"
   gh issue list --state all --limit 20 --search "<file path or function>"
   ```
   A closed issue with the same symptom is a regression: comment and reopen it rather
   than filing a new one.
2. **Cluster check.** If three or more open issues share a root cause, don't file a
   fourth symptom. Propose an Epic that names the design flaw, and link the members as
   sub-issues.
3. **File it** only when 1–2 found nothing. Write it **for the user**, who doesn't read code:
   - **Title:** what goes wrong or what becomes possible, in plain words.
   - **Body:** the sections `## What you'll be able to see or do` (or, for a bug,
     `## What goes wrong`), `## How to try it`, `## Done when` (with requirement IDs),
     and a collapsed `<details><summary>Technical notes</summary>` with the evidence
     (command and output, file:line), how it was found (issue, round, agent), and a
     suggested fix if it's obvious.
4. **Put it on the board:**
   ```bash
   node --no-warnings .claude/scripts/board.ts <n> --kind <Kind> --priority <P> --status Todo
   ```
   - **Kind:** `Feature` or `Bug` only when someone *using the app* would notice;
     otherwise `Engineering` (tests, tooling, refactors, docs). `Epic` for an umbrella.
   - **Priority:** P3 by default. P2 needs a concrete reason (a user would hit it, it
     costs money, it blocks planned work). **P0 and P1 are the user's call**: `board.ts`
     refuses them without `--user-approved`. Propose them in the report and set the
     status to `Needs you`.
   - A decision only the user can make (a product choice, a priority, spending) goes to
     `Needs you` with the question written at the top of the issue.
5. **Dependencies.** If it can't start until another issue lands, link it:
   ```bash
   id=$(gh api repos/daveharmswebdev/chess-tutor/issues/<blocker> --jq .id)
   gh api -X POST repos/daveharmswebdev/chess-tutor/issues/<n>/dependencies/blocked_by -F issue_id=$id --silent
   ```
   Add it as a sub-issue of the Epic it belongs to (`.../issues/<epic>/sub_issues -F sub_issue_id=<id>`).

## Report

| Finding / gap | Result | Board |
|---|---|---|
| … | #n new / #n existing (commented) / cluster #epic / not filed: <reason> | Kind, Priority, blocked by |
