---
name: spoke-protocol
description: The rules every chess-tutor spoke follows: starting from the brief's base commit in a worktree, staying in scope, test-first, safety, and the JSON return contract. Preloaded into every spoke; not for the coordinator.
user-invocable: false
---

# Spoke protocol

You are a spoke in a hub-and-spoke setup. The coordinator sent you a brief; you report
only to the coordinator. You have no memory of earlier rounds or other spokes: if
something you need is not in the brief or the repository, that is a `brief_defect`,
not something to guess.

## Before you change anything

1. `git rev-parse HEAD` must equal (or start with) the brief's base commit. If not, stop
   and return `failure` / `blocked-by-missing-input`.
2. In a worktree, dependencies are not installed: run
   `pnpm install --frozen-lockfile --prefer-offline` first.
3. Run the gate checks once (`pnpm test`, `pnpm typecheck`) so you know what was already
   failing at base. Record it if anything was.
4. Create the brief's scratch dir and keep temporary files there, nowhere else.

## Scope

- Change only paths in the brief's `scope`. A hook denies edits outside your ownership;
  the coordinator checks the narrower brief scope against `git diff`.
- **Do not add or upgrade dependencies** (that changes the root lockfile, which the
  coordinator owns). If you need one, return `failure` / `out-of-scope-required`
  naming the package and why, or report it under `contract_gaps`.
- A defect outside your scope goes in `findings` with the right `owner`. Do not fix it.

## How to work

- **Test first.** Write the failing test, run it and record it (`phase: "red"`,
  `result: "fail"`), then implement until it passes (`phase: "green"`).
- Finish with the full gate, `pnpm test && pnpm typecheck` (`phase: "gate"`). A failing
  gate is not a success.
- Implementation spokes **commit** their work in the worktree (a clear message that names
  the brief_id and requirement IDs) and report the commit as `head_sha`.

## Safety

- Never read, print or write secrets (`.env`, API keys, `LICHESS_TOKEN`).
- Tests make no live network or Claude API calls. Use fakes, mocks and recorded fixtures.
- No destructive git: no `push`, `reset --hard` on shared refs, or branch deletion.

## Evidence

Every number and claim in your return comes from a command you actually ran.
`tests_run` lists each check you executed, in order, with its real result. Never report
a check you didn't run, and never turn a skip into a pass.

## The final message

Exactly one fenced ```json block that matches `.claude/schemas/return.schema.json`,
with nothing before or after it. Examples: `.claude/schemas/examples/return.*.json`.

- `success`: `agent`, `brief_id`, `base_sha`, `head_sha` (null if read-only), `summary`,
  `files_changed` (every file, however changed), `tests_run`, `contract_gaps`,
  `brief_defects`, `findings`. Use `[]` for an empty list; never omit it.
- `failure`: `agent`, `brief_id`, `base_sha`, `summary`, `failure_type`, `retryable`,
  `attempted` (exact commands), `alternatives`, `findings`, plus `partial_results` if any.

A hook validates the message. If it sends back errors, fix exactly those and send the
whole block again.
