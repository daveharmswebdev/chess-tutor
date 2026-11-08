# Eval 2026-11-08: choosing the tutor model (Q-3)

**Decision (user, 2026-11-08): Claude Sonnet 5.5 at effort `medium`** is pinned as the tutor model for `development` and `eval` in `config/models.json`.

## The runs
- **What ran:** 66 frozen cases (`evals/cases/`, all four key-moment kinds plus hints) with prompt `tutor-system.v1.md`.
- **Setup:** live calls, offline explorer stub, real WASM Stockfish, concurrency 1.
- **Graders:** the figures below use the round-2 graders. The three first runs were re-graded offline with `pnpm eval -- regrade`, with no new API calls.
- **Cost:** $5.29 in total for #10, out of the $10 budget. That covers a bake-off of 12 asks ($0.26), the three runs ($4.05) and one confirming Sonnet run ($0.98).

| | Opus 5.5 medium | **Sonnet 5.5 medium** (run 1 / confirming run) | Opus 5.5 low |
|---|---|---|---|
| Tutor returned a reply | **100%** | 94% / 94% (4 refused by the claims check) | 98% |
| NFR-6 moves legal | 100% | 100% / 100% | 100% |
| NFR-6 evaluations match the engine | 100% | 100% / 100% | 100% |
| NFR-7 no give-away (the user's rule; target ≥ 90%) | 87.9% | **96.8% / 88.7%** | 84.6% |
| Arrow points at the answer's square (information only) | 24% | 29% / 29% | 32% |
| Arrows well formed | 94% | 81% / **100%** (malformed arrows now dropped) | 97% |
| Latency p50 / p95 (NFR-1: ~6 s / 12 s) | 9.5 / 15.5 s | **7.3 / 10.6 s**, 7.4 / 11.3 s | 7.1 / 12.8 s |
| Cost per game (10 asks) | $0.27 | **$0.15** | $0.19 |

**How NFR-7 is counted:** only asks that returned a reply are counted. The claims check refused 4 Sonnet asks per run, mostly for giving the answer away. Counted against Sonnet, run 1 would read 60/66 = 90.9%.

### Why Sonnet
- It is the only setup inside the NFR-1 p95 target.
- It is at or near the NFR-7 target. The two runs read 96.8% and 88.7%, so it sits around the 90% line.
- It costs about half as much as Opus.
- Opus medium always answered, but one reply in twenty took over 15 s, and it gave more answers away (87.9%).
- Opus low gave the most answers away, mostly on missed wins.

### Where Sonnet's retries go
The confirming run recorded why each correction retry was sent: 42 retries, of which 31 were the claims check catching a give-away, 17 an unbacked move and 4 an illegal move. A case can have several reasons.

So in about half of its first drafts, Sonnet hands over the answer, and the claims check sends it back. The 4 failed asks are drafts that gave the answer away twice in a row, or named a move without asking the engine. These are correct refusals. The lever is a firmer prompt (v2), not a looser check.

## The give-away rule (user decision)
A first message gives the answer away if any of these is true:
- it names the answer move in any notation;
- a pre-reveal arrow *is* the answer move, or starts on its piece;
- it names the answer's piece together with the check it gives.

An arrow that only ends on the answer's square, or runs along its line, is a Socratic nudge ("look at e5") and is allowed. It is reported as information, not counted against NFR-7.

## Known grader limits
The review of #10 (brief 034) found that the graders can pass a bad reply. So the 100% NFR-6 and the NFR-7 figures are upper bounds:
- evaluations quoted without a sign or unit ("better by 2.3") are not checked;
- a move legal earlier in the game counts as legal now;
- some give-away wordings slip through: "a bishop check", "castle", "the e4 break", "putting your knight on e5".

These holes are tracked as a follow-up, which must be closed before the CI eval becomes a blocking gate.

False positional claims ("Bg5 pins the knight on f6" when e7 blocks the diagonal) need an LLM judge. That is also a follow-up.

Raw results (local, gitignored): `evals/results/q3-2026-11-08/`.
