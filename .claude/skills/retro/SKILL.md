---
name: retro
description: Review chess-tutor's own development workflow (the delegation hooks, skills, brief and return schemas, cycle process) from its recorded data — orchestration log, cycle ledger, PR delegation records — compare with the previous retro, and propose at most 3 evidence-backed changes for the user to approve. Use when the user says "retro", "review our workflow", or asks whether the agents, skills or hooks can be improved. Changes nothing in .claude/ without approval.
argument-hint: "[--since <iso>]"
---

# Retro

Arguments: `$ARGUMENTS`. The question is **what is the workflow costing us, and which change
would cut that most?** The answer comes from recorded data, not impressions. Apart from
appending to the ledger, this is read-only until the user approves.

## 1. The window

Read the cycle ledger (`"$(git rev-parse --git-dir)/cycle-ledger.md"`). The last `# Retro`
section records `Window end: <iso>` and the baseline numbers. This retro covers everything
after that (`--since` in the arguments overrides it). With no previous retro, use the whole log.

## 2. The numbers

```bash
node --no-warnings .claude/scripts/retro-stats.ts --since <window start>
```

It reports spoke dispatches, what shipped, verdicts and first-round acceptance, every
re-delegation with its reason, rejected returns by cause class (each class is something a
template or a rule would have to fix), denied edits and dispatches, and cost per agent from
`coordinator_verdict` entries. Don't recount by hand; if a number you need is missing, add it
to the script.

## 3. The evidence behind the numbers

- **Re-delegations:** for each one, what caused it? A reviewer finding (which class of bug?),
  a brief defect, a contract gap, or a spoke error? Look for a **class** that repeats: two or
  more rounds lost to the same kind of bug is a candidate for a rule.
- **Rejected returns:** by class. A "gate failed" rejection is the hook working. Count only
  the format classes as waste.
- **`brief_defects` and `contract_gaps`:** collect them from the PR delegation records
  (`gh pr view <n> --json body` for the PRs shipped in the window) and the ledger notes.
  These are the coordinator's own errors. Look for repeats.
- **Coordinator friction:** the ledger notes on inline fixes, failed commands and workarounds.
- **Did the last retro's changes work?** Compare against the baseline the previous retro
  recorded. Say plainly when a change made no difference, or when the window is too small to
  tell (fewer than about 5 rounds).

## 4. Proposals: at most 3, ranked

Each proposal has:
- **Evidence**: the numbers and the specific briefs or PRs.
- **The change**: the files (hook, skill, schema, script) and what changes in them.
- **Expected effect**: on which number, and roughly by how much.
- **Cost**: the size of the change and the risk of breaking something.

Rank by expected effect divided by cost. Small fixes (a few lines each) may be listed apart
from the 3. Also say what the data argues **against** doing: a change that looks attractive
but that the numbers don't support (the first retro dropped "skip review for small diffs",
because every re-delegation came from a review). "No change needed" is a valid answer.

## 5. Record, then ask

Append to the ledger:

```
# Retro <date>
- Window: <since> → <until> (Window end: <until>)
- Baseline: first-round <a/b>, re-delegations <n> (<classes>), returns <valid>/<rejected> (format <n>), avg tokens <per agent>
- Previous changes: <worked / no difference / too early>
- Proposed: R1 …, R2 …, R3 …; small fixes …
- Rejected: <what the data argues against>
```

Then report to the user in under 30 lines: the numbers, the proposals and what was rejected.
Ask which proposals to apply. Edits to `.claude/` happen only after the user approves. Apply
them as one commit, with hook tests for any hook change, and the full gate green. Then add an
`- Applied: …` line under the retro's ledger section.
