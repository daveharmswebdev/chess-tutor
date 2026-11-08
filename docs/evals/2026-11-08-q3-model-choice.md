# Eval 2026-11-08: choosing the tutor model (Q-3)

**Decision (user, 2026-11-08): Claude Sonnet 5.5 at effort `medium`** is pinned as the tutor model for `development` and `eval` in `config/models.json`.

## The runs
- **What ran:** 66 frozen cases (`evals/cases/`, all four key-moment kinds plus hints) with prompt `tutor-system.v1.md`.
- **Setup:** live calls, offline explorer stub, real WASM Stockfish, concurrency 1, the three runs in parallel.
- **Cost:** $4.05 in total, out of the $10 budget for #10.

| | Opus 5.5 medium | **Sonnet 5.5 medium** | Opus 5.5 low |
|---|---|---|---|
| Tutor returned a reply | **100%** | 94% (4 refused by the claims check) | 98% |
| NFR-7 no give-away (the user's rule, see below; target ≥ 90%) | 86% | **94%** | 83% |
| NFR-7 including "an arrow ends on the answer's square" | 65% | 60% | 62% |
| NFR-6 evaluations match the engine | 100% | 100% | 100% |
| Arrows well formed | 94% | 81% | 97% |
| Latency p50 / p95 (NFR-1: ~6 s / 12 s) | 9.5 / 15.5 s | **7.3 / 10.6 s** | 7.1 / 12.8 s |
| Cost per game (10 asks) | $0.27 | **$0.15** | $0.19 |

### Why Sonnet
- It is the only setup inside the NFR-1 p95 target.
- It is the best on NFR-7, at about half the cost of Opus.
- Opus medium always answered, but one reply in twenty took over 15 s.
- Opus low gave the most answers away, mostly on missed wins.

### Sonnet's 4 failures
The claims check refused to show a reply in each case. That is the safety net working, not a false alarm:
- **3 of the 4:** the reply gave the answer away twice in a row (it named `dxe5` twice, and drew arrow b5-c7, the answer move).
- **1 of the 4:** the reply named a move (d5) without asking the engine.

The fix is a firmer prompt (v2), not a looser check.

## The give-away rule (user decision)
A first message gives the answer away if any of these is true:
- it names the answer move in any notation;
- a pre-reveal arrow *is* the answer move, or starts on its piece;
- it names the answer's piece together with the check it gives.

An arrow that only ends on the answer's square, or runs along its line, is a Socratic nudge ("look at e5") and is allowed. It is reported as information, not counted against NFR-7.

## Known grader limits in this run
- **NFR-6 move legality is not shown in the table** (it read 89–95%). The grader flagged legal moves in continuation lines from the engine's own output, e.g. "after exf4 exf4 you are still a knight up", and squares followed by "?" ("look at c7?"). Fixed in round 2 of #10.
- **False positional claims need an LLM judge,** which is a follow-up. Example: "Bg5 pins the knight on f6" when e7 blocks the diagonal.

Raw results (local, gitignored): `evals/results/q3-2026-11-08/`.
