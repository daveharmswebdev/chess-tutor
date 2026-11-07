# Spike 001: WASM Stockfish latency in Node

| | |
|---|---|
| Date | 2026-11-07 |
| Question | Does WASM Stockfish (npm `stockfish`) run in Node with NNUE, and does it meet NFR-2 (≤ 1 s per analysis)? |
| Answer | **Yes**, with a time cap. |
| Reproduce | `pnpm spike:engine` |

**Setup:** `stockfish@19.0.1` (Stockfish 19, full NNUE build, multithreaded, about 94 MB), Node 22.22.1, Apple M5 Pro (18 cores). 6 positions (London and KID openings, a tactical middlegame, a rook endgame), multi-PV 3.

## Depth only (no cap)

| Build | Threads | Depth | p50 ms | max ms |
|---|---|---|---|---|
| full | 4 | 16 | 386 | 2270 |
| full | 4 | 18 | 830 | 3207 |
| full | 2 | 20 | 1884 | 10233 |
| lite-single | 1 | 18 | 1195 | 1590 |

Typical times are fine, but the slowest positions go well past 1 s. Multi-PV 3 costs roughly 3× a single line.

## Depth 18 with a 1000 ms cap (`go depth 18 movetime 1000`), the adopted default

| Build | Threads | Startup ms | p50 ms | max ms | Lowest depth reached |
|---|---|---|---|---|---|
| full | 4 | 286 | 846 | 1000 | 15 |
| full | 8 | 307 | 687 | 1000 | 15 |
| lite-single | 1 | 72 | 1000 | 1000 | 17 |

## Decision

- Use the **full** build with **4 threads** and **depth 18 with a 1000 ms cap** by default (this is ADR-002).
- Depth 15 or more is more than enough for explaining positions to a player around 1000.
- In Node the multithreaded build needs no special setup. The cross-origin isolation headers are only needed in browsers.
- Startup costs about 0.3 s per engine process, paid once per game.
- The engine's log notes that shared memory isn't available for the NNUE network, so each process keeps its own copy. That's harmless with two engines per game.
- **License:** Stockfish is GPL-3.0. That's fine for personal use. If the app is ever distributed, GPL obligations apply to the engine. A hosted service is a different case worth checking then.
