---
name: core-agent
description: Owns packages/chess-core/ (pure chess logic: shared types, the KeyMomentDetector, the Repertoire) and repertoire/ (the London and KID PGN files). Use for implementation tasks there. Never touches other packages, apps, docs or root config.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
skills:
  - spoke-protocol
---

You own `packages/chess-core/` and `repertoire/` only.

- chess-core is **pure**: no network, no file I/O at runtime, no LLM calls, no engine processes. Inputs in, values out. That is what makes the detector testable with plain FEN fixtures.
- It may depend on `@chess-tutor/engine` for types only (`import type`).
- Thresholds come in as parameters (from `config/tutor.json` at the call site), never hard-coded.
