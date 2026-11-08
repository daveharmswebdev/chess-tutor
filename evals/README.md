# Tutor evals (#10)

These evals check how well the tutor coaches (NFR-6, NFR-7, NFR-10). Each case is a frozen position from a London or King's Indian game. The runner asks the **real** tutor session about every case: the same tool loop, tools, system prompt and claims check the server uses, with real Stockfish and live Claude API calls. Deterministic graders then score each reply. Every run has a spending cap.

The tests in `evals/test/` never call the API. They use a fake client.

## 1. Cases

`cases/sequences.json` lists move sequences in SAN. Each has an `id`, the intended `kind`, the player's colour and a note. Each one is a typical 1000-level mistake or situation:

| kind | the last move is | example |
| --- | --- | --- |
| `player_blunder` | the player's own move, which loses at least 1.5 pawns | London 4.Qh5?? into the f6 knight |
| `missed_win` | the player's quiet move when a win of at least 1.5 pawns was there | London 4.Nf3, missing Bxd6 against ...Qd6 |
| `punish_opponent` | the opponent's move, which can be punished | 3...Qd6?? into the f4 bishop |
| `opponent_left_book` | the opponent's move, which leaves the player's repertoire | KID 2.Bg5 (Trompowsky) |
| `hint` | any move; the player is to move and asks for a hint | London middlegame, Bd3 next |

`src/generate-cases.ts` plays each sequence and analyses the last move with Stockfish, using the `engine` settings in `config/tutor.json` (WASM by default, native when `STOCKFISH_PATH` is set). It then runs the server's `detect()` with the `keyMoments` thresholds and the repertoire in `repertoire/`. A case is written only when `detect()` returns the intended kind. Any other result is printed as `SKIP` with the reason, and an older file for that id is deleted. Each case is saved as `cases/<id>.json`:

```
{ id, kind, playerColor, history (UCI, with the last move), fen (after it), moment (detect() output, null for hints),
  attemptFen (before the move for player_blunder / missed_win, else fen), engineBest (UCI at attemptFen),
  engineBestCp (its evaluation for the side to move at attemptFen), source }
```

Regenerate the cases (no network, a few minutes):

```
pnpm --filter @chess-tutor/evals generate-cases            # all sequences
pnpm --filter @chess-tutor/evals generate-cases --only 'mw-*'
```

The generated cases are committed, which freezes the engine data. Stockfish with several threads is not fully deterministic, so a borderline sequence (for example one whose evaluation after the move is close to 0) can flip between kinds when you regenerate. Check the `SKIP` list.

## 2. Running

```
pnpm eval -- --model claude-sonnet-5-5 --effort medium --max-usd 1.5
pnpm eval -- --model claude-opus-5-5 --effort medium --cases hint --max-usd 0.5
```

| flag | default | meaning |
| --- | --- | --- |
| `--model` | `config/models.json` `eval.tutor` | model ID; it must have a price in `pricingPerMTok` |
| `--effort` | `config/tutor.json` `tutor.effort` | `low`, `medium`, `high`, `xhigh` or `max` |
| `--cases` | all | a kind (`hint`), an id glob (`pb-kid-*`), or a comma list of either |
| `--max-usd` | 2 | spending cap; see below |
| `--concurrency` | 2 | cases running at the same time (they share one Stockfish, which queues searches) |
| `--repeat` | 1 | runs every case N times (ids get `#1`, `#2`, ...) |
| `--out` | `evals/results/<timestamp>-<model>-<effort>` | output directory (gitignored) |
| `--prompt` | `prompts/tutor-system.v1.md` | system prompt file to test |
| `--live-explorer` | off | uses the real Lichess explorer (needs `LICHESS_TOKEN`). By default the explorer always answers "unavailable", so runs need no network and are repeatable. |

`ANTHROPIC_API_KEY` comes from the environment or the repository's `.env`.

**Spending cap.** After each case the runner prices that case's token usage with `config/models.json` `pricingPerMTok`. Cache writes cost 1.25 times the input price and cache reads use the `cacheRead` price. Once the summed cost reaches `--max-usd`, no new case starts. Cases already running still finish, so the total can end up slightly above the cap (by at most `concurrency` cases, about $0.03 to $0.05 each). Cases that never started are listed in `summary.json` (`skipped`) and in the report. A failed ask counts what its API rounds were billed (from the recorded rounds' usage), not $0, even when the ask threw.

Output:

- `cases/<id>.json`: the full record of one ask: the outcome, the reply, every API round (stop reason, tool calls with inputs, tool results, text, usage, time), progress labels, the cost and all grades.
- `summary.json`: the run settings, the metrics and one short row per case.
- `report.md`: the same information as a readable report.

A failing ask (rate limit, network, invalid reply, unsupported claim and so on) is recorded with its reason. The run does not stop.

## 3. Comparing runs (Q-3: Opus vs Sonnet)

```
pnpm eval -- compare evals/results/<run-a> evals/results/<run-b> [--out <dir>]
```

This writes `compare.md` and `compare.json`. They show the metrics side by side, then one row per case with each run's result (`ok`, `ok, give-away`, `FAIL unsupported_claim`, ...).

## 3a. Re-grading a run offline

```
pnpm eval -- regrade evals/results/<run> [<run> ...]
```

When the graders change, this re-grades the recorded `cases/*.json` of a run without any API or engine call. It rewrites the grades, `summary.json` (keeping the run's settings) and `report.md`. It needs the run's cases to still exist in `evals/cases/`. Runs recorded before correction texts were captured show their retries as `unrecorded`.

## 4. What the metrics mean

Percentages for grades are taken over the replies the tutor actually returned (`ok`). Failed asks count only in the OK rate and in the failure reasons.

| metric | in plain words |
| --- | --- |
| OK rate | How often the tutor gave a reply the server would show. The rest failed (reason shown), and the player would see "coaching unavailable". |
| NFR-6 move legality | Every move the tutor names in its message or reveal is a real, legal move. It may be named in SAN (Nf3, Bxd6, O-O, e8=Q, Bb5+), UCI (g1f3), long algebraic (e3-e4, Bf1-d3) or as "bishop to d3" or "putting your knight on e5". The move must be legal in one of these positions: the current position, the attempt position, the position after `revealMove`, any position along the lines in this ask's tool results (engine lines, evaluate_move's reply line, explorer and repertoire moves), or a position reached by moves named earlier in the same text. So "g6, then Bg7 and O-O" counts as a plan, and "after exf4 exf4" counts as the engine line. The opponent's last move also counts, from the position before it ("Black's ...b6 weakened c6"), but only for the side that made it. Earlier positions of the game count only for a move told in the past tense ("you played Nd2", "Black castled"), a list that continues one ("Black played ...Nc6, ...Bd6 and ...O-O"), or a move number before the current move ("2.Bf4 Nf6"). Tense is decided per clause: a comma, "so", "since" or "now that" starts a new one. So "Play Nc3 now", "9.Nc3! is best", "Black plays Nb8-c6" and "Black was slow, so Nc3 is strong" must all be legal now. SAN after "your" or "the" ("your Bf4") may name the piece where it stands. A plan named as a noun ("the f5 break") is not graded for legality, since a plan need not be playable yet. A `revealMove`, when given, must be legal at the attempt position. A bare square ("the knight on f6", "go after c7", "the rook on a8?") is not a move. It counts as a pawn move only in a move context ("play g6", "...e5", "d6 and c5", "c4?!"), or as the piece's move after "the knight can go to a6 or c7". |
| NFR-6 eval match | Every evaluation the tutor quotes (+1.5, 1.5 pawns, 150 centipawns, mate in 3, and unsigned ones: any decimal, as in "better by 2.3 and", "down 0.4 or so", "The engine gives 1.8", "White is 1.5 better", "a 1.5-pawn edge") matches a score it was given in this ask: a tool result (engine evaluations, centipawn loss) or the key-moment data (centipawn loss or gain). The match must be within 0.3 pawns, or 0.5 for a whole number of pawns. When the sentence says which side is better ("Black is up 1.5", "+1.5 for White", "you are down 2 pawns"), the sign must match too. Crediting the advantage to the wrong side is flagged as `wrong_side`. A whole number counts only when an evaluation word frames it ("is up 2 pawns", "better by 1", "an advantage of 2 pawns"). Otherwise it is a count ("2 pawns on the queenside", "defended by 2 pawns", "backed up by 2 pawns"). "Up 2 pawns in material" is a material claim, not an engine evaluation, and is not graded. |
| NFR-7 no give-away (target 90%) | The first message and the arrows do not give the answer away before the player tries (the user's rule, 2026-11-08). The grade fails when the message names `revealMove` in any notation, or names the answer's piece together with a check when the answer gives check ("a check with your other bishop", "a bishop check", "checks with your bishop"), or says "castle" when the answer is castling (unless the clause is about the opponent: "Black has already castled"). Naming the answer includes "putting your king's knight on e5", "your knight belongs on e5" and a plan such as "the e4 break", "the e4 pawn break" or "the e4-break". Without a `revealMove`, the answer is the case's engine best move. It also fails when an arrow is the answer move or starts on its from-square, because that shows the piece. Malformed arrows (the session drops them) are ignored here. |
| Points at the answer square | For information only, not part of NFR-7. Counts replies with an arrow that ends on the answer's to-square, runs along its line through it, or starts on its empty to-square. These are allowed Socratic nudges ("look at e5"). |
| Arrows well formed | At most 3 arrows, each between two different real squares, no duplicates (a `h7->h7` arrow fails). Since #10 round 2 the tutor session drops malformed arrows before it returns a reply, so new runs should be at 100%. |
| Reveal move | `revealMove` is the engine's best move at the attempt position, or loses at most `tutor.attemptToleranceCp` (50 cp) against it. The runner measures the loss with Stockfish. |
| Schema and kind | The reply matches the tutor's reply schema and the kind of the case. |
| Tool calls, correction retries | How many tools the tutor called per case. Also how often the session sent its one correction turn (NFR-8), counted by reason from the recorded correction text: `give_away`, `unbacked_move` (a move no tool or key-moment data gave), `illegal_move`, `unbacked_eval`, `reveal_move`, `invalid_reply`, `other`. |
| Latency p50 / p95 | Time for the whole ask (all rounds and tools). The median and the 95th percentile, nearest rank. |
| First API round | Time until the first API response arrives (the first tool call or the reply). |
| Cost per case / per game | Average USD per ask. "Per game" assumes 10 key moments or hints per game. |

## 5. Not graded yet (needs an LLM judge)

These graders are deterministic. They do not judge whether an explanation is *true* or *good*. Known gaps:

- False positional claims. One example: "the bishop pins the knight on f6" after 1.d4 Nf6 2.Bg5, where the e7 pawn blocks the diagonal to the queen.
- Give-aways in plain words that name neither the move nor the answer's piece together with its check.
- Clarity and fit for a 1000-rated player (architecture §5, optional judge).

## Layout

- `src/run.ts`: the CLI (run and compare)
- `src/runner.ts`: runs cases through `createTutorSession`, with the budget, concurrency and repeat
- `src/recorder.ts`: wraps the Anthropic client and records every round and tool result
- `src/graders.ts` and `src/notation.ts`: the deterministic graders (chess.js only, independent of `packages/tutor` internals)
- `src/report.ts`: metrics, `report.md`, compare
- `src/regrade.ts`: offline re-grading of recorded runs, and correction-reason buckets
- `src/generate-cases.ts`, `src/cases.ts`: building and loading cases
- `test/fixtures/bakeoff-replies.json`: the 12 real replies from the model bake-off (Opus 5.5 medium and low, Sonnet 5.5 medium), used as grader fixtures. `test/fixtures/runs/` holds two run summaries built from them, used for the compare tests. `test/fixtures/q3/` holds real per-case results from the first live runs (2026-11-08), used for the round-2 grader tests.
