---
name: cycle
description: One full coordinator cycle with the user's standing answers already given — orient, file untracked gaps through /triage without asking, then work the READY issues in parallel (one spoke worktree each) through /delegate and /ship. Can repeat for N rounds or until the work runs out. Use when the user says "cycle", "the usual", or "keep going".
argument-hint: "[max-parallel, default 2] [rounds: a number or 'all', default 1]"
---

# Cycle

The user's standing answers: "yes, triage the gaps" and "work the ready items in
parallel, in separate worktrees". Don't ask those again; report what you did.

Arguments: `$ARGUMENTS`. First: the most issues to work at once (default 2). Second:
how many rounds (a number, or `all` until a stop condition in step 6 fires; default 1).

**Prerequisite:** the delegation hooks must be active (`.claude/settings.json` has a
`hooks` block). If they aren't, stop and tell the user. Parallel spokes without the
contract gates are exactly the case the gates exist for.

## 0. The ledger

A cycle can outlive its context. The ledger keeps what GitHub doesn't: the running tally,
gaps judged not worth filing (and why), and the spokes in flight. It lives at
`"$(git rev-parse --git-dir)/cycle-ledger.md"` (untracked, survives compaction).

- **Read it first** whenever it exists, at the start and straight after any compaction.
  A gap under **Not filed** stays unfiled unless there's new evidence.
- A new `/cycle` appends `# Cycle <date> — args <max-parallel> <rounds>`.
- **Keep In flight current**, one line per pick: issue, agent, agent ID, worktree,
  branch, round, next step. Delete the line once the pick ships or is parked.
- Append each round's report (step 5) when the round ends.

## 1. Orient

Run `/orient`. Its report is this round's state; don't re-derive it.

## 2. Triage the untracked gaps, without asking

Pass every **Untracked gap** to `/triage` in one batch. Its rules still apply:
authorized to file is not the same as must file. P0/P1 and product decisions go to
`Needs you`.

## 3. Pick the batch

From **Ready now**, take up to max-parallel issues in this order: `from-you`, then P0–P1,
then P2, then P3. Skip an issue when:

- its files would collide with an in-flight branch or another pick in this batch.
  Two picks may share an owner only if their files don't overlap.
- it needs a decision only the user makes (it should be in `Needs you`).
- it needs a dependency added or a shared contract changed first. Then do that inline
  (it's coordinator territory), commit it to `main`, and pick the issue next round.
  **Exception:** if the contract change would break a branch already in flight (a new
  required field, a changed signature), don't put it on `main` yet, and don't keep it as
  a patch in the session scratchpad, which is lost when the session ends. Commit it on a
  pushed branch `contract-<issue>` and record that branch in the ledger. The pick's spokes
  later branch from it (`base_sha` = its head), and it merges together with them.

An Epic isn't a pick. Nothing ready is a valid answer: say why each candidate was skipped.

## 4. Work the batch in parallel

1. Claim every pick first: `gh issue edit <n> --add-label in-progress`, board → In Progress,
   and a claim comment (`/delegate` step 2b).
2. Prepare each brief (`/delegate` steps 3–5). Each brief's `concurrency` names the other
   picks and their files. Launch all the implementation spokes in **one message**, each
   with `isolation: "worktree"`.
3. As each returns, carry it on its own: the hook verdict, then the coordinator's
   verification (`/delegate` step 6), the reviewer, then the next round or `/ship`. One
   pick failing doesn't hold the others: park it with a comment on its issue, set it to
   `Todo` or `Needs you`, and keep going. **At most 3 rounds per pick**, then park it.
4. Ship one at a time. After each merge, rebase the next pick's branch onto `main`
   before its PR, so the batch never races itself.

Inline work (a typo, a one-line fix, docs, config) skips delegation.

## 5. Report (under 25 lines), also appended to the ledger

```
## Cycle — <date>, round <k> of <rounds|all>
**Filed:** #n (Kind, Priority) … | none   **Not filed:** <gap — reason>
**Shipped:** #n → PR #p (tests: N passed, CI green)
**Parked:** #n — <why, and what's needed>
**Skipped:** #n — <reason>
**Needs you:** <decisions, P0/P1 proposals> | none
**Now ready:** <issues unblocked by this round's merges>
```

## 6. Next round, or stop

Once every pick from this round has shipped or been parked, start the next round at
step 1 (orient again). Stop when any of these is true, and say which one fired:

- the requested number of rounds is done;
- nothing is ready and triage filed nothing (the work has run out, or is blocked on you);
- two rounds in a row shipped nothing (stuck, not finished);
- something needs the user before anything else can go ahead safely (red `main`, a
  decision in `Needs you` that blocks the rest).

At the end, add a one-line total across all rounds, summed from the ledger rather than
from memory. The end of a round is the safe point for the user to `/compact`.
