# Chess Tutor: Architecture

| | |
|---|---|
| Status | Draft v0.1 |
| Date | 2026-11-07 |
| Implements | [requirements.md](requirements.md) v0.2 |

## 1. Overview

```
┌──────────────────────────── Browser (apps/web) ───────────────────────────┐
│  Board (react-chessboard + chess.js)   Tutor panel   Chat input   Hint btn │
└──────────────┬──────────────────────────────▲──────────────────────────────┘
               │ REST: moves, hint, chat       │ SSE: bot moves, tutor progress,
               ▼                               │      validated tutor replies
┌──────────────────────────── Node server (apps/server) ────────────────────┐
│                                                                           │
│   GameService ──► KeyMomentDetector ──(key moment?)──► TutorAgent         │
│       │   ▲              ▲                                 │  ▲           │
│       │   │              │ analysis                        │  │ tool calls│
│       ▼   │              │                                 ▼  │           │
│   SparringBot      AnalysisEngine ◄──── tools ────── ToolRegistry         │
│    │      │        (Stockfish #1)                     │     │             │
│    │      └──► BotEngine (Stockfish #2, limited)      │     ▼             │
│    └──────────► ExplorerClient ◄──────────────────────┘  Repertoire       │
│                    │  (cached)                                            │
│   UsageLedger ◄── TutorAgent        BudgetGuard ──► TutorAgent            │
│        └───────────── SQLite (games, usage, explorer cache) ──────────────│
└───────────────────────────┬───────────────────────────────┬───────────────┘
                            ▼                               ▼
                  Claude API (Anthropic)          Lichess opening explorer
```

**Main rule:** deterministic code decides *when* the tutor speaks and *what is true* about the position. Claude decides *how to explain it*.

## 2. Repository layout

A pnpm workspace monorepo.

```
chess-tutor/
├── apps/
│   ├── web/                 React + Vite, react-chessboard, chess.js
│   └── server/              Fastify, SSE, wires the packages together
├── packages/
│   ├── engine/              UciClient, Engine interface, WasmEngine, NativeEngine
│   ├── chess-core/          shared types, KeyMomentDetector, Repertoire (pure, no I/O)
│   ├── explorer/            Lichess explorer client + cache
│   └── tutor/               TutorAgent, tools, schemas (zod), prompt loader, ledger
├── prompts/                 tutor-system.v1.md, chat-system.v1.md (+ CHANGELOG.md)
├── repertoire/              london.pgn, kid.pgn                     (Q-4)
├── config/                  models.json (model ID pinned per env), tutor.json (thresholds)
├── evals/                   cases/*.json, graders/, run.ts
├── docs/                    requirements.md, architecture.md, adr/
├── CLAUDE.md                tracked
├── .claude/settings.json    tracked
└── .gitignore               .env, .claude/settings.local.json, CLAUDE.local.md, *.sqlite
```

`chess-core` has no I/O, so the key-moment logic, the most important deterministic part, can be unit-tested with plain FEN fixtures.

## 3. Components

### 3.1 Engine (`packages/engine`), covering IR-2 and IR-3

```ts
interface Engine {
  analyze(fen: string, opts: { depth?: number; multiPv?: number; movetimeMs?: number }): Promise<Analysis>;
  bestMove(fen: string, opts: { elo?: number; movetimeMs?: number }): Promise<string>;
  quit(): Promise<void>;
}
interface Analysis { depth: number; lines: { moves: string[]; scoreCp?: number; mate?: number }[] }
```

- `UciClient` handles the protocol: it parses `info` and `bestmove` lines and talks over a line-based stream. It doesn't care whether the process behind it is WASM or native.
- `WasmEngine` uses the npm `stockfish` package (version pinned). `NativeEngine` is used when `STOCKFISH_PATH` is set.
- **One UCI search at a time per process.** Each engine instance owns a FIFO queue, so callers just `await` and never see the protocol's one-search limit.
- **Two instances per game:** `AnalysisEngine` runs at full strength for the detector and the tutor tools, and `BotEngine` runs at limited strength (`UCI_LimitStrength`/`UCI_Elo`) for the bot's moves. This keeps the strength options from switching back and forth on one process.
- `FakeEngine` returns canned analysis for unit tests.
- **Spike first:** confirm that the npm package runs in Node with its neural-network evaluation (NNUE) enabled, and measure NFR-2.

### 3.2 Explorer (`packages/explorer`), covering FR-2, FR-18 and IR-8

- `ExplorerClient.lookup(fen, { ratings, speeds })` returns `{ moves: { san, games, white, draws, black }[], totalGames }`.
- Responses are cached in SQLite by `(fen, ratings, speeds)` for 30 days, since opening statistics barely change. The client sends one request at a time and treats an unreachable explorer as "out of book."
- **Authentication:** anonymous requests return a 401, so the client sends `Authorization: Bearer ${LICHESS_TOKEN}`.
- **Error mapping:** a 401 throws a configuration error with a clear message. A 429 honors `Retry-After` and that lookup is treated as out of book. A 5xx or a network error is also treated as out of book, so the game continues.
- **Contract:** Lichess's JSON is parsed with a zod schema into our own `ExplorerResult` type. A change on their side breaks only this package.
- Verified in [spike 002](spikes/002-lichess-explorer-auth.md): a personal token with no permissions works. The response shape is recorded there (moves carry `averageRating`).

### 3.3 Sparring bot, covering FR-2 and FR-3

```
if explorer.totalGames >= minGames (config):  sample a move weighted by games played
else:                                          BotEngine.bestMove(fen, { elo: botElo })
```

Weighted sampling is the important part. A real 1000-rated player answers 1.d4 with whatever is popular at their level, which is what produces the deviations you want to practice against.

### 3.4 KeyMomentDetector (`packages/chess-core`), covering FR-6 and FR-7

The detector is a pure function. It takes the analysis before and after a move, plus the repertoire context.

```ts
type KeyMoment =
  | { kind: "opponent_left_book"; line: string; expected: string[]; played: string }
  | { kind: "player_blunder"; played: string; cpLoss: number; best: string }
  | { kind: "missed_win"; played: string; best: string; gainCp: number }
  | { kind: "punish_opponent"; opponentMove: string; refutation: string; gainCp: number };

detect(input: DetectorInput): KeyMoment | null
```

- `AnalysisEngine` analyzes every position as it comes up (multi-PV 3, default depth from config). The detector compares consecutive analyses, with no LLM involved.
- The thresholds (150 cp, and so on) live in `config/tutor.json`.

### 3.5 TutorAgent (`packages/tutor`), covering FR-8 to FR-19

**One game is one conversation.** The message history only ever grows (no edits or deletions). That's good for prompt caching, it's what preserved thinking requires on Opus 5.5 and Sonnet 5.5, and it lets the tutor remember the hints it already gave in this game.

**Request layout (cache order, IR-6):**

| Position | Content | Changes |
|---|---|---|
| `tools` | 4 tool definitions, in a fixed order, `strict: true` | never |
| `system` | `prompts/tutor-system.vN.md` | per release |
| `system` (2nd block) + `cache_control` | player profile + the repertoire line for this game | per game |
| `messages` | earlier key moments in this game, then a new user turn holding the key-moment data in `<key_moment>` tags | every call |

**Loop.** I'll write the tool loop by hand rather than use the SDK's Tool Runner, because its mechanics are exam material:

```
send → stop_reason?
  tool_use   → run every tool_use block (in parallel) → one user turn with all tool_results → send
  end_turn   → validate the reply against TutorReply (zod) → emit
  max_tokens / refusal / pause_turn / model_context_window_exceeded → defined failure path
cap: 4 tool rounds per key moment (keeps cost bounded)
```

- `tool_choice: auto`, because `any` and `tool` return a 400 error on the 5.5 models. The system prompt says when to call which tool.
- `thinking: adaptive`, with effort set per route in config (start at `medium`). It can't be disabled on Opus 5.5.
- The tutor's final reply uses structured output (`output_config.format`) with the `TutorReply` schema, and is also validated with zod when it arrives (NFR-8). *Spike: confirm that structured output and tools work together in the same request.*

**The reply contract (NFR-8):**

```ts
const TutorReply = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["opponent_left_book", "player_blunder", "missed_win", "punish_opponent", "hint", "chat"]),
  message: z.string(),            // the Socratic question or explanation shown now
  reveal: z.string().nullable(),  // the full answer; held server-side
  revealMove: z.string().nullable(), // UCI move, checked for legality before being shown
  arrows: z.array(z.object({ from: z.string(), to: z.string() })).max(3),
});
```

**Socratic hint and reveal without a second LLM call.** The server sends only `message` and `arrows` to the browser. It keeps `reveal` and `revealMove` on the server. When the player:
- asks "show me", the server sends the stored `reveal`, with no API call.
- takes back and tries a different move, the *engine* grades the attempt. If it's within the threshold of `revealMove`, it's correct; if not, the stored reveal is shown. Again, no API call.

That makes FR-8 cheap and instant.

**Tools (FR-16 to FR-19)** wrap `AnalysisEngine`, `ExplorerClient`, and `Repertoire`. Tool results are compact JSON, with moves given in both SAN and UCI notation. Explorer data is third-party content, so it reaches the model only inside `tool_result`.

### 3.6 Streaming and the UI, covering NFR-1 and IR-5

The server calls `messages.stream(...)` and forwards **progress events** to the browser over SSE: "Tutor is looking at the position…" and "Checking Nf3…" (taken from the `tool_use` names and inputs). The validated `TutorReply` arrives as the final event.

The reply is a schema-checked JSON object, so streaming raw tokens to the UI would mean showing text that hasn't been validated yet. NFR-1 is therefore measured as time to the first progress event, plus the total time to the reply. **Proposed amendment A1 (below).**

### 3.7 Chat, covering FR-13 and FR-14

- **In a game:** the question is added as a user turn to that game's conversation (`<player_question>` tags), using the same tools and reply contract with `kind: "chat"`.
- **Pasted FEN or PGN:** starts a fresh conversation. The pasted text is validated with chess.js first and sent inside `<pasted_position>` tags as data.

### 3.8 Cost control, covering NFR-4, NFR-5 and NFR-9

- `UsageLedger` records `usage` from every response (input, output, cache creation, cache read), along with the model ID and the game ID, and prices it from `config/models.json`.
- `BudgetGuard` checks the month-to-date total before every tutor call. Once it reaches $25, coaching pauses and games carry on (NFR-9). The Console's $30 limit is the backstop; if the API rejects a call over that limit, the app takes the same path.
- Errors are caught as typed SDK errors. A 429 pauses coaching for that moment. A 529 or 5xx shows "tutor unavailable." The SDK's default `maxRetries: 2` is the only retry layer.

### 3.9 Persistence, covering IR-7

SQLite through `better-sqlite3` and Drizzle, with tables `games` (PGN, metadata, tutor comments), `tutor_turns` (the stored conversation for each game), `usage`, and `explorer_cache`. The schema is designed to move to Postgres if the app is ever hosted.

## 4. Life of a move

1. The player drags d4 to d5. The browser checks it with chess.js and POSTs it.
2. GameService applies the move. `AnalysisEngine` analyzes the new position. The detector compares it with the previous analysis.
3. **No key moment:** SparringBot replies (explorer sample or BotEngine) and the server sends `bot_move`. **No Claude call.**
4. **Key moment:** the server sends `tutor_thinking`, and BudgetGuard checks the budget. TutorAgent appends the `<key_moment>` turn and runs the loop, sending `tutor_progress` for each tool call. The reply is validated and the server sends `tutor_reply` (with the reveal held back). Usage is recorded. Then the bot replies.

## 5. Evals and the regression gate, covering NFR-6, NFR-7 and NFR-10

- `evals/cases/*.json` hold a FEN, the move history, the key moment, and expectations.
- **Deterministic graders** (most of the weight):
  - every SAN or UCI move mentioned in `message` or `reveal` is legal (checked with chess.js);
  - every number quoted matches a tool result or the key-moment data;
  - `message` doesn't contain `revealMove` (NFR-7);
  - the reply parses against the schema.
- **LLM-judge grader** (optional): a rubric on clarity and how well the explanation fits a 1000-rated player.
- The runner uses the **Message Batches API**, at half price. Evals have no deadline, so a batch is the right tool.
- CI runs the eval suite only on PRs that touch `prompts/`, `packages/tutor/`, or `config/models.json`, to keep cost down.
- Q-3 (Opus vs Sonnet) gets answered by running the same suite with both model IDs.

## 6. Configuration and secrets, covering NFR-12, NFR-13 and IR-9

| Item | Where | Tracked? |
|---|---|---|
| Model ID for each environment | `config/models.json` | yes, pinned, changed through review |
| Thresholds, rating band, bot Elo, effort per route | `config/tutor.json` | yes |
| System prompts | `prompts/*.vN.md` + `CHANGELOG.md` | yes |
| `ANTHROPIC_API_KEY`, `LICHESS_TOKEN`, `STOCKFISH_PATH` | `.env` / shell environment | **no** |
| Team Claude Code settings | `.claude/settings.json`, `CLAUDE.md` | yes |
| Personal Claude Code settings | `.claude/settings.local.json`, `CLAUDE.local.md` | **no** |

## 7. Testing

- **Vitest** everywhere.
- `chess-core`: table-driven detector tests on FEN fixtures.
- `engine`: `UciClient` parser tests on recorded UCI output, plus one integration test that starts real WASM Stockfish.
- `tutor`: tests of the loop's logic against a mocked Anthropic client (tool_use → tool_result pairing, the round cap, and each `stop_reason` path).
- Evals cover model behavior, while unit tests cover our own code.

## 8. Requirement amendments (approved 2026-11-07, applied in requirements v0.2)

| ID | Change | Why |
|---|---|---|
| **A1** | NFR-1 becomes: "a tutor progress event within 1 s of the key moment, and the validated reply in ≤ 6 s p50 / ≤ 12 s p95." | Replies are schema-checked JSON (NFR-8), so we show progress events instead of raw tokens. The numbers are still provisional until measured. |
| **A2** | FR-10 becomes: "…must come from a tool call in that turn **or from the key-moment data the server produced from engine output**." | The detector has already run Stockfish. Making the model call it again for the same facts adds a round trip of latency and cost while producing the same numbers. |

## 9. Spikes before building

1. ~~Does WASM Stockfish run in Node with NNUE, and what latency does it give?~~ **Done**: [spike 001](spikes/001-wasm-stockfish-latency.md), NFR-2 met with a 1000 ms cap.
2. ~~Is a personal Lichess token accepted, and what are the rate limits?~~ **Done**: [spike 002](spikes/002-lichess-explorer-auth.md).
3. Do structured output and tool use work together in one request on the chosen model?
4. How do we parse SAN from the tutor's prose reliably enough for the legality grader?

## 10. Decisions to record as ADRs

ADR-001 TypeScript monorepo · ADR-002 WASM Stockfish behind an Engine interface · ADR-003 code decides when the tutor speaks · ADR-004 one conversation per game, append-only · ADR-005 a hand-written tool loop · ADR-006 the reveal is held server-side · ADR-007 evals run through the Batch API.
