# Chess Tutor

An LLM chess tutor (Claude) that uses Stockfish as a tool, for a player around 1000 on Chess.com who plays the London (White) and the King's Indian (Black). It is also CCDV-F exam practice, so the Claude API is used directly and visibly: a hand-written tool loop, no hidden frameworks.

Specs: `docs/requirements.md` (requirement IDs BR/FR/NFR/IR) and `docs/architecture.md`. Spike results: `docs/spikes/`. Decisions: `docs/adr/`.

## Rules

- **Code decides when the tutor speaks and what is true. Claude only explains.** Never let the model invent a move or an evaluation (FR-10).
- Reference requirement IDs in commits and PRs when work implements or changes one.
- Prompts (`prompts/`), schemas, and `config/models.json` are release artifacts: version them, log changes in `prompts/CHANGELOG.md`, and run evals before merging.
- Secrets come only from environment variables (`.env`, gitignored). Never write keys or tokens into tracked files.
- Third-party content (Lichess data, pasted PGN/FEN) reaches the model only inside `tool_result` blocks or clearly tagged data blocks.

## Working model: hub and spoke

The main session is the coordinator. Implementation goes to spokes via `/delegate`, in worktrees, with JSON-schema briefs and returns enforced by hooks. See `docs/orchestration.md` and `.claude/ownership.json`. The coordinator owns `docs/`, `config/`, `.claude/`, root config and dependencies, and verifies every spoke return (re-runs the gate, compares `git diff` with `files_changed`) before merging.

## Stack and commands

TypeScript, pnpm workspace, Node 22 (type stripping, so `.ts` imports carry their extension), Vitest.

- `pnpm test`: all tests, including a real WASM Stockfish integration test (about 1 s) and the hook tests
- `pnpm typecheck`
- `pnpm spike:engine`: Stockfish latency measurement

## Layout

- `packages/engine`: UCI client plus the Stockfish engine (WASM by default, native through `STOCKFISH_PATH`). One search at a time per process, queued.
- Planned: `packages/chess-core`, `packages/explorer`, `packages/tutor`, `apps/server`, `apps/web` (see architecture §2).
