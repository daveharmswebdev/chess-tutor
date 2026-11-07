# Spike 003: structured output and tools in one request

**Question (architecture §3.5):** on `claude-opus-5-5`, can one Messages request carry both
strict tools (`strict: true`, `tool_choice: auto`) and a JSON output format
(`output_config.format`), so tool turns happen normally and only the final text is held to
the `TutorReply` schema? Do adaptive thinking, effort and streaming still work?

**Answer: yes, according to the documentation. Not yet measured live.** (2026-11-07)

## Evidence

- Structured outputs docs (platform.claude.com/docs/en/build-with-claude/structured-outputs):
  "JSON outputs and strict tool use solve different problems and work together … When combined,
  Claude can call tools with guaranteed-valid parameters AND return structured JSON responses.
  This is useful for agentic workflows where you need both reliable tool calls and structured
  final outputs." The combined example reads either a `tool_use` block or a JSON `text` block
  from the same response.
- The Anthropic SDK reference says structured outputs work with streaming, token counting and
  extended thinking. They don't work with citations or prefill, and we use neither.
- Opus 5.5 rejects forced `tool_choice` (`any` / `tool`), so `auto` is required anyway
  (architecture §3.5 already says so). It also rejects disabling thinking, so the request sets
  `output_config.effort` (`medium` from config/tutor.json).

## Constraints the tutor must respect

| Constraint | Effect on `TutorReply` and the tools |
|---|---|
| Every object needs `additionalProperties: false` and `required` | Build the JSON Schema by hand or with `z.toJSONSchema` and check it. All fields required, nullable fields as `anyOf [T, null]` |
| No `minLength`/`maxLength`, `minimum`/`maximum`, complex array constraints | `arrows.max(3)` is checked by zod after the reply arrives, not by the API |
| A request may have at most 20 strict tools, 24 optional parameters and 16 union-typed parameters across all its schemas | 4 tools plus the reply schema are well within these limits. The optional `depth` / `multi_pv` parameters count towards the 24 |
| A grammar compiles the first time a schema is seen (one-off latency, then cached for 24 h); changing the tool set invalidates the cache | Keep the tools and their order fixed, which is already required for prompt caching (IR-6) |
| Enum values may come back in different case | Validate `kind` with zod and normalise the case before comparing |
| `stop_reason` `refusal` or `max_tokens` can produce output that doesn't match the schema | Already part of the NFR-8 failure path: validate, retry once, then show a generic message |

## Still to measure

The first run with a real key (an eval run under #10, or a manual run) should confirm three
things: a `tool_use` turn followed by a schema-valid `end_turn`, `usage.cache_read_input_tokens`
above zero on the second key moment of a game, and time to the first progress event.
