# Chess Tutor: Requirements

| | |
|---|---|
| Status | Accepted v0.2 (amendments A1 and A2 applied 2026-11-07) |
| Date | 2026-11-04 |
| Owner | Dave Harms |

Requirements flow in one direction: **business** (why the system exists) → **functional** (what it does) → **non-functional** (the qualities and limits that behavior must meet) → **infrastructure** (what the platform has to provide, given the proposed architecture). Every requirement has an ID. The traceability matrix in §9 links each one back to its source.

---

## 1. Purpose and scope

A web app for one intermediate player (about 1000 on Chess.com) who plays the **London System** as White and the **King's Indian Defense** as Black. The player gets lost when opponents leave the expected opening lines. The tutor coaches them during practice games against a sparring bot that plays like real club players. The explanations come from an LLM (Claude), and every concrete chess claim comes from a chess engine (Stockfish) that the LLM calls as a tool.

The project has three goals: get better at chess, build a portfolio-quality piece of software, and practice the skills on the CCDV-F exam.

## 2. Business requirements

| ID | Requirement |
|---|---|
| BR-1 | The player must be able to handle positions where the opponent has left the London or KID lines they expected, instead of losing their way after move 5. |
| BR-2 | The player must improve their own thinking, not lean on the tool. Coaching builds understanding rather than handing out moves. |
| BR-3 | The project must use Claude's tool use against a real chess engine (no custom-trained model) to serve as CCDV-F exam practice and as a portfolio piece. |
| BR-4 | Running costs must stay a small fraction of the owner's monthly AI budget. |
| BR-5 | The tool must never be usable for help in live rated games on other sites (Chess.com fair play). |

## 3. Functional requirements

### 3.1 Sparring games

| ID | Requirement | Source |
|---|---|---|
| FR-1 | The player can start a game against the sparring bot as White or Black. | BR-1 |
| FR-2 | During the opening, the bot picks its moves from real human games at a configurable rating band, sampled in proportion to how often each move is played (Lichess opening explorer). That way the bot leaves the book the way real opponents do, not the way an engine would. | BR-1 |
| FR-3 | Once the position is out of the explorer data (too few games below a threshold), the bot switches to Stockfish at a reduced strength set for the player's level. | BR-1 |
| FR-4 | The board enforces legal moves, shows the move list, and supports takebacks during sparring games. | BR-2 |
| FR-5 | Finished and abandoned games are saved as PGN with the tutor's comments, so the player can look at them later. | BR-1 |

### 3.2 Coaching during the game

| ID | Requirement | Source |
|---|---|---|
| FR-6 | The app detects **key moments** with deterministic code, without calling the LLM. Key moments are: (a) the opponent leaves the player's repertoire line; (b) the player's move loses at least a configurable number of centipawns (default 150) compared with the engine's best move; (c) the player misses a winning opportunity (the best move gains at least the threshold and the player's move doesn't); (d) the opponent blunders and the player can punish it. | BR-1, BR-4 |
| FR-7 | The tutor stays silent at every other moment. The tutor model is never called on a move that isn't a key moment. | BR-2, BR-4 |
| FR-8 | At a key moment the tutor asks a **Socratic** question first (for example, "Their knight on e4 looks strong. What could challenge it?"). It gives the full answer only if the player asks or plays a wrong attempt. | BR-2 |
| FR-9 | When the opponent leaves the book (FR-6a), the tutor names the deviation and explains the plan that usually works against it in terms of pawn structure and piece placement, not just a move. | BR-1 |
| FR-10 | Every move, evaluation, or line the tutor states must come from a Stockfish tool call made in that same turn, **or from the key-moment data the server built from engine output**. The tutor never states an engine evaluation that came from neither source. *Amended by A2, 2026-11-07.* | BR-3 |
| FR-11 | The tutor's suggestions can be shown on the board as arrows or highlighted squares. | BR-1 |
| FR-12 | The player can press "Hint" at any time for one Socratic hint, even when it isn't a key moment. | BR-2 |

### 3.3 Ask-anything chat

| ID | Requirement | Source |
|---|---|---|
| FR-13 | The player can ask free-form questions about the current position ("Why not Bxh7?", "What's the plan here?"). | BR-1 |
| FR-14 | The player can paste a FEN or PGN and talk it through with the tutor outside of a game. | BR-1 |
| FR-15 | FR-10 applies to chat answers too. | BR-3 |

### 3.4 Tutor tools (called by the model)

| ID | Requirement | Source |
|---|---|---|
| FR-16 | `analyze_position(fen, depth?, multi_pv?)` returns the evaluation and the top N lines. | BR-3 |
| FR-17 | `evaluate_move(fen, move)` returns the centipawn loss compared with the best move, and the engine's reply. | BR-3 |
| FR-18 | `opening_explorer(fen)` returns the moves human players chose, their frequencies, and their results at the configured rating band. | BR-1, BR-3 |
| FR-19 | `get_repertoire_context(fen)` reports whether the position is in the player's London or KID repertoire and names the line. | BR-1 |

## 4. Non-functional requirements

| ID | Requirement | Source |
|---|---|---|
| NFR-1 **Responsiveness** | A visible "tutor is thinking" signal appears within 200 ms of a key moment being detected. A tutor progress event (for example "Checking Nf3…") arrives within 1 s. The validated tutor reply arrives in ≤ 6 s at p50 and ≤ 12 s at p95. *These targets are provisional and get adjusted after the first measurements. Amended by A1, 2026-11-07.* | BR-1 |
| NFR-2 **Engine latency** | A single `analyze_position` call returns in ≤ 1 s at the default depth on the development machine (an M-series Mac). | BR-1 |
| NFR-3 **Bot latency** | The bot replies within 2 s, excluding any artificial "thinking" delay. | BR-1 |
| NFR-4 **Monthly cost** | Total Claude API spend stays under **$25/month** (target), with a **$30/month hard spend limit** set in the Console. | BR-4 |
| NFR-5 **Cost visibility** | Every API response's token usage (input, output, cache creation, cache read) is recorded and summed per game and per month. | BR-4 |
| NFR-6 **Factual accuracy** | 100% of the moves the tutor mentions are legal in the position it is talking about. 100% of the evaluations it quotes match a tool result from that turn. Checked by the eval suite (NFR-10). | BR-3 |
| NFR-7 **Pedagogy** | In ≥ 90% of graded eval cases, the tutor's first message at a key moment doesn't reveal the best move. | BR-2 |
| NFR-8 **Output contract** | Every tutor reply matches a versioned schema (for example `{ speak, kind, message, hint, reveal, arrows[] }`) and is validated when it arrives. A reply that fails validation follows a defined failure path (retry once, then show a generic "couldn't analyze this one" message) and never shows unvalidated output. | BR-3 |
| NFR-9 **Degradation** | If the Claude API is unavailable, rate-limited, or out of budget, sparring games keep working without coaching and the UI tells the player why. | BR-1, BR-4 |
| NFR-10 **Regression gate** | Prompts, tool schemas, and eval sets are stored in the repository and versioned. Every change to them goes through the eval suite before it is merged. | BR-3 |
| NFR-11 **Fair play** | The app does not read positions from other sites, offers no browser extension or overlay, and makes no attempt to import a game in progress. | BR-5 |
| NFR-12 **Secrets** | The API key is never committed. It comes only from a runtime environment variable or a credential helper. | BR-3 |
| NFR-13 **Portability** | Runs locally with a single command. All configuration (model ID, thresholds, rating band) comes from versioned config plus environment variables, so the app can be deployed later without code changes. | BR-3 |

## 5. Infrastructure requirements

These follow from the functional requirements plus the proposed architecture: a TypeScript monorepo with a React front end, a Node back end, Stockfish, and the Anthropic SDK.

| ID | Requirement | Source |
|---|---|---|
| IR-1 | Node.js LTS and pnpm. The exact versions are pinned in the repo. | NFR-13 |
| IR-2 | Stockfish runs as an npm (WebAssembly) dependency pinned in the lockfile. A native binary can be used instead through `STOCKFISH_PATH`. Both sit behind one `Engine` interface. | FR-16, FR-17, NFR-2 |
| IR-3 | One Stockfish process per active game, with analysis requests queued one at a time (UCI handles one search at a time per process). | FR-6, NFR-2 |
| IR-4 | A Claude API key with enough rate limit headroom (requests per minute, input and output tokens per minute) for a single user. Expected peak: about 3 requests in a burst per key moment. | FR-8, NFR-1 |
| IR-5 | Responses stream from the back end to the browser (SSE or WebSocket). | NFR-1 |
| IR-6 | Prompt caching on the stable prefix: tool definitions, then the system prompt, then the repertoire context. Changing content (game state, move history) goes last. | NFR-4 |
| IR-7 | Local persistent storage (a single SQLite file) for games, the usage ledger, and a cache of Lichess explorer responses. | FR-5, NFR-5, FR-18 |
| IR-8 | Outbound HTTPS access to the Lichess explorer API, authenticated with a personal token (`LICHESS_TOKEN`, a runtime secret), with responses cached and respecting Lichess's rate limits. | FR-2, FR-18, NFR-12 |
| IR-9 | The model ID is set per environment in versioned config and pinned to an exact model ID. | NFR-10, NFR-13 |

## 6. Constraints and assumptions

- **Model behavior.** On Opus 5.5 and Sonnet 5.5, forcing a tool call (`tool_choice` set to `any` or `tool`) returns a 400 error. The tutor uses `tool_choice: auto` plus prompt instructions and `strict: true` tool schemas. The structured reply in NFR-8 uses structured outputs.
- **Model lifecycle.** The pinned model will eventually be deprecated. The operations phase includes watching deprecation notices and migrating: run the eval on the new model first, change the pin through review, then deploy.
- **Untrusted content.** Lichess data and pasted PGN/FEN are third-party data. They reach the model only inside `tool_result` blocks or clearly tagged data blocks, never as instructions.
- **Session hygiene.** One game is one tutor session. Anything that must last beyond the game (repertoire, player profile) lives in app state and is added to the prompt on purpose.
- **Retries.** The Anthropic SDK retries transient failures twice by default. The app adds no retry loop of its own on top of that.
- **Constraint (confirmed 2026-11-07).** The Lichess explorer API rejects anonymous requests (HTTP 401). The app authenticates with a personal Lichess API token with no permissions, read from the `LICHESS_TOKEN` environment variable. Verified in spike 002.
- **Assumption.** A Chess.com rating of about 1000 corresponds to roughly the 1200–1400 band on Lichess. The band is configurable (Q-2).

## 7. Out of scope (v1)

- Multiple users, authentication, and hosted deployment (the architecture shouldn't rule them out).
- Importing and reviewing Chess.com games after they're played. This is a strong candidate for v2.
- Opening drills and spaced repetition.
- Voice, mobile-native apps, and running a Maia (human-like engine) model locally.

## 8. Open questions

| ID | Question |
|---|---|
| Q-1 | **Resolved 2026-11-07** ([spike 002](spikes/002-lichess-explorer-auth.md)): a personal token with no permissions works. Rate limits aren't published, so the client sends one request at a time and backs off on a 429. |
| Q-2 | **Resolved 2026-11-07:** Lichess bands 1200 and 1400, blitz and rapid (`config/tutor.json` `bot.explorerRatings`). Lichess ratings run roughly 300–400 above Chess.com, so this matches the player's ~1000 Chess.com opponents. |
| Q-3 | ~~Which tutor model, Opus 5.5 or Sonnet 5.5?~~ **Resolved 2026-11-08: Sonnet 5.5 at effort medium** (evals: `docs/evals/2026-11-08-q3-model-choice.md`). |
| Q-4 | **Resolved 2026-11-07** (#13, PR #18): London against …d5, …Nf6 and …c5; KID Classical, against the London, and against the Fianchetto; 8–9 moves deep. Stored as one PGN game per line in `repertoire/london.pgn` and `repertoire/kid.pgn`. |
| Q-5 | **Resolved 2026-11-07** (#5, PR #19): Stockfish at UCI_Elo 1400 once the position has fewer than 20 explorer games (`config/tutor.json` `bot.outOfBookElo`, `bot.minGames`). |

## 9. Traceability matrix

| Business | Functional | Non-functional | Infrastructure |
|---|---|---|---|
| BR-1 Handle deviations | FR-1–6, 9, 11, 13, 14, 18, 19 | NFR-1, 2, 3, 9 | IR-2, 3, 5, 7, 8 |
| BR-2 Build understanding | FR-4, 7, 8, 12 | NFR-7 | — |
| BR-3 Claude + engine, exam prep | FR-10, 15–19 | NFR-6, 8, 10, 12, 13 | IR-1, 2, 6, 9 |
| BR-4 Cost | FR-6, 7 | NFR-4, 5, 9 | IR-4, 6 |
| BR-5 Fair play | — | NFR-11 | — |
