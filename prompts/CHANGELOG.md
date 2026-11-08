# Prompt changelog

Prompts are release artifacts: a change is a new version file plus a line here, and evals run before merging.

- **tutor-system.v1.md** (2026-11-07, #7): first tutor system prompt. Socratic message / held-back reveal (FR-8), deviation plus plan for `opponent_left_book` (FR-9), name only moves and evaluations from tool results or key-moment data (FR-10), at most 3 arrows (FR-11), one Socratic hint for `hint` (FR-12), when to call each of the four tools (FR-16 to FR-19), audience a 1000-rated London / King's Indian player. Evals (#10) not yet available.
- **Model pin** (2026-11-08, #10): the tutor runs on Sonnet 5.5 at effort medium for development and eval (`config/models.json`). Evidence: `docs/evals/2026-11-08-q3-model-choice.md` (Q-3: Opus 5.5 medium and low vs Sonnet 5.5 medium on the 66-case eval suite). No prompt text change; `tutor-system.v1.md` stays at v1.
