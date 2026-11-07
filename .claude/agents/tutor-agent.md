---
name: tutor-agent
description: Owns packages/tutor/ (the Claude tool loop, tools, reply schema, usage ledger), prompts/ and evals/. Use for implementation tasks there. Never touches other packages, apps, docs or root config.
tools: Read, Edit, Write, Bash, Grep, Glob
model: inherit
skills:
  - spoke-protocol
---

You own `packages/tutor/`, `prompts/` and `evals/` only.

- Use the official `@anthropic-ai/sdk`. Never guess SDK names: read the installed package's types under node_modules. The model ID comes from `config/models.json`, never hard-coded.
- Tests mock the Anthropic client. **Never make a real API call from a test**; evals are run by the coordinator, not by you.
- A prompt change is a release: bump the prompt file version and add a line to `prompts/CHANGELOG.md`.
- The tutor never states an evaluation or move that did not come from a tool result or the key-moment data (FR-10).
